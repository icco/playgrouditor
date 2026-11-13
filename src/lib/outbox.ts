import { GitHub, GitHubError, Repo, isConflict, isTransient } from './github';
import { Draft, cacheFile, deleteDraft, fileId, getDraft, listDrafts, writeDraft } from './localFiles';
import { recordCommittedFile, recordModified } from './offlineRepos';

type Listener = () => void;

const listeners = new Set<Listener>();
let openFile: string | null = null;
let flushing = false;
let flushAgain = false;
let outboxSession = 0;
let stopped = false;

export function stopOutbox(): void {
  outboxSession += 1;
  stopped = true;
  flushAgain = false;
}

export function startOutbox(): void {
  stopped = false;
}

export function subscribeOutbox(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyOutbox(): void {
  listeners.forEach(listener => listener());
}

// The editor owns the draft while it is open, so sending waits until the file is closed.
export function setOpenFile(repoFullName: string, path: string): void {
  openFile = fileId(repoFullName, path);
}

export function clearOpenFile(): void {
  openFile = null;
}

export async function queueCommit(draft: Omit<Draft, 'updatedAt' | 'sendError'>): Promise<void> {
  await writeDraft(draft);
  notifyOutbox();
}

async function commitOrFindLanded(github: GitHub, draft: Draft): Promise<string> {
  const repo = { full_name: draft.repoFullName, default_branch: draft.defaultBranch } as Repo;
  const mode = draft.queued!.mode;
  try {
    const res = await github.commit({
      repo,
      path: draft.path,
      text: draft.text,
      sha: draft.baseSha,
      message: draft.queued!.message,
      mode,
    });
    return res.sha;
  } catch (e: unknown) {
    if (mode !== 'direct' || !isConflict(e, !!draft.baseSha)) throw e;
    // An earlier attempt may have landed with its reply lost, which is not a conflict.
    const file = await github.read(draft.repoFullName, draft.path, draft.defaultBranch);
    if (file.text !== draft.text) throw e;
    return file.sha;
  }
}

async function send(github: GitHub, draft: Draft): Promise<string> {
  const sha = await commitOrFindLanded(github, draft);
  if (draft.queued!.mode === 'direct') {
    cacheFile(draft.repoFullName, draft.path, { sha, text: draft.text }).catch((e: unknown) =>
      console.warn('Could not cache file', e),
    );
    await recordCommittedFile(draft.repoFullName, draft.path, { sha, text: draft.text }).catch((e: unknown) =>
      console.warn('Could not update the offline copy', e),
    );
    await recordModified(draft.repoFullName, draft.path, sha).catch((e: unknown) =>
      console.warn('Could not update the offline dates', e),
    );
  }
  return sha;
}

export async function flushOutbox(github: GitHub, onSent: (draft: Draft) => void): Promise<void> {
  if (stopped) return;
  if (flushing) {
    flushAgain = true;
    return;
  }
  flushing = true;
  const session = outboxSession;
  try {
    do {
      flushAgain = false;
      // Oldest first, so commit history matches the order they were queued.
      for (const { repoFullName, path } of (await listDrafts()).reverse()) {
        if (session !== outboxSession) return;
        // Re-read each one: earlier sends take time, and the file may have been opened or edited since.
        const draft = await getDraft(repoFullName, path);
        if (!draft?.queued || fileId(repoFullName, path) === openFile) continue;
        try {
          const sha = await send(github, draft);
          if (session !== outboxSession) return;
          const current = await getDraft(repoFullName, path);
          if (current?.text === draft.text) {
            await deleteDraft(repoFullName, path);
          } else if (current && draft.queued.mode === 'direct') {
            await writeDraft({ ...current, baseSha: sha });
          }
          onSent(draft);
        } catch (e: unknown) {
          if (session !== outboxSession) return;
          if (isTransient(e) || (e instanceof GitHubError && e.status === 401)) return;
          const current = await getDraft(repoFullName, path);
          if (current) {
            const sendError = e instanceof Error ? e.message : 'Could not send this commit';
            await writeDraft({ ...current, queued: undefined, sendError });
          }
        }
        notifyOutbox();
      }
    } while (flushAgain);
  } finally {
    flushing = false;
    // A request that arrived during a run that stopped early would otherwise be lost.
    if (flushAgain) {
      flushAgain = false;
      notifyOutbox();
    }
  }
}
