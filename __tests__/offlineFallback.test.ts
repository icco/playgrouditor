import { GitHub, GitHubError, NETWORK_ERROR_STATUS } from '../src/lib/github';
import { clearLocalFiles, getCachedFile } from '../src/lib/localFiles';
import { keepRepo, recordCommittedFile, saveBlob, saveKeptModified, saveKeptTree } from '../src/lib/offlineRepos';
import { listDirOffline, modifiedDatesOffline, readFileOffline, rememberFile, repoOffline } from '../src/lib/offlineFallback';

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

  it('prefers the kept copy over the recent-file cache', async () => {
    await expect(readFileOffline(repo, 'docs/a.md', null)).resolves.toEqual({ sha: 'a1', text: 'hello' });
    await expect(readFileOffline(repo, 'docs/a.md', { sha: 'c1', text: 'stale' })).resolves.toEqual({ sha: 'a1', text: 'hello' });
    await expect(readFileOffline('bob/other', 'x.md', { sha: 'c1', text: 'cached' })).resolves.toEqual({ sha: 'c1', text: 'cached' });
    await expect(readFileOffline('bob/other', 'x.md', null)).resolves.toBeNull();
  });

  it('opens the version last read online, not the older kept copy', async () => {
    await rememberFile(repo, 'docs/a.md', { sha: 'a2', text: 'newer' });
    const cached = await getCachedFile(repo, 'docs/a.md');
    await expect(readFileOffline(repo, 'docs/a.md', cached)).resolves.toEqual({ sha: 'a2', text: 'newer' });
  });

  it('falls back to the cache when the blob is not stored', async () => {
    await saveKeptTree(repo, [{ path: 'big.md', type: 'blob', sha: 'big', size: 2_000_000 }]);
    await expect(readFileOffline(repo, 'big.md', { sha: 'c1', text: 'cached' })).resolves.toEqual({ sha: 'c1', text: 'cached' });
    await expect(readFileOffline(repo, 'big.md', null)).rejects.toThrow('This file is not stored offline.');
  });

  it('dates a kept folder from the offline copy, fetching only paths it lacks', async () => {
    await saveKeptModified(repo, { docs: { sha: 't1', date: '2026-01-01T00:00:00Z' } });
    const gh = new GitHub('t');
    const fetched = jest.spyOn(gh, 'modifiedDates').mockResolvedValue({ 'docs/new.md': '2026-02-01T00:00:00Z' });
    const dates = await modifiedDatesOffline(gh, repo, ['docs', 'docs/new.md'], 'trunk');
    expect(fetched).toHaveBeenCalledWith(repo, ['docs/new.md'], 'trunk');
    expect(dates).toEqual({ docs: '2026-01-01T00:00:00Z', 'docs/new.md': '2026-02-01T00:00:00Z' });
  });

  it('returns kept dates offline', async () => {
    await saveKeptModified(repo, { docs: { sha: 't1', date: '2026-01-01T00:00:00Z' } });
    await expect(modifiedDatesOffline(offline, repo, ['docs', 'docs/a.md'], 'trunk')).resolves.toEqual({ docs: '2026-01-01T00:00:00Z' });
  });

  it('dates a committed file and its folders as now', async () => {
    await recordCommittedFile(repo, 'docs/a.md', { sha: 'a2', text: 'new' });
    const dates = await modifiedDatesOffline(offline, repo, ['docs', 'docs/a.md'], 'trunk');
    expect(Date.now() - new Date(dates['docs/a.md']).getTime()).toBeLessThan(60_000);
    expect(dates.docs).toBe(dates['docs/a.md']);
  });
});
