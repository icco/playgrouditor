import * as Keychain from 'react-native-keychain';
import { clearLocalFiles } from '../src/lib/localFiles';
import { keepRepo } from '../src/lib/offlineRepos';
import { syncAll } from '../src/lib/offlineSync';
import { ensureBackgroundSync, headlessTask, setBackgroundSync } from '../src/lib/backgroundSync';

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

const mockConfigure = jest.fn<Promise<number>, unknown[]>().mockResolvedValue(2);
const mockStop = jest.fn<Promise<boolean>, []>().mockResolvedValue(true);
const mockFinish = jest.fn<void, [string]>();

jest.mock('react-native-background-fetch', () => ({
  __esModule: true,
  default: {
    NETWORK_TYPE_UNMETERED: 2,
    configure: (...args: unknown[]) => mockConfigure(...args),
    stop: () => mockStop(),
    finish: (id: string) => mockFinish(id),
  },
}));

jest.mock('react-native-keychain', () => ({ getGenericPassword: jest.fn() }));

jest.mock('../src/lib/offlineSync', () => ({ syncAll: jest.fn().mockResolvedValue(undefined) }));

const getPassword = Keychain.getGenericPassword as jest.Mock;
const sync = syncAll as jest.Mock;

describe('background sync', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await clearLocalFiles();
    getPassword.mockResolvedValue({ username: 'github', password: 'token' });
  });

  it('finishes at once with no token', async () => {
    await keepRepo('alice/notes', 'main');
    getPassword.mockResolvedValue(false);
    await headlessTask({ taskId: 't1', timeout: false });
    expect(sync).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledWith('t1');
  });

  it('finishes at once with no kept repos', async () => {
    await headlessTask({ taskId: 't1', timeout: false });
    expect(sync).not.toHaveBeenCalled();
    expect(mockFinish).toHaveBeenCalledWith('t1');
  });

  it('syncs and finishes with a token', async () => {
    await keepRepo('alice/notes', 'main');
    await headlessTask({ taskId: 't1', timeout: false });
    expect(sync).toHaveBeenCalledTimes(1);
    expect(mockFinish).toHaveBeenCalledTimes(1);
  });

  it('finishes on timeout and tells the running sync to stop', async () => {
    await keepRepo('alice/notes', 'main');
    let shouldStop: () => boolean = () => false;
    let release: () => void = () => {};
    sync.mockImplementationOnce((_gh: unknown, stop: () => boolean) => {
      shouldStop = stop;
      return new Promise<void>(r => {
        release = () => r();
      });
    });
    const run = headlessTask({ taskId: 't1', timeout: false });
    await new Promise<void>(r => {
      setImmediate(() => r());
    });
    await headlessTask({ taskId: 't1', timeout: true });
    expect(shouldStop()).toBe(true);
    expect(mockFinish).toHaveBeenCalledWith('t1');
    release();
    await run;
    expect(mockFinish).toHaveBeenCalledTimes(1);
  });

  it('enables only when a repo is kept', async () => {
    await ensureBackgroundSync();
    expect(mockConfigure).not.toHaveBeenCalled();
    expect(mockStop).toHaveBeenCalled();
    await keepRepo('alice/notes', 'main');
    await ensureBackgroundSync();
    expect(mockConfigure).toHaveBeenCalledWith(
      expect.objectContaining({
        minimumFetchInterval: 60,
        requiredNetworkType: 2,
        stopOnTerminate: false,
        startOnBoot: true,
        enableHeadless: true,
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('stops when disabled', async () => {
    await setBackgroundSync(false);
    expect(mockStop).toHaveBeenCalled();
  });
});
