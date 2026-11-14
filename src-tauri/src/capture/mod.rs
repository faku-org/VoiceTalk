//! Call capture (ADR 0009): listen-only capture of another app's audio plus the mic, streamed to core `/capture`.
//!
//! Rust owns the audio (WASAPI process loopback needs a native, COM-capable thread and no extra install), core owns
//! VAD+STT, sessions and notes. Audio never goes through GraphQL: it travels over the `/capture` WebSocket
//! (ADR 0002 pattern, loopback only).
//!
//! `detect` / `detect_win` notice a call starting in another app and tell the webview (ADR 0016).

pub mod apps;
pub mod client;
pub mod detect;
#[cfg(windows)]
pub mod detect_win;
pub mod resample;
#[cfg(windows)]
pub mod win;

#[cfg(windows)]
mod manager {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::mpsc::sync_channel;
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use serde::Serialize;
    use tauri::{AppHandle, Emitter, Manager, State};

    use super::apps::platform_key;
    use super::client::{self, CaptureError, Outcome, CHANNEL_MIC, CHANNEL_REMOTE};
    use super::win::{self, Source, Target};
    use crate::sidecar::Supervisor;

    const READY_TIMEOUT: Duration = Duration::from_secs(5);
    const LEVEL_EVERY: Duration = Duration::from_millis(100);
    const WINDOW: &str = "main";
    const TITLE: &str = "VoiceTalk";
    const TITLE_RECORDING: &str = "VoiceTalk \u{2014} \u{25CF} Grabando llamada";

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct StartInfo {
        pub call_id: String,
        pub pid: u32,
        pub name: String,
        pub platform: String,
        pub mic: bool,
        pub mic_error: Option<String>,
    }

    #[derive(Debug, Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct StopInfo {
        pub call_id: String,
        pub utterances: Option<u64>,
        pub error: Option<CaptureError>,
    }

    #[derive(Debug, Clone, Serialize)]
    struct Levels {
        remote: f32,
        mic: f32,
        seconds: u64,
    }

    struct Active {
        info: StartInfo,
        stop: Arc<AtomicBool>,
        captures: Vec<win::Capture>,
        pump: JoinHandle<Outcome>,
        meters: JoinHandle<()>,
    }

    #[derive(Clone, Default)]
    pub struct CaptureManager {
        inner: Arc<Mutex<Option<Active>>>,
    }

    fn set_title(app: &AppHandle, title: &str) {
        if let Some(w) = app.get_webview_window(WINDOW) {
            let _ = w.set_title(title);
        }
    }

    impl CaptureManager {
        fn finish(app: &AppHandle, a: Active) -> StopInfo {
            a.stop.store(true, Ordering::SeqCst);
            for c in a.captures {
                let _ = c.thread.join();
            }
            let outcome = a.pump.join().unwrap_or_else(|_| {
                Outcome::Failed(CaptureError {
                    code: "connect".into(),
                    message: "el hilo de captura falló".into(),
                })
            });
            let _ = a.meters.join();
            set_title(app, TITLE);
            let info = match outcome {
                Outcome::Ended { utterances } => StopInfo {
                    call_id: a.info.call_id,
                    utterances: Some(utterances),
                    error: None,
                },
                Outcome::Failed(e) => StopInfo {
                    call_id: a.info.call_id,
                    utterances: None,
                    error: Some(e),
                },
            };
            let _ = app.emit("capture://ended", &info);
            info
        }

        /// Removes a session whose pump already ended (core error, socket dead) so a new one can start.
        fn reap(&self, app: &AppHandle) {
            let mut guard = self.inner.lock().unwrap();
            if guard.as_ref().is_some_and(|a| a.pump.is_finished()) {
                if let Some(a) = guard.take() {
                    drop(guard);
                    Self::finish(app, a);
                }
            }
        }

        pub fn status(&self, app: &AppHandle) -> Option<StartInfo> {
            self.reap(app);
            self.inner.lock().unwrap().as_ref().map(|a| a.info.clone())
        }

        pub fn start(
            &self,
            app: &AppHandle,
            core_url: &str,
            source: &Source,
            platform: &str,
            mic: bool,
        ) -> Result<StartInfo, CaptureError> {
            self.reap(app);
            if self.inner.lock().unwrap().is_some() {
                return Err(CaptureError {
                    code: "busy".into(),
                    message: "Ya hay una captura en curso.".into(),
                });
            }
            let (ws, call_id) = client::connect(core_url, platform, Some(&source.name))?;
            let stop = Arc::new(AtomicBool::new(false));
            let (tx, rx) = sync_channel(512);
            let pump = {
                let stop = stop.clone();
                let app = app.clone();
                thread::Builder::new()
                    .name("vt-capture-pump".into())
                    .spawn(move || {
                        let outcome = client::run(ws, rx, stop);
                        if let Outcome::Failed(e) = &outcome {
                            // Cut short: tell the UI now; the session is reaped on the next status/start/stop.
                            let _ = app.emit("capture://error", e);
                        }
                        outcome
                    })
                    .expect("spawn pump thread")
            };
            let remote_meter = Arc::new(AtomicU32::new(0));
            let mic_meter = Arc::new(AtomicU32::new(0));
            let abort =
                |stop: &Arc<AtomicBool>, captures: Vec<win::Capture>, pump: JoinHandle<Outcome>| {
                    stop.store(true, Ordering::SeqCst);
                    for c in captures {
                        let _ = c.thread.join();
                    }
                    let _ = pump.join();
                };

            let remote = win::spawn(
                Target::Process(source.pid),
                CHANNEL_REMOTE,
                stop.clone(),
                tx.clone(),
                remote_meter.clone(),
            );
            if let Err(message) = win::wait_ready(&remote, READY_TIMEOUT) {
                drop(tx);
                abort(&stop, vec![remote], pump);
                return Err(CaptureError {
                    code: "device".into(),
                    message,
                });
            }
            let mut captures = vec![remote];
            let mut mic_error = None;
            if mic {
                let c = win::spawn(
                    Target::Mic,
                    CHANNEL_MIC,
                    stop.clone(),
                    tx.clone(),
                    mic_meter.clone(),
                );
                match win::wait_ready(&c, READY_TIMEOUT) {
                    Ok(()) => captures.push(c),
                    Err(e) => {
                        let _ = c.thread.join();
                        mic_error = Some(e);
                    }
                }
            }
            drop(tx);

            let started = Instant::now();
            let meters = {
                let stop = stop.clone();
                let app = app.clone();
                thread::Builder::new()
                    .name("vt-capture-levels".into())
                    .spawn(move || {
                        while !stop.load(Ordering::SeqCst) {
                            thread::sleep(LEVEL_EVERY);
                            let _ = app.emit(
                                "capture://levels",
                                Levels {
                                    remote: win::take_level(&remote_meter),
                                    mic: win::take_level(&mic_meter),
                                    seconds: started.elapsed().as_secs(),
                                },
                            );
                        }
                    })
                    .expect("spawn levels thread")
            };

            let info = StartInfo {
                call_id,
                pid: source.pid,
                name: source.name.clone(),
                platform: platform.to_string(),
                mic: mic_error.is_none() && mic,
                mic_error,
            };
            set_title(app, TITLE_RECORDING);
            *self.inner.lock().unwrap() = Some(Active {
                info: info.clone(),
                stop,
                captures,
                pump,
                meters,
            });
            Ok(info)
        }

        pub fn stop(&self, app: &AppHandle) -> Result<StopInfo, CaptureError> {
            let active = self.inner.lock().unwrap().take();
            match active {
                Some(a) => Ok(Self::finish(app, a)),
                None => Err(CaptureError {
                    code: "idle".into(),
                    message: "No hay una captura en curso.".into(),
                }),
            }
        }
    }

    #[tauri::command]
    pub async fn capture_list_sources() -> Result<Vec<Source>, String> {
        tauri::async_runtime::spawn_blocking(win::list_sources)
            .await
            .map_err(|e| e.to_string())?
    }

    /// `platform` overrides the detected one (e.g. a browser the user says is Google Meet or "other").
    #[tauri::command]
    pub async fn capture_start(
        app: AppHandle,
        supervisor: State<'_, Supervisor>,
        manager: State<'_, CaptureManager>,
        source: Source,
        platform: Option<String>,
        mic: Option<bool>,
    ) -> Result<StartInfo, CaptureError> {
        let core_url = supervisor.core_url();
        let manager = manager.inner().clone();
        let platform = platform
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| platform_key(&source.name).to_string());
        tauri::async_runtime::spawn_blocking(move || {
            manager.start(&app, &core_url, &source, &platform, mic.unwrap_or(true))
        })
        .await
        .map_err(|e| CaptureError {
            code: "connect".into(),
            message: e.to_string(),
        })?
    }

    #[tauri::command]
    pub async fn capture_stop(
        app: AppHandle,
        manager: State<'_, CaptureManager>,
    ) -> Result<StopInfo, CaptureError> {
        let manager = manager.inner().clone();
        tauri::async_runtime::spawn_blocking(move || manager.stop(&app))
            .await
            .map_err(|e| CaptureError {
                code: "connect".into(),
                message: e.to_string(),
            })?
    }

    #[tauri::command]
    pub fn capture_status(app: AppHandle, manager: State<'_, CaptureManager>) -> Option<StartInfo> {
        manager.status(&app)
    }
}

#[cfg(windows)]
pub use manager::{
    capture_list_sources, capture_start, capture_status, capture_stop, CaptureManager,
};
