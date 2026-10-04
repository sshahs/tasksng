#![cfg_attr(not(windows), allow(dead_code))]

//! Windows notifications ("toasts").
//!
//! Reminder toasts carry *Snooze* (with a duration picker) and *Done*
//! buttons. Clicks are delivered to this process while it runs, which it does
//! in the notification area. On other platforms (development only) showing a
//! toast fails and the caller falls back to an in-app message.

use std::path::Path;
use std::sync::Arc;

pub struct Toast {
    pub title: String,
    pub body: String,
    /// Reminder toasts get Snooze/Done buttons and stay until dismissed.
    pub reminder_uid: Option<String>,
    /// Task to open when the toast itself is clicked.
    pub open_uid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToastAction {
    Open(Option<String>),
    Done(String),
    Snooze(String, u32),
}

pub type Handler = Arc<dyn Fn(ToastAction) + Send + Sync>;

pub const SNOOZE_CHOICES: [(u32, &str); 6] = [
    (5, "5 minutes"),
    (10, "10 minutes"),
    (30, "30 minutes"),
    (60, "1 hour"),
    (240, "4 hours"),
    (1440, "1 day"),
];
pub const DEFAULT_SNOOZE: u32 = 10;

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The toast's XML payload.
pub fn toast_xml(t: &Toast) -> String {
    let launch = format!("open|{}", t.open_uid.as_deref().unwrap_or_default());
    let mut xml = String::new();
    let scenario = if t.reminder_uid.is_some() { r#" scenario="reminder""# } else { "" };
    xml.push_str(&format!(r#"<toast launch="{}"{scenario}><visual><binding template="ToastGeneric">"#, escape(&launch)));
    xml.push_str(&format!(r#"<text hint-maxLines="2">{}</text>"#, escape(&t.title)));
    if !t.body.is_empty() {
        xml.push_str(&format!("<text>{}</text>", escape(&t.body)));
    }
    xml.push_str("</binding></visual>");
    if let Some(uid) = &t.reminder_uid {
        let uid = escape(uid);
        xml.push_str(&format!(r#"<actions><input id="snooze" type="selection" defaultInput="{DEFAULT_SNOOZE}">"#));
        for (minutes, label) in SNOOZE_CHOICES {
            xml.push_str(&format!(r#"<selection id="{minutes}" content="{label}"/>"#));
        }
        xml.push_str("</input>");
        xml.push_str(&format!(r#"<action activationType="foreground" arguments="snooze|{uid}" content="Snooze"/>"#));
        xml.push_str(&format!(r#"<action activationType="foreground" arguments="done|{uid}" content="Done"/>"#));
        xml.push_str("</actions>");
        xml.push_str(r#"<audio src="ms-winsoundevent:Notification.Reminder"/>"#);
    }
    xml.push_str("</toast>");
    xml
}

pub fn parse_action(arguments: &str, snooze_minutes: Option<u32>) -> ToastAction {
    let (kind, uid) = arguments.split_once('|').unwrap_or((arguments, ""));
    let uid = uid.to_string();
    match kind {
        "done" if !uid.is_empty() => ToastAction::Done(uid),
        "snooze" if !uid.is_empty() => ToastAction::Snooze(uid, snooze_minutes.unwrap_or(DEFAULT_SNOOZE)),
        _ => ToastAction::Open((!uid.is_empty()).then_some(uid)),
    }
}

/// Registers the app's notification identity (name and icon). Installed
/// copies also get it from their Start menu shortcut; this covers the MSI
/// and the portable exe.
pub fn register(app_id: &str, data_dir: &Path) {
    #[cfg(windows)]
    if let Err(e) = win::register(app_id, data_dir) {
        log::warn!("registering for notifications failed: {e}");
    }
    #[cfg(not(windows))]
    let _ = (app_id, data_dir);
}

pub fn show(app_id: &str, toast: &Toast, handler: Handler) -> Result<(), String> {
    #[cfg(windows)]
    {
        win::show(app_id, toast, handler).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (app_id, toast, handler);
        Err("notifications are only available on Windows".into())
    }
}

#[cfg(windows)]
mod win {
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Mutex;

    use windows::core::{IInspectable, Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::{IPropertyValue, TypedEventHandler};
    use windows::UI::Notifications::{
        ToastActivatedEventArgs, ToastDismissalReason, ToastDismissedEventArgs, ToastFailedEventArgs, ToastNotification,
        ToastNotificationManager,
    };

    use super::{parse_action, toast_xml, Handler, Toast};

    /// Toasts stay alive here so clicks on them (also from the notification
    /// centre) still reach their handlers.
    static LIVE: Mutex<Vec<(u64, ToastNotification)>> = Mutex::new(Vec::new());
    static NEXT: AtomicU64 = AtomicU64::new(1);
    const KEEP: usize = 64;

    fn forget(id: u64) {
        LIVE.lock().unwrap_or_else(|p| p.into_inner()).retain(|(i, _)| *i != id);
    }

    pub fn register(app_id: &str, data_dir: &Path) -> windows::core::Result<()> {
        let icon = data_dir.join("notification-icon.png");
        let bytes = include_bytes!("../icons/128x128@2x.png");
        if std::fs::metadata(&icon).map(|m| m.len() != bytes.len() as u64).unwrap_or(true) {
            let _ = std::fs::create_dir_all(data_dir);
            let _ = std::fs::write(&icon, bytes);
        }
        let key = windows_registry::CURRENT_USER.create(format!(r"Software\Classes\AppUserModelId\{app_id}"))?;
        key.set_string("DisplayName", "TasksNG")?;
        key.set_string("IconUri", icon.to_string_lossy().as_ref())?;
        Ok(())
    }

    fn snooze_minutes(args: &ToastActivatedEventArgs) -> Option<u32> {
        let input = args.UserInput().ok()?;
        let value = input.Lookup(&HSTRING::from("snooze")).ok()?;
        let text = value.cast::<IPropertyValue>().ok()?.GetString().ok()?;
        text.to_string().parse().ok()
    }

    pub fn show(app_id: &str, toast: &Toast, handler: Handler) -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(toast_xml(toast)))?;
        let notification = ToastNotification::CreateToastNotification(&doc)?;
        let id = NEXT.fetch_add(1, Ordering::Relaxed);

        notification.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
            if let Some(args) = args.as_ref().and_then(|a| a.cast::<ToastActivatedEventArgs>().ok()) {
                let arguments = args.Arguments().map(|a| a.to_string()).unwrap_or_default();
                handler(parse_action(&arguments, snooze_minutes(&args)));
            }
            forget(id);
            Ok(())
        }))?;
        notification.Dismissed(&TypedEventHandler::<ToastNotification, ToastDismissedEventArgs>::new(move |_, args| {
            // Timed-out toasts move to the notification centre and can
            // still be clicked there.
            let timed_out = args.as_ref().and_then(|a| a.Reason().ok()) == Some(ToastDismissalReason::TimedOut);
            if !timed_out {
                forget(id);
            }
            Ok(())
        }))?;
        notification.Failed(&TypedEventHandler::<ToastNotification, ToastFailedEventArgs>::new(move |_, _| {
            forget(id);
            Ok(())
        }))?;

        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&notification)?;
        let mut live = LIVE.lock().unwrap_or_else(|p| p.into_inner());
        live.push((id, notification));
        if live.len() > KEEP {
            let excess = live.len() - KEEP;
            live.drain(..excess);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_is_escaped_and_has_buttons() {
        let xml = toast_xml(&Toast {
            title: "Pay <rent> & \"bills\"".into(),
            body: "Due today at 09:00".into(),
            reminder_uid: Some("A&B".into()),
            open_uid: Some("A&B".into()),
        });
        assert!(xml.contains("Pay &lt;rent&gt; &amp; &quot;bills&quot;"));
        assert!(xml.contains(r#"launch="open|A&amp;B" scenario="reminder""#));
        assert!(xml.contains(r#"arguments="done|A&amp;B""#));
        assert!(xml.contains(r#"<selection id="60" content="1 hour"/>"#));

        let plain = toast_xml(&Toast { title: "Hi".into(), body: String::new(), reminder_uid: None, open_uid: None });
        assert_eq!(plain, r#"<toast launch="open|"><visual><binding template="ToastGeneric"><text hint-maxLines="2">Hi</text></binding></visual></toast>"#);
    }

    #[test]
    fn actions() {
        assert_eq!(parse_action("done|u-1", None), ToastAction::Done("u-1".into()));
        assert_eq!(parse_action("snooze|u|x", Some(30)), ToastAction::Snooze("u|x".into(), 30));
        assert_eq!(parse_action("snooze|u", None), ToastAction::Snooze("u".into(), DEFAULT_SNOOZE));
        assert_eq!(parse_action("open|", None), ToastAction::Open(None));
        assert_eq!(parse_action("open|u", None), ToastAction::Open(Some("u".into())));
        assert_eq!(parse_action("", None), ToastAction::Open(None));
    }
}
