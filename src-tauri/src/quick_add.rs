//! The small "quick add" window that the global shortcut and the tray menu
//! open on top of whatever app is in front.

use std::sync::atomic::Ordering;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::AppState;

pub const LABEL: &str = "quick-add";
const WIDTH: f64 = 640.0;
const HEIGHT: f64 = 132.0;

/// Creates the (hidden) window ahead of time so the shortcut opens it
/// instantly.
pub fn prepare(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
        .title("Quick add · TasksNG")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .shadow(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(true)
        .build();
    match built {
        Ok(w) => Some(w),
        Err(e) => {
            log::error!("creating the quick add window failed: {e}");
            None
        }
    }
}

/// Centres the window near the top of the screen the mouse is on.
fn place(app: &AppHandle, window: &WebviewWindow) {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|c| app.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        let _ = window.center();
        return;
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let (w, h) = ((WIDTH * scale) as i32, (HEIGHT * scale) as i32);
    let x = area.position.x + (area.size.width as i32 - w) / 2;
    let y = area.position.y + ((area.size.height as i32 - h) as f64 * 0.28) as i32;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

pub fn show(app: &AppHandle) {
    log::info!("opening quick add");
    let state = app.state::<AppState>();
    let fresh = app.get_webview_window(LABEL).is_none();
    let Some(window) = prepare(app) else { return };
    place(app, &window);
    if fresh || !state.quick_add_loaded.load(Ordering::SeqCst) {
        // Shown by `quick_add_ready` once the page has painted.
        state.quick_add_pending.store(true, Ordering::SeqCst);
        return;
    }
    reveal(&window);
}

fn reveal(window: &WebviewWindow) {
    let _ = window.emit_to(LABEL, "quick-add-open", ());
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn toggle(app: &AppHandle) {
    match app.get_webview_window(LABEL) {
        Some(w) if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) => hide(app),
        _ => show(app),
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}

/// The page in the quick add window has loaded.
pub fn ready(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.quick_add_loaded.store(true, Ordering::SeqCst);
    if state.quick_add_pending.swap(false, Ordering::SeqCst) {
        if let Some(w) = app.get_webview_window(LABEL) {
            reveal(&w);
        }
    }
}
