# playgrounditor

An Android editor for text files in your GitHub repositories.

## Install

Download the APK from the [latest release](https://github.com/icco/playgrounditor/releases/latest) and open it on your phone.

## Usage

1. Sign in with GitHub, or paste a personal access token with `repo` scope.
2. Pick a repository and browse to a file, or tap + to start a new Markdown file.
3. Tap Save, then open a pull request or commit to the default branch.

Repositories, folders and recently opened files stay available offline. Turn on Keep offline in a repository to store every editable text file on its default branch (up to 1 MB each). Kept repositories refresh about hourly on Wi-Fi, even when the app is closed, and Settings lists them with their size. Edits are saved on the device as drafts. Tapping Save offline queues the commit and sends it when you reconnect; if the file changed on GitHub meanwhile, it stays a draft marked "Not sent". Signing out deletes all of this, queued commits included.

## Development

```sh
pnpm install
pnpm android
```
