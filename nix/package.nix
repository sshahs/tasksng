{
  lib,
  rustPlatform,
  cargo-tauri,
  importNpmLock,
  nodejs,
  pkg-config,
  versionCheckHook,
  wrapGAppsHook3,

  dbus,
  glib-networking,
  libayatana-appindicator,
  openssl,
  webkitgtk_4_1,
  xdg-utils,

  # Defaults to the version Tauri itself reports (config.version wins over
  # CARGO_PKG_VERSION). The flake may pass e.g. "0.2.1-unstable-2026-10-04";
  # tauriBuildFlags stamps whatever ends up here into the app and the .deb.
  version ? (lib.importJSON ../src-tauri/tauri.conf.json).version,
}:

let
  fs = lib.fileset;
in
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "tasksng";
  inherit version;

  # Only what the build reads, so README/CI/tools edits don't rebuild.
  src = fs.toSource {
    root = ../.;
    fileset = fs.unions [
      ../Cargo.toml
      ../Cargo.lock
      ../crates
      ../src-tauri
      ../package.json
      ../package-lock.json
      ../index.html
      ../src
      ../public
      ../assets
      ../vite.config.ts
      ../tsconfig.json
      ../tsconfig.app.json
      ../tsconfig.node.json
    ];
  };

  # Workspace and Cargo.lock are at the repo root (=> no cargoRoot); the Tauri
  # crate is the src-tauri member, where `cargo tauri build` has to run.
  # Hash-free: every crate comes from crates.io with a checksum in Cargo.lock.
  cargoLock.lockFile = ../Cargo.lock;
  buildAndTestSubdir = "src-tauri";

  # Hash-free npm deps: every package-lock.json (v3) entry has
  # `resolved` + `integrity`. Must be paired with importNpmLock.npmConfigHook.
  npmDeps = importNpmLock {
    package = lib.importJSON ../package.json;
    packageLock = lib.importJSON ../package-lock.json;
  };

  __structuredAttrs = true;

  # tray-icon -> libappindicator-sys dlopen()s "libayatana-appindicator3.so.1"
  # by soname; nothing links it, so it is not on the RUNPATH. Point it at the
  # store path (as deltachat-tauri, devpod, clash-verge-rev ... do).
  # importCargoLock vendors crates flat, hence no `*/` level in the glob
  # (fetchCargoVendor/cargoHash would need "$cargoDepsCopy"/*/libappindicator-sys-*).
  postPatch = ''
    substituteInPlace "$cargoDepsCopy"/libappindicator-sys-*/src/lib.rs \
      --replace-fail "libayatana-appindicator3.so.1" "$TASKSNG_APPINDICATOR"
  '';
  # TasksNG checks the library loads before creating the tray (tray-icon
  # aborts the process otherwise): src-tauri/src/desktop.rs.
  env.TASKSNG_APPINDICATOR = "${libayatana-appindicator}/lib/libayatana-appindicator3.so.1";

  nativeBuildInputs = [
    cargo-tauri.hook
    nodejs
    importNpmLock.npmConfigHook
    pkg-config
    wrapGAppsHook3 # webkitgtk_4_1 is the GTK3 flavour
  ];

  buildInputs = [
    dbus # libdbus-sys via tao's default "dbus" feature
    glib-networking # GIO TLS/proxy modules for WebKit
    libayatana-appindicator # tray (see postPatch)
    openssl # native-tls (reqwest, updater plugin)
    webkitgtk_4_1 # propagates gtk3 + libsoup_3
  ];

  # The hook already passes `--bundles deb` (overrides "targets": "all", so no
  # AppImage/linuxdeploy downloads). Additionally: never produce or sign
  # updater artifacts, and stamp the version into the app like CI does.
  tauriBuildFlags = [
    "--config"
    (builtins.toJSON {
      inherit (finalAttrs) version;
      bundle.createUpdaterArtifacts = false;
    })
    "--no-sign"
  ];

  # cargoCheckHook would run `cargo test --profile release` in src-tauri only
  # (3 small tests) and, because tests are always panic=unwind while the
  # release profile is panic=abort and the CLI-only tauri/custom-protocol
  # feature is missing, recompile the whole dependency tree with fat LTO.
  # The CI `test` job already runs tasks-core, Baikal e2e and vitest.
  doCheck = false;

  # `tasksng --version` works without a display, D-Bus or $HOME.
  nativeInstallCheckInputs = [ versionCheckHook ];
  doInstallCheck = true;

  # Links in notes open through xdg-open, also in minimal sessions.
  preFixup = ''
    gappsWrapperArgs+=(--prefix PATH : ${lib.makeBinPath [ xdg-utils ]})
  '';

  # The deb only carries 32, 128 and 256@2 PNGs; add a large and a scalable icon.
  postInstall = ''
    install -Dm644 src-tauri/icons/icon.png $out/share/icons/hicolor/512x512/apps/tasksng.png
    install -Dm644 assets/app-icon.svg $out/share/icons/hicolor/scalable/apps/tasksng.svg
  '';

  meta = {
    description = "Fast, keyboard-friendly task manager for Baikal and other CalDAV servers";
    homepage = "https://github.com/sshahs/tasksng";
    mainProgram = "tasksng";
    platforms = lib.platforms.linux;
    # No LICENSE file or license field in the repo: set meta.license once one is
    # chosen. (lib.licenses.unfree would force allowUnfree on every user.)
  };
})
