import AsyncStorage from '@react-native-async-storage/async-storage';
import { Entry, GitHubError, TreeEntry, sortEntries } from './github';
import type { CachedFile } from './localFiles';

export const OFFLINE_PREFIX = '@playgrounditor:offline:';
const REPOS_KEY = `${OFFLINE_PREFIX}repos`;
const TREE_PREFIX = `${OFFLINE_PREFIX}tree:`;
const BLOB_PREFIX = `${OFFLINE_PREFIX}blob:`;

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

export async function keepRepo(fullName: string, defaultBranch: string): Promise<void> {
  const repos = await listKeptRepos();
  if (repos.some(r => r.fullName === fullName)) return;
  await writeKeptRepos([...repos, { fullName, defaultBranch, fileCount: 0, bytes: 0, pending: 0 }]);
}

export async function unkeepRepo(fullName: string): Promise<void> {
  await writeKeptRepos((await listKeptRepos()).filter(r => r.fullName !== fullName));
  const prefix = `${BLOB_PREFIX}${fullName}:`;
  const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(prefix) || k === TREE_PREFIX + fullName);
  await Promise.all(keys.map(k => AsyncStorage.removeItem(k)));
}

export async function updateKeptRepo(fullName: string, patch: Partial<KeptRepo>): Promise<void> {
  const repos = await listKeptRepos();
  if (!repos.some(r => r.fullName === fullName)) return;
  await writeKeptRepos(repos.map(r => (r.fullName === fullName ? { ...r, ...patch } : r)));
}

export function getKeptTree(fullName: string): Promise<TreeEntry[] | null> {
  return readJson<TreeEntry[]>(TREE_PREFIX + fullName);
}

export async function saveKeptTree(fullName: string, entries: TreeEntry[]): Promise<void> {
  await AsyncStorage.setItem(TREE_PREFIX + fullName, JSON.stringify(entries));
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
        type: e.type === 'tree' ? 'dir' : e.type === 'commit' ? 'submodule' : 'file',
      }),
    );
  return sortEntries(children);
}

export async function readKeptFile(fullName: string, path: string): Promise<CachedFile | null> {
  const entry = (await getKeptTree(fullName))?.find(e => e.path === path && e.type === 'blob');
  if (!entry) return null;
  const text = await AsyncStorage.getItem(blobKey(fullName, entry.sha));
  if (text === null) throw new GitHubError('This file is not stored offline.', 404);
  return { sha: entry.sha, text };
}

export async function recordCommittedFile(fullName: string, path: string, file: CachedFile): Promise<void> {
  const tree = await getKeptTree(fullName);
  if (!tree || !(await getKeptRepo(fullName))) return;
  const rest = tree.filter(e => e.path !== path);
  await saveBlob(fullName, file.sha, file.text);
  await saveKeptTree(fullName, [...rest, { path, type: 'blob', sha: file.sha, size: file.text.length }]);
  notify();
}
