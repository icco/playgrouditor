# Keep repos offline

## Intent

Let the user mark a repository "Keep offline" so every editable text file in it can be browsed and opened with no connection, for both writing and looking things up across files and repos. Today only folders already visited (30-day query cache) and the 30 most recently opened files (`src/lib/localFiles.ts`) survive offline, so a file never opened before is unreachable on a plane. Drafts and queued commits already work offline and stay as they are.

## Goals

- A Keep offline switch per repo, in the repo's file browser header menu and in a new "Offline repos" section of Settings.
- A kept repo stores its default branch's full file tree and the contents of every editable text file (`isEditable` in `src/lib/github.ts`).
- Offline, the file browser lists any folder of a kept repo, and the editor opens any stored file. Saving offline uses the existing outbox, with the stored blob sha as the base.
- Turning a repo on starts its first download right away.
- Background refresh about every 60 minutes, Wi-Fi (unmetered) only, including after the app is closed or the phone reboots. Each refresh downloads only files whose content sha changed.
- Settings lists each kept repo with file count, stored size, last synced time, last error, a Refresh now button and a remove action.

## Non-goals

- Images and other binaries, files over 1 MB, non-UTF-8 files (same limits as `GitHub.read`).
- Branches other than the default branch.
- Sort by modified date offline (it keeps using whatever the query cache has).
- Search across files, iOS.

## Anti-goals

- Routine refreshes using mobile data.
- Background work that drains battery or trips GitHub rate limits.
- Losing or overwriting a draft or queued commit.
- Background code signing the user out or touching another account's data.
- Blocking the UI during a sync.

## Constraints

- React Native 0.88, Android only, pnpm, TypeScript, Jest. Keep the existing `GitHub` class style (injectable `fetcher` for tests).
- AsyncStorage 3.1 is SQLite-backed with no configured size cap; Android's SQLite cursor window is about 2 MB per row, so one value must stay well under that (the 1 MB file limit does).
- Android background work runs at least 15 minutes apart, and the OS may delay it further.
- Sign out already clears local data (`clearLocalFiles` in `AuthContext`); offline repos must be cleared the same way.

## Approaches

1. **react-native-background-fetch (chosen).** MIT, runs on WorkManager/JobScheduler, has `requiredNetworkType: UNMETERED`, `minimumFetchInterval`, `stopOnTerminate: false`, `startOnBoot`, and a HeadlessJS task on Android so the same TypeScript sync code runs when the app is closed. Docs: https://github.com/transistorsoft/react-native-background-fetch, https://fetch.transistorsoft.com/react-native/BackgroundFetchConfig
2. Own Kotlin WorkManager worker starting a HeadlessJS task. Same behavior, no library, but native code to maintain across React Native upgrades. Rejected for upkeep.
3. Download the repo tarball each refresh. Simplest sync, but re-downloads everything hourly and needs a tar/gzip library. Rejected for data and battery.

## Design

### Storage (`src/lib/offlineRepos.ts`)

- `@playgrounditor:offline:repos`: list of kept repos `{ fullName, defaultBranch, treeSha?, syncedAt?, fileCount, bytes, pending, error? }`.
- `@playgrounditor:offline:tree:<repo>`: the recursive tree `{ path, type, sha, size }[]` from the last completed tree fetch.
- `@playgrounditor:offline:blob:<repo>:<sha>`: decoded file text. Keyed by blob sha, so renames and identical files share one copy.
- After a sync, blobs no longer referenced by the tree are deleted.
- `clearLocalFiles` also removes every `@playgrounditor:offline:` key.

### Sync (`syncRepo`, `syncAll`)

1. `GET /repos/{repo}` for the default branch.
2. `GET /repos/{repo}/git/trees/{branch}?recursive=1`. If `truncated` is true, stop and record the error "This repo is too large to keep offline."
3. For each editable blob up to 1 MB whose sha has no stored blob, `GET /repos/{repo}/git/blobs/{sha}`, decode with `decodeUtf8Strict`, store it, skip it if it is not UTF-8. Fetch a few at a time (start at 4), sequential batches, matching the comment on `modifiedDates` about secondary rate limits.
4. Save the new tree, update counts and size, delete unreferenced blobs.

- Blobs are stored as they arrive, so a run cut short by the OS resumes where it stopped.
- One sync at a time per process (a module-level lock); a second request joins the running one.
- A transient error (`isTransient`) ends the run and keeps the old copy. A 404 or 403 records the error and keeps the old copy. A 401 in the background ends the run without signing out.
- Rate limit: stop when `x-ratelimit-remaining` is below 500, so foreground use keeps working.

### Background

- `index.js` registers the headless task. `BackgroundFetch.configure` runs at app start with `minimumFetchInterval: 60`, `requiredNetworkType: UNMETERED`, `stopOnTerminate: false`, `startOnBoot: true`, `enableHeadless: true`.
- The task reads the token from Keychain (same service as `AuthContext`). With no token or no kept repos it finishes at once. Otherwise it runs `syncAll` and calls `finish(taskId)`; the timeout callback stops the run and finishes.
- Configured only while at least one repo is kept; `BackgroundFetch.stop()` when the last one is removed or on sign out.

### Reading

- File browser: the `dir` query falls back to the stored tree when the network request fails with `NETWORK_ERROR_STATUS`, building entries for that folder and sorting with `sortEntries`. `repo` falls back to the kept repo's default branch the same way.
- Editor: after the draft, network, and recent-file cache, look up the path in the stored tree and load its blob. The blob sha is the base sha, so the outbox's conflict handling applies unchanged.
- Commits made from the app update the stored tree entry and blob for that path, so the copy does not look stale until the next refresh.

### UI

- File browser header menu: a "Keep offline" switch for the whole repo, and a status line: "Downloading 120 of 340 files", "Offline copy updated 12 min ago", or the last error.
- Settings, "Offline repos": one row per repo with files, size, last updated, error, Refresh now, Remove. Refresh now and the first download run on any connection, because the user asked for them.

## Tests

Jest with a fake fetcher, in the style of `__tests__/github.test.ts` and `__tests__/outbox.test.ts`: tree diff fetches only new shas, skips binaries and large files, truncated tree errors, resume after a partial run, blob cleanup, folder listing from the tree, sign-out clears offline keys.

## Left to the builder

- Exact component layout and copy, following the existing screens and theme.
- Blob fetch concurrency and the rate-limit floor, if the starting values misbehave.
- How the editor shows that it opened the offline copy (reuse the existing notice).
