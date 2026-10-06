//! Facts about the desktop TasksNG runs on (mostly relevant on Linux, where
//! sessions differ a lot: X11 or Wayland, with or without a tray).

/// How this copy was installed, which decides how it gets updated.
pub fn install_kind() -> &'static str {
    let exe = std::env::current_exe().unwrap_or_default();
    if cfg!(target_os = "android") {
        "android"
    } else if exe.starts_with("/nix/store") {
        "nix"
    } else if std::env::var_os("APPIMAGE").is_some() {
        "appimage"
    } else if cfg!(windows) {
        "windows"
    } else {
        "system"
    }
}

/// A Wayland session, where apps can't register global shortcuts.
pub fn wayland_session() -> bool {
    cfg!(target_os = "linux")
        && (std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|t| t.eq_ignore_ascii_case("wayland")))
}

/// tray-icon loads the AppIndicator library at runtime and aborts the
/// process when it can't (the release profile has panic = "abort"), so look
/// for it first.
#[cfg(target_os = "linux")]
pub fn tray_library_available() -> bool {
    // Packages that patch the library's full path into libappindicator-sys
    // (Nix) pass the same path here at build time.
    option_env!("TASKSNG_APPINDICATOR")
        .into_iter()
        .chain(["libayatana-appindicator3.so.1", "libappindicator3.so.1"])
        // SAFETY: loading a well-known system library; nothing is called.
        .any(|name| unsafe { libloading::Library::new(name) }.is_ok())
}

#[cfg(all(desktop, not(target_os = "linux")))]
pub fn tray_library_available() -> bool {
    true
}

/// Whether something shows tray icons right now (KDE, waybar, GNOME with the
/// AppIndicator extension …). GNOME alone has no tray.
#[cfg(target_os = "linux")]
pub fn tray_host_present() -> bool {
    let Ok(conn) = zbus::blocking::Connection::session() else { return false };
    let Ok(dbus) = zbus::blocking::fdo::DBusProxy::new(&conn) else { return false };
    let Ok(name) = zbus::names::BusName::try_from("org.kde.StatusNotifierWatcher") else { return false };
    dbus.name_has_owner(name).unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
pub fn tray_host_present() -> bool {
    true
}
