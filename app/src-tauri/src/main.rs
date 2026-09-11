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
//      SIGKILL after a grace period — so no orphan server survives;
//   5. guard against a second instance via an OS-held advisory lock on a
//      sentinel file under the app-data dir (two shells would race the
//      recorder's disk-scan part numbering and corrupt recordings); the OS
//      releases the lock on exit or crash, so no stale-file takeover exists;
//   6. watch the sidecar every ~10 s and respawn it once if it dies mid-session.
//
// Startup failures are fatal WITHOUT panicking: the Windows GUI subsystem has
// no console, so a panic (or a `?` in setup) dies silently. Everything that can
// fail before the window exists goes through `show_error_box` + a clean exit.
//
// The webview shows immediately; the client's own WebSocket reconnect/backoff
// bridges the ~1-3 s the sidecar takes to come up, and a background thread logs
// when `/api/health` first responds. There is no webview event channel in this
// shell, so monitor status surfaces through the same log.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::path::BaseDirectory;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

// The `windows` crate is already in the tree as a transitive tauri dependency,
// so the minimal Win32 MessageBox (spawn-failure / already-running dialogs)
// comes from it instead of a new dependency.
#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
};

/// How often the monitor thread checks sidecar liveness.
const MONITOR_INTERVAL: Duration = Duration::from_secs(10);

/// Holds the sidecar child so it can be terminated exactly once on exit.
struct SidecarState(Mutex<Option<Child>>);

/// Set just before teardown begins; the sidecar monitor reads it to stand down
/// instead of respawning into a dying process.
struct ShutdownState(AtomicBool);

/// Managed so the exit handlers can release the single-instance sentinel.
struct InstanceState(Mutex<Option<InstanceGuard>>);

/// The single-instance guard: an advisory-locked file held open for the whole
/// process lifetime. The OS drops the lock on exit or crash, so there is no
/// stale-file takeover logic; on a clean exit `release` also removes the file.
#[derive(Debug)]
struct InstanceGuard {
    _file: File,
    path: PathBuf,
}

#[derive(Debug)]
enum LockError {
    /// Another live FlowMap process holds the lock.
    AlreadyRunning,
    Io(std::io::Error),
}

/// Bind :0 on loopback, read the assigned port, drop the listener. A tiny TOCTOU
/// window remains before the sidecar rebinds it, negligible for a local app.
fn free_loopback_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// UTF-16 (NUL-terminated) for the Win32 wide-string APIs.
#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Surface a fatal error to a user who has no console (the Windows GUI
/// subsystem detaches stdout/stderr, so a panic would die silently). Never
/// panics itself; callers exit with a non-zero code afterwards.
fn show_error_box(title: &str, message: &str) {
    eprintln!("[flowmap] {title}: {message}");
    #[cfg(windows)]
    {
        let text = wide(&format!("{message}\n\nFlowMap will now exit."));
        let caption = wide(title);
        unsafe {
            MessageBoxW(
                None,
                PCWSTR(text.as_ptr()),
                PCWSTR(caption.as_ptr()),
                MB_ICONERROR | MB_OK | MB_SETFOREGROUND | MB_TOPMOST,
            );
        }
    }
}

/// Fatal startup failure: show the message box, exit non-zero.
fn fatal_error(title: &str, message: &str) -> ! {
    show_error_box(title, message);
    std::process::exit(1);
}

/// The sentinel file holds one decimal PID (plus trailing newline). Diagnostic
/// only — the OS-held lock, not this text, decides liveness.
#[cfg(test)]
fn parse_lock_pid(content: &str) -> Option<u32> {
    content.trim().parse::<u32>().ok()
}

/// Acquire the single-instance advisory lock on `flowmap.lock`.
///
/// The LOCK ITSELF (an OS-held advisory file lock via `File::try_lock`) is the
/// authority, not the file's existence or contents: the OS releases it
/// automatically when the holding process exits OR CRASHES, so there is no
/// stale lockfile to second-guess. PID-liveness probing had two failure modes
/// ending in the exact two-shell recording corruption this guard exists to
/// prevent — a recycled PID reading "alive" forever, and an `OpenProcess`
/// permission failure deleting a LIVE instance's lockfile. The PID inside the
/// file is diagnostic text only.
fn acquire_instance_lock(data_dir: &Path) -> Result<InstanceGuard, LockError> {
    std::fs::create_dir_all(data_dir).map_err(LockError::Io)?;
    let path = data_dir.join("flowmap.lock");
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(LockError::Io)?;
    match file.try_lock() {
        Ok(()) => {
            // Diagnostic content only — never trusted for liveness.
            let _ = file.set_len(0);
            let _ = write!(file, "{}", std::process::id());
            let _ = file.sync_all();
            Ok(InstanceGuard { _file: file, path })
        }
        // Another live FlowMap process holds the lock.
        Err(std::fs::TryLockError::WouldBlock) => Err(LockError::AlreadyRunning),
        Err(std::fs::TryLockError::Error(err)) => Err(LockError::Io(err)),
    }
}

impl InstanceGuard {
    /// Remove the sentinel on a clean exit so the next start doesn't have to
    /// staleness-check it. The handle must close first — Windows refuses to
    /// delete an open file. Best effort either way.
    fn release(self) {
        drop(self._file);
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Release the managed sentinel, if this process holds it.
fn release_instance_lock(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<InstanceState>() {
        let mut guard = match state.0.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(instance) = guard.take() {
            instance.release();
        }
    }
}

/// Whether teardown has begun (the monitor must not respawn into it).
fn is_shutting_down(app: &tauri::AppHandle) -> bool {
    app.try_state::<ShutdownState>()
        .map(|s| s.0.load(Ordering::Relaxed))
        .unwrap_or(false)
}

/// Locate the bundled interpreter inside the resource dir (macOS:
/// `Contents/Resources/pyruntime`, Windows/Linux: the platform resource dir).
///
/// The interpreter sub-path is OS-specific: astral's python-build-standalone
/// puts the Windows interpreter at the runtime ROOT (`python.exe`, no `bin/`),
/// while the macOS/Linux interpreter lives under `bin/`. We also try a
/// `resources/pyruntime/` root so the resolver works whether the tree was
/// placed by the Tauri `resources` map (→ `<res>/pyruntime`) or the macOS
/// `ditto` injection in build-dmg.sh (→ `<res>/pyruntime`) — and a defensive
/// `resources/pyruntime` fallback covers a list-form `resources` layout.
fn resolve_python(app: &tauri::AppHandle) -> Option<PathBuf> {
    // Windows candidates FIRST on Windows; unix candidates on macOS/Linux.
    #[cfg(windows)]
    let interpreters: &[&str] = &["python.exe", "python3.13.exe"];
    #[cfg(unix)]
    let interpreters: &[&str] = &["bin/python3.13", "bin/python3"];

    for root in ["pyruntime", "resources/pyruntime"] {
        for interp in interpreters {
            let rel = format!("{root}/{interp}");
            if let Ok(p) = app.path().resolve(&rel, BaseDirectory::Resource) {
                if p.exists() {
                    return Some(p);
                }
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
        // Ask for a graceful shutdown. On unix that's SIGTERM (uvicorn traps it
        // and drains); Windows has no SIGTERM, so we go straight to a hard
        // terminate — child.kill() below in the loop tail is the same call, but
        // issuing it up front lets the try_wait loop reap the process promptly.
        #[cfg(unix)]
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            let _ = child.kill();
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

/// UTC calendar stamp `YYYY-MM-DDTHH:MM:SSZ` from unix seconds (Howard
/// Hinnant's civil-from-days algorithm; no chrono dependency). Diagnostic
/// log-stamping only — never parsed back.
fn utc_timestamp(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let secs_of_day = unix_secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        secs_of_day / 3_600,
        (secs_of_day % 3_600) / 60,
        secs_of_day % 60
    )
}

/// Open the sidecar log for spawn number `spawn_index` (0 = the initial
/// spawn, >=1 = the monitor's respawn).
///
/// The FIRST spawn truncates (a fresh app run starts a fresh log). Every
/// RESPAWN opens in APPEND mode and writes a dated `--- respawn #N ---`
/// separator first: the respawn happens exactly when the sidecar died
/// unexpectedly, and `File::create` here used to erase the Python traceback
/// the respawn exists to explain (survey-4 M-1) — a crash loop left only the
/// least informative (newest) log. std::fs::File writes are unbuffered, so
/// the separator is on disk before the child's first stdout byte.
fn open_sidecar_log(path: &Path, spawn_index: u32) -> std::io::Result<File> {
    let mut file = if spawn_index == 0 {
        File::create(path)? // first spawn of this app run: fresh log
    } else {
        OpenOptions::new().create(true).append(true).open(path)?
    };
    if spawn_index > 0 {
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(
            file,
            "\n--- respawn #{spawn_index} --- {} ---",
            utc_timestamp(secs)
        );
    }
    Ok(file)
}

fn spawn_sidecar(
    app: &tauri::AppHandle,
    port: u16,
    spawn_index: u32,
) -> Result<Child, Box<dyn std::error::Error>> {
    let python = resolve_python(app)
        .ok_or("bundled pyruntime not found (expected Contents/Resources/pyruntime)")?;

    let data_dir = app.path().app_data_dir()?;
    let recordings = data_dir.join("recordings");
    std::fs::create_dir_all(&recordings)?;

    let log_path = data_dir.join("flowmap-server.log");
    let log = open_sidecar_log(&log_path, spawn_index)?;
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

/// Periodically check the sidecar and respawn it ONCE on the same port if it
/// dies mid-session (same port so the webview's injected `__FLOWMAP_SERVER__`
/// URL stays valid). Exits cleanly on shutdown via `ShutdownState`. Status is
/// surfaced through the log only — this shell has no webview event channel,
/// so there is nothing else to append to.
///
/// Residual race, documented honestly: if teardown begins in the microseconds
/// between this thread's shutdown re-check and `process::exit`, the freshly
/// respawned child would outlive the shell. `is_shutting_down` is checked
/// before spawning AND after re-storing the child, which shrinks that window
/// to a thread-scheduling step; a full fix needs a condvar handshake that is
/// not worth the complexity for a local viewer.
fn spawn_sidecar_monitor(handle: tauri::AppHandle, port: u16) {
    std::thread::spawn(move || {
        let mut respawned = false;
        loop {
            std::thread::sleep(MONITOR_INTERVAL);
            if is_shutting_down(&handle) {
                return;
            }
            let Some(state) = handle.try_state::<SidecarState>() else {
                return; // not managed yet / already torn down
            };
            let exited = {
                let mut guard = match state.0.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                match guard.as_mut() {
                    Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                    // Taken by the shutdown path — nothing left to watch.
                    None => true,
                }
            };
            if !exited {
                continue;
            }
            if is_shutting_down(&handle) {
                return;
            }
            if respawned {
                eprintln!("[flowmap] sidecar exited again after respawn; monitor standing down");
                return;
            }
            respawned = true;
            eprintln!("[flowmap] sidecar exited unexpectedly; one respawn on :{port}");
            // spawn_index 1 = respawn: the log is APPENDED to (never
            // truncated), so the crashed process's traceback survives.
            let child = match spawn_sidecar(&handle, port, 1) {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("[flowmap] sidecar respawn failed: {err}; not retrying");
                    return;
                }
            };
            if is_shutting_down(&handle) {
                // Shutdown raced the respawn: reap what we just started.
                let mut child = child;
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
            let state = handle.state::<SidecarState>();
            {
                let mut guard = match state.0.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                *guard = Some(child);
            }
            eprintln!("[flowmap] sidecar respawned on http://127.0.0.1:{port}");
            if is_shutting_down(&handle) {
                // Teardown began while we stored the child; kill_sidecar in the
                // exit handlers may already have run. Reap the straggler here.
                kill_sidecar(&state);
                return;
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            // Single-instance guard first: two shells would race the recorder's
            // disk-scan part numbering and corrupt each other's recordings.
            let data_dir = match handle.path().app_data_dir() {
                Ok(dir) => dir,
                Err(err) => fatal_error(
                    "FlowMap failed to start",
                    &format!("could not resolve the app data directory: {err}"),
                ),
            };
            match acquire_instance_lock(&data_dir) {
                Ok(guard) => {
                    app.manage(InstanceState(Mutex::new(Some(guard))));
                }
                Err(LockError::AlreadyRunning) => {
                    show_error_box(
                        "FlowMap",
                        "FlowMap is already running.\n\nClose the other FlowMap window first. If none is visible, a stuck FlowMap process may still be running — quit it from the task manager.",
                    );
                    std::process::exit(0);
                }
                // Fail open on unexpected filesystem errors: a broken sentinel
                // must not brick the app — log loudly instead.
                Err(LockError::Io(err)) => {
                    eprintln!(
                        "[flowmap] instance lock unavailable ({err}); continuing without single-instance protection"
                    );
                }
            }

            let port = match free_loopback_port() {
                Ok(port) => port,
                Err(err) => fatal_error(
                    "FlowMap failed to start",
                    &format!("could not find a free loopback port: {err}"),
                ),
            };
            let child = match spawn_sidecar(&handle, port, 0) {
                Ok(child) => child,
                Err(err) => fatal_error(
                    "FlowMap failed to start",
                    &format!("could not launch the bundled FlowMap server: {err}"),
                ),
            };
            app.manage(SidecarState(Mutex::new(Some(child))));
            app.manage(ShutdownState(AtomicBool::new(false)));

            // Inject the absolute server origin before the client JS runs.
            let init = format!("window.__FLOWMAP_SERVER__ = \"http://127.0.0.1:{port}\";");
            if let Err(err) = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("FlowMap")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .initialization_script(&init)
                .build()
            {
                fatal_error(
                    "FlowMap failed to start",
                    &format!("could not create the main window: {err}"),
                );
            }

            // Log first health so verification can confirm the bundled server
            // (not a stray dev server) is what the webview talks to.
            std::thread::spawn(move || {
                if wait_for_health(port, Duration::from_secs(30)) {
                    eprintln!("[flowmap] sidecar healthy on http://127.0.0.1:{port}");
                } else {
                    eprintln!("[flowmap] sidecar health timed out; client will keep retrying");
                }
            });

            // Watch the sidecar for the rest of the session (one respawn).
            spawn_sidecar_monitor(handle, port);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Single-window app: closing the window quits and tears down the
                // sidecar (the Exit event below performs the actual kill).
                let handle = window.app_handle().clone();
                if let Some(state) = handle.try_state::<ShutdownState>() {
                    state.0.store(true, Ordering::Relaxed);
                }
                if let Some(state) = handle.try_state::<SidecarState>() {
                    kill_sidecar(&state);
                }
                release_instance_lock(&handle);
                handle.exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building FlowMap")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<ShutdownState>() {
                    state.0.store(true, Ordering::Relaxed);
                }
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    kill_sidecar(&state);
                }
                release_instance_lock(app_handle);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lock_pid_parses_decimal_with_newline() {
        assert_eq!(parse_lock_pid("1234\n"), Some(1234));
        assert_eq!(parse_lock_pid(" 42 "), Some(42));
        assert_eq!(parse_lock_pid(""), None);
        assert_eq!(parse_lock_pid("not-a-pid"), None);
        assert_eq!(parse_lock_pid("4294967296"), None); // out of u32 range
    }

    #[test]
    fn a_second_lock_acquirement_reports_already_running() {
        // The real two-instance scenario, in-process: the first guard HOLDS the
        // OS lock, so a second acquirement on the same path must be refused.
        let dir = std::env::temp_dir().join(format!("flowmap-lock-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _first = acquire_instance_lock(&dir).expect("first acquire");
        match acquire_instance_lock(&dir) {
            Err(LockError::AlreadyRunning) => {}
            other => panic!("expected AlreadyRunning, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn respawn_log_opens_in_append_mode_and_keeps_crash_evidence() {
        // survey-4 M-1 regression: the respawn monitor used to reopen the log
        // with File::create (truncate), erasing the crash traceback it exists
        // to explain. A respawn must APPEND and mark the boundary.
        let dir = std::env::temp_dir().join(format!("flowmap-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("flowmap-server.log");
        std::fs::write(&path, "Traceback (most recent call last): ...\n").unwrap();

        {
            let _log = open_sidecar_log(&path, 1).expect("respawn open");
        } // drop before reading
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("Traceback (most recent call last)"));
        assert!(contents.contains("--- respawn #1 ---"));
        assert!(contents.contains("T") && contents.ends_with("Z ---\n")); // dated

        // A second respawn appends again, keeping everything before it.
        {
            let _log = open_sidecar_log(&path, 2).expect("second respawn open");
        }
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("Traceback (most recent call last)"));
        assert!(contents.contains("--- respawn #1 ---"));
        assert!(contents.contains("--- respawn #2 ---"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn first_spawn_of_a_run_starts_a_fresh_log() {
        // spawn_index 0 keeps the historical truncate-on-launch behavior: one
        // fresh log per app run, no unbounded growth across runs.
        let dir = std::env::temp_dir().join(format!("flowmap-log-test0-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("flowmap-server.log");
        std::fs::write(&path, "stale bytes from the previous run").unwrap();
        {
            let _log = open_sidecar_log(&path, 0).expect("first open");
        }
        let contents = std::fs::read_to_string(&path).unwrap();
        assert_eq!(contents, "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn utc_timestamp_matches_known_epochs() {
        assert_eq!(utc_timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(utc_timestamp(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(utc_timestamp(1_752_710_400), "2025-07-17T00:00:00Z");
        assert_eq!(utc_timestamp(4_102_444_800), "2100-01-01T00:00:00Z"); // post-2038 sanity
    }
}
