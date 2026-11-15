# ADR 0017: Hermes Agent as Ether's hands (OpenRouter by default)

- Status: accepted (`core/src/agent`, `core/scripts/hermes-profile.ts`, `src-tauri/src/hermes.rs`, `src/features/call/AgentTimeline.tsx`)
- Date: 2026-11-14
- Builds on: ADR 0005 (call loop), ADR 0015 (model ops as text directives), ADR 0007 (preferences in core).
- Issue: faku-org/VoiceTalk#11

## Context

Ether talks, but she cannot act on the PC. Hermes Agent v0.23.1 is installed natively on this machine and already
knows how to use the computer (`computer_use`), read the screen (`vision`), edit files and run commands. VoiceTalk
should hand a spoken request ("abrí la carpeta de facturas y decime qué hay") to a **local** Hermes (the process runs
on this PC), show every step, and ask before anything that changes something.

The first cut assumed a local vision-language model too. Faku decided the agent uses **OpenRouter** instead: a model
that can drive the computer does not fit next to the voice stack, and the hosted ones are cheap. The local model stays
available as a provider option.

## Decision

### A dedicated Hermes profile, additive only

The default Hermes profile is Faku's personal one (cloud model). VoiceTalk never reads, writes or stops it. It uses
the profile `voicetalk`, created with the Hermes CLI (`hermes profile create voicetalk --no-alias`,
`hermes -p voicetalk config set ...`, `hermes -p voicetalk tools enable|disable ...`).

`bun run agent:profile` (`core/scripts/hermes-profile.ts`) is the repeatable setup. It refuses the `default` profile,
is idempotent and has `--dry-run`:

| Setting                                                         | Value                                                                                                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `model.provider` / `default` (default, `--provider openrouter`) | `openrouter`, `meta/muse-ember` (`--model`); `base_url` and `api_key` are cleared so no stale local value survives                    |
| `provider_routing.data_collection`                              | `deny` (OpenRouter only, see Privacy)                                                                                                 |
| `model.provider` / `base_url` / `default` (`--provider local`)  | `custom`, VoiceTalk's local LLM URL (`--llm-url`, env `VT_LLM_URL`, default `http://127.0.0.1:8080/v1`), `--model`                    |
| `approvals.mode`                                                | `manual`: Hermes asks only what its dangerous-command filter flags (see Approvals)                                                    |
| `gateway.standalone`                                            | `true` (see below)                                                                                                                    |
| Toolsets on `api_server`                                        | only `computer_use`, `vision`, `file`, `terminal`; every other enabled toolset is disabled                                            |
| `.env` of the profile                                           | `API_SERVER_ENABLED`, `API_SERVER_HOST=127.0.0.1`, `API_SERVER_PORT=8650`, `API_SERVER_KEY`, and with OpenRouter `OPENROUTER_API_KEY` |

Rerunning with the other provider overwrites every model field, so the profile always matches one provider.

Port 8650: 8642 is the Ether VPS tunnel. `API_SERVER_KEY` is generated once (`vt_` + 32 random bytes), kept if it
already exists, written only to the profile `.env` and never printed, logged or committed. Core reads it from there
(`readAgentKey`) and the webview never sees it.

`OPENROUTER_API_KEY` comes from the environment (on Windows the script also reads the user variable) and is copied
into the profile `.env` only, so the gateway works however it was launched. Core reads it the same way
(`readOpenRouterKey`, environment first). It is never printed: the script says "copied (not shown)".

### Provider and model preferences

`agent.provider` is `openrouter` (default) or `local`; `agent.model` defaults to `meta/muse-ember`. Both take image
input and tools, which the computer-use loop needs. Prices in USD per million tokens (input / cache read / output):

| Model                          | Input | Cache | Output |
| ------------------------------ | ----- | ----- | ------ |
| `meta/muse-ember` (default)    | 0.10  | 0.004 | 0.50   |
| `deepseek/deepseek-v4.1-flash` | 0.051 | 0.001 | 0.203  |

Every run sends its own `provider` (`openrouter`, or `custom` for local) and `model`, so the profile cannot send a run
somewhere the pref did not ask for. That alone is not enough: Hermes takes no base URL per request, and a `custom` run
on a profile set up for OpenRouter **still reached openrouter.ai** (seen in the real smoke: `provider=custom
base_url=https://openrouter.ai/api/v1`). So with `local`, core first reads the profile `config.yaml` and refuses the run
(and shows it in the status line) unless `model.provider` is `custom` on a loopback URL. Nothing is sent to Hermes in
that case.

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
- **Preferencias > Asistente > Agente**: on/off, Hermes URL, profile, where the model runs (OpenRouter or local), the
  model (the two presets with their prices, or any id), live status (`agentStatus`). With OpenRouter the privacy line
  is always visible: "Las capturas de pantalla y tus pedidos al agente se envían a OpenRouter (sin retención de
  datos)." Saved with the area's own save. Off by default. The `default` profile is rejected in the form and in core's
  schema.
- **Agent model is its own setting**, separate from the voice brain.

### Tauri shell (`src-tauri/src/hermes.rs`)

When the agent is on, the webview calls `hermes_ensure(profile, url)`. The shell:

- refuses `default` and any non-loopback address;
- probes `/health` on the profile's port: if something already answers it is reported `external` and **left alone**;
- otherwise spawns `hermes -p <profile> gateway run` (path from `VT_HERMES` or `%LOCALAPPDATA%\hermes\bin`), health-checks
  it for up to 90 s, and records its pid;
- on switch-off or app exit it stops **only that pid's tree**. Never by image name, never a gateway it did not start.

### Approvals

VoiceTalk adds no approval layer of its own. Approvals follow **Hermes' own dangerous-command filter** under
`approvals.mode: manual`. Faku decided to keep that behavior as is. Hermes asks the user only when the filter flags
something; the Runs API turns that into an approval event, and core shows it as the card in the timeline
(`/v1/runs/{id}/approval`, only `once` or `deny`).

**Asks** (read in Hermes 0.23.1, `tools/approval.py`, `tools/file_tools_write_guards.py`, computer-use handler):

- `terminal` commands that match a dangerous pattern, and content rules (credential upload, hidden Unicode). Seen in
  the smoke: `powershell -Command ...` ("script execution via -e/-c flag").
- `computer_use` actions that change the screen state: click (also double, right, middle), drag, scroll, type, key,
  set value, focus app, bring to front.
- `write_file` / `patch` only on protected paths: `~/.ssh/config` and agent-instruction files.

**Runs without asking:**

- `terminal` commands that match no pattern. Seen in the smoke: `cmd /c start notepad.exe` (opens an app) and
  `tasklist`. Also `dir`, `type` and the like.
- `computer_use` `capture`, `wait`, `list_apps`, `list_windows` (screenshots and window lists).
- `read_file`, `search_files`, `vision_analyze`.
- `write_file` / `patch` on ordinary paths (derived from the guards above, not exercised in the smoke).

So "ask before anything that changes something" is **not** guaranteed: a shell command the filter does not know can
change the machine silently. That is the accepted trade-off. Dangerous patterns, hard floors (`approvals.deny`,
hardline blocks) and the protected paths still stop the run.

**Not used:**

- `smart`: a guardian LLM (auxiliary model, optional `approvals.smart_policy`) assesses what the filter flagged. It is
  not the same behavior: it adds a model that sees the command text (cost, privacy) and can approve on its own.
- `off`: bypasses every approval. Never.
- A `pre_tool_call` Hermes plugin that escalates every command and click to approval: prototyped, then dropped by
  decision and never committed. The profile has no plugins.

Revisit if the accepted trade-off changes: the plugin route is the way to force approval without patching Hermes.

### Privacy

With OpenRouter, screenshots and the user's requests leave the PC. The profile sets
`provider_routing.data_collection: deny`, which makes OpenRouter route only to providers that do not store or train on
prompts. This is the strongest switch Hermes exposes for OpenRouter: it has **no zero-data-retention (`zdr`) option**
for it (only the Nous Portal provider sends `zdr`). So "sin retención de datos" in the UI means "only providers that
declare no retention or training", not a contractual ZDR guarantee. Consequence seen in the smoke: free models are
rejected under this policy when their provider trains on free traffic (`HTTP 404: No endpoints found matching your
data policy (Free model training)`). The policy is not relaxed to make a free model work. With `local`, nothing leaves
the PC.

### Models

- The voice LFM 1.7B (ADR 0003/0011) is text-only and far too small to drive the computer. It stays the voice brain.
- Computer use needs a model with image input and tool calling: OpenRouter's, configured per profile (`--model`) and
  per run (the agent model in Preferencias).
- Auxiliary Hermes tasks (vision auto-detect, titles) use the profile's main model (`meta/muse-ember`), so a run
  pinned to a free model can still spend a little on those.
- Local model: VRAM next to the voice stack **pending, not measured**. No local model server was running, so there is
  no number.

### Smoke (2026-11-14, Hermes 0.23.1, `bun core/scripts/agent-smoke.ts`)

Real runs through core's `HermesClient`, provider `openrouter`, key without credits (free tier):

| Run                                                                                       | Result                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google/gemma-4-26b-a4b-it:free`, `google/gemma-4-31b-it:free`                            | `HTTP 429: ... temporarily rate-limited upstream` (Google AI Studio), after 3 tries, 9 to 14 s; three attempts across the session                                                                                                                                                                                                                         |
| `nvidia/nemotron-3.5-super-vl:free`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | `HTTP 404: No endpoints found matching your data policy (Free model training)`, 0.3 s                                                                                                                                                                                                                                                                     |
| `inclusionai/ling-3.2-flash:free`, "Listá los archivos del Escritorio"                    | Completed in 21.7 s: one `terminal` call, the real Desktop listing. Tokens: input 13372, output 252, cache 0                                                                                                                                                                                                                                              |
| same model, "Abrí el Bloc de notas", approvals approved via API                           | `cmd /c start notepad.exe` and two `tasklist` calls ran without a prompt; two `powershell -Command` calls asked for permission ("script execution via -e/-c flag") and were approved once through `/approval`; the run then failed with an upstream `429` at 86.9 s. After it, no Notepad process was running, so **that Notepad opened is not verified** |
| `--provider local` on the OpenRouter profile (before the guard)                           | Ran on `openrouter.ai` with `meta/muse-ember`: 55371 input and 748 output tokens, about USD 0.006. This is why the guard exists                                                                                                                                                                                                                           |

## Consequences

- Off by default; nothing starts and no port is opened until the user enables it.
- Only what Hermes' dangerous-command filter flags waits for the user (a visible card). Opening apps, `tasklist`,
  screenshots and ordinary file writes run unasked. See Approvals.
- A run's steps live only in the live call timeline; they are not persisted in session history yet.
- With OpenRouter the agent costs money per run and needs `OPENROUTER_API_KEY`; the status line says when it is missing.

## Not done (follow-ups)

- Voice approvals ("sí, permitilo"): only the buttons and Esc decide for now.
- Persisting agent steps in the session/chat history.
- A local VL model and its VRAM budget.
- A smoke with `meta/muse-ember` and `deepseek/deepseek-v4.1-flash` once the key has credits, and a confirmed Notepad
  open.
- A contractual ZDR route for OpenRouter, if Hermes ever exposes one.
- Dropping `gateway.standalone` once Hermes supports profile gateways natively.
- DESIGN.md also lists "Saltear": the timeline implements Permitir / No / Esc plus Detener (stop the task).
