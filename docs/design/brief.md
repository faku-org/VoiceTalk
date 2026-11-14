# VoiceTalk: design brief

Input for building VoiceTalk's design system (Claude Design, PenPot). It describes what the app is, who uses it,
what exists today and what is coming. The house rules it inherits are summarized here; where this brief and the house
rules disagree, the house rules win (WeFaber house design, `~/.claude/standards/DESIGN.md`).

## What it is

A desktop voice companion (Windows first, Tauri). The user talks to an AI agent called **Ether** by voice, like a
phone call. Ether answers with a natural voice, remembers past conversations, can read the user's own folders and
can transcribe calls the user has on other platforms (Discord, Teams, Zoom, Meet, WhatsApp, Slack).

- **User:** one person, on their own PC, for long sessions (thinking out loud, journaling, planning, meetings).
- **Tone:** calm, polished, private. Reference points: Vision / FRIDAY (an assistant that is present but never loud),
  not a chatbot, not a game.
- **Language:** UI copy in Spanish. The agent speaks **neutral Spanish** (no regional slang); UI copy follows the
  house rule (short, plain, no jargon, no exclamation marks, no emojis).
- **Privacy is a feature.** Everything runs locally except the voice (Cartesia) and an optional cloud model. Every
  recording is visible while it happens, and the UI says what is kept and where.

## How it works (what the UI has to show)

```
mic ──> local STT (speech to text) ──> brain (LLM) ──> Cartesia TTS ──> speaker
                     │                      │
                     └── transcript ────────┴──> sessions DB: transcript, summary, notes
```

- **Call states** (the agent's face reflects these): `idle`, `listening` (user talking), `thinking` (waiting for the
  model), `speaking` (agent talking). The user can interrupt the agent at any moment (barge-in): speaking stops and it
  goes back to listening.
- **Transcript** grows live during the call: one bubble per turn, speaker name and time offset.
- **After the call:** a summary ("Resumen"), open questions ("Quedó pendiente"), topics raised ("Salieron estos temas").
  Internal notes the agent writes for itself are never shown.
- **Sources of a session:** the own call with Ether, a captured call from another app ("Capturada de Discord"), or a
  Discord voice channel transcribed by the bot (several named speakers).
- **Recording indicator:** while a capture or Discord session is recording, a red bar stays visible on every screen
  ("Grabando llamada · Discord · 03:12 · Ver captura"). This is a hard rule.

## Screens today

Sidebar shell (icons on narrow windows, icon + label at `md`), one view at a time with a fade between views.

| Screen           | Content                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Llamada**      | Start/end call, state label + icon, mic level, live transcript, latency details. Needs Ether's presence (see below).                                            |
| **Capturar**     | Pick an app with audio (Discord, Zoom…), consent step, start/stop, levels for remote + own mic, timer.                                                          |
| **Discord**      | Bot status, which server/channel it is transcribing, people in the channel, privacy notice. Hidden without a bot token.                                         |
| **Sesiones**     | List (title, date, duration, status, platform) + detail (summary, open questions, topics, transcript). List left, detail right on wide screens.                 |
| **Preferencias** | Areas, one at a time with pill navigation, each with its own save: Asistente, Decisiones, Carpetas, Ubicación, Captura, Apariencia, Actualizaciones, Servicios. |
| **Onboarding**   | Steps: Bienvenido, Micrófono (level meter), Carpetas permitidas, Modelos (download progress), Tu voz, Tema.                                                     |

## Coming next (design these too)

- **Ether in the call:** the agent orb as the center of the call screen, driven by the call state (see "Agent").
- **Chat tab:** talk to the model by text, see transcripts as a chat.
- **Select and reply:** select text in a transcript or answer, then: reply to that message, correct what the
  transcript says, continue a topic from it, fork the conversation, highlight on screen.
- **Voice picker:** change the agent's voice and provider (Cartesia, xAI, local), with a preview.
- **Brain settings:** model presets (local, Ollama, Claude, OpenAI, Grok, custom), thinking effort, reply style
  (Tranquilo, Conciso…), custom system prompt.
- **Dashboard:** tokens used, call time, most discussed topics.
- **Generative UI:** the agent renders small views of its own inside the conversation (cards, lists, charts).
- **Computer use:** the agent acts on the PC; every action is visible as a step timeline and needs approval.

## Agent: Ether

Shared WeFaber identity, from `@wefaber/orb` (`EtherStage`):

- A **dotted sphere** with a **ring that turns in 3D** around it. Optional face: two vertical bar eyes, no mouth.
- **Dots = voice:** they move outward while speaking, inward while listening. **Ring = state:** continuous when idle,
  pulsing while speaking, arcs on their own orbits while working, broken on error, flat grey when offline.
- States available: `idle`, `listening`, `thinking`, `speaking`, `working`, `attention`, `error`, `resting`, `offline`.
- **The only element with ambient motion** in the whole app. Never two orbs on one screen. It reflects the agent,
  never data loading. Sound off by default.
- In product screens it stays in place (no wandering, no moods); reactions are for broadcast surfaces only.

## Visual system (current)

Theme **Azul** from `@wefaber/tokens` (same family as JobIt), light + dark, switchable (Sistema / Claro / Oscuro),
painted before first render.

| Role                             | Light                             | Dark                              |
| -------------------------------- | --------------------------------- | --------------------------------- |
| `bg` (canvas)                    | `#e3f2fd`                         | `#0a1220`                         |
| `surface` (cards)                | `#ffffff`                         | `#111c2e`                         |
| `surface-2` (inset, hover)       | `#e3f2fd`                         | `#17243a`                         |
| `text`                           | `#0d47a1`                         | `#eef3f8`                         |
| `text-muted`                     | `#3d6cb4` (5.25:1 on white)       | `#c5ced8`                         |
| `border`                         | ink at 10 %                       | `#eef3f8` at 12 %                 |
| `accent` (focus, links, primary) | `#1976d2`                         | `#4c9ffe`                         |
| `orb`                            | `#2196f3`                         | `#4c9ffe`                         |
| `danger` / `warning` / `success` | `#c62828` / `#9a5b00` / `#2e7d32` | `#ff8a80` / `#ffcc80` / `#a5d6a7` |

- **Type:** system UI stack (Segoe UI on Windows); one family, small consistent steps, `tabular-nums` for times.
- **Radii:** control 12 px, card/panel 16 px, full for orb and pills. 4 px grid; rows 32/40 px.
- **Icons:** lucide only. Platform logos (Discord, Zoom…) as Simple Icons SVG.
- **Motion:** 120 ms hover/press, 180 ms panels, 200 ms view fade, 240 ms layout. Reduced motion → opacity only.

## Rules the system must keep

1. Content first; one thing per screen; at most three options on a default screen.
2. Color always means something (status, danger, identity) and never travels alone: icon + color.
3. No box inside a box (two visible levels at most). No single-side accent borders: full border or tint fill.
4. One primary button per area. Submit never disabled; a live summary lists what is missing.
5. Empty states say what to do (dashed box). Errors say what failed and what to try.
6. Menus and panels float over content and never move it. Details open in a docked panel on the right.
7. AA contrast in both themes, visible focus ring, full keyboard, screen-reader names.

## Open design questions

- Call screen layout with Ether: orb centered with the transcript below, or orb in a side column with the transcript
  as the main content?
- How the transcript and chat merge: one timeline with voice and text turns, or two tabs?
- Where selection actions live: floating toolbar over the selection, or a context menu?
- How generative views sit in the transcript: inline cards, or a side panel?
- Whether VoiceTalk keeps Azul or gets its own theme within the house family.
