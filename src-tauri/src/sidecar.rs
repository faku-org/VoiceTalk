//! Supervision of the two sidecars: core (Bun) and voice (Python/uv).
//!
//! Contract (shared with the core and voice sessions, see docs/adr/0001-processes-and-sidecars.md):
//! - core:  `bun core/src/index.ts`, env `VT_CORE_PORT` and `VT_VOICE_PORT`, `GET /health` -> 200.
//! - voice: `uv run --project voice voicetalk-voice --port <N>`, `GET /health` -> 200.
//! - Both run with cwd = repo root and bind 127.0.0.1 only.
//!
//! Nothing here reads or logs environment values: secrets such as CARTESIA_API_KEY
//! are inherited by the child processes and never leave this process.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

/// A sidecar that has not answered `/health` within this window is reported `down`.
/// Polling continues, so it flips to `healthy` if it comes up later (first `uv run`
/// may install dependencies, hence the generous limit).
const STARTUP_TIMEOUT: Duration = Duration::from_secs(120);
const POLL_INTERVAL: Duration = Duration::from_millis(1000);
const IO_TIMEOUT: Duration = Duration::from_millis(800);

/// `CREATE_NO_WINDOW`: child consoles stay hidden in the packaged app.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Starting,
    Healthy,
    Down,
}

#[derive(Serialize, Clone, Debug)]
pub struct Info {
    pub port: u16,
    pub state: State,
    /// Short reason when `state` is `down` (never contains env values); null otherwise.
    pub detail: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Status {
    pub core: Info,
    pub voice: Info,
}

#[derive(Clone, Debug)]
struct Slot {
    port: u16,
    state: State,
    detail: Option<String>,
    /// Root pid of the sidecar, kept so shutdown can kill its whole tree.
    pid: Option<u32>,
}

impl Slot {
    fn new(port: u16) -> Self {
        Slot { port, state: State::Starting, detail: None, pid: None }
    }

    fn info(&self) -> Info {
        Info { port: self.port, state: self.state, detail: self.detail.clone() }
    }
}

/// Owns both sidecar slots. Child handles live in the watcher threads; shutdown
/// goes through the pids recorded here.
pub struct Supervisor {
    core: Arc<Mutex<Slot>>,
    voice: Arc<Mutex<Slot>>,
}

/// Resolved once at startup. Paths are absolute so PATH is never consulted.
struct Toolchain {
    repo_root: PathBuf,
    bun: Result<PathBuf, String>,
    uv: Result<PathBuf, String>,
}

impl Supervisor {
    /// Picks two free loopback ports, spawns both sidecars and starts one watcher
    /// per sidecar. Never fails: a sidecar that cannot start is reported as `down`
    /// with a reason, so the window still opens and the UI can say what is missing.
    pub fn start(repo_root: PathBuf) -> Supervisor {
        // Without two ports nothing can be spawned: both sidecars report down.
        let (core_port, voice_port, port_error) = match two_free_ports() {
            Ok((a, b)) => (a, b, None),
            Err(err) => (0, 0, Some(format!("no se pudieron reservar puertos: {err}"))),
        };

        let core = Arc::new(Mutex::new(Slot::new(core_port)));
        let voice = Arc::new(Mutex::new(Slot::new(voice_port)));

        if let Some(reason) = port_error {
            mark_down(&core, "core", reason.clone());
            mark_down(&voice, "voice", reason);
            return Supervisor { core, voice };
        }

        let toolchain = Toolchain {
            bun: resolve_exe("VT_BUN", &bun_candidates()),
            uv: resolve_exe("VT_UV", &uv_candidates()),
            repo_root,
        };

        match spawn_core(&toolchain, core_port, voice_port) {
            Ok(child) => watch(Arc::clone(&core), "core", child, core_port),
            Err(reason) => mark_down(&core, "core", reason),
        }
        match spawn_voice(&toolchain, voice_port) {
            Ok(child) => watch(Arc::clone(&voice), "voice", child, voice_port),
            Err(reason) => mark_down(&voice, "voice", reason),
        }

        Supervisor { core, voice }
    }

    pub fn status(&self) -> Status {
        Status { core: lock(&self.core).info(), voice: lock(&self.voice).info() }
    }

    /// Loopback URL of core. The webview only ever gets this, never secrets.
    pub fn core_url(&self) -> String {
        format!("http://127.0.0.1:{}", lock(&self.core).port)
    }

    /// Kills both sidecar trees. Called on app exit.
    pub fn shutdown(&self) {
        for slot in [&self.core, &self.voice] {
            let pid = lock(slot).pid.take();
            if let Some(pid) = pid {
                kill_tree(pid);
            }
        }
    }
}

fn lock(slot: &Mutex<Slot>) -> MutexGuard<'_, Slot> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn mark_down(slot: &Mutex<Slot>, name: &str, reason: String) {
    println!("[sidecar] {name}: down ({reason})");
    let mut guard = lock(slot);
    guard.state = State::Down;
    guard.detail = Some(reason);
}

/// Both listeners are held until both ports are chosen, so the OS cannot hand
/// out the same port twice.
fn two_free_ports() -> Result<(u16, u16), String> {
    let a = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let b = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    let pa = a.local_addr().map_err(|e| e.to_string())?.port();
    let pb = b.local_addr().map_err(|e| e.to_string())?.port();
    Ok((pa, pb))
}

/// Explicit override first (`VT_BUN` / `VT_UV`), then the known install paths.
/// An override that points nowhere is an error, not a silent fallback.
fn resolve_exe(env_var: &str, candidates: &[PathBuf]) -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os(env_var) {
        let path = PathBuf::from(value);
        return if path.is_file() {
            Ok(path)
        } else {
            Err(format!("{env_var} apunta a un archivo que no existe"))
        };
    }
    candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| format!("no se encontró el ejecutable; define {env_var}"))
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn bun_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = home_dir() {
        out.push(home.join(".bun").join("bin").join(exe_name("bun")));
    }
    out
}

fn uv_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(home) = home_dir() {
        out.push(home.join(".local").join("bin").join(exe_name("uv")));
        out.push(home.join(".cargo").join("bin").join(exe_name("uv")));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        out.push(PathBuf::from(local).join("hermes").join("bin").join(exe_name("uv")));
    }
    out
}

fn spawn_core(tc: &Toolchain, port: u16, voice_port: u16) -> Result<Child, String> {
    let bun = tc.bun.as_ref().map_err(Clone::clone)?;
    let entry = tc.repo_root.join("core").join("src").join("index.ts");
    if !entry.is_file() {
        return Err("core/src/index.ts no existe todavía".to_string());
    }
    let mut cmd = Command::new(bun);
    cmd.arg("core/src/index.ts")
        .current_dir(&tc.repo_root)
        .env("VT_CORE_PORT", port.to_string())
        .env("VT_VOICE_PORT", voice_port.to_string());
    launch("core", cmd)
}

fn spawn_voice(tc: &Toolchain, port: u16) -> Result<Child, String> {
    let uv = tc.uv.as_ref().map_err(Clone::clone)?;
    if !tc.repo_root.join("voice").join("pyproject.toml").is_file() {
        return Err("voice/pyproject.toml no existe todavía".to_string());
    }
    let mut cmd = Command::new(uv);
    cmd.args(["run", "--project", "voice", "voicetalk-voice", "--port"])
        .arg(port.to_string())
        .current_dir(&tc.repo_root);
    launch("voice", cmd)
}

/// Spawns with piped output, forwards each line to this process's stdout tagged
/// with the sidecar name, and returns the child for the watcher.
fn launch(name: &'static str, mut cmd: Command) -> Result<Child, String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("no se pudo iniciar: {e}"))?;
    if let Some(out) = child.stdout.take() {
        forward(name, out);
    }
    if let Some(err) = child.stderr.take() {
        forward(name, err);
    }
    Ok(child)
}

fn forward<R: Read + Send + 'static>(name: &'static str, reader: R) {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            println!("[{name}] {line}");
        }
    });
}

/// One watcher per sidecar: records its pid, polls `/health` and reports exit.
fn watch(slot: Arc<Mutex<Slot>>, name: &'static str, mut child: Child, port: u16) {
    lock(&slot).pid = Some(child.id());
    println!("[sidecar] {name}: started on 127.0.0.1:{port} (pid {})", child.id());

    thread::spawn(move || {
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let reason = match status.code() {
                        Some(code) => format!("terminó con código {code}"),
                        None => "terminó por señal".to_string(),
                    };
                    mark_down(&slot, name, reason);
                    lock(&slot).pid = None;
                    return;
                }
                Ok(None) => {}
                Err(err) => {
                    mark_down(&slot, name, format!("no se pudo consultar el proceso: {err}"));
                    return;
                }
            }

            let healthy = probe_health(port);
            let mut guard = lock(&slot);
            let previous = guard.state;
            if healthy {
                guard.state = State::Healthy;
                guard.detail = None;
            } else if started.elapsed() > STARTUP_TIMEOUT {
                guard.state = State::Down;
                guard.detail = Some("sin respuesta en /health".to_string());
            } else {
                guard.state = State::Starting;
                guard.detail = None;
            }
            if guard.state != previous {
                println!("[sidecar] {name}: {:?}", guard.state);
            }
            drop(guard);

            thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Minimal HTTP/1.1 `GET /health` over a raw socket: true only on a 200 status line.
fn probe_health(port: u16) -> bool {
    probe_health_path(port, "/health")
}

/// Same probe for any path (the Hermes gateway also answers `/health`).
pub(crate) fn probe_health_path(port: u16, path: &str) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, IO_TIMEOUT) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));
    let request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = stream.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// Kills a process and its children. On Windows `uv run` starts Python as a
/// child, so killing only the root pid would leave Python running.
pub(crate) fn kill_tree(pid: u32) {
    let pid = pid.to_string();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let system_root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let taskkill = Path::new(&system_root).join("System32").join("taskkill.exe");
        let _ = Command::new(taskkill)
            .args(["/PID", &pid, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill")
            .args(["-KILL", &pid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
