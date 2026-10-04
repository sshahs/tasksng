//! End-to-end tests against a Baikal (sabre/dav) server.
//!
//! Start `tools/baikal-dev-server` and run:
//!   TASKSNG_TEST_URL=http://127.0.0.1:8800 cargo test -p tasks-core --test baikal -- --test-threads=1
//! Without the variable the tests are skipped.

use std::sync::Mutex;

use reqwest::Url;
use tasks_core::dav::{normalize_url, Credentials, DavClient, PutCondition, WriteResult};
use tasks_core::model::{NewTask, PatchOutcome, TaskPatch, TaskStatus};
use tasks_core::store::{Account, Store};
use tasks_core::sync::{self, SyncReport};
use tasks_core::Error;

fn server() -> Option<String> {
    std::env::var("TASKSNG_TEST_URL").ok().filter(|s| !s.is_empty())
}

struct Device {
    store: Mutex<Store>,
    client: DavClient,
    home: Url,
}

impl Device {
    async fn connect(url: &str, user: &str, pass: &str) -> Result<Device, Error> {
        let input = normalize_url(url)?;
        let client = DavClient::new(&input, Credentials { username: user.into(), password: pass.into() }, false)?;
        let (home, disc) = client.discover(&input).await?;
        let mut store = Store::in_memory();
        store.set_account(Account {
            server_url: url.into(),
            username: user.into(),
            principal_url: disc.principal_url,
            home_url: disc.home_url,
            accept_invalid_certs: false,
        });
        Ok(Device { store: Mutex::new(store), client, home })
    }

    async fn sync(&self) -> SyncReport {
        sync::sync(&self.store, &self.client, &self.home, &self.home).await.expect("sync")
    }

    fn store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store.lock().unwrap()
    }

    async fn new_list(&self, name: &str) -> String {
        let href = self.client.make_calendar(&self.home, name, Some("#10B981")).await.expect("mkcalendar");
        self.sync().await;
        href
    }

    async fn drop_list(&self, href: &str) {
        self.client.delete_calendar(&self.home.join(href).unwrap()).await.expect("delete calendar");
    }

    async fn raw(&self, href: &str) -> String {
        let r = self.client.send("GET", &self.home.join(href).unwrap(), &[], None).await.unwrap();
        assert!(r.status.is_success(), "GET {href}: {}", r.status);
        r.body
    }
}

macro_rules! need_server {
    () => {
        match server() {
            Some(s) => s,
            None => {
                eprintln!("TASKSNG_TEST_URL not set; skipping");
                return;
            }
        }
    };
}

#[tokio::test]
async fn discovery_and_auth() {
    let url = need_server!();
    // From the bare host (well-known / dav.php probing) …
    let d = Device::connect(&url, "test", "test").await.expect("discover from root");
    assert!(d.home.path().ends_with("/dav.php/calendars/test/"), "{}", d.home);
    // … and from the explicit endpoint.
    Device::connect(&format!("{url}/dav.php"), "test", "test").await.expect("discover from dav.php");
    // Wrong password.
    match Device::connect(&url, "test", "nope").await {
        Err(Error::Unauthorized) => {}
        Err(e) => panic!("expected Unauthorized, got {e:?}"),
        Ok(_) => panic!("expected Unauthorized, got Ok"),
    }
    // Unreachable host.
    match Device::connect("http://127.0.0.1:1", "test", "test").await {
        Err(e) => assert!(e.is_offline(), "{e:?}"),
        Ok(_) => panic!("expected network error"),
    }
}

#[tokio::test]
async fn only_task_lists_are_listed() {
    let url = need_server!();
    let d = Device::connect(&url, "test", "test").await.unwrap();
    d.sync().await;
    let store = d.store();
    let names: Vec<_> = store.lists().iter().map(|l| l.name.clone()).collect();
    assert!(names.contains(&"Default calendar".to_string()), "{names:?}");
    assert!(!names.contains(&"Events only".to_string()), "{names:?}");
    let default = store.lists().iter().find(|l| l.name == "Default calendar").unwrap();
    assert_eq!(default.color.as_deref(), Some("#2563EB"));
    assert!(!default.read_only);
}

#[tokio::test]
async fn round_trip_between_two_devices() {
    let url = need_server!();
    let a = Device::connect(&url, "test", "test").await.unwrap();
    let b = Device::connect(&url, "test", "test").await.unwrap();
    let list = a.new_list("Round trip").await;
    b.sync().await;

    // Create on A with every field the UI can set.
    let parent = a.store().create_task(&list, &NewTask { summary: "Plan trip".into(), ..Default::default() }).unwrap();
    let child = a
        .store()
        .create_task(
            &list,
            &NewTask {
                summary: "Book hotel, cheap; central".into(),
                description: Some("Line 1\nLine 2".into()),
                priority: Some(1),
                due: Some("2026-11-02T15:30:00Z".into()),
                categories: vec!["Travel".into(), "Money, mostly".into()],
                parent_uid: Some(parent.uid.clone()),
                rrule: None,
            },
        )
        .unwrap();
    let report = a.sync().await;
    assert!(report.notices.is_empty(), "{:?}", report.notices);
    assert_eq!(a.store().pending_count(), 0);

    // B sees exactly what A wrote.
    b.sync().await;
    let t = b.store().task(&child.id).cloned().expect("child on B");
    assert_eq!(t.summary, "Book hotel, cheap; central");
    assert_eq!(t.description, "Line 1\nLine 2");
    assert_eq!(t.priority, 1);
    assert_eq!(t.due.as_deref(), Some("2026-11-02T15:30:00Z"));
    assert_eq!(t.categories, vec!["Travel", "Money, mostly"]);
    assert_eq!(t.parent_uid.as_deref(), Some(parent.uid.as_str()));

    // Complete on B, A picks it up.
    b.store().update_task(&t.id, &TaskPatch { status: Some(TaskStatus::Completed), ..Default::default() }).unwrap();
    b.sync().await;
    a.sync().await;
    assert!(a.store().task(&child.id).unwrap().completed);

    // Deleting the parent on A removes the subtask everywhere.
    a.store().delete_tasks(std::slice::from_ref(&parent.id)).unwrap();
    a.sync().await;
    b.sync().await;
    assert!(b.store().task(&parent.id).is_none());
    assert!(b.store().task(&child.id).is_none());

    a.drop_list(&list).await;
    a.sync().await;
    assert!(a.store().lists().iter().all(|l| l.id != list));
}

#[tokio::test]
async fn concurrent_edit_keeps_server_version() {
    let url = need_server!();
    let a = Device::connect(&url, "test", "test").await.unwrap();
    let b = Device::connect(&url, "test", "test").await.unwrap();
    let list = a.new_list("Conflicts").await;
    let t = a.store().create_task(&list, &NewTask { summary: "original".into(), ..Default::default() }).unwrap();
    a.sync().await;
    b.sync().await;

    b.store().update_task(&t.id, &TaskPatch { summary: Some("from B".into()), ..Default::default() }).unwrap();
    b.sync().await;
    a.store().update_task(&t.id, &TaskPatch { summary: Some("from A".into()), ..Default::default() }).unwrap();
    let report = a.sync().await;
    assert_eq!(report.notices.len(), 1, "{:?}", report.notices);
    assert_eq!(a.store().task(&t.id).unwrap().summary, "from B");
    assert_eq!(a.store().pending_count(), 0);

    // Deleted on B while edited on A.
    b.sync().await;
    b.store().delete_tasks(std::slice::from_ref(&t.id)).unwrap();
    b.sync().await;
    a.store().update_task(&t.id, &TaskPatch { summary: Some("too late".into()), ..Default::default() }).unwrap();
    let report = a.sync().await;
    assert_eq!(report.notices.len(), 1, "{:?}", report.notices);
    assert!(a.store().task(&t.id).is_none());
    a.drop_list(&list).await;
}

#[tokio::test]
async fn move_between_lists_and_list_management() {
    let url = need_server!();
    let a = Device::connect(&url, "test", "test").await.unwrap();
    let one = a.new_list("One").await;
    let two = a.new_list("Two").await;
    let t = a.store().create_task(&one, &NewTask { summary: "wanderer".into(), ..Default::default() }).unwrap();
    a.sync().await;
    let moved = a.store().move_task(&t.id, &two).unwrap();
    a.sync().await;
    assert_eq!(a.store().pending_count(), 0);

    let b = Device::connect(&url, "test", "test").await.unwrap();
    b.sync().await;
    assert!(b.store().task(&t.id).is_none());
    assert_eq!(b.store().task(&moved.id).unwrap().list_id, two);

    // Move back before syncing (revives the pending deletion).
    let back = a.store().move_task(&moved.id, &one).unwrap();
    let again = a.store().move_task(&back.id, &two).unwrap();
    let back = a.store().move_task(&again.id, &one).unwrap();
    let report = a.sync().await;
    assert!(report.notices.is_empty(), "{:?}", report.notices);
    b.sync().await;
    assert_eq!(b.store().task(&back.id).unwrap().list_id, one);
    assert!(b.store().task(&moved.id).is_none());

    // Rename + recolor.
    a.client.update_calendar(&a.home.join(&two).unwrap(), Some("Zwei ✓"), Some("#EF4444")).await.unwrap();
    b.sync().await;
    let l = b.store().lists().iter().find(|l| l.id == two).cloned().unwrap();
    assert_eq!(l.name, "Zwei ✓");
    assert_eq!(l.color.as_deref(), Some("#EF4444"));

    a.drop_list(&one).await;
    a.drop_list(&two).await;
}

#[tokio::test]
async fn server_accepts_what_we_write() {
    let url = need_server!();
    let a = Device::connect(&url, "test", "test").await.unwrap();
    let list = a.new_list("Validation").await;

    // Repeating task: completing it moves it forward.
    let t = a
        .store()
        .create_task(&list, &NewTask { summary: "water plants".into(), due: Some("2026-10-04".into()), rrule: Some("FREQ=WEEKLY".into()), ..Default::default() })
        .unwrap();
    let (_, outcome) = a.store().update_task(&t.id, &TaskPatch { status: Some(TaskStatus::Completed), ..Default::default() }).unwrap();
    assert!(matches!(outcome, PatchOutcome::Advanced { .. }));
    let report = a.sync().await;
    assert!(report.notices.is_empty(), "{:?}", report.notices);

    // A task written by another client with a start date, alarm and custom
    // properties; our edits must keep it valid and keep foreign data.
    let foreign_href = format!("{list}foreign-1.ics");
    let foreign = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Other//EN\r\nBEGIN:VTODO\r\nUID:foreign-1\r\nDTSTAMP:20260101T000000Z\r\nDTSTART:20261010T090000Z\r\nDUE:20261012T090000Z\r\nSUMMARY:From another app\r\nX-OTHER-APP-ID:1234\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Reminder\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\nEND:VTODO\r\nEND:VCALENDAR\r\n";
    let r = a.client.put(&a.home.join(&foreign_href).unwrap(), foreign, &PutCondition::Create).await.unwrap();
    assert!(matches!(r, WriteResult::Ok { .. }));
    a.sync().await;
    // An all-day due date before the timed start: must be normalised or the
    // server rejects it.
    a.store()
        .update_task(&foreign_href, &TaskPatch { due: Some(Some("2026-10-05".into())), summary: Some("Edited here".into()), ..Default::default() })
        .unwrap();
    let report = a.sync().await;
    assert!(report.notices.is_empty(), "{:?}", report.notices);
    let raw = a.raw(&foreign_href).await;
    assert!(raw.contains("SUMMARY:Edited here"), "{raw}");
    assert!(raw.contains("X-OTHER-APP-ID:1234"), "{raw}");
    assert!(raw.contains("TRIGGER:-PT15M"), "{raw}");

    // Second user can't see the first user's lists.
    let other = Device::connect(&url, "other", "other").await.unwrap();
    other.sync().await;
    assert!(other.store().lists().iter().all(|l| l.id != list));

    a.drop_list(&list).await;
}

#[tokio::test]
async fn incremental_sync_downloads_only_changes() {
    let url = need_server!();
    let a = Device::connect(&url, "test", "test").await.unwrap();
    let list = a.new_list("Incremental").await;
    for i in 0..30 {
        a.store().create_task(&list, &NewTask { summary: format!("task {i}"), ..Default::default() }).unwrap();
    }
    a.sync().await;
    let b = Device::connect(&url, "test", "test").await.unwrap();
    b.sync().await;
    let rev = b.store().revision();
    // Nothing changed: the ctag short-circuits and the store stays untouched
    // apart from the sync timestamp.
    b.sync().await;
    assert_eq!(b.store().revision(), rev + 1);
    let count = b.store().snapshot().tasks.iter().filter(|t| t.list_id == list).count();
    assert_eq!(count, 30);
    a.drop_list(&list).await;
}
