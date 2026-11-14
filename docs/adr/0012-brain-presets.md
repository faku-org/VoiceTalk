# 0012: Brain presets, thinking effort, styles and system prompt

Status: accepted (v0.11.0)

## Context

`prefs.brain` was an enum (`local` | `claude`): the brain was hardcoded to two providers, with no way to pick a model, tune reasoning or shape the voice of the answers (issue #6). Everything behind `ChatProvider` already existed (`OpenAiCompatChat`, `AnthropicChat`), so the gap was configuration, not architecture.

## Decision

`prefs.brain` is an object: `{ provider, model, baseUrl, effort, style, systemPrompt }`.

### Providers

`core/src/llm/presets.ts` holds the catalog. Defaults are editable suggestions, not contracts: an empty `model` or `baseUrl` means "the preset's default".

| Provider | Adapter       | Default model      | Default endpoint           | Key (env only)                 |
| -------- | ------------- | ------------------ | -------------------------- | ------------------------------ |
| `local`  | OpenAI-compat | whatever is loaded | `prefs.llmUrl`             | none                           |
| `ollama` | OpenAI-compat | `llama3.2`         | `http://127.0.0.1:11434`   | none                           |
| `claude` | Anthropic SDK | `claude-haiku-5-5` | SDK                        | `ANTHROPIC_API_KEY`            |
| `openai` | OpenAI-compat | `gpt-5-mini`       | `https://api.openai.com`   | `OPENAI_API_KEY`               |
| `xai`    | OpenAI-compat | `grok-4-fast`      | `https://api.x.ai`         | `XAI_API_KEY`                  |
| `custom` | OpenAI-compat | none (required)    | `brain.baseUrl` (required) | `VT_CUSTOM_LLM_KEY` (optional) |

- Keys come from env only. GraphQL `keyStatus` reports booleans; key material never reaches prefs, GraphQL or the webview.
- A required key that is missing, or a `custom` brain without an endpoint, degrades to the local brain with one warning in the log (same behavior as the old `claude` without a key). Effort, style and prompt survive the degradation.
- `brain.baseUrl` is an extra field: `llmUrl` stays the address of the local llama-server, and Ollama and custom need their own. Any non-empty `baseUrl` overrides a preset's endpoint, so the UI sends it empty for providers that have none.

### Thinking effort

`effort` is `off` | `low` | `medium` | `high`. `off` is the default because latency matters in a call.

| Provider | `off`                                                                | `low` / `medium` / `high`                               |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| local    | `chat_template_kwargs.enable_thinking: false` (required for latency) | `enable_thinking: true`                                 |
| ollama   | `reasoning_effort: "none"`                                           | `reasoning_effort` as is                                |
| openai   | `reasoning_effort: "minimal"`                                        | `reasoning_effort` as is                                |
| xai      | `reasoning_effort: "low"`                                            | `low` for `low`, `high` for `medium`/`high`             |
| custom   | `enable_thinking: false`                                             | `reasoning_effort` as is                                |
| claude   | per family, see below, with `output_config.effort: "low"`            | `thinking: {type: "adaptive"}` + `output_config.effort` |

- OpenAI sends `reasoning_effort` only to reasoning families (`o*`, `gpt-5*`); xAI only to `mini` models, the only ones that accept it. Other models get no field, so the request never fails on an unsupported parameter. OpenAI and xAI also drop `temperature` and use `max_completion_tokens`.
- Claude never uses `budget_tokens`: current models reject it with a 400. Depth is adaptive thinking plus `output_config.effort`. For `off`: Haiku sends `thinking: {type: "disabled"}`, Sonnet 5.5 sends `between_tools`, Opus and Fable omit `thinking`.
- Thinking tokens count against the output cap, so `max_tokens` gets headroom when effort is on: +1024 (`low`), +2048 (`medium`), +4096 (`high`). `off` adds nothing.

### Styles and system prompt

`style` is `tranquilo` (default) | `conciso` | `detallado`. Each is a short Spanish fragment; `detallado` says it replaces the persona's word limit. The fragment and the user's custom prompt (max 2000 chars, labeled "Instrucciones del usuario") are appended to the first system message by `withBrainPrompt`, which wraps any provider, so the persona built by the call loop is untouched.

### Preferences, GraphQL and migration

- Schema: nested zod object, patch merges per field. GraphQL: `BrainPreference` / `BrainPreferenceInput` with enums `BrainProvider`, `ThinkingEffort`, `BrainStyle`.
- Migration on load and on update: a string `brain` equal to `local` or `claude` becomes `{ provider }` with the defaults for the rest. Any other string is a validation error. Old clients that still send the enum keep working at the data level; the GraphQL type no longer accepts a bare enum.
- `VT_BRAIN` (env fallback without prefs) accepts any provider id.

### Runtime

`call/live.ts` resolves the config from prefs on every read and caches the provider by the full config key (provider, model, endpoint, effort, style, prompt). The API key is not part of the key. A change applies on the next turn without a restart.

## Consequences

- Adding a provider is one entry in `PRESETS` plus, if it needs a body quirk, one case in `openAiCompatBody`. The UI mirrors the catalog in `src/app/brainPresets.ts`; the two must stay in sync (no codegen yet).
- Model ids are free text. A typo surfaces as an HTTP error from the provider on the next turn, logged by the call loop.
- Reasoning parameter support moves with the providers; the family checks (`gpt-5*`, `mini`) are heuristics and are the first thing to revisit if a provider rejects a request.
