//! Two-phase synchronisation: push pending local changes, then pull what
//! changed on the server (using the collection ctag to skip unchanged lists
//! and etags to download only changed tasks).

use std::sync::Mutex;

use reqwest::Url;

use crate::dav::{DavClient, PutCondition};
use crate::store::{EntryState, Store};
use crate::{Error, Result};

#[derive(Debug, Default, Clone)]
pub struct SyncReport {
    /// Messages for the user (conflicts, rejected changes).
    pub notices: Vec<String>,
}

fn lock(store: &Mutex<Store>) -> std::sync::MutexGuard<'_, Store> {
    store.lock().unwrap_or_else(|p| p.into_inner())
}

fn join(base: &Url, href: &str) -> Result<Url> {
    base.join(href).map_err(|e| Error::Protocol(format!("invalid href {href}: {e}")))
}

/// Sends all pending local changes to the server.
pub async fn push(store: &Mutex<Store>, client: &DavClient, base: &Url, report: &mut SyncReport) -> Result<()> {
    // Loop because edits can arrive while we are pushing.
    for _ in 0..5 {
        let ops = lock(store).pending_ops();
        if ops.is_empty() {
            return Ok(());
        }
        for op in &ops {
            let url = join(base, &op.href)?;
            let result = match op.state {
                EntryState::Deleted => client.delete(&url, op.etag.as_deref()).await,
                EntryState::Modified => client.put(&url, &op.ics, &PutCondition::Update(op.etag.clone())).await,
                EntryState::Created => client.put(&url, &op.ics, &PutCondition::Create).await,
                EntryState::Synced => continue,
            };
            match result {
                Ok(r) => {
                    if let Some(n) = lock(store).apply_write(op, r) {
                        report.notices.push(n);
                    }
                }
                Err(e) if e.is_offline() || matches!(e, Error::Unauthorized) => return Err(e),
                Err(e) => {
                    log::warn!("server rejected {} {}: {e}", op.href, op.summary);
                    let title = if op.summary.is_empty() { "A change".to_string() } else { format!("“{}”", op.summary) };
                    report.notices.push(format!("{title} could not be saved: {e}"));
                    lock(store).reject_write(op);
                }
            }
        }
    }
    Ok(())
}

/// Downloads server changes.
pub async fn pull(store: &Mutex<Store>, client: &DavClient, base: &Url, home: &Url) -> Result<()> {
    let calendars = client.list_calendars(home).await?;
    let changed = lock(store).update_lists(&calendars);
    for (list_id, ctag, has_entries) in changed {
        let url = join(base, &list_id)?;
        if !has_entries {
            let objects = client.fetch_all(&url).await?;
            let listing: Vec<(String, Option<String>)> = objects.iter().map(|o| (o.href.clone(), o.etag.clone())).collect();
            lock(store).merge_list(&list_id, &listing, objects, ctag);
        } else {
            let listing = client.list_etags(&url).await?;
            let needed = lock(store).hrefs_to_fetch(&list_id, &listing);
            let objects = if needed.is_empty() { Vec::new() } else { client.multiget(&url, &needed).await? };
            lock(store).merge_list(&list_id, &listing, objects, ctag);
        }
    }
    Ok(())
}

/// A full synchronisation round.
pub async fn sync(store: &Mutex<Store>, client: &DavClient, base: &Url, home: &Url) -> Result<SyncReport> {
    let mut report = SyncReport::default();
    push(store, client, base, &mut report).await?;
    pull(store, client, base, home).await?;
    // Push edits that were made while we were pulling.
    if lock(store).pending_count() > 0 {
        push(store, client, base, &mut report).await?;
    }
    lock(store).mark_synced_now();
    Ok(report)
}
