import { encodeBase64 } from '../src/lib/base64';
import { GitHub } from '../src/lib/github';
import { clearLocalFiles, getDraft, saveDraft, writeDraft } from '../src/lib/localFiles';
import { keepRepo, readKeptFile, saveBlob, saveKeptTree } from '../src/lib/offlineRepos';
import { clearOpenFile, flushOutbox, setOpenFile, startOutbox, stopOutbox, subscribeOutbox } from '../src/lib/outbox';

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

const queued = {
  repoFullName: 'alice/notes',
  path: 'a.md',
  defaultBranch: 'main',
  text: 'hello',
  baseSha: 'old',
  queued: { mode: 'direct' as const, message: 'docs: a' },
};

describe('outbox', () => {
  beforeEach(async () => {
    startOutbox();
    clearOpenFile();
    await clearLocalFiles();
    await writeDraft(queued);
  });

  it('sends a queued commit and removes the draft', async () => {
    const onSent = jest.fn();
    await flushOutbox(new GitHub('t', jest.fn().mockResolvedValue(respond({ content: { sha: 'new' } }))), onSent);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(await getDraft('alice/notes', 'a.md')).toBeNull();
  });

  it('a sent commit updates the kept copy', async () => {
    await keepRepo('alice/notes', 'main');
    await saveKeptTree('alice/notes', [{ path: 'a.md', type: 'blob', sha: 'old', size: 3 }]);
    await flushOutbox(new GitHub('t', jest.fn().mockResolvedValue(respond({ content: { sha: 'new' } }))), jest.fn());
    await expect(readKeptFile('alice/notes', 'a.md')).resolves.toEqual({ sha: 'new', text: 'hello' });
  });

  it('a queued commit from a kept blob that changed on GitHub stays Not sent', async () => {
    await keepRepo('alice/notes', 'main');
    await saveKeptTree('alice/notes', [{ path: 'a.md', type: 'blob', sha: 'old', size: 3 }]);
    await saveBlob('alice/notes', 'old', 'abc');
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(respond({ message: 'does not match' }, 409))
      .mockResolvedValueOnce(respond({ path: 'a.md', sha: 'theirs', encoding: 'base64', content: encodeBase64('theirs') }));
    await flushOutbox(new GitHub('t', fetcher), jest.fn());
    expect((await getDraft('alice/notes', 'a.md'))?.sendError).toBe('does not match');
    await expect(readKeptFile('alice/notes', 'a.md')).resolves.toEqual({ sha: 'old', text: 'abc' });
  });

  it('stays queued on a network failure', async () => {
    const onSent = jest.fn();
    await flushOutbox(new GitHub('t', jest.fn().mockRejectedValue(new TypeError('offline'))), onSent);
    expect(onSent).not.toHaveBeenCalled();
    expect((await getDraft('alice/notes', 'a.md'))?.queued).toBeDefined();
  });

  it('keeps the text and flags the draft on a conflict', async () => {
    await flushOutbox(new GitHub('t', jest.fn().mockResolvedValue(respond({ message: 'does not match' }, 409))), jest.fn());
    const draft = await getDraft('alice/notes', 'a.md');
    expect(draft?.text).toBe('hello');
    expect(draft?.queued).toBeUndefined();
    expect(draft?.sendError).toBe('does not match');
  });

  it('treats a conflict as sent when GitHub already has this text', async () => {
    const onSent = jest.fn();
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(respond({ message: 'does not match' }, 409))
      .mockResolvedValueOnce(respond({ path: 'a.md', sha: 'new', encoding: 'base64', content: encodeBase64('hello') }));
    await flushOutbox(new GitHub('t', fetcher), onSent);
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(await getDraft('alice/notes', 'a.md')).toBeNull();
  });

  it('sends the oldest queued commit first', async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 2));
    await writeDraft({ ...queued, path: 'b.md' });
    const fetcher = jest.fn().mockImplementation(() => Promise.resolve(respond({ content: { sha: 'new' } })));
    await flushOutbox(new GitHub('t', fetcher), jest.fn());
    expect((fetcher.mock.calls[0] as [string])[0]).toContain('/contents/a.md');
  });

  it('asks for another run when a request arrives during one that stops early', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeOutbox(listener);
    const github: GitHub = new GitHub('t', jest.fn(() => {
      stopOutbox();
      startOutbox();
      void flushOutbox(github, jest.fn());
      return Promise.resolve(respond({ content: { sha: 'new' } }));
    }));
    await flushOutbox(github, jest.fn());
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not restart after sign out, even with a request pending', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeOutbox(listener);
    await writeDraft({ ...queued, path: 'b.md' });
    const fetcher = jest.fn(() => {
      void flushOutbox(github, jest.fn());
      stopOutbox();
      return Promise.resolve(respond({ content: { sha: 'new' } }));
    });
    const github: GitHub = new GitHub('t', fetcher);
    await flushOutbox(github, jest.fn());
    await flushOutbox(github, jest.fn());
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('leaves a file alone while it is open', async () => {
    const fetcher = jest.fn();
    setOpenFile('alice/notes', 'a.md');
    await flushOutbox(new GitHub('t', fetcher), jest.fn());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('keeps newer text that arrives while a commit is sending', async () => {
    const fetcher = jest.fn(async () => {
      await saveDraft({ repoFullName: 'alice/notes', path: 'a.md', defaultBranch: 'main', text: 'newer', baseSha: 'old' });
      return respond({ content: { sha: 'new' } });
    });
    await flushOutbox(new GitHub('t', fetcher), jest.fn());
    const draft = await getDraft('alice/notes', 'a.md');
    expect(draft?.text).toBe('newer');
    expect(draft?.baseSha).toBe('new');
  });

  it('stops sending after sign out', async () => {
    await writeDraft({ ...queued, path: 'b.md' });
    const fetcher = jest.fn(() => {
      stopOutbox();
      return Promise.resolve(respond({ content: { sha: 'new' } }));
    });
    await flushOutbox(new GitHub('t', fetcher), jest.fn());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the queued commit when the draft is edited', async () => {
    await saveDraft({ repoFullName: 'alice/notes', path: 'a.md', defaultBranch: 'main', text: 'newer', baseSha: 'old' });
    const draft = await getDraft('alice/notes', 'a.md');
    expect(draft?.text).toBe('newer');
    expect(draft?.queued?.message).toBe('docs: a');
  });
});
