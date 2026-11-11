import { formatBytes, offlineStatus } from '../src/lib/offlineStatus';
import type { KeptRepo } from '../src/lib/offlineRepos';

const base: KeptRepo = { fullName: 'alice/notes', defaultBranch: 'main', fileCount: 340, bytes: 4_200_000, pending: 0 };
const now = new Date('2026-11-11T12:00:00Z');

describe('offline status', () => {
  it('shows download progress while syncing', () => {
    expect(offlineStatus({ ...base, syncing: true, pending: 220, fileCount: 0 }, now)).toBe('Downloading files, 220 left');
  });

  it('shows the error when the last sync failed', () => {
    expect(offlineStatus({ ...base, error: 'Not Found', syncedAt: '2026-11-11T11:00:00Z' }, now)).toBe('Not Found');
  });

  it('shows how long ago the copy was updated', () => {
    expect(offlineStatus({ ...base, syncedAt: '2026-11-11T11:48:00Z' }, now)).toBe('Offline copy updated 12 min ago');
    expect(offlineStatus({ ...base, syncedAt: '2026-11-11T11:59:40Z' }, now)).toBe('Offline copy updated just now');
    expect(offlineStatus({ ...base, syncedAt: '2026-11-11T09:00:00Z' }, now)).toBe('Offline copy updated 3 h ago');
    expect(offlineStatus({ ...base, syncedAt: '2026-11-09T12:00:00Z' }, now)).toBe('Offline copy updated 2 days ago');
  });

  it('waits for the first download', () => {
    expect(offlineStatus(base, now)).toBe('Waiting to download');
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4_200_000)).toBe('4.2 MB');
    expect(formatBytes(12_300)).toBe('12.3 KB');
  });
});
