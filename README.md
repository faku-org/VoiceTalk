# VoiceTalk

Desktop voice companion (Tauri v2, Windows). Turn-based voice calls with local speech-to-text and cloud text-to-speech, notes, context from personal folders, and a read-only Code Mode. Architecture and decisions: [docs/README.md](docs/README.md).

```
Tauri shell (Rust, React webview)
 ├─ core   Bun + Elysia + GraphQL (127.0.0.1:4310)  call loop, TTS, storage, ingest/RAG, Code Mode, prefs
 ├─ voice  Python + uv + FastAPI (loopback)         Silero VAD + Fluid Speech Pro STT over WS /stt
 └─ llama-server (external)                        LFM3-1.7B chat (:8080), EmbeddingGemma (:8891)
```

## Requirements

- Windows 11, NVIDIA GPU (developed on an RTX 5070 12 GB).
- [Bun](https://bun.sh) 1.4+, [uv](https://docs.astral.sh/uv/), Rust stable (MSVC) with the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
- [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` (Vulkan or CUDA build).
- A [Cartesia](https://cartesia.ai) API key for speech output.

## Setup

1. Install dependencies:

   ```powershell
   bun install
   uv sync --project voice
   ```

2. Set the API keys as user environment variables. Never put them in the repo or in a `.env` inside it. The Tauri shell passes its environment to the sidecars, so open a new terminal after setting them.

   ```powershell
   [Environment]::SetEnvironmentVariable('CARTESIA_API_KEY', '<key>', 'User')
   # Optional, only for VT_BRAIN=claude:
   [Environment]::SetEnvironmentVariable('ANTHROPIC_API_KEY', '<key>', 'User')
   ```

3. Start the local models (two terminals). The STT model downloads on the first run of the voice sidecar.

   ```powershell
   llama-server -m <path>\LFM3-1.7B-Q4_K_M.gguf --port 8080 -ngl 99
   llama-server -m <path>\embeddinggemma-2.gguf --embedding --port 8891 -ngl 99
   ```

4. Run the app:

   ```powershell
   bun run tauri:dev
   ```

   Each sidecar also runs alone: `bun core/src/index.ts` and `uv run --project voice voicetalk-voice --port 8765`.

## Environment

Every variable is optional except `CARTESIA_API_KEY`, which speech output needs.

| Variable                          | Used by     | Default / meaning                                                             |
| --------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| `CARTESIA_API_KEY`                | core        | Cartesia TTS key. Never sent to the webview.                                  |
| `ANTHROPIC_API_KEY`               | core        | Only with `VT_BRAIN=claude`.                                                  |
| `VT_BRAIN`                        | core        | `local` (llama-server) or `claude` (Haiku).                                   |
| `VT_LLM_URL`, `VT_LLM_MODEL`      | core, voice | `http://127.0.0.1:8080`. In voice, unset disables the LLM post-correction.    |
| `VT_EMBED_URL`, `VT_EMBED_MODEL`  | core        | `http://127.0.0.1:8891/v1/embeddings`, `embeddinggemma-2`.                    |
| `VT_FOLDERS`                      | core        | Folders to ingest, `;`-separated. Default `%USERPROFILE%\Documents\Personal`. |
| `VT_DATA_DIR`                     | core        | SQLite and index. Default `core/.data` (gitignored).                          |
| `VT_INGEST`                       | core        | `off` skips the folder watcher.                                               |
| `VT_GLOSSARY`                     | voice       | Glossary TOML, default `voice/glossary.toml`.                                 |
| `VT_CORE_PORT`, `VT_VOICE_PORT`   | sidecars    | Set by the Tauri shell. Core default is 4310.                                 |
| `VT_BUN`, `VT_UV`, `VT_REPO_ROOT` | Tauri shell | Overrides for the `bun`/`uv` paths and the repo root.                         |

## Checks

```powershell
bun run check                      # typecheck, oxlint, oxfmt --check, bun test
cargo check --manifest-path src-tauri/Cargo.toml
uv run --project voice pytest
```

`bun run check` must be green before every commit.

## Icons

The icons in `src-tauri/icons/` are generated from a single source image, and the current one is a placeholder. To replace them:

1. Export a 1024×1024 PNG, square and with a transparent background (for example `assets/icon.png`).
2. Generate every size, plus `icon.ico` and `icon.icns`:

   ```powershell
   bun run tauri icon assets/icon.png
   ```

3. Check `src-tauri/icons/` in the diff, then run `bun run tauri:dev` to see the window and taskbar icon. The installer uses `icon.ico`.

`tauri.conf.json` (`bundle.icon`) already lists the generated files, so it needs no change.

## Releases and OTA updates

A `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml). It builds the signed NSIS installer on `windows-latest` and publishes the installer and `latest.json` to the GitHub Release. Installed apps check `releases/latest/download/latest.json` from Preferencias > Actualizaciones. Design: [ADR 0007](docs/adr/0007-app-shell-and-updates.md).

### Signing key (once)

Updates are signed with minisign. The public key is in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`). The private key never goes in the repo.

The current key is in `%USERPROFILE%\.tauri\voicetalk.key`. Only generate a new one if it is lost. A new key means a new `pubkey`, and apps already installed with the old key cannot update.

```powershell
bun run tauri signer generate -w "$env:USERPROFILE\.tauri\voicetalk.key"
# Copy the printed public key into tauri.conf.json > plugins.updater.pubkey
```

Keep the key file and its password in the password manager.

### GitHub secrets (once)

With [gh](https://cli.github.com) logged in to an account with admin access to the repo:

```powershell
Get-Content -Raw "$env:USERPROFILE\.tauri\voicetalk.key" | gh secret set TAURI_SIGNING_PRIVATE_KEY --repo faku-org/VoiceTalk
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo faku-org/VoiceTalk   # prompts, no echo
gh secret list --repo faku-org/VoiceTalk
```

The web UI works too: Settings > Secrets and variables > Actions > New repository secret, with the same two names. The first secret holds the full content of the `.key` file.

`GITHUB_TOKEN` is provided by Actions and needs no setup. Cartesia and Anthropic keys are not needed in CI.

### Cutting a release

1. Bump `version` in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and `voice/pyproject.toml` (same value) through a PR.
2. After the merge to `main`, tag it:

   ```powershell
   git tag v0.5.0
   git push origin v0.5.0
   ```

3. Check that the workflow is green and that the Release has the `.exe`, its `.sig` and `latest.json`.
4. Install the previous version, open Preferencias > Actualizaciones and confirm that it finds the new one, installs it and restarts.

To build locally (signed), set `TAURI_SIGNING_PRIVATE_KEY` (the file content) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the session, then run `bun run tauri build`. The installer lands in `src-tauri/target/release/bundle/nsis/`.

### Known limitation

The repo is private, so the updater cannot read `latest.json` without authentication. OTA only works once the repo, or a separate releases repo or mirror, is public.

## Versioning and docs

- Semver in `package.json` (`0.x.y` before v1). Commits: `<type>(<scope>): <msg> [v<version>]`.
- Docs, ADRs and spikes: [docs/README.md](docs/README.md). Voice sidecar protocol: [voice/README.md](voice/README.md).
