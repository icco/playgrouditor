import { decodeUtf8Strict, encodeBase64 } from '../src/lib/base64';
import { Entry, GitHub, GitHubError, NETWORK_ERROR_STATUS, Repo, isConflict, isEditable, isTransient, newFilePath, sortEntries } from '../src/lib/github';
import { cacheFile, clearLocalFiles, deleteDraft, getCachedFile, getDraft, listDrafts, saveDraft } from '../src/lib/localFiles';

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

function respond(body: unknown, status = 200): Response {
  return { ok: status < 400, status, statusText: 'status', json: () => Promise.resolve(body) } as Response;
}

const repo = { full_name: 'alice/notes', default_branch: 'main' } as Repo;

describe('GitHub requests', () => {
  it('reports a network failure as a transient GitHubError', async () => {
    const fetcher = jest.fn().mockRejectedValue(new TypeError('Network request failed'));
    const error: unknown = await new GitHub('t', fetcher).user().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(NETWORK_ERROR_STATUS);
    expect(isTransient(error)).toBe(true);
  });

  it('aborts a request that never answers', async () => {
    jest.useFakeTimers();
    const fetcher = jest.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    const pending = new GitHub('t', fetcher as unknown as typeof fetch).user().catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(((await pending) as GitHubError).message).toContain('too long');
    jest.useRealTimers();
  });

  it('reports a body that fails mid-read as a network error', async () => {
    const res = { ok: true, status: 200, json: () => Promise.reject(new Error('connection lost')) } as unknown as Response;
    const error: unknown = await new GitHub('t', jest.fn().mockResolvedValue(res)).user().catch((e: unknown) => e);
    expect((error as GitHubError).status).toBe(NETWORK_ERROR_STATUS);
  });

  it('calls onUnauthorized on a 401', async () => {
    const gh = new GitHub('t', jest.fn().mockResolvedValue(respond({ message: 'Bad credentials' }, 401)));
    gh.onUnauthorized = jest.fn();
    await expect(gh.user()).rejects.toThrow('Bad credentials');
    expect(gh.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('refuses a file that is not valid UTF-8', async () => {
    const fetcher = jest.fn().mockResolvedValue(respond({ path: 'a.txt', sha: '1', encoding: 'base64', content: '/+7/' }));
    await expect(new GitHub('t', fetcher).read('alice/notes', 'a.txt', 'main')).rejects.toThrow('UTF-8');
  });

  it('removes the new branch when the commit fails', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(respond({ object: { sha: 'base' } }))
      .mockResolvedValueOnce(respond({}))
      .mockResolvedValueOnce(respond({ message: 'conflict' }, 409))
      .mockResolvedValueOnce(respond({}));
    const commit = new GitHub('t', fetcher).commit({ repo, path: 'a.md', text: 'x', sha: 's', message: 'm', mode: 'pr' });
    await expect(commit).rejects.toThrow('conflict');
    const [url, init] = fetcher.mock.calls[3] as [string, RequestInit];
    expect(init.method).toBe('DELETE');
    expect(url).toContain('/git/refs/heads/playgrounditor/a-');
  });

  it('keeps a branch with slashes as path segments', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(respond({ object: { sha: 'base' } }))
      .mockResolvedValueOnce(respond({}))
      .mockResolvedValueOnce(respond({ content: { sha: 'new' } }))
      .mockResolvedValueOnce(respond({ html_url: 'https://github.com/alice/notes/pull/1' }));
    const release = { ...repo, default_branch: 'release/1' };
    const result = await new GitHub('t', fetcher).commit({ repo: release, path: 'a.md', text: 'x', message: 'm', mode: 'pr' });
    expect((fetcher.mock.calls[0] as [string])[0]).toContain('/git/ref/heads/release/1');
    expect(result.prUrl).toContain('/pull/1');
  });
});

describe('modified dates', () => {
  function historyResponse(init: RequestInit): Response {
    const { variables } = JSON.parse(init.body as string) as { variables: Record<string, string> };
    const object = Object.fromEntries(
      Object.entries(variables)
        .filter(([key]) => /^p\d+$/.test(key))
        .map(([key, path]) => [`f${key.slice(1)}`, { nodes: [{ committedDate: `date-${path}` }] }]),
    );
    return respond({ data: { repository: { object } } });
  }

  it('dates every path in a large folder, a few batches at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetcher = jest.fn(async (_url: string, init: RequestInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return historyResponse(init);
    });
    const paths = Array.from({ length: 450 }, (_, i) => `f${i}.md`);
    const dates = await new GitHub('t', fetcher as unknown as typeof fetch).modifiedDates('alice/notes', paths, 'main');
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(peak).toBe(4);
    expect(Object.keys(dates)).toHaveLength(450);
    expect(dates['f449.md']).toBe('date-f449.md');
  });

  it('omits paths with no history', async () => {
    const fetcher = jest.fn().mockResolvedValue(respond({ data: { repository: { object: { f0: { nodes: [] } } } } }));
    await expect(new GitHub('t', fetcher).modifiedDates('alice/notes', ['a.md'], 'main')).resolves.toEqual({});
  });

  it('surfaces errors from a successful GraphQL response', async () => {
    const fetcher = jest.fn().mockResolvedValue(respond({ errors: [{ message: 'API rate limit exceeded' }] }));
    const failure = await new GitHub('t', fetcher).modifiedDates('alice/notes', ['a.md'], 'main').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(GitHubError);
    expect(isTransient(failure)).toBe(true);
  });
});

describe('transient errors', () => {
  it('retries rate limits but not other refusals', () => {
    expect(isTransient(new GitHubError('Too many requests', 429))).toBe(true);
    expect(isTransient(new GitHubError('API rate limit exceeded', 403))).toBe(true);
    expect(isTransient(new GitHubError('Resource not accessible', 403))).toBe(false);
  });
});

describe('sorting', () => {
  it('orders files and submodules by name, whatever the input order', () => {
    const entry = (name: string, type: Entry['type']) => ({ name, path: name, type, sha: name });
    const a = entry('a', 'submodule');
    const b = entry('b', 'file');
    expect(sortEntries([a, b]).map(e => e.name)).toEqual(['a', 'b']);
    expect(sortEntries([b, a]).map(e => e.name)).toEqual(['a', 'b']);
  });
});

describe('conflict detection', () => {
  it('treats 409 and a missing sha on an existing file as conflicts', () => {
    expect(isConflict(new GitHubError('does not match', 409), true)).toBe(true);
    expect(isConflict(new GitHubError('"sha" wasn\'t supplied', 422), false)).toBe(true);
    expect(isConflict(new GitHubError('Validation Failed', 422), true)).toBe(false);
  });
});

describe('strict UTF-8 decoding', () => {
  it('round-trips unicode and tolerates GitHub line breaks', () => {
    const encoded = encodeBase64('Ada Lovelace 🚀 — notes\r\n');
    expect(decodeUtf8Strict(`${encoded.slice(0, 8)}\n${encoded.slice(8)}\n`)).toBe('Ada Lovelace 🚀 — notes\r\n');
  });
});

describe('file names', () => {
  it('builds paths and rejects traversal', () => {
    expect(newFilePath('', 'post')).toBe('post.md');
    expect(newFilePath('posts', 'a.txt')).toBe('posts/a.txt');
    expect(newFilePath('', '../secret')).toBeNull();
    expect(newFilePath('', ' ')).toBeNull();
    expect(newFilePath('', '/abs')).toBeNull();
  });

  it('allows every language the editor highlights', () => {
    expect(isEditable('main.rs')).toBe(true);
    expect(isEditable('photo.png')).toBe(false);
  });
});

describe('local files', () => {
  beforeEach(() => clearLocalFiles());

  it('stores, lists and deletes drafts', async () => {
    await saveDraft({ repoFullName: 'alice/notes', path: 'a.md', defaultBranch: 'main', text: 'hello', baseSha: '1' });
    expect((await getDraft('alice/notes', 'a.md'))?.text).toBe('hello');
    expect(await listDrafts()).toHaveLength(1);
    await deleteDraft('alice/notes', 'a.md');
    expect(await getDraft('alice/notes', 'a.md')).toBeNull();
  });

  it('evicts the oldest cached file past the limit', async () => {
    for (let i = 0; i < 31; i++) {
      await cacheFile('alice/notes', `f${i}.md`, { sha: String(i), text: 'x' });
    }
    expect(await getCachedFile('alice/notes', 'f0.md')).toBeNull();
    expect(await getCachedFile('alice/notes', 'f30.md')).not.toBeNull();
  });

  it('clears everything on sign out', async () => {
    await cacheFile('alice/notes', 'a.md', { sha: '1', text: 'x' });
    await saveDraft({ repoFullName: 'alice/notes', path: 'b.md', defaultBranch: 'main', text: 'y' });
    await clearLocalFiles();
    expect(await getCachedFile('alice/notes', 'a.md')).toBeNull();
    expect(await listDrafts()).toHaveLength(0);
  });
});
