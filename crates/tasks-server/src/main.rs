//! `tasksng-server`: see the library docs and the README.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tasks_server::{api, app, AppState, Config};

/// `tasksng-server healthcheck`: for Docker's HEALTHCHECK (the image has
/// no curl).
fn healthcheck() -> i32 {
    use std::io::{Read, Write};
    let port = Config::from_env().map(|c| c.listen.port()).unwrap_or(8080);
    let check = || -> std::io::Result<bool> {
        let mut s = std::net::TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_secs(3))?;
        s.set_read_timeout(Some(Duration::from_secs(3)))?;
        s.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut buf = String::new();
        s.read_to_string(&mut buf)?;
        Ok(buf.starts_with("HTTP/1.1 200") || buf.starts_with("HTTP/1.0 200"))
    };
    match check() {
        Ok(true) => 0,
        _ => 1,
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}

#[tokio::main]
async fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("healthcheck") => std::process::exit(healthcheck()),
        Some("-V" | "--version") => {
            println!("tasksng-server {}", env!("CARGO_PKG_VERSION"));
            return;
        }
        Some(other) if other.starts_with('-') => {
            eprintln!("Usage: tasksng-server [healthcheck | --version]\nConfigured through TASKSNG_* environment variables.");
            std::process::exit(2);
        }
        _ => {}
    }
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,hyper_util=warn,reqwest=warn")).init();

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            log::error!("{e}");
            std::process::exit(2);
        }
    };
    match (&config.caldav_url, config.allow_any_server) {
        (Some(url), _) => log::info!("people sign in to {url}"),
        (None, true) => log::warn!("TASKSNG_ALLOW_ANY_SERVER is on: people can make this server connect to any address"),
        (None, false) => log::warn!("no TASKSNG_CALDAV_URL set: nobody can sign in until it is"),
    }
    if !config.static_dir.join("index.html").exists() {
        log::warn!("no UI found in {} (TASKSNG_STATIC_DIR)", config.static_dir.display());
    }
    let listen = config.listen;
    let state = match AppState::new(config) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            log::error!("can't use the data directory: {e}");
            std::process::exit(1);
        }
    };

    let reminders = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(10)).await;
            api::check_reminders(&reminders);
        }
    });

    let listener = match tokio::net::TcpListener::bind(listen).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("can't listen on {listen}: {e}");
            std::process::exit(1);
        }
    };
    log::info!("TasksNG {} listening on http://{listen}", env!("CARGO_PKG_VERSION"));

    let server = axum::serve(listener, app(state.clone()));
    tokio::select! {
        r = server => {
            if let Err(e) = r {
                log::error!("server error: {e}");
            }
        }
        _ = shutdown_signal() => log::info!("shutting down"),
    }
    // Open event streams would keep a graceful shutdown waiting, so save and
    // leave.
    for user in state.loaded_users() {
        api::save_now(&user).await;
    }
}
