# ADR 0010: Discord voice channels

- Status: accepted (Phase 7, `core/src/discord`, `src/features/discord`). Mocked end to end; the live gateway is not yet
  exercised against a real bot (see "Not verified live").
- Date: 2026-11-14
- Builds on: ADR 0002 (voice `WS /stt`), ADR 0004 (Cartesia TTS), ADR 0005 (call loop), ADR 0008 (sessions and notes).

## Context

VoiceTalk should sit in a Discord voice call as a participant: per-user transcripts with the real display names, a
session with notes like any other call, and, only when asked, spoken answers in the channel. The user's own mic call
(one speaker, one STT link) cannot express this: a room has many speakers, each needs its own VAD state, and Discord
delivers one Opus stream per user, not a mixed signal.

## Decision

### Library: discord.js + @discordjs/voice + opusscript, in core (Bun)

- `discord.js` 14 for the gateway, REST and slash commands. `@discordjs/voice` 0.19 for the voice UDP connection,
  receive per user (`receiver.subscribe(userId)`) and playback. `opusscript` (WASM) decodes Opus: no native build,
  nothing to compile on the user's machine.
- DAVE (Discord's end-to-end encryption for voice, mandatory for non-stage calls) is implemented inside
  `@discordjs/voice` through `@snazzah/davey`. We do not touch it.
- Imports and construction were checked under Bun 1.4.4. Bun is not a supported target of discord.js, so this is a
  risk we accept and isolate (below).

Alternatives considered:

- **Python sidecar with py-cord / discord.py voice receive.** Receive is a fork or unmaintained, and DAVE support is
  absent or lagging. It would also put a second network client in the voice process. Rejected.
- **Selfhosted Lavalink or a Rust (songbird) bot.** Playback-oriented; receive and DAVE are not what they are built for,
  and it adds a third process to ship. Rejected.
- **Capturing the Discord desktop client's audio (WASAPI loopback).** Platform-agnostic, no bot, but no per-user
  separation and no real names. This is the parallel call-capture work (p6) and complements this ADR; it is not a
  substitute.

### Isolation

Everything Discord-specific sits behind `DiscordGateway` / `VoiceConnection` (`gateway.ts`). Only
`discord-js-gateway.ts` imports discord.js. If Bun and the library stop agreeing, that one file can move to a Node
child process without touching the session, the answerer, the service or the tests.

### Terms of service

A bot account with its own token, invited by a server admin through OAuth2, may receive voice. That is what this is.
Self-bots and user-token automation violate Discord's ToS and are out of scope, now and later: `DISCORD_BOT_TOKEN` is
a bot token, and no code path accepts a user token. Recording people without telling them is the other line: see
"Transparency".

### Join and leave

- Slash commands, guild-scoped (instant, no one-hour global propagation): `/voicetalk join [talk]` joins the voice
  channel of the person who ran it; `/voicetalk leave` leaves. `leave` works only for members who are in the same voice
  channel as the bot.
- From the VoiceTalk UI: pick guild and channel (GraphQL `discordGuilds`, `discordJoin`, `discordLeave`).
- One session in total (the UI and the voice sidecar stay simple). A second join is refused with a clear message.
- The bot leaves by itself 60 s after the channel has no humans, and ends the session when the connection is lost.

### Audio path

Per speaker: Opus (48 kHz stereo) -> PCM -> 16 kHz mono (`Downsampler48kStereoTo16kMono`, streaming, frame-split safe)
-> one `WS /stt` link per user to the voice sidecar.

- Discord sends no packets during silence, so the VAD would never see the end of speech. On the end of a stream, core
  injects 800 ms of zero PCM (`FLUSH_SILENCE_MS`) so the segment closes and the final transcript arrives.
- `receiver.subscribe` is re-created on each speaking start (`AfterInactivity`, 500 ms); the Opus decoder is fresh per
  burst so packet loss does not leak into the next one.
- Each link has its own VAD state; transcription stays serialized on the one ASR worker. The sidecar now accepts
  several links: `VT_STT_MAX_CLIENTS`, default 8 (was 1). More concurrent speakers get close 1013 and core retries with
  a short backoff. Links idle for 20 s are closed. ADR 0002's "one connection at a time" is superseded by this.
- Names: server nickname, else global display name, else username. The name is stored per utterance
  (`utterances.speaker_name`), so renaming later does not rewrite history.

### Sessions

`sessions.source` comes from call capture's migration `0003_capture_sessions.sql` (ADR 0009), which also adds
`utterances.speaker_name`. Discord sessions are `source = 'discord'`, the same key a Discord call captured through
WASAPI gets; the UI tells them apart because bot utterances carry `speaker_name`. A dedicated `CallStore` (not the
mic call's) feeds `CallEvents`, so `NotesRecorder` produces the transcript, summary and the external note. Like
captured calls, bot sessions skip the decision model: no internal notes about third parties. The external note
body names the people ("con Ana y Beto"). `Note.speakers` keeps its `user | agent` ids. The mic call stays `call`.

### Talking (off by default)

`DiscordAnswerer` runs the same pipeline as ADR 0005 (LLM stream -> sentence chunks -> parallel Cartesia TTS ->
ordered playback) fed by a room. It does not reuse `CallSession`, which is bound to one mic and one STT link.

- Off unless enabled per session (`/voicetalk join talk:true`, the UI switch, or `discordSetTalk`). Needs
  `CARTESIA_API_KEY`.
- Gate (`addressed.ts`): with talking on, answer only when the utterance contains one of the names as whole words
  (accent and case insensitive). Names: `VT_DISCORD_NAMES` (comma-separated, default `voicetalk`, `voice talk`) plus the
  bot's username. `VT_DISCORD_ADDRESS=always` answers every utterance, for tiny rooms. Everything said in the room is
  kept as model context either way.
- Barge-in: when anyone starts talking, generation is aborted, queued audio is dropped, playback stops, and what had
  been said is recorded as the agent's utterance.
- Cartesia gives 24 kHz mono; core upsamples to 48 kHz stereo for Discord.

### Configuration

Env only. `DISCORD_BOT_TOKEN` and `DISCORD_APP_ID`; `VT_DISCORD=off` disables the feature. The token never reaches the
webview or GraphQL: `keyStatus.discord` is a boolean (token set and not `off`). Without a token the feature is simply
hidden (no nav item, `discordStatus.available = false`). A failed login becomes `state = error` with the library's
message, never the token.

Intents: `Guilds` and `GuildVoiceStates` only. No Message Content, no Guild Members, no Presences (display names are
fetched per member on demand).

Invite permissions: Connect, Speak, Use Slash Commands, plus **Send Messages** (integer `2150631424`). The spec
minimum is the first three (`2150629376`); Send Messages is added because the transparency notice must be posted to the
channel's chat when the join comes from the UI (a slash command can reply without it). Scope: `bot applications.commands`.

### Transparency

- On every join the bot posts in the voice channel's own text chat that it is transcribing, who is transcribing, whether
  it can talk, and how to remove it (`/voicetalk leave`). For `/voicetalk join` the public reply is the notice.
- Fail-closed: if the notice cannot be posted (missing permission), the bot leaves and refuses. No audio is sent to STT
  before `session.start()`, which runs after the notice is out.
- Changing the talk setting mid-session is announced too. Leaving is announced.
- The UI shows a recording indicator in every view (banner + dot on the nav item) while a session is active.

## Limits

- One session, one guild at a time. Stage channels are not handled.
- Speakers are separated by Discord (one stream per user), not by diarization. Someone's voice leaking into another
  person's mic is transcribed under the second person's name.
- Latency of the first answer is the ADR 0005 chain plus about 800 ms of flush silence and the 500 ms inactivity window.
- Bun is outside discord.js's support matrix (see Isolation).

## Not verified live

Verified with mocks (53 tests: config, resamplers, address gate, join/leave, fail-closed announce, slash commands,
speaker mapping, session writes, TTS-answer gate, barge-in, GraphQL): everything above the gateway interface.

Needs a real bot and a voice channel with at least two people, because no token was available when this was written:

1. `discord-js-gateway.ts`: login, guild slash command registration, `joinVoice` to `Ready`.
2. The UDP and DAVE handshake under Bun.
3. Real Opus decode (opusscript) of live packets and the downsample quality for STT.
4. Real playback into the channel and barge-in cutting it.
5. `VoiceStateUpdate` member counts for the empty-room auto-leave.
