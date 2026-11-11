import BackgroundFetch from 'react-native-background-fetch';
import * as Keychain from 'react-native-keychain';
import { KEYCHAIN_SERVICE } from '../config';
import { GitHub } from './github';
import { listKeptRepos } from './offlineRepos';
import { syncAll } from './offlineSync';

const timedOut = new Set<string>();
const finished = new Set<string>();

function finish(taskId: string): void {
  if (finished.has(taskId)) return;
  finished.add(taskId);
  BackgroundFetch.finish(taskId);
}

async function runTask(taskId: string): Promise<void> {
  finished.delete(taskId);
  timedOut.delete(taskId);
  try {
    const creds = await Keychain.getGenericPassword({ service: KEYCHAIN_SERVICE });
    if (!creds || !(await listKeptRepos()).length) return;
    await syncAll(new GitHub(creds.password), () => timedOut.has(taskId));
  } catch (e: unknown) {
    console.error('Background sync failed', e);
  } finally {
    finish(taskId);
  }
}

function onTimeout(taskId: string): void {
  timedOut.add(taskId);
  finish(taskId);
}

export async function headlessTask(event: { taskId: string; timeout: boolean }): Promise<void> {
  if (event.timeout) {
    onTimeout(event.taskId);
    return;
  }
  await runTask(event.taskId);
}

export async function setBackgroundSync(enabled: boolean): Promise<void> {
  if (!enabled) {
    await BackgroundFetch.stop();
    return;
  }
  await BackgroundFetch.configure(
    {
      minimumFetchInterval: 60,
      requiredNetworkType: BackgroundFetch.NETWORK_TYPE_UNMETERED,
      stopOnTerminate: false,
      startOnBoot: true,
      enableHeadless: true,
    },
    taskId => void runTask(taskId),
    onTimeout,
  );
}

export async function ensureBackgroundSync(): Promise<void> {
  await setBackgroundSync((await listKeptRepos()).length > 0);
}
