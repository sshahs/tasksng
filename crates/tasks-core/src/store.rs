//! Offline-first local task store.
//!
//! Every change is applied here first (so the UI never waits for the
//! network) and remembered as pending until the sync engine has written it to
//! the server. The whole store is persisted as one JSON file which loads in a
//! few milliseconds even with thousands of tasks.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::dav::{RemoteCalendar, RemoteObject, WriteResult};
use crate::events::CalEvent;
use crate::model::{self, NewTask, PatchOutcome, Task, TaskPatch};
use crate::{Error, Result};

const SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// The address as typed by the user.
    pub server_url: String,
    pub username: String,
    pub principal_url: String,
    pub home_url: String,
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskList {
    /// Collection path on the server, ending with `/`.
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub order: Option<i64>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ctag: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EntryState {
    Synced,
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub href: String,
    pub list_id: String,
    pub etag: Option<String>,
    pub ics: String,
    pub state: EntryState,
    /// Bumped on every local change; lets the sync engine detect edits made
    /// while a request was in flight.
    #[serde(default)]
    pub version: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    #[serde(default)]
    schema: u32,
    account: Option<Account>,
    #[serde(default)]
    lists: Vec<TaskList>,
    #[serde(default)]
    entries: Vec<Entry>,
    last_sync: Option<String>,
    #[serde(default)]
    conflicts: Vec<Conflict>,
    #[serde(default)]
    events: Vec<CachedEvents>,
    #[serde(default)]
    history: HashMap<String, Vec<Version>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub account: Option<Account>,
    pub lists: Vec<TaskList>,
    pub tasks: Vec<Task>,
    pub last_sync: Option<String>,
    pub pending: usize,
    pub conflicts: Vec<ConflictView>,
}

/// A task changed both here and on another device (or deleted on one and
/// changed on the other). The server's version is in the store; ours is kept
/// here until the user picks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub href: String,
    pub list_id: String,
    /// Our version, `None` when we had deleted the task.
    pub local: Option<String>,
    /// The other device deleted the task.
    #[serde(default)]
    pub remote_deleted: bool,
    /// Waiting for the server's version to be downloaded.
    #[serde(default)]
    pub awaiting: bool,
    pub at: String,
}

/// A conflict as the UI sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictView {
    pub id: String,
    pub list_id: String,
    /// This device's version (`None`: deleted here).
    pub mine: Option<Task>,
    /// The server's version (`None`: deleted on another device).
    pub theirs: Option<Task>,
    pub at: String,
}

/// How the user settled a conflict.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "keep")]
pub enum Resolution {
    /// The other device's version (or its deletion).
    Theirs,
    /// This device's version (or its deletion).
    Mine,
    /// The other device's version with some of our fields.
    Merge { patch: Box<TaskPatch> },
}

/// Whether two versions of a task say the same thing (timestamps aside).
fn same_content(a: &Task, b: &Task) -> bool {
    a.summary == b.summary
        && a.description == b.description
        && a.status == b.status
        && a.completed == b.completed
        && a.priority == b.priority
        && a.due == b.due
        && a.start == b.start
        && a.categories == b.categories
        && a.parent_uid == b.parent_uid
        && a.rrule == b.rrule
        && a.reminders == b.reminders
        && a.planned == b.planned
        && a.planned_minutes == b.planned_minutes
        && a.snoozed_until == b.snoozed_until
}

/// Where a version of a task came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VersionSource {
    /// Created on this device.
    Created,
    /// Changed on this device.
    Here,
    /// Changed on another device (arrived with a sync).
    Elsewhere,
    /// How the task was before its history started.
    Earlier,
}

/// One version of a task, kept so earlier ones can be looked at and restored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub at: String,
    pub source: VersionSource,
    pub ics: String,
}

/// A version as the UI sees it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionView {
    pub at: String,
    pub source: VersionSource,
    pub task: Task,
}

/// Versions kept per task.
const HISTORY: usize = 25;
/// Edits made on this device within this time count as one version (typing
/// a title shouldn't make a version per letter).
const COALESCE_SECS: i64 = 180;

/// Calendar events of a day (or any range) as last downloaded, so the day
/// planner shows them offline.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedEvents {
    pub from: String,
    pub to: String,
    pub fetched_at: String,
    pub events: Vec<CalEvent>,
}

/// How many ranges of events are kept.
const EVENT_CACHE: usize = 31;

/// A change that still has to be sent to the server.
#[derive(Debug, Clone)]
pub struct PendingOp {
    pub key: String,
    pub href: String,
    pub state: EntryState,
    pub etag: Option<String>,
    pub ics: String,
    pub version: u64,
    pub summary: String,
}

#[derive(Debug, Clone)]
struct UndoItem {
    key: String,
    before: Entry,
}

pub struct Store {
    path: Option<PathBuf>,
    account: Option<Account>,
    lists: Vec<TaskList>,
    entries: HashMap<String, Entry>,
    views: HashMap<String, Task>,
    last_sync: Option<String>,
    revision: u64,
    next_version: u64,
    undo: HashMap<u64, Vec<UndoItem>>,
    next_undo: u64,
    unsaved: bool,
    conflicts: HashMap<String, Conflict>,
    events: Vec<CachedEvents>,
    history: HashMap<String, Vec<Version>>,
}

/// Hrefs are compared percent-decoded so `/a%20b.ics` and `/a b.ics` match.
pub fn key_of(href: &str) -> String {
    percent_encoding::percent_decode_str(href).decode_utf8_lossy().into_owned()
}

impl Store {
    pub fn in_memory() -> Self {
        Store {
            path: None,
            account: None,
            lists: Vec::new(),
            entries: HashMap::new(),
            views: HashMap::new(),
            last_sync: None,
            revision: 1,
            next_version: 1,
            undo: HashMap::new(),
            next_undo: 1,
            unsaved: false,
            conflicts: HashMap::new(),
            events: Vec::new(),
            history: HashMap::new(),
        }
    }

    /// Loads the store from disk. A corrupt file is moved aside instead of
    /// failing start-up.
    pub fn open(path: &Path) -> Self {
        let mut store = Store::in_memory();
        store.path = Some(path.to_path_buf());
        let data = match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<Persisted>(&bytes) {
                Ok(d) => d,
                Err(e) => {
                    log::warn!("cache {path:?} is unreadable ({e}); starting fresh");
                    let _ = std::fs::rename(path, path.with_extension("corrupt.json"));
                    Persisted::default()
                }
            },
            Err(_) => Persisted::default(),
        };
        store.account = data.account;
        store.lists = data.lists;
        store.last_sync = data.last_sync;
        store.conflicts = data.conflicts.into_iter().map(|c| (key_of(&c.href), c)).collect();
        store.events = data.events;
        store.history = data.history.into_iter().map(|(href, v)| (key_of(&href), v)).collect();
        for e in data.entries {
            store.next_version = store.next_version.max(e.version + 1);
            let key = key_of(&e.href);
            store.entries.insert(key.clone(), e);
            store.refresh_view(&key);
        }
        store
    }

    fn bump(&mut self) {
        self.revision += 1;
        self.unsaved = true;
    }

    fn new_version(&mut self) -> u64 {
        self.next_version += 1;
        self.next_version
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn account(&self) -> Option<&Account> {
        self.account.as_ref()
    }

    pub fn lists(&self) -> &[TaskList] {
        &self.lists
    }

    pub fn last_sync(&self) -> Option<&str> {
        self.last_sync.as_deref()
    }

    /// Serialized form for persisting; `None` when nothing changed since the
    /// last call. Writing happens outside the lock (see [`write_atomic`]).
    pub fn take_unsaved(&mut self) -> Option<(PathBuf, Vec<u8>)> {
        if !self.unsaved {
            return None;
        }
        let path = self.path.clone()?;
        self.unsaved = false;
        let mut entries: Vec<Entry> = self.entries.values().cloned().collect();
        entries.sort_by(|a, b| a.href.cmp(&b.href));
        let data = Persisted {
            schema: SCHEMA,
            account: self.account.clone(),
            lists: self.lists.clone(),
            entries,
            last_sync: self.last_sync.clone(),
            conflicts: {
                let mut c: Vec<Conflict> = self.conflicts.values().cloned().collect();
                c.sort_by(|a, b| a.href.cmp(&b.href));
                c
            },
            events: self.events.clone(),
            history: {
                // Tasks that are gone for good take their history with them.
                self.history.retain(|k, _| self.entries.contains_key(k));
                self.history.iter().filter_map(|(k, v)| Some((self.entries.get(k)?.href.clone(), v.clone()))).collect()
            },
        };
        match serde_json::to_vec(&data) {
            Ok(bytes) => Some((path, bytes)),
            Err(e) => {
                log::error!("failed to serialize cache: {e}");
                None
            }
        }
    }

    pub fn save_now(&mut self) -> Result<()> {
        if let Some((path, bytes)) = self.take_unsaved() {
            write_atomic(&path, &bytes)?;
        }
        Ok(())
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut lists = self.lists.clone();
        for l in &mut lists {
            l.ctag = None;
        }
        Snapshot {
            revision: self.revision,
            account: self.account.clone(),
            lists,
            tasks: self.views.values().cloned().collect(),
            last_sync: self.last_sync.clone(),
            pending: self.pending_count(),
            conflicts: self.conflict_views(),
        }
    }

    /// Conflicts that are ready for the user to settle, oldest first.
    pub fn conflict_views(&self) -> Vec<ConflictView> {
        let mut out: Vec<ConflictView> = self
            .conflicts
            .iter()
            .filter(|(_, c)| !c.awaiting)
            .map(|(key, c)| ConflictView {
                id: c.href.clone(),
                list_id: c.list_id.clone(),
                mine: c.local.as_deref().and_then(|ics| model::task_from_ics(&c.href, &c.list_id, ics, false).ok()),
                theirs: if c.remote_deleted { None } else { self.views.get(key).cloned() },
                at: c.at.clone(),
            })
            .filter(|v| v.mine.is_some() || v.theirs.is_some())
            .collect();
        out.sort_by(|a, b| a.at.cmp(&b.at).then_with(|| a.id.cmp(&b.id)));
        out
    }

    pub fn pending_count(&self) -> usize {
        self.entries.values().filter(|e| e.state != EntryState::Synced).count()
    }

    pub fn task(&self, id: &str) -> Option<&Task> {
        self.views.get(&key_of(id))
    }

    pub fn tasks(&self) -> impl Iterator<Item = &Task> {
        self.views.values()
    }

    pub fn task_by_uid(&self, uid: &str) -> Option<&Task> {
        self.views.values().find(|t| t.uid == uid)
    }

    fn refresh_view(&mut self, key: &str) {
        let Some(e) = self.entries.get(key) else {
            self.views.remove(key);
            return;
        };
        if e.state == EntryState::Deleted {
            self.views.remove(key);
            return;
        }
        match model::task_from_ics(&e.href, &e.list_id, &e.ics, e.state != EntryState::Synced) {
            Ok(t) => {
                self.views.insert(key.to_string(), t);
            }
            Err(err) => {
                log::warn!("skipping unreadable task {}: {err}", e.href);
                self.views.remove(key);
            }
        }
    }

    // ----------------------------------------------------------------------
    // Account

    pub fn set_account(&mut self, account: Account) {
        let same_server = self
            .account
            .as_ref()
            .is_some_and(|a| a.home_url == account.home_url && a.username == account.username);
        if !same_server {
            self.lists.clear();
            self.entries.clear();
            self.views.clear();
            self.conflicts.clear();
            self.events.clear();
            self.history.clear();
            self.last_sync = None;
        }
        self.account = Some(account);
        self.bump();
    }

    pub fn sign_out(&mut self) {
        self.account = None;
        self.lists.clear();
        self.entries.clear();
        self.views.clear();
        self.undo.clear();
        self.conflicts.clear();
        self.events.clear();
        self.history.clear();
        self.last_sync = None;
        self.bump();
    }

    // ----------------------------------------------------------------------
    // History

    /// Remembers a new version of a task. Changes nobody would notice (the
    /// order in a list, timestamps) are left out.
    fn record(&mut self, key: &str, source: VersionSource, before: Option<&str>, after: &str) {
        let href = self.entries.get(key).map(|e| (e.href.clone(), e.list_id.clone()));
        let Some((href, list_id)) = href else { return };
        let parse = |ics: &str| model::task_from_ics(&href, &list_id, ics, false).ok();
        let Some(new) = parse(after) else { return };
        let now = Utc::now();
        let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let list = self.history.entry(key.to_string()).or_default();
        if list.is_empty() {
            if let Some(old) = before.and_then(parse) {
                if same_content(&old, &new) {
                    return;
                }
                let at = old.modified.clone().unwrap_or_else(|| stamp.clone());
                list.push(Version { at, source: VersionSource::Earlier, ics: before.unwrap_or_default().to_string() });
            }
        } else if let Some(last) = list.last().and_then(|v| parse(&v.ics)) {
            if same_content(&last, &new) {
                return;
            }
        }
        if let Some(last) = list.last_mut() {
            let recent = DateTime::parse_from_rfc3339(&last.at).is_ok_and(|t| (now - t.with_timezone(&Utc)).num_seconds() < COALESCE_SECS);
            if source == VersionSource::Here && matches!(last.source, VersionSource::Here | VersionSource::Created) && recent {
                last.ics = after.to_string();
                if last.source == VersionSource::Here {
                    last.at = stamp;
                }
                return;
            }
        }
        list.push(Version { at: stamp, source, ics: after.to_string() });
        if list.len() > HISTORY {
            list.drain(..list.len() - HISTORY);
        }
    }

    /// A task's versions, newest first.
    pub fn history(&self, id: &str) -> Vec<VersionView> {
        let key = key_of(id);
        let Some(e) = self.entries.get(&key) else { return Vec::new() };
        self.history
            .get(&key)
            .map(|versions| {
                versions
                    .iter()
                    .rev()
                    .filter_map(|v| {
                        let task = model::task_from_ics(&e.href, &e.list_id, &v.ics, false).ok()?;
                        Some(VersionView { at: v.at.clone(), source: v.source, task })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    // ----------------------------------------------------------------------
    // Calendar events (day planner)

    /// Remembers the events downloaded for a range.
    pub fn cache_events(&mut self, from: &str, to: &str, events: Vec<CalEvent>) {
        self.events.retain(|c| !(c.from == from && c.to == to));
        self.events.push(CachedEvents {
            from: from.to_string(),
            to: to.to_string(),
            fetched_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            events,
        });
        if self.events.len() > EVENT_CACHE {
            self.events.remove(0);
        }
        self.unsaved = true;
    }

    /// The events last downloaded for exactly this range.
    pub fn cached_events(&self, from: &str, to: &str) -> Option<&CachedEvents> {
        self.events.iter().find(|c| c.from == from && c.to == to)
    }

    // ----------------------------------------------------------------------
    // Local edits

    fn writable_list(&self, list_id: &str) -> Result<&TaskList> {
        let list = self
            .lists
            .iter()
            .find(|l| l.id == list_id)
            .ok_or_else(|| Error::NotFound("This list no longer exists".into()))?;
        if list.read_only {
            return Err(Error::InvalidInput(format!("“{}” is read-only", list.name)));
        }
        Ok(list)
    }

    fn live_entry(&self, id: &str) -> Result<(String, &Entry)> {
        let key = key_of(id);
        match self.entries.get(&key) {
            Some(e) if e.state != EntryState::Deleted => Ok((key, e)),
            _ => Err(Error::NotFound("This task no longer exists".into())),
        }
    }

    /// Inserts a locally created object, reviving a pending deletion of the
    /// same resource if there is one.
    fn insert_local(&mut self, href: String, list_id: String, ics: String) -> String {
        let key = key_of(&href);
        let version = self.new_version();
        let entry = match self.entries.remove(&key) {
            Some(old) if old.state == EntryState::Deleted && old.etag.is_some() => {
                Entry { href, list_id, etag: old.etag, ics, state: EntryState::Modified, version }
            }
            _ => Entry { href, list_id, etag: None, ics, state: EntryState::Created, version },
        };
        self.entries.insert(key.clone(), entry);
        self.refresh_view(&key);
        key
    }

    pub fn create_task(&mut self, list_id: &str, input: &NewTask) -> Result<Task> {
        if input.summary.trim().is_empty() {
            return Err(Error::InvalidInput("A task needs a title".into()));
        }
        self.writable_list(list_id)?;
        let uid = model::new_uid();
        let ics = model::build_ics(&uid, input, Utc::now())?;
        let href = format!("{list_id}{uid}.ics");
        let key = self.insert_local(href, list_id.to_string(), ics.clone());
        self.record(&key, VersionSource::Created, None, &ics);
        self.bump();
        Ok(self.views[&key].clone())
    }

    pub fn update_task(&mut self, id: &str, patch: &TaskPatch) -> Result<(Task, PatchOutcome)> {
        let (key, entry) = self.live_entry(id)?;
        self.writable_list(&entry.list_id.clone())?;
        let before = entry.ics.clone();
        let (ics, outcome) = model::patch_ics(&entry.ics, patch, Utc::now())?;
        self.record(&key, VersionSource::Here, Some(&before), &ics);
        let version = self.new_version();
        let entry = self.entries.get_mut(&key).expect("checked");
        entry.ics = ics;
        entry.version = version;
        if entry.state == EntryState::Synced {
            entry.state = EntryState::Modified;
        }
        self.refresh_view(&key);
        self.bump();
        Ok((self.views[&key].clone(), outcome))
    }

    /// Keys of a task and (recursively) its subtasks.
    fn with_descendants(&self, key: &str) -> Vec<String> {
        let mut out = vec![key.to_string()];
        let mut seen: HashSet<String> = HashSet::new();
        let mut i = 0;
        while i < out.len() {
            if let Some(t) = self.views.get(&out[i]) {
                if seen.insert(t.uid.clone()) {
                    let uid = t.uid.clone();
                    for (k, v) in &self.views {
                        if v.parent_uid.as_deref() == Some(uid.as_str()) && !out.contains(k) {
                            out.push(k.clone());
                        }
                    }
                }
            }
            i += 1;
        }
        out
    }

    /// Deletes tasks and their subtasks. Returns an undo token.
    pub fn delete_tasks(&mut self, ids: &[String]) -> Result<u64> {
        let mut keys = Vec::new();
        for id in ids {
            let (key, entry) = self.live_entry(id)?;
            self.writable_list(&entry.list_id.clone())?;
            for k in self.with_descendants(&key) {
                if !keys.contains(&k) {
                    keys.push(k);
                }
            }
        }
        let mut items = Vec::new();
        for key in keys {
            let version = self.new_version();
            let Some(entry) = self.entries.get_mut(&key) else { continue };
            items.push(UndoItem { key: key.clone(), before: entry.clone() });
            entry.state = EntryState::Deleted;
            entry.version = version;
            self.refresh_view(&key);
        }
        let token = self.next_undo;
        self.next_undo += 1;
        self.undo.insert(token, items);
        if self.undo.len() > 20 {
            if let Some(oldest) = self.undo.keys().min().copied() {
                self.undo.remove(&oldest);
            }
        }
        self.bump();
        Ok(token)
    }

    pub fn undo_delete(&mut self, token: u64) -> Result<()> {
        let items = self.undo.remove(&token).ok_or_else(|| Error::NotFound("Nothing to undo".into()))?;
        for item in items {
            let version = self.new_version();
            match self.entries.get_mut(&item.key) {
                Some(e) if e.state == EntryState::Deleted => {
                    *e = Entry { version, ..item.before };
                }
                Some(_) => {}
                None => {
                    // The deletion already reached the server: recreate it.
                    let entry = Entry { etag: None, state: EntryState::Created, version, ..item.before };
                    self.entries.insert(item.key.clone(), entry);
                }
            }
            self.refresh_view(&item.key);
        }
        self.bump();
        Ok(())
    }

    /// Moves a task (and its subtasks) to another list.
    pub fn move_task(&mut self, id: &str, target_list: &str) -> Result<Task> {
        let (key, entry) = self.live_entry(id)?;
        if entry.list_id == target_list {
            return Ok(self.views[&key].clone());
        }
        self.writable_list(&entry.list_id.clone())?;
        self.writable_list(target_list)?;
        let mut moved_root = None;
        for k in self.with_descendants(&key) {
            let Some(old) = self.entries.get(&k).cloned() else { continue };
            if old.list_id == target_list {
                continue;
            }
            let uid = self.views.get(&k).map(|t| t.uid.clone()).unwrap_or_default();
            let safe = !uid.is_empty() && uid.chars().all(|c| c.is_ascii_alphanumeric() || "-_.@".contains(c));
            let name = if safe { uid } else { model::new_uid() };
            let href = format!("{target_list}{name}.ics");
            let version = self.new_version();
            if let Some(e) = self.entries.get_mut(&k) {
                e.state = EntryState::Deleted;
                e.version = version;
            }
            self.refresh_view(&k);
            let new_key = self.insert_local(href, target_list.to_string(), old.ics);
            if let Some(h) = self.history.remove(&k) {
                self.history.insert(new_key.clone(), h);
            }
            if k == key {
                moved_root = Some(new_key);
            }
        }
        self.bump();
        let root = moved_root.ok_or_else(|| Error::NotFound("This task no longer exists".into()))?;
        // A subtask moved on its own becomes a top-level task over there.
        let moved = self.views[&root].clone();
        if let Some(parent) = &moved.parent_uid {
            if !self.views.values().any(|t| &t.uid == parent && t.list_id == target_list) {
                let patch = TaskPatch { parent_uid: Some(None), ..Default::default() };
                return Ok(self.update_task(&moved.id, &patch)?.0);
            }
        }
        Ok(moved)
    }

    /// Applies several edits at once (e.g. reordering a list).
    pub fn update_tasks(&mut self, updates: &[(String, TaskPatch)]) -> Result<()> {
        for (id, _) in updates {
            let (_, entry) = self.live_entry(id)?;
            self.writable_list(&entry.list_id.clone())?;
        }
        for (id, patch) in updates {
            self.update_task(id, patch)?;
        }
        Ok(())
    }

    // ----------------------------------------------------------------------
    // Lists

    pub fn add_list(&mut self, list: TaskList) {
        self.lists.retain(|l| l.id != list.id);
        self.lists.push(list);
        self.bump();
    }

    pub fn rename_list(&mut self, id: &str, name: Option<&str>, color: Option<&str>) {
        if let Some(l) = self.lists.iter_mut().find(|l| l.id == id) {
            if let Some(n) = name {
                l.name = n.to_string();
            }
            if let Some(c) = color {
                l.color = Some(c.to_string());
            }
            // The server changes the ctag; refresh lazily on the next sync.
            self.bump();
        }
    }

    pub fn remove_list(&mut self, id: &str) {
        self.lists.retain(|l| l.id != id);
        let keys: Vec<String> = self.entries.iter().filter(|(_, e)| e.list_id == id).map(|(k, _)| k.clone()).collect();
        for k in keys {
            self.entries.remove(&k);
            self.views.remove(&k);
        }
        self.bump();
    }

    // ----------------------------------------------------------------------
    // Sync support

    pub fn pending_ops(&self) -> Vec<PendingOp> {
        let mut ops: Vec<PendingOp> = self
            .entries
            .iter()
            .filter(|(_, e)| e.state != EntryState::Synced)
            .map(|(k, e)| PendingOp {
                key: k.clone(),
                href: e.href.clone(),
                state: e.state,
                etag: e.etag.clone(),
                ics: e.ics.clone(),
                version: e.version,
                summary: model::task_from_ics(&e.href, &e.list_id, &e.ics, true)
                    .map(|t| t.summary)
                    .unwrap_or_default(),
            })
            .collect();
        // Deletions first so a task moved back and forth never collides.
        ops.sort_by_key(|o| match o.state {
            EntryState::Deleted => 0,
            EntryState::Modified => 1,
            EntryState::Created => 2,
            EntryState::Synced => 3,
        });
        ops
    }

    /// Records the outcome of sending `op`. Returns a message for the user
    /// when their change could not be applied as-is.
    pub fn apply_write(&mut self, op: &PendingOp, result: WriteResult) -> Option<String> {
        let title = if op.summary.is_empty() { "A task".to_string() } else { format!("“{}”", op.summary) };
        let entry = self.entries.get_mut(&op.key)?;
        let unchanged = entry.version == op.version;
        let list_id = entry.list_id.clone();
        let mut refetch = false;
        let mut notice = None;
        let mut conflict: Option<(Option<String>, bool)> = None;
        match (op.state, result) {
            (EntryState::Deleted, WriteResult::Ok { .. } | WriteResult::Gone) => {
                if unchanged {
                    self.entries.remove(&op.key);
                } else {
                    // Restored (undo) while the delete was in flight.
                    entry.etag = None;
                    entry.state = EntryState::Created;
                }
            }
            (EntryState::Deleted, WriteResult::Conflict) => {
                // Changed elsewhere: show the server's version and let the
                // user decide whether to delete it after all.
                entry.state = EntryState::Synced;
                entry.etag = None;
                refetch = true;
                conflict = Some((None, false));
            }
            (EntryState::Created | EntryState::Modified, WriteResult::Ok { etag }) => {
                entry.etag = etag;
                entry.state = if unchanged { EntryState::Synced } else { EntryState::Modified };
            }
            (EntryState::Created | EntryState::Modified, WriteResult::Conflict) => {
                // Changed on another device too: the server's version comes
                // in with the next pull, ours waits for the user.
                conflict = Some((Some(entry.ics.clone()), false));
                entry.state = EntryState::Synced;
                entry.etag = None; // forces a refetch on the next pull
                refetch = true;
            }
            (EntryState::Modified, WriteResult::Gone) => {
                conflict = Some((Some(entry.ics.clone()), true));
                self.entries.remove(&op.key);
            }
            (EntryState::Created, WriteResult::Gone) => {
                notice = Some(format!("{title} could not be saved because its list no longer exists."));
                self.entries.remove(&op.key);
            }
            (EntryState::Synced, _) => {}
        }
        if let Some((local, remote_deleted)) = conflict {
            self.conflicts.insert(
                op.key.clone(),
                Conflict {
                    href: op.href.clone(),
                    list_id: list_id.clone(),
                    local,
                    remote_deleted,
                    awaiting: !remote_deleted,
                    at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                },
            );
        }
        if refetch {
            self.invalidate_list(&list_id);
        }
        self.refresh_view(&op.key);
        self.bump();
        notice
    }

    /// Settles a conflict the way the user chose.
    pub fn resolve_conflict(&mut self, id: &str, resolution: &Resolution) -> Result<()> {
        let key = key_of(id);
        let conflict = self.conflicts.get(&key).cloned().ok_or_else(|| Error::NotFound("This conflict was already settled".into()))?;
        match resolution {
            Resolution::Theirs => {}
            Resolution::Mine => match (&conflict.local, self.entries.contains_key(&key)) {
                // Ours over theirs: written with the server's etag.
                (Some(ics), true) => {
                    self.writable_list(&conflict.list_id)?;
                    let before = self.entries[&key].ics.clone();
                    self.record(&key, VersionSource::Here, Some(&before), ics);
                    let version = self.new_version();
                    let entry = self.entries.get_mut(&key).expect("checked");
                    entry.ics = ics.clone();
                    entry.version = version;
                    entry.state = EntryState::Modified;
                    self.refresh_view(&key);
                }
                // Deleted over there: put ours back.
                (Some(ics), false) => {
                    self.writable_list(&conflict.list_id)?;
                    self.insert_local(conflict.href.clone(), conflict.list_id.clone(), ics.clone());
                }
                // We had deleted it: delete it after all.
                (None, true) => {
                    self.conflicts.remove(&key);
                    self.delete_tasks(std::slice::from_ref(&conflict.href))?;
                    return Ok(());
                }
                (None, false) => {}
            },
            Resolution::Merge { patch } => {
                self.update_task(&conflict.href, patch)?;
            }
        }
        self.conflicts.remove(&key);
        self.bump();
        Ok(())
    }

    /// Drops conflicts that turned out not to be any (both devices made the
    /// same change) or whose task is gone for good.
    fn settle_conflicts(&mut self) {
        let keys: Vec<String> = self.conflicts.keys().cloned().collect();
        for key in keys {
            let c = &self.conflicts[&key];
            if c.awaiting || c.remote_deleted {
                continue;
            }
            let settled = match (&c.local, self.views.get(&key)) {
                (Some(ics), Some(theirs)) => {
                    model::task_from_ics(&c.href, &c.list_id, ics, false).is_ok_and(|mine| same_content(&mine, theirs))
                }
                // Deleted on both sides.
                (None, None) => !self.entries.contains_key(&key),
                _ => false,
            };
            if settled {
                self.conflicts.remove(&key);
                self.bump();
            }
        }
    }

    /// Forces the next pull to re-list this collection.
    fn invalidate_list(&mut self, list_id: &str) {
        if let Some(l) = self.lists.iter_mut().find(|l| l.id == list_id) {
            l.ctag = None;
        }
    }

    /// The server rejected a change outright (e.g. validation error). Fall
    /// back to the server version so the task doesn't stay stuck.
    pub fn reject_write(&mut self, op: &PendingOp) {
        let Some(entry) = self.entries.get_mut(&op.key) else { return };
        if entry.version != op.version {
            return;
        }
        let list_id = entry.list_id.clone();
        match entry.state {
            EntryState::Created => {
                self.entries.remove(&op.key);
            }
            _ => {
                entry.state = EntryState::Synced;
                entry.etag = None;
            }
        }
        self.invalidate_list(&list_id);
        self.refresh_view(&op.key);
        self.bump();
    }

    /// Replaces the list set with what the server reports. Returns lists
    /// whose contents changed (ctag differs) together with whether we hold
    /// any entry for them yet.
    pub fn update_lists(&mut self, remote: &[RemoteCalendar]) -> Vec<(String, Option<String>, bool)> {
        let mut changed = Vec::new();
        let mut lists = Vec::new();
        for r in remote.iter().filter(|r| r.supports_todo) {
            let local = self.lists.iter().find(|l| l.id == r.href || key_of(&l.id) == key_of(&r.href));
            let stale = local.is_none_or(|l| l.ctag.is_none() || l.ctag != r.ctag);
            let has_entries = self.entries.values().any(|e| e.list_id == r.href);
            if stale {
                changed.push((r.href.clone(), r.ctag.clone(), has_entries));
            }
            lists.push(TaskList {
                id: r.href.clone(),
                name: r.name.clone(),
                color: r.color.clone(),
                order: r.order,
                read_only: r.read_only,
                ctag: local.and_then(|l| l.ctag.clone()),
            });
        }
        let ids: HashSet<String> = lists.iter().map(|l| l.id.clone()).collect();
        let gone: Vec<String> = self.entries.iter().filter(|(_, e)| !ids.contains(&e.list_id)).map(|(k, _)| k.clone()).collect();
        for k in gone {
            self.entries.remove(&k);
            self.views.remove(&k);
        }
        self.conflicts.retain(|_, c| ids.contains(&c.list_id));
        let visible_change = lists.len() != self.lists.len()
            || lists.iter().zip(&self.lists).any(|(a, b)| a.id != b.id || a.name != b.name || a.color != b.color || a.order != b.order || a.read_only != b.read_only);
        self.lists = lists;
        if visible_change {
            self.bump();
        } else {
            self.unsaved = true;
        }
        changed
    }

    /// Which server objects need to be downloaded.
    pub fn hrefs_to_fetch(&self, list_id: &str, server: &[(String, Option<String>)]) -> Vec<String> {
        server
            .iter()
            .filter(|(href, etag)| match self.entries.get(&key_of(href)) {
                None => true,
                Some(e) if e.state != EntryState::Synced => false,
                Some(e) => e.list_id != list_id || e.etag.is_none() || e.etag != *etag,
            })
            .map(|(h, _)| h.clone())
            .collect()
    }

    /// Merges a list's server state. `server` is the complete href/etag
    /// listing, `objects` the downloaded data.
    pub fn merge_list(&mut self, list_id: &str, server: &[(String, Option<String>)], objects: Vec<RemoteObject>, ctag: Option<String>) {
        let mut changed = false;
        for obj in objects {
            let key = key_of(&obj.href);
            if self.entries.get(&key).is_some_and(|e| e.state != EntryState::Synced) {
                continue; // local changes win until they are pushed
            }
            if let Some(c) = self.conflicts.get_mut(&key) {
                c.awaiting = false;
            }
            let same = self.entries.get(&key).is_some_and(|e| e.ics == obj.data && e.etag == obj.etag);
            let before = self.entries.get(&key).filter(|e| e.ics != obj.data).map(|e| e.ics.clone());
            if !same {
                self.entries.insert(
                    key.clone(),
                    Entry {
                        href: obj.href,
                        list_id: list_id.to_string(),
                        etag: obj.etag,
                        ics: obj.data,
                        state: EntryState::Synced,
                        version: 0,
                    },
                );
                self.refresh_view(&key);
                if let Some(before) = before {
                    let after = self.entries[&key].ics.clone();
                    self.record(&key, VersionSource::Elsewhere, Some(&before), &after);
                }
                changed = true;
            }
        }
        let on_server: HashSet<String> = server.iter().map(|(h, _)| key_of(h)).collect();
        let removed: Vec<String> = self
            .entries
            .iter()
            .filter(|(k, e)| e.list_id == list_id && e.state == EntryState::Synced && !on_server.contains(*k))
            .map(|(k, _)| k.clone())
            .collect();
        for k in removed {
            self.entries.remove(&k);
            self.views.remove(&k);
            // Gone from the server while we waited for its version.
            if let Some(c) = self.conflicts.get_mut(&k) {
                c.awaiting = false;
                c.remote_deleted = true;
            }
            changed = true;
        }
        if let Some(l) = self.lists.iter_mut().find(|l| l.id == list_id) {
            l.ctag = ctag;
        }
        self.settle_conflicts();
        if changed {
            self.bump();
        } else {
            self.unsaved = true;
        }
    }

    pub fn mark_synced_now(&mut self) {
        self.last_sync = Some(Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        self.bump();
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| Error::Io(e.to_string()))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| Error::Io(e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| Error::Io(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::TaskStatus;

    fn store_with_list() -> Store {
        let mut s = Store::in_memory();
        s.update_lists(&[RemoteCalendar {
            href: "/dav.php/calendars/u/tasks/".into(),
            name: "Tasks".into(),
            color: None,
            order: None,
            ctag: Some("1".into()),
            supports_todo: true, supports_event: true,
            read_only: false,
        }]);
        s
    }
    const L: &str = "/dav.php/calendars/u/tasks/";

    fn new(summary: &str) -> NewTask {
        NewTask { summary: summary.into(), ..Default::default() }
    }

    #[test]
    fn create_update_delete_cycle() {
        let mut s = store_with_list();
        let t = s.create_task(L, &new("one")).unwrap();
        assert!(t.pending);
        assert_eq!(s.pending_ops().len(), 1);
        let ops = s.pending_ops();
        s.apply_write(&ops[0], WriteResult::Ok { etag: Some("\"e1\"".into()) });
        assert!(!s.task(&t.id).unwrap().pending);

        let (t2, _) = s.update_task(&t.id, &TaskPatch { status: Some(TaskStatus::Completed), ..Default::default() }).unwrap();
        assert!(t2.completed && t2.pending);
        let op = s.pending_ops().remove(0);
        assert_eq!(op.state, EntryState::Modified);
        assert_eq!(op.etag.as_deref(), Some("\"e1\""));

        let token = s.delete_tasks(std::slice::from_ref(&t.id)).unwrap();
        assert!(s.task(&t.id).is_none());
        s.undo_delete(token).unwrap();
        assert!(s.task(&t.id).unwrap().completed);
    }

    #[test]
    fn edits_during_push_stay_pending() {
        let mut s = store_with_list();
        let t = s.create_task(L, &new("one")).unwrap();
        let op = s.pending_ops().remove(0);
        s.update_task(&t.id, &TaskPatch { summary: Some("two".into()), ..Default::default() }).unwrap();
        s.apply_write(&op, WriteResult::Ok { etag: Some("e".into()) });
        let op2 = s.pending_ops().remove(0);
        assert_eq!(op2.state, EntryState::Modified);
        assert!(op2.ics.contains("SUMMARY:two"));
    }

    #[test]
    fn undo_after_delete_reached_server_recreates() {
        let mut s = store_with_list();
        let t = s.create_task(L, &new("one")).unwrap();
        let op = s.pending_ops().remove(0);
        s.apply_write(&op, WriteResult::Ok { etag: Some("e".into()) });
        let token = s.delete_tasks(std::slice::from_ref(&t.id)).unwrap();
        let del = s.pending_ops().remove(0);
        s.apply_write(&del, WriteResult::Ok { etag: None });
        assert_eq!(s.pending_count(), 0);
        s.undo_delete(token).unwrap();
        let op = s.pending_ops().remove(0);
        assert_eq!(op.state, EntryState::Created);
    }

    #[test]
    fn subtasks_are_deleted_and_moved_with_parent() {
        let mut s = store_with_list();
        s.update_lists(&[
            RemoteCalendar { href: L.into(), name: "Tasks".into(), color: None, order: None, ctag: Some("1".into()), supports_todo: true, supports_event: true, read_only: false },
            RemoteCalendar { href: "/other/".into(), name: "Other".into(), color: None, order: None, ctag: Some("1".into()), supports_todo: true, supports_event: true, read_only: false },
        ]);
        let p = s.create_task(L, &new("parent")).unwrap();
        let c = s.create_task(L, &NewTask { summary: "child".into(), parent_uid: Some(p.uid.clone()), ..Default::default() }).unwrap();
        let moved = s.move_task(&p.id, "/other/").unwrap();
        assert_eq!(moved.list_id, "/other/");
        assert!(s.task(&c.id).is_none());
        let snap = s.snapshot();
        assert_eq!(snap.tasks.len(), 2);
        assert!(snap.tasks.iter().all(|t| t.list_id == "/other/"));
        s.delete_tasks(std::slice::from_ref(&moved.id)).unwrap();
        assert!(s.snapshot().tasks.is_empty());

        // A subtask moved on its own loses its parent link.
        let p = s.create_task(L, &new("parent")).unwrap();
        let c = s.create_task(L, &NewTask { summary: "child".into(), parent_uid: Some(p.uid.clone()), ..Default::default() }).unwrap();
        let moved = s.move_task(&c.id, "/other/").unwrap();
        assert_eq!(moved.parent_uid, None);
        assert_eq!(s.task(&p.id).unwrap().list_id, L);
    }

    #[test]
    fn batch_updates() {
        let mut s = store_with_list();
        let a = s.create_task(L, &new("a")).unwrap();
        let b = s.create_task(L, &new("b")).unwrap();
        s.update_tasks(&[
            (a.id.clone(), TaskPatch { sort_order: Some(2), ..Default::default() }),
            (b.id.clone(), TaskPatch { sort_order: Some(1), parent_uid: Some(Some(a.uid.clone())), ..Default::default() }),
        ])
        .unwrap();
        assert_eq!(s.task(&a.id).unwrap().sort_order, Some(2));
        assert_eq!(s.task(&b.id).unwrap().parent_uid.as_deref(), Some(a.uid.as_str()));
        assert!(s.update_tasks(&[("/nope.ics".into(), TaskPatch::default())]).is_err());
    }

    #[test]
    fn merge_respects_local_changes_and_removals() {
        let mut s = store_with_list();
        let ics = model::build_ics("A", &new("server"), Utc::now()).unwrap();
        let a = format!("{L}A.ics");
        let server = vec![(a.clone(), Some("1".to_string()))];
        assert_eq!(s.hrefs_to_fetch(L, &server), vec![a.clone()]);
        s.merge_list(L, &server, vec![RemoteObject { href: a.clone(), etag: Some("1".into()), data: ics.clone() }], Some("2".into()));
        assert_eq!(s.task(&a).unwrap().summary, "server");
        assert!(s.hrefs_to_fetch(L, &server).is_empty());

        // Local edit is not overwritten by a pull.
        s.update_task(&a, &TaskPatch { summary: Some("local".into()), ..Default::default() }).unwrap();
        let ics2 = model::build_ics("A", &new("server2"), Utc::now()).unwrap();
        s.merge_list(L, &[(a.clone(), Some("2".into()))], vec![RemoteObject { href: a.clone(), etag: Some("2".into()), data: ics2 }], Some("3".into()));
        assert_eq!(s.task(&a).unwrap().summary, "local");

        // Synced tasks missing on the server are removed.
        let op = s.pending_ops().remove(0);
        s.apply_write(&op, WriteResult::Ok { etag: Some("3".into()) });
        s.merge_list(L, &[], vec![], Some("4".into()));
        assert!(s.task(&a).is_none());
    }

    #[test]
    fn persistence_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let mut s = Store::open(&path);
        s.update_lists(&[RemoteCalendar { href: L.into(), name: "Tasks".into(), color: Some("#FF0000".into()), order: None, ctag: None, supports_todo: true, supports_event: true, read_only: false }]);
        let t = s.create_task(L, &new("persist me")).unwrap();
        s.save_now().unwrap();
        let s2 = Store::open(&path);
        assert_eq!(s2.task(&t.id).unwrap().summary, "persist me");
        assert!(s2.task(&t.id).unwrap().pending);
        assert_eq!(s2.lists()[0].color.as_deref(), Some("#FF0000"));
    }

    #[test]
    fn read_only_lists_reject_edits() {
        let mut s = Store::in_memory();
        s.update_lists(&[RemoteCalendar { href: L.into(), name: "Shared".into(), color: None, order: None, ctag: None, supports_todo: true, supports_event: true, read_only: true }]);
        assert!(s.create_task(L, &new("x")).is_err());
    }

    /// A task that reached the server (etag "e1"), then the server's copy as
    /// another device changed it.
    fn synced(s: &mut Store, summary: &str) -> Task {
        let t = s.create_task(L, &new(summary)).unwrap();
        let op = s.pending_ops().remove(0);
        s.apply_write(&op, WriteResult::Ok { etag: Some("e1".into()) });
        t
    }

    fn server_copy(s: &Store, id: &str, from: &str, to: &str) -> RemoteObject {
        let e = &s.entries[&key_of(id)];
        RemoteObject { href: e.href.clone(), etag: Some("e2".into()), data: e.ics.replace(from, to) }
    }

    fn pull_one(s: &mut Store, obj: RemoteObject) {
        let listing = vec![(obj.href.clone(), obj.etag.clone())];
        s.merge_list(L, &listing, vec![obj], Some("9".into()));
    }

    fn patch_summary(s: &mut Store, id: &str, summary: &str) {
        s.update_task(id, &TaskPatch { summary: Some(summary.into()), ..Default::default() }).unwrap();
    }

    #[test]
    fn conflicting_edits_keep_both_versions_until_chosen() {
        let mut s = store_with_list();
        let t = synced(&mut s, "base");
        let theirs = server_copy(&s, &t.id, "SUMMARY:base", "SUMMARY:theirs");
        patch_summary(&mut s, &t.id, "mine");
        let op = s.pending_ops().remove(0);
        assert!(s.apply_write(&op, WriteResult::Conflict).is_none());
        // Not shown until the server's version is here.
        assert!(s.snapshot().conflicts.is_empty());
        pull_one(&mut s, theirs);
        let c = s.snapshot().conflicts;
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].mine.as_ref().unwrap().summary, "mine");
        assert_eq!(c[0].theirs.as_ref().unwrap().summary, "theirs");
        assert_eq!(s.task(&t.id).unwrap().summary, "theirs");

        s.resolve_conflict(&t.id, &Resolution::Mine).unwrap();
        assert!(s.snapshot().conflicts.is_empty());
        let op = s.pending_ops().remove(0);
        assert_eq!(op.state, EntryState::Modified);
        assert_eq!(op.etag.as_deref(), Some("e2"), "overwrites the server's version knowingly");
        assert!(op.ics.contains("SUMMARY:mine"));
    }

    #[test]
    fn conflicts_merge_fields_and_survive_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let mut s = Store::open(&path);
        s.update_lists(&store_with_list().lists.iter().map(|l| RemoteCalendar {
            href: l.id.clone(), name: l.name.clone(), color: None, order: None, ctag: Some("1".into()), supports_todo: true, supports_event: true, read_only: false,
        }).collect::<Vec<_>>());
        let t = synced(&mut s, "base");
        let theirs = server_copy(&s, &t.id, "SUMMARY:base", "SUMMARY:base\r\nPRIORITY:1");
        patch_summary(&mut s, &t.id, "mine");
        let op = s.pending_ops().remove(0);
        s.apply_write(&op, WriteResult::Conflict);
        pull_one(&mut s, theirs);
        s.save_now().unwrap();

        let mut s = Store::open(&path);
        assert_eq!(s.snapshot().conflicts.len(), 1);
        let patch = TaskPatch { summary: Some("mine".into()), ..Default::default() };
        s.resolve_conflict(&t.id, &Resolution::Merge { patch: Box::new(patch) }).unwrap();
        let merged = s.task(&t.id).unwrap();
        assert_eq!((merged.summary.as_str(), merged.priority), ("mine", 1));
        assert!(s.snapshot().conflicts.is_empty());
    }

    #[test]
    fn the_same_change_on_both_devices_is_no_conflict() {
        let mut s = store_with_list();
        let t = synced(&mut s, "base");
        patch_summary(&mut s, &t.id, "same");
        let op = s.pending_ops().remove(0);
        let theirs = RemoteObject { href: op.href.clone(), etag: Some("e2".into()), data: op.ics.clone() };
        s.apply_write(&op, WriteResult::Conflict);
        pull_one(&mut s, theirs);
        assert!(s.snapshot().conflicts.is_empty());
        assert_eq!(s.pending_count(), 0);
    }

    #[test]
    fn deleted_on_one_device_changed_on_the_other() {
        // Edited here, deleted there: ours can come back.
        let mut s = store_with_list();
        let t = synced(&mut s, "base");
        patch_summary(&mut s, &t.id, "mine");
        let op = s.pending_ops().remove(0);
        s.apply_write(&op, WriteResult::Gone);
        let c = s.snapshot().conflicts;
        assert!(c[0].theirs.is_none() && c[0].mine.is_some());
        assert!(s.task(&t.id).is_none());
        s.resolve_conflict(&t.id, &Resolution::Mine).unwrap();
        assert_eq!(s.task(&t.id).unwrap().summary, "mine");
        assert_eq!(s.pending_ops()[0].state, EntryState::Created);

        // Deleted here, edited there: delete it after all, or keep theirs.
        let mut s = store_with_list();
        let t = synced(&mut s, "base");
        let theirs = server_copy(&s, &t.id, "SUMMARY:base", "SUMMARY:theirs");
        s.delete_tasks(std::slice::from_ref(&t.id)).unwrap();
        let op = s.pending_ops().remove(0);
        s.apply_write(&op, WriteResult::Conflict);
        pull_one(&mut s, theirs);
        let c = s.snapshot().conflicts;
        assert!(c[0].mine.is_none());
        assert_eq!(c[0].theirs.as_ref().unwrap().summary, "theirs");
        s.resolve_conflict(&t.id, &Resolution::Mine).unwrap();
        assert!(s.task(&t.id).is_none());
        assert_eq!(s.pending_ops()[0].state, EntryState::Deleted);
        assert!(s.snapshot().conflicts.is_empty());
    }

    /// Makes the last version look older than the coalescing window.
    fn age_last(s: &mut Store, id: &str) {
        let v = s.history.get_mut(&key_of(id)).unwrap().last_mut().unwrap();
        v.at = (Utc::now() - chrono::Duration::minutes(10)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    }

    fn rename(s: &mut Store, id: &str, to: &str) {
        s.update_task(id, &TaskPatch { summary: Some(to.into()), ..Default::default() }).unwrap();
    }

    #[test]
    fn history_keeps_versions_and_coalesces_quick_edits() {
        let mut s = store_with_list();
        let t = s.create_task(L, &new("one")).unwrap();
        rename(&mut s, &t.id, "two");
        rename(&mut s, &t.id, "three");
        // Typing right after creating is still the created version.
        let h = s.history(&t.id);
        assert_eq!(h.len(), 1);
        assert_eq!((h[0].source, h[0].task.summary.as_str()), (VersionSource::Created, "three"));

        age_last(&mut s, &t.id);
        rename(&mut s, &t.id, "four");
        rename(&mut s, &t.id, "five");
        age_last(&mut s, &t.id);
        rename(&mut s, &t.id, "six");
        let h: Vec<_> = s.history(&t.id).into_iter().map(|v| (v.source, v.task.summary)).collect();
        assert_eq!(
            h,
            vec![
                (VersionSource::Here, "six".to_string()),
                (VersionSource::Here, "five".to_string()),
                (VersionSource::Created, "three".to_string()),
            ]
        );

        // Changes nobody sees (the order in a list) are no new version.
        age_last(&mut s, &t.id);
        s.update_task(&t.id, &TaskPatch { sort_order: Some(5), ..Default::default() }).unwrap();
        assert_eq!(s.history(&t.id).len(), 3);
    }

    #[test]
    fn history_starts_with_how_the_task_was() {
        let mut s = store_with_list();
        let ics = model::build_ics("A", &new("from server"), Utc::now()).unwrap();
        let a = format!("{L}A.ics");
        s.merge_list(L, &[(a.clone(), Some("1".into()))], vec![RemoteObject { href: a.clone(), etag: Some("1".into()), data: ics }], None);
        assert!(s.history(&a).is_empty());
        rename(&mut s, &a, "edited");
        let h = s.history(&a);
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].source, h[0].task.summary.as_str()), (VersionSource::Here, "edited"));
        assert_eq!((h[1].source, h[1].task.summary.as_str()), (VersionSource::Earlier, "from server"));
    }

    #[test]
    fn history_records_changes_from_elsewhere() {
        let mut s = store_with_list();
        let t = synced(&mut s, "mine");
        let obj = server_copy(&s, &t.id, "SUMMARY:mine", "SUMMARY:theirs");
        s.merge_list(L, &[(obj.href.clone(), obj.etag.clone())], vec![obj], None);
        let h = s.history(&t.id);
        assert_eq!(h.len(), 2);
        assert_eq!((h[0].source, h[0].task.summary.as_str()), (VersionSource::Elsewhere, "theirs"));
        assert_eq!(h[1].source, VersionSource::Created);
    }

    #[test]
    fn history_is_kept_short_and_saved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cache.json");
        let mut s = Store::open(&path);
        s.update_lists(&[RemoteCalendar { href: L.into(), name: "Tasks".into(), color: None, order: None, ctag: None, supports_todo: true, supports_event: true, read_only: false }]);
        let t = s.create_task(L, &new("v0")).unwrap();
        for i in 1..=30 {
            age_last(&mut s, &t.id);
            rename(&mut s, &t.id, &format!("v{i}"));
        }
        let h = s.history(&t.id);
        assert_eq!(h.len(), HISTORY);
        assert_eq!(h[0].task.summary, "v30");
        s.save_now().unwrap();
        let s2 = Store::open(&path);
        assert_eq!(s2.history(&t.id).len(), HISTORY);

        let mut s2 = s2;
        // History stays while the delete can be undone, and goes with the task.
        s2.delete_tasks(std::slice::from_ref(&t.id)).unwrap();
        for op in s2.pending_ops() {
            s2.apply_write(&op, WriteResult::Ok { etag: None });
        }
        s2.save_now().unwrap();
        assert!(Store::open(&path).history(&t.id).is_empty());
    }
}
