import { GitHub, GitHubError, TreeEntry, isEditable } from './github';
import {
  deleteUnreferencedBlobs,
  getKeptRepo,
  hasBlob,
  listKeptRepos,
  saveBlob,
  saveKeptTree,
  updateKeptRepo,
} from './offlineRepos';

const MAX_FILE_BYTES = 1_000_000;
const BATCH_SIZE = 4;
const RATE_LIMIT_FLOOR = 500;

const running = new Map<string, Promise<void>>();

function wanted(entry: TreeEntry): boolean {
  const name = entry.path.split('/').pop() ?? '';
  return entry.type === 'blob' && isEditable(name) && (entry.size ?? 0) <= MAX_FILE_BYTES;
}

export function syncRepo(github: GitHub, fullName: string, shouldStop: () => boolean = () => false): Promise<void> {
  const existing = running.get(fullName);
  if (existing) return existing;
  const run = runSync(github, fullName, shouldStop).finally(() => running.delete(fullName));
  running.set(fullName, run);
  return run;
}

export async function syncAll(github: GitHub, shouldStop: () => boolean = () => false): Promise<void> {
  for (const repo of await listKeptRepos()) {
    if (shouldStop()) return;
    await syncRepo(github, repo.fullName, shouldStop);
  }
}

async function isKept(fullName: string): Promise<boolean> {
  return (await getKeptRepo(fullName)) !== null;
}

async function runSync(github: GitHub, fullName: string, shouldStop: () => boolean): Promise<void> {
  await updateKeptRepo(fullName, { syncing: true, error: undefined });
  try {
    const repo = await github.repo(fullName);
    const tree = await github.tree(fullName, repo.default_branch);
    if (tree.truncated) {
      await updateKeptRepo(fullName, { error: 'This repo is too large to keep offline.' });
      return;
    }
    const files = tree.entries.filter(wanted);
    const missing: TreeEntry[] = [];
    for (const f of files) if (!(await hasBlob(fullName, f.sha))) missing.push(f);
    const notText = new Set<string>();
    let pending = missing.length;
    await updateKeptRepo(fullName, { pending, defaultBranch: repo.default_branch });

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      if (shouldStop()) return;
      if (github.rateLimitRemaining !== null && github.rateLimitRemaining < RATE_LIMIT_FLOOR) {
        await updateKeptRepo(fullName, { error: "Paused until GitHub's rate limit resets." });
        return;
      }
      const batch = missing.slice(i, i + BATCH_SIZE);
      const texts = await Promise.all(batch.map(f => github.blob(fullName, f.sha)));
      if (!(await isKept(fullName))) return;
      await Promise.all(
        batch.map((f, j) => {
          const text = texts[j];
          if (text === null) {
            notText.add(f.sha);
            return Promise.resolve();
          }
          return saveBlob(fullName, f.sha, text);
        }),
      );
      pending -= batch.length;
      await updateKeptRepo(fullName, { pending });
    }

    if (!(await isKept(fullName))) return;
    const stored = files.filter(f => !notText.has(f.sha));
    await saveKeptTree(fullName, tree.entries);
    await deleteUnreferencedBlobs(fullName, new Set(stored.map(f => f.sha)));
    await updateKeptRepo(fullName, {
      treeSha: tree.sha,
      syncedAt: new Date().toISOString(),
      fileCount: stored.length,
      bytes: stored.reduce((sum, f) => sum + (f.size ?? 0), 0),
      pending: 0,
    });
  } catch (e: unknown) {
    await updateKeptRepo(fullName, { error: e instanceof Error ? e.message : 'Could not update the offline copy.' });
    if (!(e instanceof GitHubError)) throw e;
  } finally {
    await updateKeptRepo(fullName, { syncing: false });
  }
}
