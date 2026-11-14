# ADR 0001: Processes and sidecars

- Status: accepted (0.1.0)
- Date: 2026-11-14

## Context

VoiceTalk is a desktop app with three processes: the Tauri webview (UI), the core
service (Bun: GraphQL, state, tools, LLM and TTS calls) and the voice service
(Python via `uv`: local STT). ADR 0003 fixes the voice stack. This ADR fixes how
the desktop shell starts, watches and stops the two backends.

## Decision

1. **Tauri owns the lifecycle.** The Rust process spawns both sidecars at startup
   and kills them on exit. The webview never spawns anything.
2. **Loopback only.** Each sidecar binds `127.0.0.1` on a port that Tauri picks at
   startup (two free ports, both listeners held until both are chosen). Nothing
   listens on a public interface.
3. **Commands (dev, cwd = repo root):**
   - core: `bun core/src/index.ts`, env `VT_CORE_PORT=<port>`.
   - voice: `uv run --project voice voicetalk-voice --port <port>`.
4. **Health contract.**
   - core: `GET /health` -> 200 `{"ok":true}`; `GET /ready` -> 200 `{"ok":true,"cartesia":bool}` or 503.
   - voice: `GET /health` -> 200 `{"ok":true,"stt":"loading"|"ready"}`; `WS /stt` documented by the voice service.
   - The shell polls `/health` once per second. The state is derived from the poll:
     `healthy` on 200, `starting` before the first 200, `down` when the process exits,
     cannot be spawned, or has not answered within 120 s. A `down` sidecar that later answers goes back to `healthy`.
5. **Executables are resolved explicitly, never via bare PATH.**
   - `bun`: `VT_BUN`, else `%USERPROFILE%\.bun\bin\bun.exe`.
   - `uv`: `VT_UV`, else `%USERPROFILE%\.local\bin\uv.exe`, `%USERPROFILE%\.cargo\bin\uv.exe`,
     `%LOCALAPPDATA%\hermes\bin\uv.exe`.
   - An override that points to a missing file is an error, not a silent fallback.
6. **Missing pieces do not crash the app.** If the entry file (`core/src/index.ts`,
   `voice/pyproject.toml`) or the executable is missing, that sidecar is reported
   `down` with a reason and the window still opens.
7. **Kill tree on exit.** On Windows, `taskkill /PID <pid> /T /F` (`uv run` starts
   Python as a child, so killing the root pid alone would leave Python running).
   Elsewhere, `kill -KILL <pid>`.
8. **Secrets stay in the shell.** Children inherit the environment (for example
   `CARTESIA_API_KEY`) and nothing reads or logs it. The webview gets only
   `sidecar_status` (`{core,voice}` with `port`, `state`, `detail`) and `core_url`
   (`http://127.0.0.1:<port>`). No token or key is ever returned to the webview.
9. **Webview CSP** allows `connect-src` to `127.0.0.1` only, plus the Vite HMR socket in dev.

## Consequences

- Sidecar stdout/stderr is forwarded to the Tauri process stdout, prefixed `[core]`/`[voice]`.
  In release builds (`windows_subsystem = "windows"`) there is no console, so this output is lost. Persistent logs are a later step.
- No restart policy in 0.1.0. A crashed sidecar stays `down` until the app restarts.

## Out of scope for 0.1.0 (known gaps)

- **Packaged sidecars (`externalBin`) are not shipped.** The release build still
  points at the repo root (`CARGO_MANIFEST_DIR/..`), so it only works on the build
  machine. Bundling Bun (single-file executable) and the Python environment needs
  its own ADR. Override the root with `VT_REPO_ROOT`.
- **Hard kill of the Tauri process** (crash, Task Manager) skips the exit hook, so
  sidecars can survive. A Windows Job Object with `KILL_ON_JOB_CLOSE` fixes this;
  planned, not in 0.1.0.
- **Voice `stt` state is not surfaced** in the UI: `healthy` means `/health` returned 200, not that STT is ready.
- Ports are chosen by bind-then-release, so there is a small race window before the sidecar binds.
- Single instance: no lock, so a second app launch starts a second set of sidecars.
