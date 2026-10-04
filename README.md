# TasksNG

A fast, keyboard-friendly task manager for Windows 10 and 11 and Linux (packaged for
[NixOS](#nixos-and-nix)) that syncs with your [Baikal](https://sabre.io/baikal/) server (and
other CalDAV servers built on sabre/dav).

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

- Smart lists: **Today** (incl. overdue and tasks starting today), **Upcoming** (grouped by day),
  **Important**, **All tasks**
- Your Baikal calendars that hold tasks appear as lists; create, rename, recolor and delete lists
- **Reminders** as Windows notifications with *Snooze* and *Done* buttons. They are standard
  iCalendar alarms, so reminders set in Thunderbird, on an iPhone or in Tasks.org work here too
  (and the other way round). Tasks with a due time can get an automatic reminder (Settings).
- **Runs in the notification area**: closing the window keeps TasksNG (and reminders) running;
  optionally starts with Windows
- **Quick add from anywhere**: <kbd>Win</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> (configurable) opens a
  small box on top of whatever you're doing
- Quick add with shortcuts: `Pay rent tomorrow 9am !1 #home @personal every month`
  - dates: `today`, `tomorrow`, weekdays (`fri`), `next week`, `in 3 days`, `2026-12-01`
  - start dates: `from fri`, `starting next week`
  - times: `9am`, `17:30`
  - priority: `!1` / `!2` / `!3` (or `!!!`, `!high` …), tags: `#tag`, list: `@name`
  - repeat: `daily`, `weekdays`, `every 2 weeks`, `every tue and thu`, `every 15th`,
    `every last friday`, `every 3 days after completion` …
- Due and start dates (tasks that start later stay out of the way until then), priority,
  status (to do, in progress, done, cancelled), tags, notes, subtasks
- Repeating tasks: every n days/weeks/months/years, chosen weekdays, a day of the month or "the
  last Friday", a number of times or until a date, or counted from completion. Completing one
  moves it to the next occurrence; cancelling skips one.
- Notes with Markdown: **bold**, _italic_, lists, `- [ ]` checklists you can tick, clickable links
- Drag and drop: reorder tasks, drop onto another task to make a subtask, onto a list to move it,
  onto *Today* / *Important* or a tag to set those
- Sort each list by due date, priority, title, creation date or manually
- Tags in the sidebar, and **saved searches** using filters (see below)
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
| <kbd>Win</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> | Quick add from anywhere (configurable) |
| <kbd>N</kbd> / <kbd>Ctrl</kbd>+<kbd>N</kbd> | New task |
| <kbd>Ctrl</kbd>+<kbd>K</kbd> | Command palette / jump to any task, list, tag or saved search |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> or <kbd>/</kbd> | Search |
| <kbd>↑</kbd> <kbd>↓</kbd> (or <kbd>J</kbd> <kbd>K</kbd>) | Move selection |
| <kbd>Space</kbd> | Complete / reopen |
| <kbd>I</kbd> | Mark as in progress |
| <kbd>Alt</kbd>+<kbd>↑</kbd> <kbd>↓</kbd> | Move the task up / down (manual order) |
| <kbd>Alt</kbd>+<kbd>→</kbd> <kbd>←</kbd> | Make it a subtask of the task above / move it out |
| <kbd>Enter</kbd> / <kbd>F2</kbd> | Edit title |
| <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> <kbd>0</kbd> | High / medium / low / no priority |
| <kbd>T</kbd> / <kbd>M</kbd> | Due today / tomorrow |
| <kbd>Del</kbd> | Delete (with undo) |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo delete |
| <kbd>Ctrl</kbd>+<kbd>H</kbd> | Show / hide completed |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>9</kbd> | Switch list |
| <kbd>Ctrl</kbd>+<kbd>B</kbd> | Toggle sidebar |
| <kbd>F5</kbd> | Sync now |

### Search filters

The search box and saved searches understand filters; put `-` in front of anything to exclude it.

| Filter | Finds |
| --- | --- |
| `milk` | tasks with "milk" in the title, notes or tags |
| `#home` | tagged *home* |
| `!1` `!2` `!3` | high, medium, low priority |
| `list:Work`, `list:"Big project"` | tasks in a list |
| `due:today` `due:tomorrow` `due:overdue` `due:week` `due:none` `due:2026-12-01` | by due date |
| `is:open` `is:done` `is:progress` `is:cancelled` `is:repeating` `is:reminder` `is:subtask` `is:later` | by state |

For example `#work !1 -is:progress due:week`. Click the bookmark next to the search box to keep a
search in the sidebar.

## Install

### Windows

Download the latest build from the **Actions** tab (artifact `TasksNG-windows-x64`) or from
**Releases** when a version is tagged:

- `TasksNG_x.y.z_x64-setup.exe`: per-user installer, no admin rights needed (recommended)
- `TasksNG_x.y.z_x64_en-GB.msi`: per-machine installer for managed deployments (British
  English)
- `TasksNG-portable.exe`: single executable, no installation (needs WebView2, which is
  part of Windows 11 and of up-to-date Windows 10). The portable version doesn't update
  itself; installed versions do.

### NixOS and Nix

The repository is a flake with the package (`x86_64-linux`, `aarch64-linux`), a NixOS module,
an overlay and a development shell. Try it without installing:

```sh
nix run github:sshahs/tasksng
```

Install it system-wide with the NixOS module:

```nix
# flake.nix
{
  inputs.tasksng.url = "github:sshahs/tasksng";
  # Optional: build against your nixpkgs instead of the one CI tests with.
  # inputs.tasksng.inputs.nixpkgs.follows = "nixpkgs";

  outputs = { nixpkgs, tasksng, ... }: {
    nixosConfigurations.my-pc = nixpkgs.lib.nixosSystem {
      modules = [
        tasksng.nixosModules.default
        {
          programs.tasksng.enable = true;
          # programs.tasksng.autostart = true; # start in the background at login, for everyone
          # programs.tasksng.keyring = true;   # GNOME Keyring for window managers (Sway, Hyprland, i3 …)
        }
      ];
    };
  };
}
```

Or add the package yourself: `tasksng.packages.${pkgs.system}.default` in
`environment.systemPackages` or Home Manager's `home.packages`, or use `tasksng.overlays.default`
to get `pkgs.tasksng`. Without flakes, import `nix/module.nix` from a checkout (or call
`nix/package.nix` with `callPackage`). `nix profile install github:sshahs/tasksng` works too.

Updates come with your system: `nix flake update tasksng` and then `nixos-rebuild switch` (or
`home-manager switch`, `nix profile upgrade`). TasksNG doesn't update itself when installed with
Nix. To update the running copy, quit it (tray menu or <kbd>Ctrl</kbd>+<kbd>Q</kbd>) and start
it again.

On Linux:

- **Password**: stored in your desktop's keyring through the Secret Service API (GNOME Keyring,
  KWallet, KeePassXC …). Without one (e.g. a bare window manager), it is kept in a file only you
  can read (`~/.local/share/app.tasksng.desktop/credentials.json`) and moved into the keyring
  once one is running. `programs.tasksng.keyring = true` turns on GNOME Keyring.
- **Reminders** are desktop notifications (any freedesktop notification server: GNOME, KDE,
  dunst, mako, swaync …) with *Snooze* and *Done* buttons where the server supports buttons.
- **Tray icon**: shown wherever StatusNotifierItem/AppIndicator icons are (KDE, Waybar, most
  panels; GNOME needs the *AppIndicator and KStatusNotifierItem Support* extension). Without a
  tray, closing the window still keeps TasksNG running for reminders: open it again from the
  app launcher and quit with <kbd>Ctrl</kbd>+<kbd>Q</kbd> or *Quit TasksNG* in the command
  palette. You can also turn off *Keep running in the background* in Settings.
- **Quick add**: the global shortcut works on X11. Wayland doesn't let apps grab keys, so bind a
  shortcut in your desktop's keyboard settings to the command `tasksng --quick-add` (Sway:
  `bindsym $mod+Alt+n exec tasksng --quick-add`; Hyprland:
  `bind = SUPER ALT, N, exec, tasksng --quick-add`). For tiling window managers, float the box:
  `for_window [title="^Quick add · TasksNG$"] floating enable` (Sway/i3) or
  `windowrulev2 = float, title:^(Quick add · TasksNG)$` (Hyprland).
- **Start at login** (Settings) writes `~/.config/autostart/TasksNG.desktop`, which runs
  `tasksng --hidden` from your profile, so it keeps working after updates and garbage
  collection.
- **Self-signed certificates**: add your CA with `security.pki.certificateFiles` rather than
  turning on *Accept invalid TLS certificates*.
- Command line: `tasksng --quick-add | --show | --sync | --quit | --hidden | --version`. With
  TasksNG running, these act on the running copy.

### First start

On first start, enter your Baikal address (e.g. `https://dav.example.com`), username and
password. The app discovers your task lists automatically via `/.well-known/caldav` or
`/dav.php`; if your Baikal lives in a sub folder, enter the full URL ending in `dav.php`,
e.g. `https://example.com/baikal/html/dav.php`.

Calendars that only allow events are not shown. In Baikal, a calendar's components are set
in the admin panel (*Users and resources → Calendars*); new lists created from TasksNG are
task-only calendars.

## Reminders and running in the background

TasksNG shows reminders while it runs, so by default closing the window keeps it running in the
notification area (next to the clock); right-click its icon to quit. (On Linux, see
[NixOS and Nix](#nixos-and-nix) for desktops without a tray.) Settings has options to quit
on close instead and to start TasksNG when you sign in to Windows (it then starts quietly in the
notification area).

- Reminders are the tasks' iCalendar alarms (`VALARM`), shared with other CalDAV apps. Which
  reminders were shown and snoozes are remembered on this PC only.
- Tasks with a due time and no reminder of their own get an automatic one (at the due time by
  default; adjustable or off in Settings). This is local and isn't written to the server.
- Reminders missed while TasksNG wasn't running are shown when it starts, if they are less than a
  day old.
- If notifications don't appear, check *Settings → System → Notifications* in Windows (and Focus /
  Do not disturb). *Settings → Send a test notification* in TasksNG shows a sample.

## Updates
## How it works

```
┌──────────────── WebView2 ────────────────┐      ┌──────────── Rust ─────────────┐
│ React + shadcn/ui                        │ IPC  │ tauri commands, tray, toasts  │
│ zustand store (optimistic updates)       │◄────►│ tasks-core                    │
└──────────────────────────────────────────┘      │  ├ store.rs  local cache (JSON)│
                                                  │  ├ sync.rs   push → pull       │
                                                  │  ├ dav/      CalDAV client     │
                                                  │  ├ ical.rs   lossless iCal     │
                                                  │  ├ model.rs  VTODO ⇄ Task      │
                                                  │  ├ recur.rs  repeat rules      │
                                                  │  └ alarms.rs reminders due     │
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
- Manual order is stored in `X-APPLE-SORT-ORDER` (as Apple Reminders and Tasks.org do);
  "repeat after completion" in `X-TASKSNG-REPEAT-FROM`, since iCalendar has no field for it.

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
npm test                     # UI logic (quick add, views, search, sorting, drag and drop, Markdown, repeat rules)
cargo test -p tasks-core     # iCalendar, recurrence, reminders, store, auth unit tests
cargo test -p tasksng        # notification payloads, command line, password file (needs the Tauri build dependencies)

# End-to-end against a real sabre/dav server configured exactly like Baikal:
cd tools/baikal-dev-server && composer install
php -S 127.0.0.1:8800 router.php &                    # Digest auth (Baikal default)
BAIKAL_AUTH=Basic php -S 127.0.0.1:8801 router.php &  # Basic auth
cd ../..
TASKSNG_TEST_URL=http://127.0.0.1:8800 cargo test -p tasks-core --test baikal -- --test-threads=1
TASKSNG_TEST_URL=http://127.0.0.1:8801 cargo test -p tasks-core --test baikal -- --test-threads=1
```

CI (`.github/workflows/build.yml`) runs all of the above, builds the Windows installers
on `windows-latest` and builds the Nix package and checks the NixOS module for every push.

### Nix

`nix develop` gives a shell with Rust, Node, the GTK/WebKit libraries, `cargo tauri` and PHP
for the Baikal test server; `npm install && npm run app:dev` then runs the app. `nix build`
builds the package (`./result/bin/tasksng`), `nix flake check` also checks the NixOS module, and
`nix fmt` formats the Nix files. The package reads its version from `src-tauri/tauri.conf.json`
and needs no hashes: Rust crates and npm packages are taken from `Cargo.lock` and
`package-lock.json`, so dependency updates need no change to the Nix files.

### Releases

One-time setup: add the updater signing key as a repository secret named
`TAURI_SIGNING_PRIVATE_KEY` (*Settings → Secrets and variables → Actions*). If the key has a
password, also add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep a backup of the key: installed
copies only accept updates signed with it.

First set the new version in `src-tauri/tauri.conf.json`, `package.json` (`npm version X.Y.Z
--no-git-tag-version`) and the workspace `Cargo.toml`, and commit it: the Nix package reads its
version from the repository, while the Windows builds get it from CI.

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

Data lives in `%APPDATA%\app.tasksng.desktop\`: `tasks-cache.json` (tasks and pending
changes), `settings.json` and `reminders.json`. Logs are written to
`%LOCALAPPDATA%\app.tasksng.desktop\logs\`. Saved searches, sort orders and view preferences
are kept in the app's web storage.
