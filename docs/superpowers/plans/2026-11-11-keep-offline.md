# Keep Offline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-repo Keep offline switch that stores every editable text file of the default branch on the phone and refreshes it hourly on Wi-Fi in the background.

**Architecture:** `src/lib/offlineRepos.ts` stores kept repos, trees and blobs in AsyncStorage and serves offline listings and file reads. `src/lib/offlineSync.ts` diffs the Git tree and fetches only new blobs. `src/lib/backgroundSync.ts` wires `react-native-background-fetch` (headless on Android) to the same sync code. Screens fall back to the kept copy on network errors.

**Tech Stack:** React Native 0.88, TypeScript, AsyncStorage 3, TanStack Query 5, react-native-background-fetch, Jest.

**Spec:** `docs/superpowers/specs/2026-11-11-keep-offline-design.md`

## Global Constraints

- Default branch only. Store only blobs where `isEditable(name)` is true, `size <= 1_000_000`, and `decodeUtf8Strict` returns non-null.
- Key prefix `@playgrounditor:offline:`; keys `@playgrounditor:offline:repos`, `@playgrounditor:offline:tree:<fullName>`, `@playgrounditor:offline:blob:<fullName>:<sha>`.
- Truncated tree error copy: "This repo is too large to keep offline."
- Blob fetch concurrency 4, in sequential batches. Stop a sync when `x-ratelimit-remaining` < 500.
- Background: `minimumFetchInterval: 60`, `requiredNetworkType: BackgroundFetch.NETWORK_TYPE_UNMETERED`, `stopOnTerminate: false`, `startOnBoot: true`, `enableHeadless: true`.
- First download and Refresh now run on any connection.
- A 401 during background sync never signs the user out.
- Sign out removes every offline key and stops background fetch.
- Tests use fictional names (`alice/notes`). No new comments beyond one-line non-obvious whys.

## Review Focus

- A file edited offline from a kept blob, then changed on GitHub, must end up "Not sent" via the existing outbox conflict path, not overwrite GitHub. Test in Task 5.
- A sync cut off mid-run (OS timeout) must leave the previous tree usable and resume without refetching stored blobs. Test in Task 3.
- Turning a repo off while its sync runs must not leave orphan blobs or re-add the repo. Test in Task 3.
- Signing out during a background sync must not write data back afterwards. Test in Task 3 (sync checks the repo is still kept before each write batch).
- A path that exists in the tree but whose blob was skipped (binary, too large) must show a clear "not stored offline" error offline, not an empty editor. Test in Task 2.

---

### Task 1: GitHub client: tree, blob, rate limit

**Files:**
- Modify: `src/lib/github.ts`
- Test: `__tests__/github.test.ts`

**Interfaces:**
- Produces:
  - `interface TreeEntry { path: string; type: 'blob' | 'tree' | 'commit'; sha: string; size?: number }`
  - `GitHub.tree(fullName: string, ref: string): Promise<{ sha: string; truncated: boolean; entries: TreeEntry[] }>` via `GET /repos/{r}/git/trees/{ref}?recursive=1`
  - `GitHub.blob(fullName: string, sha: string): Promise<string | null>` via `GET /repos/{r}/git/blobs/{sha}`, returns `decodeUtf8Strict(content)`
  - `GitHub.rateLimitRemaining: number | null`, set in `req` from `res.headers?.get('x-ratelimit-remaining')`

- [ ] **Step 1: Write failing tests** `fetches a recursive tree` (URL contains `/git/trees/main?recursive=1`, returns `truncated` and entries), `decodes a blob and returns null for non-UTF-8` (use `Base64.fromUint8Array(new Uint8Array([0xff, 0xfe]))`), `records the rate limit remaining` (response with `headers: new Headers({'x-ratelimit-remaining': '42'})` gives `42`; response without headers leaves `null`).
- [ ] **Step 2: Run** `pnpm test __tests__/github.test.ts`, expect the three to FAIL.
- [ ] **Step 3: Implement** the three members. `encodeURIComponent` the ref.
- [ ] **Step 4: Run** `pnpm test __tests__/github.test.ts`, expect PASS.
- [ ] **Step 5: Commit** `feat: add git tree and blob reads to the GitHub client`.

### Task 2: Offline repo storage and reads

**Files:**
- Create: `src/lib/offlineRepos.ts`
- Modify: `src/lib/localFiles.ts` (`clearLocalFiles` also removes keys starting with `@playgrounditor:offline:`)
- Test: `__tests__/offlineRepos.test.ts` (AsyncStorage mock as in `__tests__/outbox.test.ts`)

**Interfaces:**
- Consumes: `TreeEntry`, `Entry`, `sortEntries`, `isEditable` from Task 1 / `github.ts`; `CachedFile` from `localFiles.ts`.
- Produces:
  - `interface KeptRepo { fullName: string; defaultBranch: string; treeSha?: string; syncedAt?: string; fileCount: number; bytes: number; pending: number; syncing?: boolean; error?: string }`
  - `listKeptRepos(): Promise<KeptRepo[]>`, `getKeptRepo(fullName): Promise<KeptRepo | null>`
  - `keepRepo(fullName: string, defaultBranch: string): Promise<void>`, `unkeepRepo(fullName: string): Promise<void>` (removes repo, tree and blobs)
  - `updateKeptRepo(fullName: string, patch: Partial<KeptRepo>): Promise<void>` (no-op if not kept)
  - `getKeptTree(fullName): Promise<TreeEntry[] | null>`, `saveKeptTree(fullName, entries: TreeEntry[]): Promise<void>`
  - `hasBlob(fullName, sha): Promise<boolean>`, `saveBlob(fullName, sha, text): Promise<void>`, `deleteUnreferencedBlobs(fullName, keep: Set<string>): Promise<void>`
  - `listKeptDir(fullName: string, path: string): Promise<Entry[] | null>` (direct children of `path` from the tree, `tree` mapped to `dir`, `blob` to `file`, sorted by `sortEntries`; null when not kept)
  - `readKeptFile(fullName: string, path: string): Promise<CachedFile | null>`; throws `GitHubError('This file is not stored offline.', 404)` when the path is in the tree but its blob is missing
  - `recordCommittedFile(fullName: string, path: string, file: CachedFile): Promise<void>` (no-op if not kept; updates tree entry sha and saves blob)
  - `subscribeKeptRepos(listener: () => void): () => void`; every write above notifies

- [ ] **Step 1: Write failing tests** `lists direct children of a folder` (tree `docs`, `docs/a.md`, `docs/sub/b.md`, `top.md`; `listKeptDir('alice/notes','docs')` gives `sub` dir then `a.md`), `reads a stored file by path`, `throws not stored offline for a skipped blob`, `returns null for repos not kept`, `unkeep removes tree and blobs`, `deletes only unreferenced blobs`, `recordCommittedFile updates the tree sha`, `clearLocalFiles removes offline keys`, `notifies subscribers on keep`.
- [ ] **Step 2: Run** `pnpm test __tests__/offlineRepos.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** `offlineRepos.ts` with the signatures above, using a `readJson` helper like `localFiles.ts`.
- [ ] **Step 4: Run** `pnpm test __tests__/offlineRepos.test.ts __tests__/outbox.test.ts`, expect PASS.
- [ ] **Step 5: Commit** `feat: store kept repos, trees and blobs on the device`.

### Task 3: Sync

**Files:**
- Create: `src/lib/offlineSync.ts`
- Test: `__tests__/offlineSync.test.ts`

**Interfaces:**
- Consumes: Task 1 `GitHub.repo/tree/blob/rateLimitRemaining`, Task 2 storage functions, `isTransient`.
- Produces:
  - `syncRepo(github: GitHub, fullName: string, shouldStop?: () => boolean): Promise<void>` (joins a running sync for the same repo)
  - `syncAll(github: GitHub, shouldStop?: () => boolean): Promise<void>` (kept repos in order, sequential)

Algorithm: set `syncing: true, error: undefined`; `repo()` for default branch; `tree()`; if `truncated` set error and stop. Wanted = blobs passing the Global Constraints filter; missing = wanted without `hasBlob`. Set `pending`. Fetch missing in batches of 4; before each batch stop if `shouldStop()`, the repo is no longer kept, or `rateLimitRemaining !== null && < 500`; save each non-null blob; update `pending`. Only when every wanted blob is fetched or known non-UTF-8: `saveKeptTree`, `deleteUnreferencedBlobs`, set `treeSha`, `syncedAt`, `fileCount`, `bytes` (sum of stored text lengths). Always clear `syncing` in `finally`. On error: `GitHubError` message into `error`, keep the old tree; never call `onUnauthorized` (construct background `GitHub` without it).

- [ ] **Step 1: Write failing tests** with a fake `GitHub` object: `fetches only blobs it does not have`, `skips binaries, large files and non-UTF-8`, `records too large for a truncated tree`, `resumes after shouldStop without refetching`, `keeps the old tree when stopped early`, `stops below the rate limit floor`, `records a 404 and keeps the old copy`, `does not write after the repo is unkept mid-sync`, `does not write after clearLocalFiles mid-sync`, `joins a running sync for the same repo`.
- [ ] **Step 2: Run** `pnpm test __tests__/offlineSync.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** `offlineSync.ts`.
- [ ] **Step 4: Run** `pnpm test __tests__/offlineSync.test.ts`, expect PASS.
- [ ] **Step 5: Commit** `feat: sync kept repos by fetching only changed blobs`.

### Task 4: Background refresh

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (`pnpm add react-native-background-fetch`), `android/build.gradle` (add `maven { url("${project(':react-native-background-fetch').projectDir}/libs") }` under `allprojects.repositories`, per https://github.com/transistorsoft/react-native-background-fetch/blob/master/docs/INSTALL-AUTO-ANDROID.md), `index.js` (register headless task), `src/context/AuthContext.tsx` (export `KEYCHAIN_SERVICE`; on logout and account switch call `setBackgroundSync(false)`)
- Create: `src/lib/backgroundSync.ts`
- Test: `__tests__/backgroundSync.test.ts` (mock `react-native-background-fetch` and `react-native-keychain`)

**Interfaces:**
- Consumes: Task 3 `syncAll`, Task 2 `listKeptRepos`.
- Produces:
  - `setBackgroundSync(enabled: boolean): Promise<void>` (configure with Global Constraints values, or `BackgroundFetch.stop()`)
  - `ensureBackgroundSync(): Promise<void>` (enables iff any repo is kept; called at app start and after keep/unkeep)
  - `headlessTask(event: { taskId: string; timeout: boolean }): Promise<void>`, registered with `BackgroundFetch.registerHeadlessTask`
  - The foreground `configure` callback runs the same body as `headlessTask`.

- [ ] **Step 1: Write failing tests** `finishes at once with no token`, `finishes at once with no kept repos`, `syncs and finishes with a token`, `finishes on timeout without syncing`, `enables only when a repo is kept`, `stops on sign out`.
- [ ] **Step 2: Run** `pnpm test __tests__/backgroundSync.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** `backgroundSync.ts`, the gradle repo, and the `index.js` registration. Timeout sets a flag passed as `shouldStop` and calls `finish`.
- [ ] **Step 4: Run** `pnpm test`, `pnpm lint`, `npx tsc --noEmit`, expect PASS.
- [ ] **Step 5: Commit** `feat: refresh kept repos hourly on Wi-Fi in the background`.

### Task 5: Offline reads in the file browser and editor

**Files:**
- Modify: `src/screens/FileBrowserScreen.tsx:41-52`, `src/screens/EditorScreen.tsx:131-150` and `:253`, `src/lib/outbox.ts:73` (call `recordCommittedFile` next to `cacheFile`)
- Create: `src/lib/offlineFallback.ts`
- Test: `__tests__/offlineFallback.test.ts`, extend `__tests__/outbox.test.ts`

**Interfaces:**
- Consumes: Task 2 `listKeptDir`, `readKeptFile`, `getKeptRepo`, `recordCommittedFile`.
- Produces:
  - `listDirOffline(github: GitHub, fullName: string, path: string, ref: string): Promise<Entry[]>` (network, then `listKeptDir` when the error has `status === NETWORK_ERROR_STATUS`, else rethrow)
  - `repoOffline(github: GitHub, fullName: string): Promise<Repo>` (network, then a minimal `Repo` from the kept repo on network error)
  - Editor base order: network, `getCachedFile`, then `readKeptFile`.

- [ ] **Step 1: Write failing tests** `lists from the kept tree on a network error`, `rethrows non-network errors`, `rethrows when the repo is not kept`, `builds the repo from the kept copy offline`, and in outbox tests `a queued commit from a kept blob that changed on GitHub stays Not sent`, `a sent commit updates the kept copy`.
- [ ] **Step 2: Run** `pnpm test __tests__/offlineFallback.test.ts __tests__/outbox.test.ts`, expect FAIL.
- [ ] **Step 3: Implement** `offlineFallback.ts`; use it in the `repo` and `dir` queries; add the editor fallback and `recordCommittedFile` calls.
- [ ] **Step 4: Run** `pnpm test`, expect PASS.
- [ ] **Step 5: Commit** `feat: open kept repos and files offline`.

### Task 6: Keep offline UI and README

**Files:**
- Create: `src/lib/useKeptRepos.ts` (`useKeptRepos(): KeptRepo[]` via `useSyncExternalStore` over `subscribeKeptRepos`)
- Modify: `src/screens/FileBrowserScreen.tsx` (header `Switch` labelled "Keep offline" plus status line), `src/screens/SettingsScreen.tsx` (section "Offline repos"), `README.md` (Usage paragraph on offline)

Status copy: "Downloading {done} of {total} files", "Offline copy updated {relative time}", or the stored error. Settings row: name, "{fileCount} files, {size}", last updated, error, "Refresh now", "Remove". Turning on: `keepRepo`, `ensureBackgroundSync`, `syncRepo` (any connection). Removing: `unkeepRepo`, `ensureBackgroundSync`.

- [ ] **Step 1: Implement** the hook, the switch, the status line and the Settings section with theme colors from `useTheme`.
- [ ] **Step 2: Run** `pnpm test`, `pnpm lint`, `npx tsc --noEmit`, expect PASS.
- [ ] **Step 3: Manual check on a device or emulator:** keep a repo, airplane mode, open an unvisited folder and file; force a background run with `adb shell cmd jobscheduler run -f com.timeclimbers.playgrounditor 999` (see https://fetch.transistorsoft.com/react-native/debugging).
- [ ] **Step 4: Commit** `feat: add keep offline switch and offline repos settings`.
