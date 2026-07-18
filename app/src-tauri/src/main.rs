// FlowMap desktop shell (Tauri 2).
//
// Wraps the built WebGL2 client and runs the FlowMap Python server as a bundled
// sidecar so the app is fully self-contained (no user-side Python/Node install):
//
//   1. pick a free loopback TCP port;
//   2. spawn `<bundled pyruntime>/bin/python3.13 -m flowmap_server` bound to that
//      port, recording under the app-data dir, logs piped to a file there;
//   3. create the webview with an initialization script that injects
//      `window.__FLOWMAP_SERVER__ = "http://127.0.0.1:<port>"` BEFORE the client
//      JS runs, so the SPA reaches the sidecar (the client falls back to
//      same-origin only in the vite dev server, where the global is absent);
//   4. on quit (window close or Cmd-Q) terminate the sidecar — SIGTERM, then
//      SIGKILL after a grace period — so no orphan server survives.
//
// The webview shows immediately; the client's own WebSocket reconnect/backoff
// bridges the ~1-3 s the sidecar takes to come up, and a background thread logs
// when `/api/health` first responds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::File;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::path::BaseDirectory;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// Holds the sidecar child so it can be terminated exactly once on exit.
struct SidecarState(Mutex<Option<Child>>);

/// Bind :0 on loopback, read the assigned port, drop the listener. A tiny TOCTOU
/// window remains before the sidecar rebinds it, negligible for a local app.
fn free_loopback_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Locate the bundled interpreter inside the .app (Contents/Resources/pyruntime).
fn resolve_python(app: &tauri::App) -> Option<PathBuf> {
    for candidate in ["pyruntime/bin/python3.13", "pyruntime/bin/python3"] {
        if let Ok(p) = app.path().resolve(candidate, BaseDirectory::Resource) {
            if p.exists() {
                return Some(p);
            }
        }
    }
    None
}

/// One `GET /api/health` over a short-lived loopback socket; true on `200 ok`.
fn health_ok(port: u16) -> bool {
    let addr: SocketAddr = match format!("127.0.0.1:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1000)));
    let req = format!(
        "GET /api/health HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = String::new();
    let _ = stream.read_to_string(&mut buf);
    buf.contains("200") && buf.contains("\"status\":\"ok\"")
}

/// Poll `/api/health` until healthy or `timeout` elapses.
fn wait_for_health(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if health_ok(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    false
}

/// Terminate the sidecar: SIGTERM, wait up to ~2 s for a clean uvicorn shutdown,
/// then SIGKILL. Idempotent via `Option::take` — safe to call from both the
/// window-close handler and the app-exit event.
fn kill_sidecar(state: &SidecarState) {
    let mut guard = match state.0.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some(mut child) = guard.take() {
        #[cfg(unix)]
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        for _ in 0..20 {
            match child.try_wait() {
                Ok(Some(_)) => return, // exited on SIGTERM
                Ok(None) => std::thread::sleep(Duration::from_millis(100)),
                Err(_) => break,
            }
        }
        let _ = child.kill(); // SIGKILL
        let _ = child.wait();
    }
}

fn spawn_sidecar(app: &tauri::App, port: u16) -> Result<Child, Box<dyn std::error::Error>> {
    let python = resolve_python(app)
        .ok_or("bundled pyruntime not found (expected Contents/Resources/pyruntime)")?;

    let data_dir = app.path().app_data_dir()?;
    let recordings = data_dir.join("recordings");
    std::fs::create_dir_all(&recordings)?;

    let log_path = data_dir.join("flowmap-server.log");
    let log = File::create(&log_path)?;
    let log_err = log.try_clone()?;

    eprintln!("[flowmap] sidecar: {} -m flowmap_server on :{port}", python.display());
    eprintln!("[flowmap] server log -> {}", log_path.display());

    let child = Command::new(&python)
        .arg("-m")
        .arg("flowmap_server")
        .env("FLOWMAP_HOST", "127.0.0.1")
        .env("FLOWMAP_PORT", port.to_string())
        .env("FLOWMAP_RECORDING_ENABLED", "1")
        .env("FLOWMAP_DATA_DIR", &recordings)
        // Isolate from any user-level PYTHON* env that could shadow the bundle.
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .current_dir(&data_dir)
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err))
        .spawn()?;
    Ok(child)
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let port = free_loopback_port()?;
            let child = spawn_sidecar(app, port)?;
            app.manage(SidecarState(Mutex::new(Some(child))));

            // Inject the absolute server origin before the client JS runs.
            let init = format!("window.__FLOWMAP_SERVER__ = \"http://127.0.0.1:{port}\";");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("FlowMap")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(&init)
                .build()?;

            // Log first health so verification can confirm the bundled server
            // (not a stray dev server) is what the webview talks to.
            std::thread::spawn(move || {
                if wait_for_health(port, Duration::from_secs(30)) {
                    eprintln!("[flowmap] sidecar healthy on http://127.0.0.1:{port}");
                } else {
                    eprintln!("[flowmap] sidecar health timed out; client will keep retrying");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Single-window app: closing the window quits and tears down the
                // sidecar (the Exit event below performs the actual kill).
                if let Some(state) = window.app_handle().try_state::<SidecarState>() {
                    kill_sidecar(&state);
                }
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building FlowMap")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    kill_sidecar(&state);
                }
            }
        });
}
