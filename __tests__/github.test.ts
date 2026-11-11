import { Base64 } from 'js-base64';
import { encodeBase64 } from '../src/lib/base64';
import { GitHub, GitHubError, branchName, sortEntries, isMarkdown, formatDate } from '../src/lib/github';

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as Response;
}

describe('GitHub client', () => {
  it('follows repository pages until a short page', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(Array.from({ length: 100 }, (_, i) => ({ full_name: `alice/${i}` }))))
      .mockResolvedValueOnce(jsonResponse([{ full_name: 'alice/last' }]));
    const repos = await new GitHub('token', fetcher).repos();
    expect(repos).toHaveLength(101);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(expect.stringContaining('page=2'), expect.anything());
  });

  it('refuses files GitHub returns without base64 content', async () => {
    const fetcher = jest.fn().mockResolvedValue(jsonResponse({ path: 'big.md', sha: '1', content: '', encoding: 'none' }));
    await expect(new GitHub('token', fetcher).read('alice/repo', 'big.md', 'main')).rejects.toBeInstanceOf(GitHubError);
  });

  it('fetches a recursive tree', async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({ sha: 't1', truncated: false, tree: [{ path: 'a.md', type: 'blob', sha: 'b1', size: 3, mode: '100644' }] }),
    );
    const tree = await new GitHub('token', fetcher).tree('alice/notes', 'main');
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/repos/alice/notes/git/trees/main?recursive=1'), expect.anything());
    expect(tree).toEqual({ sha: 't1', truncated: false, entries: [{ path: 'a.md', type: 'blob', sha: 'b1', size: 3 }] });
  });

  it('decodes a blob and returns null for non-UTF-8', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ content: encodeBase64('hi ✍️'), encoding: 'base64' }))
      .mockResolvedValueOnce(jsonResponse({ content: Base64.fromUint8Array(new Uint8Array([0xff, 0xfe])), encoding: 'base64' }));
    const gh = new GitHub('token', fetcher);
    await expect(gh.blob('alice/notes', 'b1')).resolves.toBe('hi ✍️');
    await expect(gh.blob('alice/notes', 'b2')).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('/repos/alice/notes/git/blobs/b1'), expect.anything());
  });

  it('records the rate limit remaining', async () => {
    const withHeader = { ...jsonResponse({}), headers: new Headers({ 'x-ratelimit-remaining': '42' }) } as Response;
    const gh = new GitHub('token', jest.fn().mockResolvedValueOnce(withHeader).mockResolvedValueOnce(jsonResponse({})));
    expect(gh.rateLimitRemaining).toBeNull();
    await gh.user();
    expect(gh.rateLimitRemaining).toBe(42);
    await gh.user();
    expect(gh.rateLimitRemaining).toBe(42);
  });
});

describe('base64 UTF-8 encoding', () => {
  it('encodes and decodes normal ascii and unicode strings with emoji', () => {
    const text = 'Hello, world! 🚀 — #writing';
    const encoded = encodeBase64(text);
    const decoded = Base64.decode(encoded);
    expect(decoded).toBe(text);
  });
});

describe('github helper functions', () => {
  it('generates clean branch names', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    expect(branchName('posts/hello world.md', now)).toBe('playgrounditor/hello-world-202610291200');
  });

  it('identifies markdown files', () => {
    expect(isMarkdown('test.md')).toBe(true);
    expect(isMarkdown('test.MD')).toBe(true);
    expect(isMarkdown('test.txt')).toBe(false);
  });

  it('sorts entries with directories first', () => {
    const entries = [
      { name: 'b.md', path: 'b.md', type: 'file' as const, sha: '1' },
      { name: '.hidden', path: '.hidden', type: 'file' as const, sha: '2' },
      { name: 'a-dir', path: 'a-dir', type: 'dir' as const, sha: '3' },
      { name: 'a.md', path: 'a.md', type: 'file' as const, sha: '4' },
    ];
    const sorted = sortEntries(entries, 'name');
    expect(sorted.map(e => e.name)).toEqual(['a-dir', 'a.md', 'b.md']);
  });

  it('sorts entries by modified date descending', () => {
    const entries = [
      { name: 'older.md', path: 'older.md', type: 'file' as const, sha: '1', modified: '2026-10-01T10:00:00Z' },
      { name: 'newer.md', path: 'newer.md', type: 'file' as const, sha: '2', modified: '2026-10-30T10:00:00Z' },
      { name: 'no-date.md', path: 'no-date.md', type: 'file' as const, sha: '3' },
    ];
    const sorted = sortEntries(entries, 'modified');
    expect(sorted.map(e => e.name)).toEqual(['newer.md', 'older.md', 'no-date.md']);
  });

  it('formats dates cleanly', () => {
    expect(formatDate('2026-10-31T12:34:56Z')).toBeTruthy();
    expect(formatDate('')).toBe('');
  });
});
