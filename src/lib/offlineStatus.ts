import type { KeptRepo } from './offlineRepos';

function ago(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function offlineStatus(repo: KeptRepo, now: Date = new Date()): string {
  if (repo.syncing && repo.pending > 0) return `Downloading files, ${repo.pending} left`;
  if (repo.error) return repo.error;
  if (repo.syncedAt) return `Offline copy updated ${ago(repo.syncedAt, now)}`;
  return 'Waiting to download';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
