import AsyncStorage from '@react-native-async-storage/async-storage';
import { GitHub, GitHubError, TreeEntry } from '../src/lib/github';
import { clearLocalFiles } from '../src/lib/localFiles';
import { getKeptModified, getKeptRepo, getKeptTree, hasBlob, keepRepo, readKeptFile, saveBlob, saveKeptTree, unkeepRepo } from '../src/lib/offlineRepos';
import { syncAll, syncRepo } from '../src/lib/offlineSync';

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

function blobs(n: number): TreeEntry[] {
  return Array.from({ length: n }, (_, i) => ({ path: `p${i}.md`, type: 'blob' as const, sha: `s${i}`, size: 2 }));
}

function fakeGitHub(entries: TreeEntry[], opts: { truncated?: boolean; texts?: Record<string, string | null> } = {}) {
  const gh = {
    rateLimitRemaining: null as number | null,
    repo: jest.fn<Promise<{ full_name: string; default_branch: string }>, [string]>().mockResolvedValue({ full_name: repo, default_branch: 'main' }),
    tree: jest.fn<Promise<{ sha: string; truncated: boolean; entries: TreeEntry[] }>, [string, string]>().mockResolvedValue({ sha: 'tree1', truncated: opts.truncated ?? false, entries }),
    blob: jest.fn<Promise<string | null>, [string, string]>((_: string, sha: string) =>
      Promise.resolve(opts.texts && sha in opts.texts ? opts.texts[sha] : `t-${sha}`),
    ),
    modifiedDates: jest.fn<Promise<Record<string, string>>, [string, string[], string]>((_: string, paths: string[]) =>
      Promise.resolve(Object.fromEntries(paths.map(p => [p, `date-${p}`]))),
    ),
  };
  return gh;
}

describe('offline sync', () => {
  beforeEach(async () => {
    await clearLocalFiles();
    await keepRepo(repo, 'main');
  });

  it('fetches only blobs it does not have', async () => {
    await saveBlob(repo, 's0', 't-s0');
    const gh = fakeGitHub(blobs(3));
    await syncRepo(gh as unknown as GitHub, repo);
    expect(gh.blob.mock.calls.map(c => c[1])).toEqual(['s1', 's2']);
    const kept = await getKeptRepo(repo);
    expect(kept).toMatchObject({ treeSha: 'tree1', fileCount: 3, bytes: 6, pending: 0, syncing: false });
    expect(kept?.syncedAt).toBeDefined();
    await expect(readKeptFile(repo, 'p2.md')).resolves.toEqual({ sha: 's2', text: 't-s2' });
  });

  it('dates only paths whose sha changed since the last sync', async () => {
    const gh = fakeGitHub(blobs(3));
    await syncRepo(gh as unknown as GitHub, repo);
    expect(gh.modifiedDates.mock.calls[0][1]).toEqual(['p0.md', 'p1.md', 'p2.md']);
    const changed = [...blobs(2), { path: 'p2.md', type: 'blob' as const, sha: 's2b', size: 2 }];
    gh.tree.mockResolvedValue({ sha: 'tree2', truncated: false, entries: changed });
    gh.modifiedDates.mockResolvedValueOnce({ 'p2.md': 'newer' });
    await syncRepo(gh as unknown as GitHub, repo);
    expect(gh.modifiedDates.mock.calls[1][1]).toEqual(['p2.md']);
    await expect(getKeptModified(repo)).resolves.toEqual({ 'p0.md': 'date-p0.md', 'p1.md': 'date-p1.md', 'p2.md': 'newer' });
  });

  it('skips binaries, large files and non-UTF-8', async () => {
    const gh = fakeGitHub(
      [
        { path: 'img.png', type: 'blob', sha: 'png', size: 10 },
        { path: 'big.md', type: 'blob', sha: 'big', size: 1_000_001 },
        { path: 'latin1.txt', type: 'blob', sha: 'bad', size: 4 },
        { path: 'ok.md', type: 'blob', sha: 'ok', size: 2 },
      ],
      { texts: { bad: null } },
    );
    await syncRepo(gh as unknown as GitHub, repo);
    expect(gh.blob.mock.calls.map(c => c[1])).toEqual(['bad', 'ok']);
    expect(await getKeptRepo(repo)).toMatchObject({ fileCount: 1, pending: 0, treeSha: 'tree1' });
  });

  it('fetches each sha once when paths share content', async () => {
    const gh = fakeGitHub([
      { path: 'a.md', type: 'blob', sha: 'same', size: 2 },
      { path: 'b.md', type: 'blob', sha: 'same', size: 2 },
      { path: 'c.md', type: 'blob', sha: 'other', size: 2 },
    ]);
    await syncRepo(gh as unknown as GitHub, repo);
    expect(gh.blob.mock.calls.map(c => c[1])).toEqual(['same', 'other']);
    expect(await getKeptRepo(repo)).toMatchObject({ fileCount: 3 });
    await expect(readKeptFile(repo, 'b.md')).resolves.toEqual({ sha: 'same', text: 't-same' });
  });

  it('remembers non-UTF-8 blobs across runs', async () => {
    const gh = fakeGitHub([{ path: 'latin1.txt', type: 'blob', sha: 'bad', size: 4 }], { texts: { bad: null } });
    await syncRepo(gh as unknown as GitHub, repo);
    await syncRepo(gh as unknown as GitHub, repo);
    expect(gh.blob).toHaveBeenCalledTimes(1);
    await expect(readKeptFile(repo, 'latin1.txt')).rejects.toThrow('This file is not stored offline.');
  });

  it('skips symlinks', async () => {
    const gh = fakeGitHub([{ path: 'link.md', type: 'blob', sha: 'l1', size: 6, mode: '120000' }]);
    await syncRepo(gh as unknown as GitHub, repo);
    expect(gh.blob).not.toHaveBeenCalled();
    expect(await getKeptRepo(repo)).toMatchObject({ fileCount: 0, treeSha: 'tree1' });
  });

  it('does not publish a new tree once stopped, even with nothing to download', async () => {
    const old: TreeEntry[] = [{ path: 'old.md', type: 'blob', sha: 'o1', size: 2 }];
    await saveKeptTree(repo, old);
    await saveBlob(repo, 'o1', 'old');
    await saveBlob(repo, 's0', 't-s0');
    let stop = false;
    const gh = fakeGitHub(blobs(1));
    gh.tree.mockImplementation(() => {
      stop = true;
      return Promise.resolve({ sha: 'tree1', truncated: false, entries: blobs(1) });
    });
    await syncRepo(gh as unknown as GitHub, repo, () => stop);
    await expect(getKeptTree(repo)).resolves.toEqual(old);
  });

  it('records too large for a truncated tree', async () => {
    const gh = fakeGitHub(blobs(2), { truncated: true });
    await syncRepo(gh as unknown as GitHub, repo);
    expect(gh.blob).not.toHaveBeenCalled();
    expect((await getKeptRepo(repo))?.error).toBe('This repo is too large to keep offline.');
  });

  it('resumes after shouldStop without refetching', async () => {
    const gh = fakeGitHub(blobs(6));
    let batches = 0;
    await syncRepo(gh as unknown as GitHub, repo, () => batches++ >= 1);
    expect(gh.blob).toHaveBeenCalledTimes(4);
    expect(await getKeptRepo(repo)).toMatchObject({ pending: 2 });
    await syncRepo(gh as unknown as GitHub, repo);
    expect(gh.blob).toHaveBeenCalledTimes(6);
    expect(await getKeptRepo(repo)).toMatchObject({ pending: 0, fileCount: 6 });
  });

  it('keeps the old tree when stopped early', async () => {
    const old: TreeEntry[] = [{ path: 'old.md', type: 'blob', sha: 'o1', size: 2 }];
    await saveKeptTree(repo, old);
    await saveBlob(repo, 'o1', 'old');
    await syncRepo(fakeGitHub(blobs(6)) as unknown as GitHub, repo, () => true);
    await expect(getKeptTree(repo)).resolves.toEqual(old);
    await expect(hasBlob(repo, 'o1')).resolves.toBe(true);
  });

  it('stops below the rate limit floor', async () => {
    const gh = fakeGitHub(blobs(6));
    gh.blob.mockImplementation((_: string, sha: string) => {
      gh.rateLimitRemaining = 499;
      return Promise.resolve(`t-${sha}`);
    });
    await syncRepo(gh as unknown as GitHub, repo);
    expect(gh.blob).toHaveBeenCalledTimes(4);
    expect(await getKeptRepo(repo)).toMatchObject({ pending: 2, error: "Paused until GitHub's rate limit resets." });
  });

  it('records a 404 and keeps the old copy', async () => {
    const old: TreeEntry[] = [{ path: 'old.md', type: 'blob', sha: 'o1', size: 2 }];
    await saveKeptTree(repo, old);
    const gh = fakeGitHub([]);
    gh.tree.mockRejectedValue(new GitHubError('Not Found', 404));
    await syncRepo(gh as unknown as GitHub, repo);
    expect(await getKeptRepo(repo)).toMatchObject({ error: 'Not Found', syncing: false });
    await expect(getKeptTree(repo)).resolves.toEqual(old);
  });

  it('does not write after the repo is unkept mid-sync', async () => {
    const gh = fakeGitHub(blobs(6));
    gh.blob.mockImplementation(async (_: string, sha: string) => {
      await unkeepRepo(repo);
      return `t-${sha}`;
    });
    await syncRepo(gh as unknown as GitHub, repo);
    expect((await AsyncStorage.getAllKeys()).filter(k => /offline:(tree|blob):/.test(k))).toEqual([]);
    await expect(getKeptRepo(repo)).resolves.toBeNull();
  });

  it('does not write after clearLocalFiles mid-sync', async () => {
    const gh = fakeGitHub(blobs(2));
    gh.blob.mockImplementation(async (_: string, sha: string) => {
      await clearLocalFiles();
      return `t-${sha}`;
    });
    await syncRepo(gh as unknown as GitHub, repo);
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });

  it('joins a running sync for the same repo', async () => {
    const gh = fakeGitHub(blobs(2));
    await Promise.all([syncRepo(gh as unknown as GitHub, repo), syncRepo(gh as unknown as GitHub, repo)]);
    expect(gh.tree).toHaveBeenCalledTimes(1);
  });

  it('syncs every kept repo', async () => {
    await keepRepo('alice/blog', 'main');
    const gh = fakeGitHub(blobs(1));
    await syncAll(gh as unknown as GitHub);
    expect(gh.tree.mock.calls.map(c => c[0])).toEqual([repo, 'alice/blog']);
  });
});
