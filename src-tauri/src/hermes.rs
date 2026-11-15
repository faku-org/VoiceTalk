//! Local Hermes Agent gateway (ADR 0017): Ether's hands.
//!
//! The shell starts `hermes -p <profile> gateway run` only when the user turned the agent on (the UI calls
//! `hermes_ensure`), only when nothing already answers `/health` on the profile's port, and stops only the
//! process it started. A gateway that was already running (Faku's own, or one started by hand) is never
//! touched: it is reported `external` and left alone.
//!
//! Hard rules, enforced by `valid_profile` and `loopback_port`:
//! - the `default` profile is Faku's personal one: it is never started or stopped from here;
//! - the address must be loopback;
//! - nothing here reads, logs or forwards `API_SERVER_KEY` or any other secret (the child inherits the
//!   environment and reads its own profile `.env`).

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::sidecar::{kill_tree, probe_health_path};

/// Hermes takes a while on first start (it loads skills and the model config).
const STARTUP_TIMEOUT: Duration = Duration::from_secs(90);
const POLL_INTERVAL: Duration = Duration::from_millis(1000);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HermesState {
    /// Not asked to run (agent off) or stopped.
    Off,
    /// Spawned by this shell, waiting for `/health`.
    Starting,
    /// Spawned by this shell and answering.
    Healthy,
    /// Something else already answers on the port: left alone.
    External,
    /// Could not start, or exited.
    Down,
}

#[derive(Serialize, Clone, Debug)]
pub struct HermesStatus {
    pub state: HermesState,
    pub port: u16,
    /// Short reason when `down` (never contains env values); null otherwise.
    pub detail: Option<String>,
}

#[derive(Debug)]
struct Inner {
    status: HermesStatus,
    /// Root pid of the gateway THIS shell started. The only process `shutdown` will ever kill.
    pid: Option<u32>,
    /// Bumped on every `ensure`/`shutdown` so a stale watcher stops touching the state.
    generation: u64,
}

pub struct HermesSupervisor {
    inner: Arc<Mutex<Inner>>,
}

impl Default for HermesSupervisor {
    fn default() -> Self {
        HermesSupervisor {
            inner: Arc::new(Mutex::new(Inner {
                status: HermesStatus { state: HermesState::Off, port: 0, detail: None },
                pid: None,
                generation: 0,
            })),
        }
    }
}

fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Profile names are passed as an argument, never through a shell, but still: letters, digits, `_`, `-`,
/// starting with a letter or digit, at most 64 chars, and never `default`.
pub fn valid_profile(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 64 {
        return Err("nombre de perfil inválido".into());
    }
    let mut chars = name.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_ascii_alphanumeric());
    if !first_ok || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Err("nombre de perfil inválido".into());
    }
    if name.eq_ignore_ascii_case("default") {
        return Err("el perfil default es personal: no se usa".into());
    }
    Ok(())
}

/// Port of a loopback `http://` URL (`127.0.0.1`, `localhost` or `[::1]`). Anything else is refused: the
/// shell never manages a gateway that is not on this machine.
pub fn loopback_port(url: &str) -> Result<u16, String> {
    let rest = url
        .trim()
        .strip_prefix("http://")
        .ok_or_else(|| "la dirección debe ser http:// local".to_string())?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (host, tail) = v6.split_once(']').ok_or("dirección inválida")?;
        (host, tail.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => (host, Some(port)),
            None => (authority, None),
        }
    };
    if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
        return Err("el agente solo puede estar en esta PC (127.0.0.1)".into());
    }
    match port {
        Some(p) => p
            .parse::<u16>()
            .ok()
            .filter(|p| *p != 0)
            .ok_or_else(|| "puerto inválido".to_string()),
        None => Err("falta el puerto en la dirección".into()),
    }
}

fn hermes_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        out.push(PathBuf::from(local).join("hermes").join("bin").join(exe("hermes")));
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        out.push(PathBuf::from(home).join(".local").join("bin").join(exe("hermes")));
    }
    out
}

fn exe(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

/// `VT_HERMES` first (an override that points nowhere is an error), then the known install paths.
fn resolve_hermes() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("VT_HERMES") {
        let path = PathBuf::from(value);
        return if path.is_file() {
            Ok(path)
        } else {
            Err("VT_HERMES apunta a un archivo que no existe".into())
        };
    }
    hermes_candidates()
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| "no se encontró hermes; define VT_HERMES".to_string())
}

impl HermesSupervisor {
    pub fn status(&self) -> HermesStatus {
        lock(&self.inner).status.clone()
    }

    /// Makes sure a gateway answers on `url`'s port for `profile`. Idempotent: it returns at once and the
    /// watcher thread keeps the status current. Never blocks the UI.
    pub fn ensure(&self, profile: &str, url: &str) -> Result<HermesStatus, String> {
        valid_profile(profile)?;
        let port = loopback_port(url)?;

        let generation = {
            let mut guard = lock(&self.inner);
            // Already ours, on the same port, and still alive: nothing to do.
            if guard.pid.is_some()
                && guard.status.port == port
                && matches!(guard.status.state, HermesState::Starting | HermesState::Healthy)
            {
                return Ok(guard.status.clone());
            }
            guard.generation += 1;
            guard.generation
        };

        // Something already answers: Faku's own gateway or one started by hand. Not ours, so never ours to stop.
        if probe_health_path(port, "/health") {
            self.stop_owned();
            return Ok(self.set(generation, HermesState::External, port, None));
        }

        // A previous gateway of ours on another port is replaced.
        self.stop_owned();

        let hermes = match resolve_hermes() {
            Ok(p) => p,
            Err(reason) => return Ok(self.set(generation, HermesState::Down, port, Some(reason))),
        };

        let mut cmd = Command::new(hermes);
        cmd.args(["-p", profile.trim(), "gateway", "run"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                return Ok(self.set(
                    generation,
                    HermesState::Down,
                    port,
                    Some(format!("no se pudo iniciar: {e}")),
                ))
            }
        };
        println!("[hermes] gateway del perfil {} iniciado (pid {})", profile.trim(), child.id());
        {
            let mut guard = lock(&self.inner);
            guard.pid = Some(child.id());
        }
        let status = self.set(generation, HermesState::Starting, port, None);
        self.watch(generation, child, port);
        Ok(status)
    }

    /// Stops the gateway this shell started, if any. Never touches one it did not start.
    pub fn shutdown(&self) {
        {
            let mut guard = lock(&self.inner);
            guard.generation += 1;
            guard.status.state = HermesState::Off;
            guard.status.detail = None;
        }
        self.stop_owned();
    }

    fn stop_owned(&self) {
        let pid = lock(&self.inner).pid.take();
        if let Some(pid) = pid {
            println!("[hermes] deteniendo el gateway propio (pid {pid})");
            kill_tree(pid);
        }
    }

    /// Writes the status unless a newer `ensure`/`shutdown` superseded this generation.
    fn set(&self, generation: u64, state: HermesState, port: u16, detail: Option<String>) -> HermesStatus {
        let mut guard = lock(&self.inner);
        if guard.generation == generation {
            guard.status = HermesStatus { state, port, detail };
        }
        guard.status.clone()
    }

    fn watch(&self, generation: u64, mut child: Child, port: u16) {
        let inner = Arc::clone(&self.inner);
        thread::spawn(move || {
            let started = Instant::now();
            loop {
                let mut guard = lock(&inner);
                if guard.generation != generation {
                    return;
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let reason = match status.code() {
                            Some(code) => format!("terminó con código {code}"),
                            None => "terminó por señal".to_string(),
                        };
                        println!("[hermes] gateway: {reason}");
                        guard.pid = None;
                        guard.status =
                            HermesStatus { state: HermesState::Down, port, detail: Some(reason) };
                        return;
                    }
                    Ok(None) => {}
                    Err(err) => {
                        guard.status = HermesStatus {
                            state: HermesState::Down,
                            port,
                            detail: Some(format!("no se pudo consultar el proceso: {err}")),
                        };
                        return;
                    }
                }
                drop(guard);

                let healthy = probe_health_path(port, "/health");
                let mut guard = lock(&inner);
                if guard.generation != generation {
                    return;
                }
                if healthy {
                    guard.status = HermesStatus { state: HermesState::Healthy, port, detail: None };
                } else if started.elapsed() > STARTUP_TIMEOUT {
                    guard.status = HermesStatus {
                        state: HermesState::Down,
                        port,
                        detail: Some("sin respuesta en /health".to_string()),
                    };
                } else {
                    guard.status = HermesStatus { state: HermesState::Starting, port, detail: None };
                }
                drop(guard);
                thread::sleep(POLL_INTERVAL);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// Minimal `/health` -> 200 server on a free port, served until the process ends.
    fn fake_gateway() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut stream in listener.incoming().flatten() {
                let mut buf = [0u8; 256];
                let _ = stream.read(&mut buf);
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
            }
        });
        port
    }

    #[test]
    fn a_gateway_already_running_is_external_and_never_owned() {
        let port = fake_gateway();
        let sup = HermesSupervisor::default();
        let status = sup.ensure("voicetalk", &format!("http://127.0.0.1:{port}")).unwrap();
        assert_eq!(status.state, HermesState::External);
        assert!(lock(&sup.inner).pid.is_none(), "an external gateway must not be owned");
        sup.shutdown();
        // Nothing was killed: the fake gateway still answers.
        assert!(probe_health_path(port, "/health"));
    }

    #[test]
    fn profile_rules() {
        assert!(valid_profile("voicetalk").is_ok());
        assert!(valid_profile("voice_talk-2").is_ok());
        assert!(valid_profile("default").is_err());
        assert!(valid_profile("DEFAULT").is_err());
        assert!(valid_profile(" default ").is_err());
        assert!(valid_profile("").is_err());
        assert!(valid_profile("-x").is_err());
        assert!(valid_profile("a b").is_err());
        assert!(valid_profile("../x").is_err());
        assert!(valid_profile("a;rm").is_err());
        assert!(valid_profile(&"a".repeat(65)).is_err());
    }

    #[test]
    fn loopback_only() {
        assert_eq!(loopback_port("http://127.0.0.1:8650"), Ok(8650));
        assert_eq!(loopback_port("http://localhost:8650/v1"), Ok(8650));
        assert_eq!(loopback_port("http://[::1]:8650"), Ok(8650));
        assert!(loopback_port("http://10.0.0.5:8650").is_err());
        assert!(loopback_port("http://evil.com:8650").is_err());
        assert!(loopback_port("http://127.0.0.1.evil.com:8650").is_err());
        assert!(loopback_port("https://127.0.0.1:8650").is_err());
        assert!(loopback_port("http://127.0.0.1").is_err());
        assert!(loopback_port("http://127.0.0.1:0").is_err());
        assert!(loopback_port("http://127.0.0.1:99999").is_err());
    }

    #[test]
    fn ensure_refuses_default_and_remote_without_spawning() {
        let sup = HermesSupervisor::default();
        assert!(sup.ensure("default", "http://127.0.0.1:8650").is_err());
        assert!(sup.ensure("voicetalk", "http://192.168.1.2:8650").is_err());
        assert_eq!(sup.status().state, HermesState::Off);
    }

    #[test]
    fn shutdown_without_a_process_is_a_noop() {
        let sup = HermesSupervisor::default();
        sup.shutdown();
        assert_eq!(sup.status().state, HermesState::Off);
    }
}
