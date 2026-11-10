//! The TasksNG sync engine for the native Android app.
//!
//! `app.tasksng.android.core.Native` (Kotlin) loads this library and calls
//! three functions: `init` once per process, `invoke` for every command, and
//! `nextEvent` in a loop to hear about background changes. Everything
//! crosses the boundary as JSON text.

pub mod engine;

use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};
use jni::JNIEnv;

use crate::engine::Engine;

static ENGINE: OnceLock<Engine> = OnceLock::new();

fn init_logging() {
    #[cfg(target_os = "android")]
    android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("TasksNG"));
    #[cfg(not(target_os = "android"))]
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).try_init();
}

fn text(env: &mut JNIEnv, s: &JString) -> Option<String> {
    if s.is_null() {
        return None;
    }
    env.get_string(s).ok().map(Into::into)
}

fn java_string(env: &mut JNIEnv, s: &str) -> jstring {
    env.new_string(s).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

fn error_json(message: &str) -> String {
    serde_json::json!({ "error": message }).to_string()
}

/// Opens the cache in `dataDir`. Answers `{"ok": null}` or `{"error": …}`.
#[no_mangle]
pub extern "system" fn Java_app_tasksng_android_core_Native_init<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    data_dir: JString<'l>,
    password: JString<'l>,
) -> jstring {
    init_logging();
    let out = match text(&mut env, &data_dir) {
        None => error_json("No data directory"),
        Some(dir) => {
            let password = text(&mut env, &password);
            if ENGINE.get().is_none() {
                match Engine::open(Path::new(&dir), password.as_deref()) {
                    Ok(engine) => {
                        let _ = ENGINE.set(engine);
                    }
                    Err(e) => return java_string(&mut env, &error_json(&format!("Could not open the task cache: {e}"))),
                }
            }
            serde_json::json!({ "ok": null }).to_string()
        }
    };
    java_string(&mut env, &out)
}

/// Runs a command. Blocks until it is done: call it off the main thread.
#[no_mangle]
pub extern "system" fn Java_app_tasksng_android_core_Native_invoke<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    cmd: JString<'l>,
    args: JString<'l>,
) -> jstring {
    let cmd = text(&mut env, &cmd).unwrap_or_default();
    let args = text(&mut env, &args).unwrap_or_default();
    let out = match ENGINE.get() {
        Some(engine) => {
            // A panic must not cross into the JVM: it would take the app down.
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engine.invoke(&cmd, &args)))
                .unwrap_or_else(|_| error_json("Something went wrong inside TasksNG"))
        }
        None => error_json("TasksNG isn't ready yet"),
    };
    java_string(&mut env, &out)
}

/// Waits up to `timeoutMs` for something to happen in the background.
/// Answers `{"name": …, "data": …}`, or null when nothing did.
#[no_mangle]
pub extern "system" fn Java_app_tasksng_android_core_Native_nextEvent<'l>(
    mut env: JNIEnv<'l>,
    _class: JClass<'l>,
    timeout_ms: jlong,
) -> jstring {
    let Some(engine) = ENGINE.get() else { return std::ptr::null_mut() };
    match engine.next_event(Duration::from_millis(timeout_ms.clamp(0, 60_000) as u64)) {
        Some(e) => java_string(&mut env, &serde_json::json!({ "name": e.name, "data": e.data }).to_string()),
        None => std::ptr::null_mut(),
    }
}
