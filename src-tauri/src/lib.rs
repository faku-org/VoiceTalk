mod sidecar;

use std::path::{Path, PathBuf};

use sidecar::{Status, Supervisor};
use tauri::{Manager, RunEvent, State};

#[tauri::command]
fn sidecar_status(supervisor: State<'_, Supervisor>) -> Status {
    supervisor.status()
}

#[tauri::command]
fn core_url(supervisor: State<'_, Supervisor>) -> String {
    supervisor.core_url()
}

/// Repo root = parent of `src-tauri/`. `VT_REPO_ROOT` overrides it. Packaged
/// builds do not ship the sidecars yet (see ADR 0001), so this is dev-only.
fn repo_root() -> PathBuf {
    if let Some(root) = std::env::var_os("VT_REPO_ROOT") {
        return PathBuf::from(root);
    }
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![sidecar_status, core_url])
        .setup(|app| {
            app.manage(Supervisor::start(repo_root()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building VoiceTalk");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            app_handle.state::<Supervisor>().shutdown();
        }
    });
}
