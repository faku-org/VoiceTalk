//! Windows side of call capture: process snapshot, audio-session listing and the WASAPI capture threads.
//!
//! Remote = process loopback of the chosen app (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, Windows 10 2004+,
//! no admin, no driver), including its process tree. Mic = default capture device. Both are asked for 48 kHz
//! stereo f32 with `autoconvert`, then converted to 16 kHz mono s16 in [`super::resample`].

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use wasapi::{
    initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, SessionState, StreamMode,
    WaveFormat,
};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

use super::apps::{platform_key, platform_for_image, root_pid, Proc};
use super::client::Frame;
use super::mic::{downmix, MicPipeline};
use super::resample::{f32_from_bytes, level, Converter};

const RATE: usize = 48_000;
const CHANNELS: usize = 2;
const WAIT_MS: u32 = 100;

/// One thing the user can capture.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// Root pid of the app: capture targets it with its process tree.
    pub pid: u32,
    /// Image name, e.g. `Discord.exe`.
    pub name: String,
    /// Platform key shared with core (discord, teams, zoom, slack, whatsapp, meet, other).
    pub platform: String,
    /// True for a known call app (or a browser, mapped to meet).
    pub known: bool,
    /// An audio session of the app is playing right now.
    pub playing: bool,
    /// Current output peak, 0..1.
    pub level: f32,
}

pub fn processes() -> Vec<Proc> {
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return out;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut ok = Process32FirstW(snap, &mut entry).is_ok();
        while ok {
            let len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            out.push(Proc {
                pid: entry.th32ProcessID,
                parent: entry.th32ParentProcessID,
                name: String::from_utf16_lossy(&entry.szExeFile[..len]),
            });
            ok = Process32NextW(snap, &mut entry).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// Audio sessions of the default output device, merged by app root, plus known call apps that are running without
/// a session yet (a call can start after the user picked the app). Known apps first, then playing, then by name.
pub fn list_sources() -> Result<Vec<Source>, String> {
    let _ = initialize_mta();
    let procs = processes();
    let by_pid: HashMap<u32, &Proc> = procs.iter().map(|p| (p.pid, p)).collect();
    let mut merged: HashMap<u32, Source> = HashMap::new();
    let mut add = |pid: u32, playing: bool, peak: f32| {
        let root = root_pid(&procs, pid);
        let Some(p) = by_pid.get(&root) else { return };
        let known = platform_for_image(&p.name).is_some() || platform_key(&p.name) == "meet";
        let e = merged.entry(root).or_insert_with(|| Source {
            pid: root,
            name: p.name.clone(),
            platform: platform_key(&p.name).to_string(),
            known,
            playing: false,
            level: 0.0,
        });
        e.playing |= playing;
        e.level = e.level.max(peak);
    };

    let enumerator = DeviceEnumerator::new().map_err(|e| e.to_string())?;
    let device = enumerator
        .get_default_device(Direction::Render)
        .map_err(|e| e.to_string())?;
    let manager = device.get_iaudiosessionmanager().map_err(|e| e.to_string())?;
    let sessions = manager.get_audiosessionenumerator().map_err(|e| e.to_string())?;
    for i in 0..sessions.get_count().map_err(|e| e.to_string())? {
        let Ok(session) = sessions.get_session(i) else {
            continue;
        };
        // pid 0 = the system sounds session.
        let Ok(pid) = session.get_process_id() else {
            continue;
        };
        if pid == 0 {
            continue;
        }
        let playing = matches!(session.get_state(), Ok(SessionState::Active));
        let peak = session
            .get_audiometerinformation()
            .and_then(|m| m.get_peak_value())
            .unwrap_or(0.0);
        add(pid, playing, peak);
    }
    for p in &procs {
        if platform_for_image(&p.name).is_some() {
            add(p.pid, false, 0.0);
        }
    }

    let mut out: Vec<Source> = merged.into_values().collect();
    out.sort_by(|a, b| {
        b.known
            .cmp(&a.known)
            .then(b.playing.cmp(&a.playing))
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// What a capture thread captures.
#[derive(Clone, Copy)]
pub enum Target {
    /// Process loopback of this pid (and its tree).
    Process(u32),
    /// Default microphone.
    Mic,
    /// Everything the default output device plays (AEC reference for the native mic, ADR 0014).
    Loopback,
}

/// Handle of a running capture thread.
pub struct Capture {
    pub thread: JoinHandle<()>,
    /// Resolves once the device is open (or failed to open).
    pub ready: Receiver<Result<(), String>>,
}

/// f32 level as ordered bits, so `fetch_max` keeps the loudest value since the last read.
pub fn store_level(slot: &AtomicU32, v: f32) {
    slot.fetch_max(v.max(0.0).to_bits(), Ordering::Relaxed);
}

pub fn take_level(slot: &AtomicU32) -> f32 {
    f32::from_bits(slot.swap(0, Ordering::Relaxed))
}

fn open(target: Target) -> Result<AudioClient, String> {
    let fmt = WaveFormat::new(32, 32, SampleType::Float, RATE, CHANNELS, None);
    let mut client = match target {
        Target::Process(pid) => AudioClient::new_application_loopback_client(pid, true)
            .map_err(|e| format!("no se pudo abrir el audio del proceso {pid}: {e}"))?,
        Target::Mic => DeviceEnumerator::new()
            .and_then(|d| d.get_default_device(Direction::Capture))
            .and_then(|d| d.get_iaudioclient())
            .map_err(|e| format!("no se pudo abrir el micrófono: {e}"))?,
        // A render endpoint initialised with Direction::Capture is a loopback stream.
        Target::Loopback => DeviceEnumerator::new()
            .and_then(|d| d.get_default_device(Direction::Render))
            .and_then(|d| d.get_iaudioclient())
            .map_err(|e| format!("no se pudo abrir la salida de audio: {e}"))?,
    };
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: 0,
    };
    client
        .initialize_client(&fmt, Direction::Capture, mode, None)
        .map_err(|e| format!("no se pudo iniciar la captura: {e}"))?;
    Ok(client)
}

fn run(
    target: Target,
    channel: u8,
    stop: &AtomicBool,
    tx: &SyncSender<Frame>,
    meter: &AtomicU32,
    ready: &mpsc::Sender<Result<(), String>>,
) {
    let _ = initialize_mta();
    let setup = open(target).and_then(|client| {
        let handle = client.set_get_eventhandle().map_err(|e| e.to_string())?;
        let cap = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
        client.start_stream().map_err(|e| e.to_string())?;
        Ok((client, handle, cap))
    });
    let (client, handle, cap) = match setup {
        Ok(v) => {
            let _ = ready.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };

    let started = Instant::now();
    let mut conv = Converter::new(RATE as u32, CHANNELS);
    let mut queue: VecDeque<u8> = VecDeque::new();
    let send = |frames: Vec<Vec<u8>>| {
        for f in frames {
            match tx.try_send((channel, f)) {
                Ok(()) | Err(TrySendError::Full(_)) => {}
                Err(TrySendError::Disconnected(_)) => return false,
            }
        }
        true
    };
    while !stop.load(Ordering::SeqCst) {
        // A timeout is normal: process loopback is silent (no events) while the app is.
        let _ = handle.wait_for_event(WAIT_MS);
        let mut alive = true;
        loop {
            if cap.read_from_device_to_deque(&mut queue).is_err() || queue.is_empty() {
                break;
            }
            let bytes: Vec<u8> = queue.drain(..).collect();
            let samples = f32_from_bytes(&bytes);
            store_level(meter, level(&samples));
            alive &= send(conv.push(&samples));
        }
        alive &= send(conv.pad_to(started.elapsed()));
        if !alive {
            break;
        }
    }
    let _ = client.stop_stream();
}

/// Native mic thread (ADR 0014): the mic drives the loop (it delivers a block every ~10 ms), the system loopback is
/// drained right before each pass so reference and mic stay on one clock, then [`MicPipeline`] does AEC3 -> RNNoise
/// -> 16 kHz frames. `tx` gets raw 640 B frames, no channel tag (same bytes the webview mic sends on `/call`).
fn run_native_mic(
    stop: &AtomicBool,
    tx: &SyncSender<Vec<u8>>,
    meter: &AtomicU32,
    ready: &mpsc::Sender<Result<(), String>>,
) {
    let _ = initialize_mta();
    let setup = (|| {
        let mic = open(Target::Mic)?;
        let mic_handle = mic.set_get_eventhandle().map_err(|e| e.to_string())?;
        let mic_cap = mic.get_audiocaptureclient().map_err(|e| e.to_string())?;
        // Without a reference the AEC has nothing to cancel against, so a missing loopback is an error, not a
        // silent downgrade: the webview mic is the fallback and the UI says so.
        let lb = open(Target::Loopback)?;
        let lb_handle = lb.set_get_eventhandle().map_err(|e| e.to_string())?;
        let lb_cap = lb.get_audiocaptureclient().map_err(|e| e.to_string())?;
        lb.start_stream().map_err(|e| e.to_string())?;
        mic.start_stream().map_err(|e| e.to_string())?;
        Ok::<_, String>((mic, mic_handle, mic_cap, lb, lb_handle, lb_cap))
    })();
    let (mic, mic_handle, mic_cap, lb, _lb_handle, lb_cap) = match setup {
        Ok(v) => {
            let _ = ready.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };

    let mut pipeline = MicPipeline::new(true);
    let mut mic_q: VecDeque<u8> = VecDeque::new();
    let mut lb_q: VecDeque<u8> = VecDeque::new();
    while !stop.load(Ordering::SeqCst) {
        let _ = mic_handle.wait_for_event(WAIT_MS);
        // Reference first: the far end of a block must already be queued when its echo is processed.
        loop {
            if lb_cap.read_from_device_to_deque(&mut lb_q).is_err() || lb_q.is_empty() {
                break;
            }
            let bytes: Vec<u8> = lb_q.drain(..).collect();
            pipeline.push_far(&downmix(&f32_from_bytes(&bytes), CHANNELS));
        }
        loop {
            if mic_cap.read_from_device_to_deque(&mut mic_q).is_err() || mic_q.is_empty() {
                break;
            }
            let bytes: Vec<u8> = mic_q.drain(..).collect();
            let mono = downmix(&f32_from_bytes(&bytes), CHANNELS);
            store_level(meter, level(&mono));
            for frame in pipeline.push_near(&mono) {
                match tx.try_send(frame) {
                    Ok(()) | Err(TrySendError::Full(_)) => {}
                    Err(TrySendError::Disconnected(_)) => {
                        let _ = mic.stop_stream();
                        let _ = lb.stop_stream();
                        return;
                    }
                }
            }
        }
    }
    let _ = mic.stop_stream();
    let _ = lb.stop_stream();
}

/// Spawns the native mic thread. See [`run_native_mic`].
pub fn spawn_native_mic(
    stop: Arc<AtomicBool>,
    tx: SyncSender<Vec<u8>>,
    meter: Arc<AtomicU32>,
) -> Capture {
    let (ready_tx, ready) = mpsc::channel();
    let thread = thread::Builder::new()
        .name("vt-native-mic".into())
        .spawn(move || run_native_mic(&stop, &tx, &meter, &ready_tx))
        .expect("spawn native mic thread");
    Capture { thread, ready }
}

/// Spawns a capture thread for `target`. Frames of 20 ms (16 kHz mono s16) go to `tx`; the loudest level since the
/// last [`take_level`] goes to `meter`. Stops when `stop` is raised.
pub fn spawn(
    target: Target,
    channel: u8,
    stop: Arc<AtomicBool>,
    tx: SyncSender<Frame>,
    meter: Arc<AtomicU32>,
) -> Capture {
    let (ready_tx, ready) = mpsc::channel();
    let thread = thread::Builder::new()
        .name(format!("vt-capture-{channel}"))
        .spawn(move || run(target, channel, &stop, &tx, &meter, &ready_tx))
        .expect("spawn capture thread");
    Capture { thread, ready }
}

/// Waits for a capture thread to report that its device is open.
pub fn wait_ready(c: &Capture, timeout: Duration) -> Result<(), String> {
    match c.ready.recv_timeout(timeout) {
        Ok(r) => r,
        Err(_) => Err("la captura no respondió a tiempo".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_slot_keeps_the_loudest() {
        let s = AtomicU32::new(0);
        store_level(&s, 0.2);
        store_level(&s, 0.7);
        store_level(&s, 0.4);
        assert!((take_level(&s) - 0.7).abs() < 1e-6);
        assert_eq!(take_level(&s), 0.0);
    }

    #[test]
    fn lists_sources_without_failing() {
        // Real WASAPI call: works on any Windows 10+ box with an output device; an empty list is fine.
        match list_sources() {
            Ok(v) => assert!(v.iter().all(|s| s.pid != 0)),
            Err(e) => eprintln!("no output device here: {e}"),
        }
    }
}
