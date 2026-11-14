# ADR 0007: App shell, preferences in core, OTA updates

- Status: accepted (Phase 5)
- Date: 2026-11-14
- Supersedes: nothing. Extends [ADR 0001](0001-processes-and-sidecars.md).

## Context

Phase 1 left the webview as a status screen. Phase 5 needs an app shell (call, sessions, preferences), a first-run
flow, persistent preferences, light/dark theming and over-the-air updates. Phases 2 and 4 work in parallel in `src/features/call`,
`core/src/call`, `core/src/db` and friends, so this phase must stay out of those folders and keep edits to shared files additive.

## Decision

### Shell and onboarding

- `src/App.tsx` is a gate: `PrefsProvider` loads preferences from core (retrying until core answers), then shows
  `OnboardingFlow` until `onboarding` is complete, else `AppShell`.
- `AppShell`: sidebar with Llamada, Sesiones, Preferencias. Llamada renders `CallScreen` from `src/features/call` when
  that folder exists (`import.meta.glob`, so the build does not break without it) and a placeholder otherwise. Sesiones
  renders `SessionsScreen` from `src/features/sessions` (Phase 3, ADR 0008).
- Onboarding steps: welcome, microphone (permission + live level meter), allowlisted folders (Tauri dialog), model
  status, Faku voice enrolment (placeholder), theme. Pure state logic lives in `onboarding.ts` and is unit-tested.
  Completion is stored as `{ version, completedAt }`; raising `ONBOARDING_VERSION` shows the flow again.
- All copy is neutral Spanish.

### Preferences live in core

- `core/src/prefs/`: JSON file `<dataDir>/preferences.json` (`%APPDATA%\com.wefaber.voicetalk` on Windows, `VT_DATA_DIR`
  overrides). Written atomically (tmp + rename). A corrupt file is renamed to `.corrupt` and defaults are used.
- Validated with zod. The stored shape has no defaults; defaults are a separate constant, so a field added later does
  not invalidate older files. Schema changes must stay additive.
- GraphQL: `preferences`, `keyStatus`, `models` queries and `updatePreferences(input)`. Nested objects merge, arrays
  replace.
- Secrets are never in the file and never sent to the webview. `keyStatus` returns booleans only.
- Core restricts CORS to the app origins (`localhost:1420` in dev, `tauri.localhost` packaged).
- Model detection follows the Hugging Face cache layout. The STT model is downloaded by the voice sidecar at start;
  the LFM GGUF is detect-only and the UI shows the `hf download` command.

### Theme

- Tokens come from `@wefaber/tokens` (azul theme). Dark mode is the `dark` class / `data-theme` on `<html>`.
- A pre-paint script (`public/theme-init.js`, external because the CSP is `script-src 'self'`) reads the cached
  preference from `localStorage` to avoid a flash. The source of truth is the core preference; the cache is refreshed
  whenever it is applied.

### OTA updates

- `tauri-plugin-updater` with minisign signatures. The public key is in `tauri.conf.json`; the private key is
  `%USERPROFILE%\.tauri\voicetalk.key` locally and the `TAURI_SIGNING_PRIVATE_KEY` secret in CI. Neither is committed.
- Endpoint: `https://github.com/faku-org/VoiceTalk/releases/latest/download/latest.json`.
- `.github/workflows/release.yml` runs on tag `v*` on `windows-latest` with `tauri-apps/tauri-action`, publishing the NSIS
  installer, its `.sig` and `latest.json` to the GitHub Release (not a draft, because drafts are not served under
  `latest/`).
- UI: Preferencias > Actualizaciones (check, download with progress, restart).
- Bundle target is NSIS only, so one updater artifact per release.

## Consequences

- Repo secrets to add: `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- The repository is private. An unauthenticated updater request cannot read private release assets, so updates only work
  once the repo (or a mirror holding `latest.json` and the installer) is public. Decide before the first release.
- The installer does not include the sidecars (ADR 0001 defers packaging), so an installed build runs only on a machine
  that has the repo toolchain. OTA is wired and signed; shipping a self-contained build is a later phase.
- The IP geolocation option is a persisted opt-in flag only; no lookup is implemented.
