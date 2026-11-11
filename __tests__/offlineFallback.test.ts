import { GitHub, GitHubError, NETWORK_ERROR_STATUS } from '../src/lib/github';
import { clearLocalFiles } from '../src/lib/localFiles';
import { keepRepo, saveBlob, saveKeptTree } from '../src/lib/offlineRepos';
import { listDirOffline, readFileOffline, repoOffline } from '../src/lib/offlineFallback';

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
const offline = new GitHub('t', jest.fn().mockRejectedValue(new TypeError('Network request failed')));
const forbidden = new GitHub(
  't',
  jest.fn().mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden', json: () => Promise.resolve({ message: 'Forbidden' }) }),
);

describe('offline fallback', () => {
  beforeEach(async () => {
    await clearLocalFiles();
    await keepRepo(repo, 'trunk');
    await saveKeptTree(repo, [
      { path: 'docs', type: 'tree', sha: 't1' },
      { path: 'docs/a.md', type: 'blob', sha: 'a1', size: 5 },
    ]);
    await saveBlob(repo, 'a1', 'hello');
  });

  it('lists from the kept tree on a network error', async () => {
    const entries = await listDirOffline(offline, repo, 'docs', 'trunk');
    expect(entries.map(e => e.path)).toEqual(['docs/a.md']);
  });

  it('rethrows non-network errors', async () => {
    await expect(listDirOffline(forbidden, repo, 'docs', 'trunk')).rejects.toMatchObject({ status: 403 });
  });

  it('rethrows when the repo is not kept', async () => {
    await expect(listDirOffline(offline, 'bob/other', '', 'main')).rejects.toMatchObject({ status: NETWORK_ERROR_STATUS });
    await expect(repoOffline(offline, 'bob/other')).rejects.toBeInstanceOf(GitHubError);
  });

  it('builds the repo from the kept copy offline', async () => {
    await expect(repoOffline(offline, repo)).resolves.toMatchObject({ full_name: repo, default_branch: 'trunk' });
  });

  it('reads a kept file when nothing newer is cached', async () => {
    await expect(readFileOffline(repo, 'docs/a.md', null)).resolves.toEqual({ sha: 'a1', text: 'hello' });
    await expect(readFileOffline(repo, 'docs/a.md', { sha: 'c1', text: 'cached' })).resolves.toEqual({ sha: 'c1', text: 'cached' });
    await expect(readFileOffline('bob/other', 'x.md', null)).resolves.toBeNull();
  });
});
