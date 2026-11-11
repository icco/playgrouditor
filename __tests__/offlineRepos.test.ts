import AsyncStorage from '@react-native-async-storage/async-storage';
import { GitHubError, TreeEntry } from '../src/lib/github';
import { clearLocalFiles } from '../src/lib/localFiles';
import {
  deleteUnreferencedBlobs,
  getKeptRepo,
  getKeptTree,
  hasBlob,
  keepRepo,
  listKeptDir,
  listKeptRepos,
  readKeptFile,
  recordCommittedFile,
  saveBlob,
  saveKeptTree,
  subscribeKeptRepos,
  unkeepRepo,
  updateKeptRepo,
} from '../src/lib/offlineRepos';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: (k: string) => Promise.resolve(store.get(k) ?? null),
      setItem: (k: string, v: string) => Promise.resolve(void store.set(k, v)),
      removeItem: (k: string) => Promise.resolve(void store.delete(k)),
      getAllKeys: () => Promise.resolve([...store.keys()]),
    },
  };
});

const repo = 'alice/notes';
const tree: TreeEntry[] = [
  { path: 'docs', type: 'tree', sha: 't1' },
  { path: 'docs/a.md', type: 'blob', sha: 'a1', size: 5 },
  { path: 'docs/sub', type: 'tree', sha: 't2' },
  { path: 'docs/sub/b.md', type: 'blob', sha: 'b1', size: 5 },
  { path: 'docs/photo.png', type: 'blob', sha: 'p1', size: 9 },
  { path: 'top.md', type: 'blob', sha: 'c1', size: 5 },
];

describe('offline repos', () => {
  beforeEach(async () => {
    await clearLocalFiles();
    await keepRepo(repo, 'main');
    await saveKeptTree(repo, tree);
    await saveBlob(repo, 'a1', 'hello');
  });

  it('lists direct children of a folder', async () => {
    const entries = await listKeptDir(repo, 'docs');
    expect(entries?.map(e => [e.name, e.type])).toEqual([
      ['sub', 'dir'],
      ['a.md', 'file'],
      ['photo.png', 'file'],
    ]);
    expect((await listKeptDir(repo, ''))?.map(e => e.path)).toEqual(['docs', 'top.md']);
  });

  it('reads a stored file by path', async () => {
    await expect(readKeptFile(repo, 'docs/a.md')).resolves.toEqual({ sha: 'a1', text: 'hello' });
    await expect(readKeptFile(repo, 'missing.md')).resolves.toBeNull();
  });

  it('throws not stored offline for a skipped blob', async () => {
    const err = await readKeptFile(repo, 'docs/photo.png').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).message).toBe('This file is not stored offline.');
  });

  it('returns null for repos not kept', async () => {
    await expect(listKeptDir('bob/other', '')).resolves.toBeNull();
    await expect(readKeptFile('bob/other', 'a.md')).resolves.toBeNull();
    await updateKeptRepo('bob/other', { fileCount: 3 });
    await expect(getKeptRepo('bob/other')).resolves.toBeNull();
  });

  it('unkeep removes tree and blobs', async () => {
    await unkeepRepo(repo);
    await expect(listKeptRepos()).resolves.toEqual([]);
    await expect(getKeptTree(repo)).resolves.toBeNull();
    await expect(hasBlob(repo, 'a1')).resolves.toBe(false);
  });

  it('deletes only unreferenced blobs', async () => {
    await saveBlob(repo, 'old', 'gone');
    await saveBlob('alice/other', 'old', 'kept');
    await deleteUnreferencedBlobs(repo, new Set(['a1']));
    await expect(hasBlob(repo, 'a1')).resolves.toBe(true);
    await expect(hasBlob(repo, 'old')).resolves.toBe(false);
    await expect(hasBlob('alice/other', 'old')).resolves.toBe(true);
  });

  it('recordCommittedFile updates the tree sha', async () => {
    await recordCommittedFile(repo, 'docs/a.md', { sha: 'a2', text: 'edited' });
    await recordCommittedFile(repo, 'docs/new.md', { sha: 'n1', text: 'new' });
    await expect(readKeptFile(repo, 'docs/a.md')).resolves.toEqual({ sha: 'a2', text: 'edited' });
    await expect(readKeptFile(repo, 'docs/new.md')).resolves.toEqual({ sha: 'n1', text: 'new' });
    await recordCommittedFile('bob/other', 'a.md', { sha: 'x', text: 'x' });
    await expect(getKeptTree('bob/other')).resolves.toBeNull();
  });

  it('clearLocalFiles removes offline keys', async () => {
    await clearLocalFiles();
    const keys = await AsyncStorage.getAllKeys();
    expect(keys.filter(k => k.startsWith('@playgrounditor:offline:'))).toEqual([]);
  });

  it('notifies subscribers on keep', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeKeptRepos(listener);
    await keepRepo('alice/blog', 'main');
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    expect((await listKeptRepos()).map(r => r.fullName)).toEqual([repo, 'alice/blog']);
  });
});
