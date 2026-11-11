import { GitHub, GitHubError, TreeEntry, isEditable } from './github';
import {
  deleteUnreferencedBlobs,
  getSkippedShas,
  hasBlob,
  isSymlink,
  listKeptRepos,
  saveBlob,
  saveKeptTree,
  saveSkippedShas,
  updateKeptRepo,
  whileKept,
} from './offlineRepos';

const MAX_FILE_BYTES = 1_000_000;
const BATCH_SIZE = 4;
const RATE_LIMIT_FLOOR = 500;

const running = new Map<string, Promise<void>>();

function wanted(entry: TreeEntry): boolean {
  const name = entry.path.split('/').pop() ?? '';
  return entry.type === 'blob' && !isSymlink(entry) && isEditable(name) && (entry.size ?? 0) <= MAX_FILE_BYTES;
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
    const skipped = await getSkippedShas(fullName);
    const missing: string[] = [];
    for (const sha of new Set(files.map(f => f.sha))) {
      if (!skipped.has(sha) && !(await hasBlob(fullName, sha))) missing.push(sha);
    }
    let pending = missing.length;
    await updateKeptRepo(fullName, { pending, defaultBranch: repo.default_branch });

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      if (shouldStop()) return;
      if (github.rateLimitRemaining !== null && github.rateLimitRemaining < RATE_LIMIT_FLOOR) {
        await updateKeptRepo(fullName, { error: "Paused until GitHub's rate limit resets." });
        return;
      }
      const batch = missing.slice(i, i + BATCH_SIZE);
      const texts = await Promise.all(batch.map(sha => github.blob(fullName, sha)));
      const kept = await whileKept(fullName, async () => {
        await Promise.all(
          batch.map((sha, j) => {
            const text = texts[j];
            if (text !== null) return saveBlob(fullName, sha, text);
            skipped.add(sha);
            return Promise.resolve();
          }),
        );
        await saveSkippedShas(fullName, skipped);
      });
      if (!kept) return;
      pending -= batch.length;
      await updateKeptRepo(fullName, { pending });
    }

    if (shouldStop()) return;
    const stored = files.filter(f => !skipped.has(f.sha));
    const treeShas = new Set(files.map(f => f.sha));
    await whileKept(fullName, async () => {
      await saveKeptTree(fullName, tree.entries);
      await deleteUnreferencedBlobs(fullName, new Set(stored.map(f => f.sha)));
      await saveSkippedShas(fullName, new Set([...skipped].filter(sha => treeShas.has(sha))));
    });
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
