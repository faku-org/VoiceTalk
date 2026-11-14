//! Windows side of call detection (ADR 0016): who holds the microphone, which windows are open, and the poll loop.
//!
//! Signal: `HKCU\...\CapabilityAccessManager\ConsentStore\microphone` (packaged apps) and its `NonPackaged` subkey
//! (classic exes, path with `#` for `\`). Windows keeps `LastUsedTimeStart`/`LastUsedTimeStop` per app; an entry
//! with a start and `LastUsedTimeStop == 0` is using the microphone right now. Readable without admin and without
//! touching audio, so a poll is a few registry reads.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State, UserAttentionType};
use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{ERROR_SUCCESS, HWND, LPARAM};
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
};

use super::apps::{root_pid, Proc};
use super::detect::{
    images_for_consent_key, Call, Config, Detector, Event, Holder, Input, Rule, Window,
};
use super::win::processes;

const POLL: Duration = Duration::from_millis(1_500);
const CONSENT: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone";
const NON_PACKAGED: &str = "NonPackaged";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

struct Key(HKEY);

impl Key {
    fn open(parent: HKEY, path: &str) -> Option<Key> {
        let path = wide(path);
        let mut out = HKEY::default();
        let status =
            unsafe { RegOpenKeyExW(parent, PCWSTR(path.as_ptr()), None, KEY_READ, &mut out) };
        (status == ERROR_SUCCESS).then_some(Key(out))
    }

    fn subkeys(&self) -> Vec<String> {
        let mut names = Vec::new();
        let mut buf = vec![0u16; 512];
        for index in 0.. {
            let mut len = buf.len() as u32;
            let status = unsafe {
                RegEnumKeyExW(
                    self.0,
                    index,
                    Some(PWSTR(buf.as_mut_ptr())),
                    &mut len,
                    None,
                    None,
                    None,
                    None,
                )
            };
            if status != ERROR_SUCCESS {
                break;
            }
            names.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        names
    }

    fn qword(&self, name: &str) -> Option<u64> {
        let name = wide(name);
        let mut data = [0u8; 8];
        let mut size = data.len() as u32;
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                PCWSTR(name.as_ptr()),
                None,
                None,
                Some(data.as_mut_ptr()),
                Some(&mut size),
            )
        };
        (status == ERROR_SUCCESS && size == 8).then(|| u64::from_le_bytes(data))
    }
}

impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

/// One ConsentStore entry: key name, under `NonPackaged`, `LastUsedTimeStart`, `LastUsedTimeStop`.
pub struct Entry {
    pub key: String,
    pub non_packaged: bool,
    pub start: u64,
    pub stop: Option<u64>,
}

impl Entry {
    /// Windows writes the stop time when the app releases the microphone; zero means it still holds it.
    pub fn holding(&self) -> bool {
        self.start != 0 && self.stop == Some(0)
    }
}

pub fn consent_entries() -> Vec<Entry> {
    let Some(root) = Key::open(HKEY_CURRENT_USER, CONSENT) else {
        return Vec::new();
    };
    let read = |parent: &Key, name: &str, non_packaged: bool| {
        Key::open(parent.0, name).map(|k| Entry {
            key: name.to_string(),
            non_packaged,
            start: k.qword("LastUsedTimeStart").unwrap_or(0),
            stop: k.qword("LastUsedTimeStop"),
        })
    };
    let mut out = Vec::new();
    for name in root.subkeys() {
        if name == NON_PACKAGED {
            if let Some(np) = Key::open(root.0, NON_PACKAGED) {
                out.extend(np.subkeys().iter().filter_map(|exe| read(&np, exe, true)));
            }
        } else {
            out.extend(read(&root, &name, false));
        }
    }
    out
}

/// Keys of the apps that hold the microphone now: `(key name, under NonPackaged)`.
pub fn consent_holders() -> Vec<(String, bool)> {
    consent_entries()
        .into_iter()
        .filter(Entry::holding)
        .map(|e| (e.key, e.non_packaged))
        .collect()
}

struct Raw {
    pid: u32,
    title: String,
    foreground: bool,
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = unsafe { &mut *(lparam.0 as *mut (Vec<Raw>, HWND)) };
    if unsafe { IsWindowVisible(hwnd) }.as_bool() {
        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
        if len > 0 {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            out.0.push(Raw {
                pid,
                title: String::from_utf16_lossy(&buf[..len as usize]),
                foreground: hwnd == out.1,
            });
        }
    }
    BOOL(1)
}

fn top_level_windows() -> Vec<Raw> {
    let mut state = (Vec::new(), unsafe { GetForegroundWindow() });
    unsafe {
        let _ = EnumWindows(Some(collect_window), LPARAM(&mut state as *mut _ as isize));
    }
    state.0
}

fn descendants(procs: &[Proc], root: u32) -> HashSet<u32> {
    let mut tree = HashSet::from([root]);
    loop {
        let before = tree.len();
        for p in procs {
            if tree.contains(&p.parent) {
                tree.insert(p.pid);
            }
        }
        if tree.len() == before {
            return tree;
        }
    }
}

/// One poll: registry holders resolved to running processes, plus the windows of those processes.
pub fn probe() -> Input {
    let keys = consent_holders();
    if keys.is_empty() {
        return Input::default();
    }
    let procs = processes();
    let own_tree = descendants(&procs, std::process::id());
    let mut holders: Vec<Holder> = Vec::new();
    for (key, non_packaged) in keys {
        for image in images_for_consent_key(&key, non_packaged) {
            let running: Vec<&Proc> = procs
                .iter()
                .filter(|p| p.name.eq_ignore_ascii_case(&image))
                .collect();
            // A stale entry (the app crashed with the mic open) has no process: not a holder.
            let Some(first) = running.first() else {
                continue;
            };
            let own = running.iter().all(|p| own_tree.contains(&p.pid))
                || image.eq_ignore_ascii_case("voicetalk.exe");
            let h = Holder {
                image: first.name.clone(),
                pid: root_pid(&procs, first.pid),
                own,
            };
            if !holders
                .iter()
                .any(|x| x.image.eq_ignore_ascii_case(&h.image))
            {
                holders.push(h);
            }
            break;
        }
    }
    let windows = top_level_windows()
        .into_iter()
        .filter_map(|w| {
            let image = procs.iter().find(|p| p.pid == w.pid)?.name.clone();
            Some(Window {
                image,
                title: w.title,
                foreground: w.foreground,
            })
        })
        .collect();
    Input { holders, windows }
}

/// Shared with the poll thread; the webview pushes the preferences through `capture_detect_config`.
#[derive(Clone)]
pub struct DetectManager {
    detector: Arc<Mutex<Detector>>,
}

impl Default for DetectManager {
    fn default() -> Self {
        Self {
            detector: Arc::new(Mutex::new(Detector::new(Config::default()))),
        }
    }
}

fn payload(call: &Call, rule: Option<Rule>) -> serde_json::Value {
    let mut v = json!({ "platform": call.platform, "app": call.app, "pid": call.pid });
    if let Some(rule) = rule {
        v["rule"] = json!(rule);
    }
    v
}

impl DetectManager {
    /// Polls in a background thread for the life of the app. Events:
    /// `capture://detected {platform, app, pid, rule}` and `capture://detected-ended {platform, app, pid}`.
    pub fn spawn(&self, app: AppHandle) {
        let detector = self.detector.clone();
        let started = Instant::now();
        thread::Builder::new()
            .name("vt-capture-detect".into())
            .spawn(move || loop {
                thread::sleep(POLL);
                let input = probe();
                let events = detector
                    .lock()
                    .unwrap()
                    .tick(started.elapsed().as_millis() as u64, &input);
                for event in events {
                    match event {
                        Event::Detected { call, rule } => {
                            let _ = app.emit("capture://detected", payload(&call, Some(rule)));
                            // Quiet nudge when the window is behind others: the taskbar button flashes.
                            if rule == Rule::Ask {
                                if let Some(w) = app.get_webview_window("main") {
                                    if !w.is_focused().unwrap_or(false) {
                                        let _ = w.request_user_attention(Some(
                                            UserAttentionType::Informational,
                                        ));
                                    }
                                }
                            }
                        }
                        Event::Ended { call } => {
                            let _ = app.emit("capture://detected-ended", payload(&call, None));
                        }
                    }
                }
            })
            .expect("spawn detect thread");
    }
}

#[tauri::command]
pub fn capture_detect_config(manager: State<'_, DetectManager>, config: Config) {
    manager.detector.lock().unwrap().set_config(config);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live smoke: reads the real ConsentStore. Prints counts and image names only.
    /// `cargo test live_registry_read -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_registry_read() {
        let entries = consent_entries();
        let with_times = entries
            .iter()
            .filter(|e| e.start != 0 && e.stop.is_some())
            .count();
        let mapped = entries
            .iter()
            .filter(|e| !images_for_consent_key(&e.key, e.non_packaged).is_empty())
            .count();
        println!(
            "entries={} with_start_and_stop={} mapped_to_an_image={} holding_now={}",
            entries.len(),
            with_times,
            mapped,
            entries.iter().filter(|e| e.holding()).count()
        );
        let newest = entries.iter().max_by_key(|e| e.start);
        if let Some(e) = newest {
            println!(
                "newest entry: {:?} start={} stop={:?}",
                images_for_consent_key(&e.key, e.non_packaged),
                e.start,
                e.stop
            );
        }
        assert!(with_times > 0, "no readable LastUsedTime values");
    }

    /// Live smoke: `cargo test live_probe -- --ignored --nocapture`. Prints who holds the mic right now
    /// (image names and window titles only).
    #[test]
    #[ignore]
    fn live_probe() {
        println!("registry holders: {:?}", consent_holders());
        let input = probe();
        for h in &input.holders {
            println!("holder: {} pid={} own={}", h.image, h.pid, h.own);
        }
        println!("visible windows: {}", input.windows.len());
        let mut d = Detector::new(Config::default());
        println!("events: {:?}", d.tick(0, &input));
    }
}
