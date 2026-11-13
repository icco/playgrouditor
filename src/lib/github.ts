import { decodeUtf8Strict, encodeBase64 } from './base64';
import { GITHUB_CLIENT_ID } from '../config';

const API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 30_000;
const MODIFIED_BATCH_SIZE = 50;
const MODIFIED_CONCURRENCY = 4;

export const NETWORK_ERROR_STATUS = 0;
// The commit landed, so this must never count as transient and be sent twice.
const PARTIAL_COMMIT_STATUS = 424;

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface Repo {
  full_name: string;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  description: string | null;
  pushed_at: string;
}

export interface Entry {
  name: string;
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  sha: string;
  modified?: string;
}

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
  mode?: string;
}

export interface FileContent {
  path: string;
  sha: string;
  text: string;
}

export interface CommitResult {
  sha: string;
  prUrl?: string;
}

export interface User {
  login: string;
  name: string | null;
}

export class GitHub {
  constructor(
    private token: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  onUnauthorized?: () => void;

  rateLimitRemaining: number | null = null;

  private async req<T>(path: string, init: RequestInit = {}): Promise<T> {
    const { res, body } = await timedFetch(this.fetcher, `${API}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const remaining = res.headers?.get('x-ratelimit-remaining');
    if (remaining) this.rateLimitRemaining = Number(remaining);
    if (!res.ok) {
      if (res.status === 401) this.onUnauthorized?.();
      const message = (body as { message?: string } | undefined)?.message;
      throw new GitHubError(message || res.statusText, res.status);
    }
    return body as T;
  }

  user(): Promise<User> {
    return this.req<User>('/user');
  }

  async repos(): Promise<Repo[]> {
    const all: Repo[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.req<Repo[]>(
        `/user/repos?sort=pushed&per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`,
      );
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }

  repo(fullName: string): Promise<Repo> {
    return this.req<Repo>(`/repos/${fullName}`);
  }

  // GitHub resolves each path's history serially within a query, so a few smaller batches at once finish far sooner.
  async modifiedDates(fullName: string, paths: string[], ref: string): Promise<Record<string, string>> {
    const batches: string[][] = [];
    for (let i = 0; i < paths.length; i += MODIFIED_BATCH_SIZE) batches.push(paths.slice(i, i + MODIFIED_BATCH_SIZE));
    const dates: Record<string, string> = {};
    for (let i = 0; i < batches.length; i += MODIFIED_CONCURRENCY) {
      const wave = batches.slice(i, i + MODIFIED_CONCURRENCY);
      const histories = await Promise.all(wave.map(batch => this.batchHistory(fullName, batch, ref)));
      wave.forEach((batch, b) =>
        batch.forEach((path, j) => {
          const date = histories[b]?.[`f${j}`]?.nodes[0]?.committedDate;
          if (date) dates[path] = date;
        }),
      );
    }
    return dates;
  }

  private async batchHistory(fullName: string, paths: string[], ref: string) {
    const [owner, name] = fullName.split('/');
    const params = paths.map((_, i) => `$p${i}: String!`).join(', ');
    const fields = paths.map((_, i) => `f${i}: history(first: 1, path: $p${i}) { nodes { committedDate } }`).join(' ');
    const query = `query($owner: String!, $name: String!, $ref: String!, ${params}) {
      repository(owner: $owner, name: $name) { object(expression: $ref) { ... on Commit { ${fields} } } }
    }`;
    const variables = Object.fromEntries(paths.map((p, i) => [`p${i}`, p]));
    const { data, errors } = await this.req<{
      data?: { repository?: { object?: Record<string, { nodes: Array<{ committedDate: string }> }> | null } | null };
      errors?: Array<{ message: string }>;
    }>('/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables: { owner, name, ref, ...variables } }),
    });
    // GraphQL reports failures in a 200 body, and 403 keeps query retries the same as a REST rate limit.
    if (errors?.length) throw new GitHubError(errors[0].message, 403);
    return data?.repository?.object;
  }

  async list(fullName: string, path: string, ref: string): Promise<Entry[]> {
    const entries = await this.req<Entry[]>(
      `/repos/${fullName}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    return sortEntries(entries);
  }

  async tree(fullName: string, ref: string): Promise<{ sha: string; truncated: boolean; entries: TreeEntry[] }> {
    const res = await this.req<{ sha: string; truncated: boolean; tree: TreeEntry[] }>(
      `/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    const entries = res.tree.map(({ path, type, sha, size, mode }) => ({ path, type, sha, size, mode }));
    return { sha: res.sha, truncated: res.truncated, entries };
  }

  async blob(fullName: string, sha: string): Promise<string | null> {
    const res = await this.req<{ content: string; encoding: string }>(`/repos/${fullName}/git/blobs/${sha}`);
    return decodeUtf8Strict(res.content);
  }

  async read(fullName: string, path: string, ref: string): Promise<FileContent> {
    const file = await this.req<{ path: string; sha: string; content: string; encoding: string }>(
      `/repos/${fullName}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
    );
    // Files over 1 MB come back with empty content; saving that would wipe the file.
    if (file.encoding !== 'base64') {
      throw new GitHubError('This file is too large to edit here.', 413);
    }
    const text = decodeUtf8Strict(file.content);
    if (text === null) {
      throw new GitHubError('This file is not UTF-8 text, so it cannot be edited here.', 415);
    }
    return { path: file.path, sha: file.sha, text };
  }

  async commit(opts: {
    repo: Repo;
    path: string;
    text: string;
    sha?: string;
    message: string;
    mode: 'direct' | 'pr';
  }): Promise<CommitResult> {
    const { repo, path, text, sha, message, mode } = opts;
    let branch = repo.default_branch;
    if (mode === 'pr') {
      branch = `${branchName(path)}-${randomSuffix()}`;
      const base = await this.req<{ object: { sha: string } }>(
        `/repos/${repo.full_name}/git/ref/heads/${encodePath(repo.default_branch)}`,
      );
      await this.req(`/repos/${repo.full_name}/git/refs`, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }),
      });
    }
    let put: { content: { sha: string } };
    try {
      put = await this.req<{ content: { sha: string } }>(
        `/repos/${repo.full_name}/contents/${encodePath(path)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ message, content: encodeBase64(text), sha, branch }),
        },
      );
    } catch (e: unknown) {
      if (mode === 'pr') await this.deleteBranch(repo.full_name, branch);
      throw e;
    }
    const result: CommitResult = { sha: put.content.sha };
    if (mode === 'pr') {
      try {
        const pr = await this.req<{ html_url: string }>(`/repos/${repo.full_name}/pulls`, {
          method: 'POST',
          body: JSON.stringify({ title: message, head: branch, base: repo.default_branch }),
        });
        result.prUrl = pr.html_url;
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : 'unknown error';
        throw new GitHubError(
          `Committed to ${branch}, but the pull request could not be opened: ${reason}`,
          PARTIAL_COMMIT_STATUS,
        );
      }
    }
    return result;
  }

  private async deleteBranch(fullName: string, branch: string): Promise<void> {
    const { res } = await timedFetch(this.fetcher, `${API}/repos/${fullName}/git/refs/heads/${encodePath(branch)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json' },
    }).catch((e: unknown) => {
      console.warn(`Could not delete branch ${branch}`, e);
      return { res: null };
    });
    if (res && !res.ok) console.warn(`Could not delete branch ${branch}: ${res.status}`);
  }
}

async function timedFetch(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<{ res: Response; body: unknown }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const res = await fetcher(url, { ...init, signal: controller.signal });
    if (res.status === 204) return { res, body: undefined };
    // A dropped connection mid-body on a success must surface as a network error.
    const body: unknown = res.ok ? await res.json() : await res.json().catch(() => undefined);
    return { res, body };
  } catch (e: unknown) {
    throw new GitHubError(
      timedOut ? 'GitHub took too long to respond. Try again.' : 'Could not reach GitHub. Check your connection.',
      NETWORK_ERROR_STATUS,
      { cause: e },
    );
  } finally {
    clearTimeout(timer);
  }
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 6);
}

export function isConflict(e: unknown, hadSha: boolean): boolean {
  if (!(e instanceof GitHubError)) return false;
  return e.status === 409 || (e.status === 422 && !hadSha && e.message.includes('sha'));
}

export function encodePath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

export function sortEntries(entries: Entry[], sortBy: 'name' | 'modified' = 'name'): Entry[] {
  return [...entries]
    .filter(e => !e.name.startsWith('.'))
    .sort((a, b) => {
      if (sortBy === 'modified') {
        const dateA = a.modified ? new Date(a.modified).getTime() : 0;
        const dateB = b.modified ? new Date(b.modified).getTime() : 0;
        if (dateA !== dateB) {
          return dateB - dateA;
        }
      }
      if ((a.type === 'dir') !== (b.type === 'dir')) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export function formatDate(isoString?: string): string {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

export function branchName(path: string, now: Date = new Date()): string {
  const base = (path.split('/').pop() ?? 'edit')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `playgrounditor/${base || 'edit'}-${stamp}`;
}

export function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

export function isEditable(name: string): boolean {
  return isMarkdown(name) || /\.(txt|ya?ml|json|toml|html?|css|js|jsx|mjs|cjs|ts|tsx|go|rs|rb|py|sh|csv|xml|ini|sql)$/i.test(name) || !name.includes('.');
}

export function newFilePath(dir: string, input: string): string | null {
  const name = input.trim();
  const segments = name.split('/');
  if (!name || segments.some(s => s === '' || s === '.' || s === '..')) return null;
  const withExtension = /\.[^./]+$/.test(name) ? name : `${name}.md`;
  return dir ? `${dir}/${withExtension}` : withExtension;
}

// ---- Device flow -----------------------------------------------------------

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

async function postForm<T>(url: string, body: Record<string, string>, fetcher: typeof fetch): Promise<T> {
  const { res, body: json } = await timedFetch(fetcher, url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new GitHubError(res.statusText, res.status);
  return json as T;
}

export function isTransient(e: unknown): boolean {
  if (!(e instanceof GitHubError)) return false;
  const rateLimited = e.status === 429 || (e.status === 403 && /rate limit/i.test(e.message));
  return rateLimited || e.status === NETWORK_ERROR_STATUS || e.status >= 500;
}

export function startDeviceFlow(fetcher: typeof fetch = fetch): Promise<DeviceCode> {
  return postForm<DeviceCode>(
    'https://github.com/login/device/code',
    { client_id: GITHUB_CLIENT_ID, scope: 'repo' },
    fetcher,
  );
}

export type PollResult = { token: string } | { pending: true; slowDown?: boolean };

export const SLOW_DOWN_PENALTY_MS = 5000;

export async function pollDeviceFlow(deviceCode: string, fetcher: typeof fetch = fetch): Promise<PollResult> {
  const r = await postForm<{ access_token?: string; error?: string; error_description?: string }>(
    'https://github.com/login/oauth/access_token',
    {
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    fetcher,
  );
  if (r.access_token) return { token: r.access_token };
  if (r.error === 'authorization_pending') return { pending: true };
  if (r.error === 'slow_down') return { pending: true, slowDown: true };
  throw new GitHubError(r.error_description || r.error || 'Sign in failed', 400);
}
