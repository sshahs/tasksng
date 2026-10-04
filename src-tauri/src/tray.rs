//! The notification area ("system tray") icon.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::{quick_add, show_main_window, AppState};

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open TasksNG", true, None::<&str>)?;
    let add = MenuItem::with_id(app, "quick-add", "New task…", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit TasksNG", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &add, &sync, &separator, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("TasksNG")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main_window(app),
            "quick-add" => quick_add::show(app),
            "sync" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let _ = crate::run_sync(&app, &state).await;
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
