import { Entry, GitHub, sortEntries } from '../src/lib/github';
import { KeptDate, keepRepo, saveKeptModified } from '../src/lib/offlineRepos';
import { modifiedDatesOffline } from '../src/lib/offlineFallback';

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

const repo = 'alice/writing';
const POSTS = 729;
const BUDGET_MS = 1000;

it('sorts a kept folder of posts by modified in under a second, even with GitHub slow', async () => {
  await keepRepo(repo, 'main');
  const posts: Entry[] = Array.from({ length: POSTS }, (_, i) => ({ name: `post-${i}.md`, path: `posts/post-${i}.md`, type: 'file', sha: `s${i}` }));
  const stored: Record<string, KeptDate> = Object.fromEntries(
    posts.map((p, i) => [p.path, { sha: p.sha, date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString() }]),
  );
  await saveKeptModified(repo, stored);
  const entries = [...posts, { name: 'draft.md', path: 'posts/draft.md', type: 'file' as const, sha: 'new' }];
  const github = new GitHub('t');
  const slow = jest.spyOn(github, 'modifiedDates').mockImplementation(() => new Promise(() => undefined));

  const started = Date.now();
  const dates = await modifiedDatesOffline(github, repo, entries.map(e => e.path), 'main');
  const sorted = sortEntries(entries.map(e => ({ ...e, modified: dates[e.path] })), 'modified');
  const elapsed = Date.now() - started;

  expect(elapsed).toBeLessThan(BUDGET_MS);
  expect(slow).not.toHaveBeenCalled();
  expect(sorted[0].path).toBe(`posts/post-${POSTS - 1}.md`);
  expect(sorted).toHaveLength(POSTS + 1);
});
