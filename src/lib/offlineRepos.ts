import AsyncStorage from '@react-native-async-storage/async-storage';
import { Entry, GitHubError, TreeEntry, sortEntries } from './github';
import type { CachedFile } from './localFiles';

export const OFFLINE_PREFIX = '@playgrounditor:offline:';
const REPOS_KEY = `${OFFLINE_PREFIX}repos`;
const TREE_PREFIX = `${OFFLINE_PREFIX}tree:`;
const BLOB_PREFIX = `${OFFLINE_PREFIX}blob:`;
const SKIPPED_PREFIX = `${OFFLINE_PREFIX}skipped:`;
const MODIFIED_PREFIX = `${OFFLINE_PREFIX}modified:`;
const SYMLINK_MODE = '120000';

export interface KeptRepo {
  fullName: string;
  defaultBranch: string;
  treeSha?: string;
  syncedAt?: string;
  fileCount: number;
  bytes: number;
  pending: number;
  syncing?: boolean;
  error?: string;
}

export interface KeptDate {
  sha: string;
  date: string;
}

const listeners = new Set<() => void>();

export function subscribeKeptRepos(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  listeners.forEach(l => l());
}

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch (e: unknown) {
    console.warn(`Dropping unreadable entry ${key}`, e);
    await AsyncStorage.removeItem(key);
    return null;
  }
}

function blobKey(fullName: string, sha: string): string {
  return `${BLOB_PREFIX}${fullName}:${sha}`;
}

export async function listKeptRepos(): Promise<KeptRepo[]> {
  return (await readJson<KeptRepo[]>(REPOS_KEY)) ?? [];
}

export async function getKeptRepo(fullName: string): Promise<KeptRepo | null> {
  return (await listKeptRepos()).find(r => r.fullName === fullName) ?? null;
}

async function writeKeptRepos(repos: KeptRepo[]): Promise<void> {
  await AsyncStorage.setItem(REPOS_KEY, JSON.stringify(repos));
  notify();
}

let queue: Promise<unknown> = Promise.resolve();

// Read-modify-write of the repo list must not interleave, or a stale write restores a removed repo.
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

export function keepRepo(fullName: string, defaultBranch: string): Promise<void> {
  return serialized(async () => {
    const repos = await listKeptRepos();
    if (repos.some(r => r.fullName === fullName)) return;
    await writeKeptRepos([...repos, { fullName, defaultBranch, fileCount: 0, bytes: 0, pending: 0 }]);
  });
}

export function unkeepRepo(fullName: string): Promise<void> {
  return serialized(async () => {
    await writeKeptRepos((await listKeptRepos()).filter(r => r.fullName !== fullName));
    const prefix = `${BLOB_PREFIX}${fullName}:`;
    const keys = (await AsyncStorage.getAllKeys()).filter(
      k =>
        k.startsWith(prefix) ||
        k === TREE_PREFIX + fullName ||
        k === SKIPPED_PREFIX + fullName ||
        k === MODIFIED_PREFIX + fullName,
    );
    await Promise.all(keys.map(k => AsyncStorage.removeItem(k)));
  });
}

export function updateKeptRepo(fullName: string, patch: Partial<KeptRepo>): Promise<void> {
  return serialized(async () => {
    const repos = await listKeptRepos();
    if (!repos.some(r => r.fullName === fullName)) return;
    await writeKeptRepos(repos.map(r => (r.fullName === fullName ? { ...r, ...patch } : r)));
  });
}

export function clearOfflineData(): Promise<void> {
  return serialized(async () => {
    const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(OFFLINE_PREFIX));
    await Promise.all(keys.map(k => AsyncStorage.removeItem(k)));
    notify();
  });
}

export async function getSkippedShas(fullName: string): Promise<Set<string>> {
  return new Set((await readJson<string[]>(SKIPPED_PREFIX + fullName)) ?? []);
}

export async function saveSkippedShas(fullName: string, shas: Set<string>): Promise<void> {
  await AsyncStorage.setItem(SKIPPED_PREFIX + fullName, JSON.stringify([...shas]));
}

export function getKeptTree(fullName: string): Promise<TreeEntry[] | null> {
  return readJson<TreeEntry[]>(TREE_PREFIX + fullName);
}

export async function saveKeptTree(fullName: string, entries: TreeEntry[]): Promise<void> {
  await AsyncStorage.setItem(TREE_PREFIX + fullName, JSON.stringify(entries));
}

export async function getKeptDates(fullName: string): Promise<Record<string, KeptDate>> {
  return (await readJson<Record<string, KeptDate>>(MODIFIED_PREFIX + fullName)) ?? {};
}

export async function getKeptModified(fullName: string): Promise<Record<string, string>> {
  return Object.fromEntries(Object.entries(await getKeptDates(fullName)).map(([path, d]) => [path, d.date]));
}

export async function saveKeptModified(fullName: string, dates: Record<string, KeptDate>): Promise<void> {
  await AsyncStorage.setItem(MODIFIED_PREFIX + fullName, JSON.stringify(dates));
}

export async function hasBlob(fullName: string, sha: string): Promise<boolean> {
  return (await AsyncStorage.getItem(blobKey(fullName, sha))) !== null;
}

export async function saveBlob(fullName: string, sha: string, text: string): Promise<void> {
  await AsyncStorage.setItem(blobKey(fullName, sha), text);
}

export async function deleteUnreferencedBlobs(fullName: string, keep: Set<string>): Promise<void> {
  const prefix = `${BLOB_PREFIX}${fullName}:`;
  const stale = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(prefix) && !keep.has(k.slice(prefix.length)));
  await Promise.all(stale.map(k => AsyncStorage.removeItem(k)));
}

export async function listKeptDir(fullName: string, path: string): Promise<Entry[] | null> {
  const tree = await getKeptTree(fullName);
  if (!tree) return null;
  const prefix = path ? `${path}/` : '';
  const children = tree
    .filter(e => e.path.startsWith(prefix) && !e.path.slice(prefix.length).includes('/'))
    .map(
      (e): Entry => ({
        name: e.path.slice(prefix.length),
        path: e.path,
        sha: e.sha,
        type: entryType(e),
      }),
    );
  return sortEntries(children);
}

export function isSymlink(e: TreeEntry): boolean {
  return e.mode === SYMLINK_MODE;
}

function entryType(e: TreeEntry): Entry['type'] {
  if (e.type === 'tree') return 'dir';
  if (e.type === 'commit') return 'submodule';
  return isSymlink(e) ? 'symlink' : 'file';
}

function withParents(tree: TreeEntry[], path: string): TreeEntry[] {
  const known = new Set(tree.map(e => e.path));
  const parts = path.split('/').slice(0, -1);
  const added = parts
    .map((_, i) => parts.slice(0, i + 1).join('/'))
    .filter(dir => !known.has(dir))
    .map((dir): TreeEntry => ({ path: dir, type: 'tree', sha: '' }));
  return [...tree, ...added];
}

// Runs fn under the repo-list lock, only while the repo is still kept, so nothing is written after removal.
export function whileKept(fullName: string, fn: () => Promise<void>): Promise<boolean> {
  return serialized(async () => {
    if (!(await getKeptRepo(fullName))) return false;
    await fn();
    return true;
  });
}

export async function readKeptFile(fullName: string, path: string): Promise<CachedFile | null> {
  const entry = (await getKeptTree(fullName))?.find(e => e.path === path && e.type === 'blob');
  if (!entry) return null;
  const text = await AsyncStorage.getItem(blobKey(fullName, entry.sha));
  if (text === null) throw new GitHubError('This file is not stored offline.', 404);
  return { sha: entry.sha, text };
}

export async function recordCommittedFile(fullName: string, path: string, file: CachedFile): Promise<void> {
  const written = await whileKept(fullName, async () => {
    const tree = await getKeptTree(fullName);
    if (!tree) return;
    const rest = withParents(
      tree.filter(e => e.path !== path),
      path,
    );
    await saveBlob(fullName, file.sha, file.text);
    await saveKeptTree(fullName, [...rest, { path, type: 'blob', sha: file.sha, size: file.text.length }]);
    const date = new Date().toISOString();
    const parts = path.split('/');
    // Folder shas are unknown here, so the next sync re-dates them.
    const touched = parts.map((_, i): [string, KeptDate] => [
      parts.slice(0, i + 1).join('/'),
      { sha: i === parts.length - 1 ? file.sha : '', date },
    ]);
    await saveKeptModified(fullName, { ...(await getKeptDates(fullName)), ...Object.fromEntries(touched) });
  });
  if (written) notify();
}
