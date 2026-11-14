# ADR 0017: Local Hermes Agent as Ether's hands

- Status: accepted (`core/src/agent`, `core/scripts/hermes-profile.ts`, `src-tauri/src/hermes.rs`, `src/features/call/AgentTimeline.tsx`)
- Date: 2026-11-14
- Builds on: ADR 0005 (call loop), ADR 0015 (model ops as text directives), ADR 0007 (preferences in core).
- Issue: faku-org/VoiceTalk#11

## Context

Ether talks, but she cannot act on the PC. Hermes Agent v0.23.1 is installed natively on this machine and already
knows how to use the computer (`computer_use`), read the screen (`vision`), edit files and run commands. VoiceTalk
should hand a spoken request ("abrí la carpeta de facturas y decime qué hay") to a **local** Hermes with a **local**
model, show every step, and ask before anything that changes something.

## Decision

### A dedicated Hermes profile, additive only

The default Hermes profile is Faku's personal one (cloud model). VoiceTalk never reads, writes or stops it. It uses
the profile `voicetalk`, created with the Hermes CLI (`hermes profile create voicetalk --no-alias`,
`hermes -p voicetalk config set ...`, `hermes -p voicetalk tools enable|disable ...`).

`bun run agent:profile` (`core/scripts/hermes-profile.ts`) is the repeatable setup. It refuses the `default` profile,
is idempotent and has `--dry-run`:

| Setting                                   | Value                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `model.provider` / `base_url` / `default` | `custom`, VoiceTalk's local LLM URL (`--llm-url`, env `VT_LLM_URL`, default `http://127.0.0.1:8080/v1`), `--model` |
| `approvals.mode`                          | `manual`: writes, commands and clicks wait for the user                                                            |
| `gateway.standalone`                      | `true` (see below)                                                                                                 |
| Toolsets on `api_server`                  | only `computer_use`, `vision`, `file`, `terminal`; every other enabled toolset is disabled                         |
| `.env` of the profile                     | `API_SERVER_ENABLED`, `API_SERVER_HOST=127.0.0.1`, `API_SERVER_PORT=8650`, `API_SERVER_KEY`                        |

Port 8650: 8642 is the Ether VPS tunnel. `API_SERVER_KEY` is generated once (`vt_` + 32 random bytes), kept if it
already exists, written only to the profile `.env` and never printed, logged or committed. Core reads it from there
(`readAgentKey`) and the webview never sees it.

`gateway.standalone: true` is a temporary shim: Hermes 0.23 multiplexes profiles into the host gateway, and a named
profile only gets its own gateway (and its own API port) with that flag. Hermes needs up to ~30 s to rescan after the
flag is set. Revisit when Hermes ships a supported way to run a profile gateway.

### Client in core (`core/src/agent`)

A typed client of the Hermes Runs API: `POST /v1/runs`, SSE `GET /v1/runs/{id}/events`, `POST .../stop`,
`POST .../approval`, `GET /v1/capabilities`, `GET /health`. Events are parsed into a closed union
(`AgentEvent`); unknown or malformed frames are dropped, never thrown into the call. `AgentPort` is the seam the call
loop uses, so tests fake it. `status()` returns reachability only.

### Call loop

The brain asks for an action with the `act` op (`<<op {"op":"act","task":"..."}>>`, ADR 0015 pattern). It is
rejected in text chat (no timeline there) and accepted in a call. Core then:

1. starts a run and streams its events to the call socket as `agent` (state) and `agent_step` (timeline row) frames;
2. says **one short neutral-Spanish line** when the task starts and one when it ends (`speech.ts`), never reading
   tool output aloud;
3. while a permission is pending the state is `attention`; while acting, `working`; if Hermes is unreachable, `offline`
   (the call continues and says so in words).

Ether's orb: `attention` wins over everything (only the user can unblock it); `working` shows only while the voice is
idle, so she never stops listening or speaking to look busy; agent `offline` does not change the orb.

### UI

- **ApprovalStep timeline** (`AgentTimeline`): one vertical list under the conversation. A pending permission is a card
  with the only primary button, **Permitir**; **No** and **Esc** deny. "Detener" stops the task. Colors are tokens
  (`review` for waiting).
- **Preferencias > Asistente > Agente**: on/off, Hermes URL, profile, agent model, live status (`agentStatus`). Saved
  with the area's own save. Off by default. The `default` profile is rejected in the form and in core's schema.
- **Agent model is its own setting**, separate from the voice brain.

### Tauri shell (`src-tauri/src/hermes.rs`)

When the agent is on, the webview calls `hermes_ensure(profile, url)`. The shell:

- refuses `default` and any non-loopback address;
- probes `/health` on the profile's port: if something already answers it is reported `external` and **left alone**;
- otherwise spawns `hermes -p <profile> gateway run` (path from `VT_HERMES` or `%LOCALAPPDATA%\hermes\bin`), health-checks
  it for up to 90 s, and records its pid;
- on switch-off or app exit it stops **only that pid's tree**. Never by image name, never a gateway it did not start.

### Models

- The voice LFM 1.7B (ADR 0003/0011) is text-only and far too small to drive the computer. It stays the voice brain.
- Computer use needs a vision-language model, configured per profile (`--model`, or the agent model in Preferencias).
- VRAM of a local VL model next to the voice stack: **pending, not measured**. No local model server was running
  when this was written, so there is no number. Record it here when measured.

## Consequences

- Off by default; nothing starts and no port is opened until the user enables it.
- Everything that changes the machine goes through `approvals.mode: manual` and a visible card.
- A run's steps live only in the live call timeline; they are not persisted in session history yet.

## Not done (follow-ups)

- Voice approvals ("sí, permitilo"): only the buttons and Esc decide for now.
- Persisting agent steps in the session/chat history.
- A measured VL model and its VRAM budget.
- Dropping `gateway.standalone` once Hermes supports profile gateways natively.
- DESIGN.md also lists "Saltear": the timeline implements Permitir / No / Esc plus Detener (stop the task).
