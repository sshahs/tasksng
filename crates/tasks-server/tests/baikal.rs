//! The web API end to end against a Baikal-compatible server
//! (tools/baikal-dev-server). Skipped unless TASKSNG_TEST_URL is set:
//!
//!   TASKSNG_TEST_URL=http://127.0.0.1:8800 cargo test -p tasks-server --test baikal

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tasks_server::{app, AppState, Config};
use tower::ServiceExt;

fn server_url() -> Option<String> {
    std::env::var("TASKSNG_TEST_URL").ok().filter(|s| !s.is_empty())
}

fn router(data: &std::path::Path) -> Router {
    let config = Config {
        listen: "127.0.0.1:0".parse().unwrap(),
        data_dir: data.to_path_buf(),
        static_dir: data.join("static"),
        caldav_url: server_url(),
        allow_any_server: false,
        secure_cookie: None,
    };
    app(Arc::new(AppState::new(config).unwrap()))
}

struct Reply {
    status: StatusCode,
    cookie: Option<String>,
    body: Value,
}

async fn call(app: &Router, cmd: &str, cookie: Option<&str>, body: Value) -> Reply {
    let mut req = Request::post(format!("/api/{cmd}")).header(header::CONTENT_TYPE, "application/json").header("x-tasksng", "1");
    if let Some(c) = cookie {
        req = req.header(header::COOKIE, format!("tasksng_session={c}"));
    }
    let res = app.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
    let status = res.status();
    let cookie = res
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .and_then(|v| v.strip_prefix("tasksng_session="))
        .map(str::to_string);
    let bytes = axum::body::to_bytes(res.into_body(), usize::MAX).await.unwrap();
    Reply { status, cookie, body: serde_json::from_slice(&bytes).unwrap_or(Value::Null) }
}

async fn sign_in(app: &Router, user: &str, pass: &str) -> Reply {
    call(app, "connect", None, json!({ "args": { "username": user, "password": pass } })).await
}

fn titles(snapshot: &Value) -> Vec<String> {
    snapshot["tasks"].as_array().unwrap().iter().map(|t| t["summary"].as_str().unwrap_or_default().to_string()).collect()
}

#[tokio::test]
async fn web_api_against_baikal() {
    if server_url().is_none() {
        eprintln!("TASKSNG_TEST_URL not set; skipping");
        return;
    }
    let data = tempfile::tempdir().unwrap();
    let app = router(data.path());

    // Signed out.
    let r = call(&app, "get_snapshot", None, json!({})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.body["account"].is_null());
    let r = call(&app, "create_task", None, json!({ "listId": "x", "task": { "summary": "nope" } })).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);

    // Requests without the X-TasksNG header (e.g. a form on another site).
    let req = Request::post("/api/get_snapshot").body(Body::empty()).unwrap();
    assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);

    // Wrong password.
    let r = sign_in(&app, "test", "wrong").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.body["error"].as_str().unwrap().contains("rejected"), "{}", r.body);
    assert!(r.cookie.is_none());

    // Sign in; the lists come from Baikal.
    let r = sign_in(&app, "test", "test").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let cookie = r.cookie.expect("session cookie");
    assert!(r.body["error"].is_null(), "{}", r.body);
    let lists = r.body["snapshot"]["lists"].as_array().unwrap().clone();
    assert!(!lists.is_empty());
    let list_id = lists[0]["id"].as_str().unwrap().to_string();

    // A task reaches the server.
    let title = format!("web test {}", std::process::id());
    let r = call(&app, "create_task", Some(&cookie), json!({ "listId": list_id, "task": { "summary": title } })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let r = call(&app, "sync_now", Some(&cookie), json!({})).await;
    assert!(r.body["error"].is_null(), "{}", r.body);
    assert_eq!(r.body["snapshot"]["pending"], 0);
    assert!(titles(&r.body["snapshot"]).contains(&title));

    // Another account sees only its own tasks.
    let other = sign_in(&app, "other", "other").await;
    assert_eq!(other.status, StatusCode::OK, "{}", other.body);
    assert!(!titles(&other.body["snapshot"]).contains(&title));

    // The session survives a restart of the server.
    let app2 = router(data.path());
    let r = call(&app2, "get_snapshot", Some(&cookie), json!({})).await;
    assert_eq!(r.body["account"]["username"], "test");
    assert!(titles(&r.body).contains(&title));

    // A fresh sign-in (another browser) sees the task straight from Baikal.
    let fresh = router(tempfile::tempdir().unwrap().path());
    let r = sign_in(&fresh, "test", "test").await;
    assert!(titles(&r.body["snapshot"]).contains(&title));
    let fresh_cookie = r.cookie.unwrap();

    // Clean up: delete the task, then sign out everywhere.
    let id = r.body["snapshot"]["tasks"].as_array().unwrap().iter().find(|t| t["summary"] == title.as_str()).unwrap()["id"].clone();
    let r = call(&fresh, "delete_tasks", Some(&fresh_cookie), json!({ "ids": [id] })).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let r = call(&fresh, "sync_now", Some(&fresh_cookie), json!({})).await;
    assert_eq!(r.body["snapshot"]["pending"], 0);

    let r = call(&app2, "sign_out", Some(&cookie), json!({})).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.body["account"].is_null());
    let r = call(&app2, "get_snapshot", Some(&cookie), json!({})).await;
    assert!(r.body["account"].is_null());
    // Signing out removes the password; the other account keeps its own.
    let stored = data
        .path()
        .join("users")
        .read_dir()
        .unwrap()
        .filter(|d| d.as_ref().unwrap().path().join("credentials.json").exists())
        .count();
    assert_eq!(stored, 1);
}
