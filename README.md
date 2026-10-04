# TasksNG

A fast, keyboard-friendly task manager for Windows 10 and 11 that syncs with your
[Baikal](https://sabre.io/baikal/) server (and other CalDAV servers built on sabre/dav).

- **Instant**: every action is applied locally first and synced in the background,
  so the UI never waits for the network. The app starts from a local cache in
  milliseconds and works offline; queued changes go out when the server is reachable again.
- **Small and native**: built with [Tauri 2](https://v2.tauri.app/). The installer is a
  few MB and uses the WebView2 runtime that ships with Windows (it is installed
  automatically if missing).
- **Modern UI**: React + [shadcn/ui](https://ui.shadcn.com) components, light and dark
  themes that follow Windows.
- **Safe with your data**: tasks are stored as standard iCalendar `VTODO`s. Properties
  written by other apps (Thunderbird, Apple Reminders, Tasks.org, DAVx⁵ …) are preserved
  when you edit a task, and edits use ETags so a change made on another device is never
  silently overwritten.

## Features

- Smart lists: **Today** (incl. overdue), **Upcoming** (grouped by day), **Important**, **All tasks**
- Your Baikal calendars that hold tasks appear as lists; create, rename, recolor and delete lists
- Quick add with shortcuts: `Pay rent tomorrow 9am !1 #home every month`
  - dates: `today`, `tomorrow`, weekdays (`fri`), `next week`, `in 3 days`, `2026-12-01`
  - times: `9am`, `17:30`
  - priority: `!1` / `!2` / `!3` (or `!!!`, `!high` …), tags: `#tag`
  - repeat: `daily`, `weekly`, `weekdays`, `monthly`, `yearly`, `every week` …
- Due dates with optional time, priority, tags, notes, subtasks, repeating tasks
  (completing a repeating task moves it to the next occurrence)
- Move tasks between lists, duplicate, delete with undo
- Search, command palette (<kbd>Ctrl</kbd>+<kbd>K</kbd>) and full keyboard control
- Automatic background sync (configurable) plus sync on focus and when the network returns
- Password stored in Windows Credential Manager; trusts certificates in the Windows
  certificate store (option to accept self-signed certificates)
- Basic **and** Digest authentication (Baikal's default)
- Automatic updates: new releases are downloaded in the background, verified against the
  app's signing key and installed after a restart (Settings → Updates)

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| <kbd>N</kbd> / <kbd>Ctrl</kbd>+<kbd>N</kbd> | New task |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | Command palette / jump to any task |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> or <kbd>/</kbd> | Search |
| <kbd>↑</kbd> <kbd>↓</kbd> (or <kbd>J</kbd> <kbd>K</kbd>) | Move selection |
| <kbd>Space</kbd> | Complete / reopen |
| <kbd>Enter</kbd> / <kbd>F2</kbd> | Edit title |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>0</kbd> | High / medium / low / no priority |
| <kbd>T</kbd> / <kbd>M</kbd> | Due today / tomorrow |
| <kbd>Del</kbd> | Delete (with undo) |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo delete |
| <kbd>Ctrl</kbd>+<kbd>H</kbd> | Show / hide completed |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | Switch list |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Toggle sidebar |
| <kbd>F5</kbd> | Sync now |

## Install

Download the latest build from the **Actions** tab (artifact `TasksNG-windows-x64`) or from
**Releases** when a version is tagged:

- `TasksNG_x.y.z_x64-setup.exe`: per-user installer, no admin rights needed (recommended)
- `TasksNG_x.y.z_x64_en-US.msi`: per-machine installer for managed deployments
- `TasksNG-portable.exe`: single executable, no installation (needs WebView2, which is
  part of Windows 11 and of up-to-date Windows 10). The portable version doesn't update
  itself; installed versions do.

On first start, enter your Baikal address (e.g. `https://dav.example.com`), username and
password. The app discovers your task lists automatically via `/.well-known/caldav` or
`/dav.php`; if your Baikal lives in a sub folder, enter the full URL ending in `dav.php`,
e.g. `https://example.com/baikal/html/dav.php`.

Calendars that only allow events are not shown. In Baikal, a calendar's components are set
in the admin panel (*Users and resources → Calendars*); new lists created from TasksNG are
task-only calendars.

## Updates

Installed copies check `https://github.com/sshahs/tasksng/releases/latest/download/latest.json`
shortly after start-up and every six hours (can be turned off in Settings). A newer version
is downloaded in the background and only accepted if its signature matches the public key
built into the app (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`). The user is then
offered *Restart now*; the installer runs in passive mode and reopens TasksNG. Unsynced
changes are written to disk before the installer starts.

## How it works

```
┌──────────────── WebView2 ────────────────┐      ┌──────────── Rust ─────────────┐
│ React + shadcn/ui                        │ IPC  │ tauri commands                │
│ zustand store (optimistic updates)       │◄────►│ tasks-core                    │
└──────────────────────────────────────────┘      │  ├ store.rs  local cache (JSON)│
                                                  │  ├ sync.rs   push → pull       │
                                                  │  ├ dav/      CalDAV client     │
                                                  │  ├ ical.rs   lossless iCal     │
                                                  │  └ model.rs  VTODO ⇄ Task      │
                                                  └───────────────┬───────────────┘
                                                                  │ HTTPS (WebDAV)
                                                             Baikal server
```

- Local edits update the cache immediately, are marked *pending*, and are pushed ~300 ms
  later (`PUT` with `If-Match` / `If-None-Match`, `DELETE` with `If-Match`).
- A sync pushes pending changes, then checks each list's `getctag`; only lists that changed
  are listed (`calendar-query` for ETags) and only changed tasks are downloaded
  (`calendar-multiget`).
- Conflicts (a task changed on another device in the meantime) keep the server's version
  and show a notice.

## Development

Requirements: Node 22+, Rust (stable), and for Windows builds the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (MSVC build tools; WebView2).

```sh
npm install
npm run app:dev      # run the desktop app with hot reload
npm run app:build    # build installers (target/release/bundle)
```

`npm run dev` serves the UI in a normal browser with an in-memory demo backend, handy for
working on the UI only (append `?setup` to the URL to see the sign-in screen; the demo
password is `demo`).

### Tests

```sh
npm test                     # UI logic (quick-add parser, views)
cargo test -p tasks-core     # iCalendar, recurrence, store, auth unit tests

# End-to-end against a real sabre/dav server configured exactly like Baikal:
cd tools/baikal-dev-server && composer install
php -S 127.0.0.1:8800 router.php &                    # Digest auth (Baikal default)
BAIKAL_AUTH=Basic php -S 127.0.0.1:8801 router.php &  # Basic auth
cd ../..
TASKSNG_TEST_URL=http://127.0.0.1:8800 cargo test -p tasks-core --test baikal -- --test-threads=1
TASKSNG_TEST_URL=http://127.0.0.1:8801 cargo test -p tasks-core --test baikal -- --test-threads=1
```

CI (`.github/workflows/build.yml`) runs all of the above and builds the Windows installers
on `windows-latest` for every push.

### Releases

One-time setup: add the updater signing key as a repository secret named
`TAURI_SIGNING_PRIVATE_KEY` (*Settings → Secrets and variables → Actions*). If the key has a
password, also add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep a backup of the key: installed
copies only accept updates signed with it.

To publish a release, either run the **Build** workflow from the *Actions* tab
(*Run workflow*, enter a version such as `0.2.0`), or push a tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

CI builds the installers with that version, signs them, generates `latest.json`
(`scripts/updater-manifest.mjs`) and publishes everything as a GitHub release. Installed
copies pick it up automatically. Versions must be plain `X.Y.Z`; the MSI format doesn't allow
pre-release suffixes.

To use a different signing key, run `npx tauri signer generate -w tasksng.key`, put the
contents of `tasksng.key.pub` into `plugins.updater.pubkey`, and store `tasksng.key` in the
secret. Copies installed before the switch only accept updates signed with the old key, so
they need to be updated by hand once.

### Project layout

```
crates/tasks-core/      platform independent sync engine (Rust)
src-tauri/              desktop shell: commands, background sync, credential storage
src/                    React UI
  components/ui/        shadcn/ui components
  components/           app components (sidebar, task list, details, dialogs)
  lib/                  store, API bindings, date & quick-add parsing, view logic
tools/baikal-dev-server Baikal-equivalent CalDAV server for development and tests
scripts/                release helpers used by CI (version stamping, updater manifest)
```

Data lives in `%APPDATA%\app.tasksng.desktop\tasks-cache.json`; logs are written to
`%LOCALAPPDATA%\app.tasksng.desktop\logs\`.
