import { ensureBackgroundSync } from './backgroundSync';
import { GitHub } from './github';
import { keepRepo, unkeepRepo } from './offlineRepos';
import { syncRepo } from './offlineSync';

export function refreshOffline(github: GitHub, fullName: string): void {
  syncRepo(github, fullName).catch((e: unknown) => console.error(`Could not refresh ${fullName}`, e));
}

export async function turnOnOffline(github: GitHub, fullName: string, defaultBranch: string): Promise<void> {
  await keepRepo(fullName, defaultBranch);
  await ensureBackgroundSync();
  refreshOffline(github, fullName);
}

export async function turnOffOffline(fullName: string): Promise<void> {
  await unkeepRepo(fullName);
  await ensureBackgroundSync();
}
