import { Entry, GitHub, GitHubError, NETWORK_ERROR_STATUS, Repo } from './github';
import type { CachedFile } from './localFiles';
import { getKeptRepo, listKeptDir, readKeptFile } from './offlineRepos';

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

export async function readFileOffline(fullName: string, path: string, cached: CachedFile | null): Promise<CachedFile | null> {
  return cached ?? readKeptFile(fullName, path);
}
