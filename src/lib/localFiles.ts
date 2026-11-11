import AsyncStorage from '@react-native-async-storage/async-storage';
import { clearOfflineData } from './offlineRepos';

const DRAFT_PREFIX = '@playgrounditor:draft:';
const FILE_PREFIX = '@playgrounditor:file:';
const FILE_INDEX_KEY = '@playgrounditor:file_index';
const MAX_CACHED_FILES = 30;

export interface Draft {
  repoFullName: string;
  path: string;
  defaultBranch: string;
  text: string;
  baseSha?: string;
  updatedAt: string;
  queued?: QueuedCommit;
  sendError?: string;
}

export interface QueuedCommit {
  mode: 'direct' | 'pr';
  message: string;
}

export interface CachedFile {
  sha: string;
  text: string;
}

export function fileId(repoFullName: string, path: string): string {
  return `${repoFullName}:${path}`;
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

export function getDraft(repoFullName: string, path: string): Promise<Draft | null> {
  return readJson<Draft>(DRAFT_PREFIX + fileId(repoFullName, path));
}

// Further edits keep a queued commit and its base, so it sends the newest text.
export async function saveDraft(draft: Omit<Draft, 'updatedAt'>): Promise<void> {
  const existing = await getDraft(draft.repoFullName, draft.path);
  const baseSha = existing?.queued ? existing.baseSha : draft.baseSha;
  await writeDraft({ queued: existing?.queued, sendError: existing?.sendError, ...draft, baseSha });
}

export async function writeDraft(draft: Omit<Draft, 'updatedAt'>): Promise<void> {
  const value: Draft = { ...draft, updatedAt: new Date().toISOString() };
  await AsyncStorage.setItem(DRAFT_PREFIX + fileId(draft.repoFullName, draft.path), JSON.stringify(value));
}

export async function deleteDraft(repoFullName: string, path: string): Promise<void> {
  await AsyncStorage.removeItem(DRAFT_PREFIX + fileId(repoFullName, path));
}

export async function listDrafts(): Promise<Draft[]> {
  const keys = (await AsyncStorage.getAllKeys()).filter(k => k.startsWith(DRAFT_PREFIX));
  const drafts = await Promise.all(keys.map(k => readJson<Draft>(k)));
  return drafts
    .filter((d): d is Draft => d !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getCachedFile(repoFullName: string, path: string): Promise<CachedFile | null> {
  return readJson<CachedFile>(FILE_PREFIX + fileId(repoFullName, path));
}

export async function cacheFile(repoFullName: string, path: string, file: CachedFile): Promise<void> {
  const id = fileId(repoFullName, path);
  const index = (await readJson<string[]>(FILE_INDEX_KEY)) ?? [];
  const next = [id, ...index.filter(i => i !== id)];
  const evicted = next.splice(MAX_CACHED_FILES);
  await AsyncStorage.setItem(FILE_PREFIX + id, JSON.stringify(file));
  await AsyncStorage.setItem(FILE_INDEX_KEY, JSON.stringify(next));
  await Promise.all(evicted.map(e => AsyncStorage.removeItem(FILE_PREFIX + e)));
}

export async function clearLocalFiles(): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter(
    k => k.startsWith(DRAFT_PREFIX) || k.startsWith(FILE_PREFIX) || k === FILE_INDEX_KEY,
  );
  await Promise.all([...keys.map(k => AsyncStorage.removeItem(k)), clearOfflineData()]);
}
