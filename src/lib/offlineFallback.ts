import { Entry, GitHub, GitHubError, NETWORK_ERROR_STATUS, Repo } from './github';
import { CachedFile, cacheFile } from './localFiles';
import {
  getKeptDates,
  getKeptModified,
  getKeptRepo,
  listKeptDir,
  readKeptFile,
  recordCommittedFile,
  saveKeptModified,
  whileKept,
} from './offlineRepos';

function isNetworkError(e: unknown): boolean {
  return e instanceof GitHubError && e.status === NETWORK_ERROR_STATUS;
}

export async function listDirOffline(github: GitHub, fullName: string, path: string, ref: string): Promise<Entry[]> {
  try {
    return await github.list(fullName, path, ref);
  } catch (e: unknown) {
    if (!isNetworkError(e)) throw e;
    const kept = await listKeptDir(fullName, path);
    if (!kept) throw e;
    return kept;
  }
}

// Kept repos answer only from stored dates, so sorting never waits on GitHub; refreshKeptDates fills gaps.
export async function modifiedDatesOffline(github: GitHub, fullName: string, paths: string[], ref: string): Promise<Record<string, string>> {
  if (!(await getKeptRepo(fullName))) return github.modifiedDates(fullName, paths, ref);
  const kept = await getKeptModified(fullName);
  return Object.fromEntries(paths.filter(p => kept[p]).map(p => [p, kept[p]]));
}

export async function refreshKeptDates(github: GitHub, fullName: string, entries: Entry[], ref: string): Promise<Record<string, string>> {
  const known = await getKeptDates(fullName);
  const stale = entries.filter(e => known[e.path]?.sha !== e.sha);
  if (!stale.length) return {};
  let fresh: Record<string, string>;
  try {
    fresh = await github.modifiedDates(fullName, stale.map(e => e.path), ref);
  } catch (e: unknown) {
    if (!isNetworkError(e)) throw e;
    return {};
  }
  await whileKept(fullName, async () => {
    const updates = Object.fromEntries(stale.filter(e => fresh[e.path]).map(e => [e.path, { sha: e.sha, date: fresh[e.path] }]));
    await saveKeptModified(fullName, { ...(await getKeptDates(fullName)), ...updates });
  });
  return fresh;
}

export async function repoOffline(github: GitHub, fullName: string): Promise<Repo> {
  try {
    return await github.repo(fullName);
  } catch (e: unknown) {
    if (!isNetworkError(e)) throw e;
    const kept = await getKeptRepo(fullName);
    if (!kept) throw e;
    const [owner, name] = fullName.split('/');
    return {
      full_name: fullName,
      name,
      owner: { login: owner },
      default_branch: kept.defaultBranch,
      private: false,
      description: null,
      pushed_at: '',
    };
  }
}

// Keeps both local copies on the version GitHub just returned, so neither goes stale behind the other.
export async function rememberFile(fullName: string, path: string, file: CachedFile): Promise<void> {
  await Promise.all([cacheFile(fullName, path, file), recordCommittedFile(fullName, path, file)]);
}

// Reads and commits update the kept copy too, so for a kept repo it is never older than the recent-file cache.
export async function readFileOffline(fullName: string, path: string, cached: CachedFile | null): Promise<CachedFile | null> {
  try {
    return (await readKeptFile(fullName, path)) ?? cached;
  } catch (e: unknown) {
    if (cached) return cached;
    throw e;
  }
}
