# Design

Extends the WeFaber house design (`~/.claude/standards/DESIGN.md`). Only deviations and product specifics below; where this file and the house rules disagree, the house rules win.
Theme: **Azul** (`@wefaber/tokens` `themes/azul.css`), light + dark + system. Reference points: Crest's Dynamic Island (desktop), JobIt (Azul family).

Source: the VoiceTalk design system (claude.ai artifact, authored by Faku). This file is its README adapted as the project design doc; the tokens live in `src/index.css` (kit import) and `src/styles/tokens.css` (VoiceTalk additions).

VoiceTalk is a desktop voice companion: one person talks to **Ether** like a phone call, for long sessions. The system is calm, polished and private: an assistant that is present but never loud.

## Principles

1. **Content first.** The transcript is what the user reads; chrome never competes. One thing per screen, at most three options on a default screen.
2. **One living element.** Ether's orb is the only thing with ambient motion. Nothing else loops, pulses or spins (a spinner that never ends is a bug).
3. **Privacy is visible.** Every recording shows while it happens (`RecordingBar`). Every screen that keeps data says what is kept and where.
4. **Color means something** (status, danger, identity) and never travels alone: icon + color + word.
5. **Calm.** No exclamation marks, no emojis, no hype, no gamification.

## Content and copy

- UI copy is Spanish, short and plain. Imperatives in voseo per house rule: "Elegí una app", "Tocá para hablar", "Guardá".
- Ether itself speaks **neutral Spanish** (no regional slang). Copy written in Ether's voice (greetings, onboarding lines) is neutral too: "Hola, soy Ether. Cuando quieras, empezamos."
- Name things by what the user sees, never by internals: "Llamada", "Capturar", "Sesiones", not STT, sidecar, LLM. Technical detail lives behind "Ver detalle" in `mono`.
- Errors say what failed and what to try: "No se pudo iniciar el micrófono (otra app lo está usando). Reintentar · Ver detalle".
- Empty states say what to do: "Todavía no hay sesiones. Iniciá una llamada y va a aparecer acá con su resumen."
- Confirmations are quiet and disappear: "Guardado."
- Session sections use these exact headings: **Resumen**, **Quedó pendiente**, **Salieron estos temas**, **Transcripción**. Ether's internal notes are never shown.
- Session sources read: "Llamada con Ether", "Capturada de Discord", "Canal de Discord · #general".

## Tokens

Roles are CSS custom properties, exposed to Tailwind v4 through `@theme`. **Names never change between themes; values do.** Components use roles (`bg-surface`, `text-muted`, `border-border`, `bg-accent text-on-accent`), never raw colors. Light is the default; dark is `.dark` / `[data-theme="dark"]` on `<html>`.

Where they live:

| Layer     | File                                              | Defines                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kit       | `@wefaber/tokens` `themes/azul.css` + `theme.css` | bg, surface*, border, text, text-muted, accent, on-accent, danger, warning, success, review, orb*, elev-float, `r-control/card/panel`, `font-ui`, `font-code`, type scale, durations (fast/panel/layout), ease, gutter, tile-pad, focus ring |
| VoiceTalk | `src/styles/tokens.css`                           | on-danger, recording, highlight, island-_, space-_, row sizes, island/dock sizes, `r-full`, `dur-view`, `font-heading` (display), `font-chat`, the type classes, `surface-recording`                                                         |

The first-skeleton aliases `canvas`, `text-muted`, `hairline` still resolve (`src/index.css`); new code uses `bg`, `muted`, `border`.

### Color

| Role                                | Light                         | Dark                          | Use                                                                                                                                                                      |
| ----------------------------------- | ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bg`                                | `#e3f2fd`                     | `#0a1220`                     | Window and sidebar. Agent transcript turns sit on it.                                                                                                                    |
| `surface`                           | `#ffffff`                     | `#111c2e`                     | Cards, panels, docked panel, user turns, inputs.                                                                                                                         |
| `surface-2`                         | `#e3f2fd`                     | `#17243a`                     | Hover and selection inside a card.                                                                                                                                       |
| `surface-3`                         | `#bbdefb`                     | `#1a4470`                     | Tracks: meters, switch off, progress rails.                                                                                                                              |
| `border`                            | `rgb(13 71 161 / 10%)`        | `rgb(238 243 248 / 12%)`      | Hairline on cards, turns, inputs, dividers. Decorative only.                                                                                                             |
| `text`                              | `#0d47a1`                     | `#eef3f8`                     | All copy. 8.6:1 on surface (light), 15.3:1 (dark).                                                                                                                       |
| `text-muted`                        | `#3d6cb4`                     | `#c5ced8`                     | Speaker, offset, dates, hints. 5.25:1 on surface, 4.59:1 on bg (light); 10.7:1 (dark).                                                                                   |
| `accent`                            | `#1976d2`                     | `#4c9ffe`                     | Focus ring, links, active nav item, the one primary button per area. Light: 4.6:1 on surface, **4.0:1 on bg (fails)**: accent text needs `surface` under it. Dark 6.3:1. |
| `on-accent`                         | `#ffffff`                     | `#0a1220`                     | Text and icons on an accent fill. 4.6:1 / 6.9:1.                                                                                                                         |
| `danger` (alias `recording`)        | `#c62828`                     | `#ff8a80`                     | Recording, ending a call, errors, destructive actions. Always with an icon. 5.6:1 / 7.5:1.                                                                               |
| `on-danger`                         | `#ffffff`                     | `#0a1220`                     | Text and icons on a danger fill. 5.6:1 / 8.2:1.                                                                                                                          |
| `warning`                           | `#9a5b00`                     | `#ffcc80`                     | Waiting on something (download, approval). 5.4:1 / 11.6:1.                                                                                                               |
| `success`                           | `#2e7d32`                     | `#a5d6a7`                     | Done, saved, connected. 5.1:1 / 10.4:1. In dark, success and danger are close in lightness: icon + word always.                                                          |
| `review`                            | `#6a1b9a`                     | `#ce93d8`                     | A computer-use step waiting for approval. 9.4:1 / 7.2:1.                                                                                                                 |
| `highlight`                         | `rgb(154 91 0 / 18%)`         | `rgb(255 204 128 / 26%)`      | Tint under a passage the user highlighted. The text stays `text`.                                                                                                        |
| `orb`, `orb-ring`, `orb-flow`       | `#2196f3` `#64b5f6` `#90caf9` | `#4c9ffe` `#7ab6ff` `#dbeafe` | `@wefaber/orb` only. Never `orb` as text (3.1:1).                                                                                                                        |
| `orb-alert`, `orb-error`, `orb-off` | `#f9a825` `#e53935` `#9aa6b4` | same                          | Attention ring, broken ring, offline disc.                                                                                                                               |

Rules:

- Paint the window `bg`; put content on `surface` cards with a `border` hairline.
- Text on fills uses the `on-` tokens: `on-accent` on accent, `on-danger` on danger. **Never `bg` (or `canvas`) on a fill.**
- `danger` means recording, ending a call, errors, destructive actions. `warning` means waiting. `success` means done or connected. `review` marks a step waiting for approval.
- Light/dark/system is chosen in Preferencias › Apariencia and painted before first render: `public/theme-init.js` sets `data-theme` and `.dark` from the cached preference (`src/lib/theme.ts` keeps the storage key in sync).

#### Island tokens (always dark, both themes)

`island` `#05080f` · `island-edge` `rgb(238 243 248 / 16%)` (without it the capsule is 1.07:1 on dark windows) · `island-text` `#eef3f8` (18:1) · `island-muted` `#aeb9c7` (10:1) · `island-accent` `#4c9ffe` (7.3:1) · `island-alert` `#ff8a80` (8.8:1). Island text uses these only.

### Type

Three voices, one job each. Fonts are bundled locally (offline desktop app, no CDN):

| Voice     | Family                                               | Package                                    | Use                                                                                                              |
| --------- | ---------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `display` | Bricolage Grotesque (variable, weights 200 to 800)   | `@fontsource-variable/bricolage-grotesque` | View titles, section headers, big figures. Tailwind `font-display`; `h1`, `h2`, `h3` get it from the base layer. |
| `chat`    | Averia Serif Libre 400 + italic                      | `@fontsource/averia-serif-libre`           | What was said: transcript turns, live STT, the composer. Tailwind `font-chat` / class `.chat`.                   |
| `ui`      | System sans (`-apple-system`, SF Pro Text, Segoe UI) | none                                       | Every control, label and list.                                                                                   |
| `code`    | `ui-monospace`, SF Mono, Cascadia Code               | none                                       | Latency, model ids, paths only.                                                                                  |

Both bundled families are SIL Open Font License 1.1 (license texts ship in the packages' `LICENSE` files). Averia Serif Libre has no variable build, so it uses the static `@fontsource` package; the house default `@fontsource-variable/*` applies wherever one exists.

Never mix: a button is never serif, a transcript turn is never Bricolage.

| Style     | Size / line | Weight | Use                                             |
| --------- | ----------- | ------ | ----------------------------------------------- |
| `hero`    | 56 / 60     | 600    | Onboarding welcome only.                        |
| `display` | 32 / 38     | 600    | Call timer, dashboard figures (`tabular-nums`). |
| `h1`      | 24 / 32     | 600    | View title, one per view.                       |
| `h2`      | 20 / 28     | 600    | Area titles (Preferencias), sections.           |
| `h3`      | 16 / 24     | 600    | Session and card titles.                        |
| `chat`    | 15 / 22     | 400    | Conversation text.                              |
| `body-lg` | 14 / 20     | 400    | Default UI text: buttons, fields, list rows.    |
| `body`    | 13 / 20     | 400    | Dense lists, bullets, empty states.             |
| `meta`    | 12 / 16     | 400    | Speaker names, offsets, dates, hints.           |
| `caption` | 11 / 16     | 500    | Tiny labels.                                    |
| `mono`    | 12 / 16     | 400    | Latency, model ids, paths (`nowrap`).           |

- Times, durations, counts and levels always use `tabular-nums`.
- Paragraphs `text-wrap: pretty`; headings `balance`. Paths, model ids and chips are `nowrap`.

### Space and shape

- 4 px grid. Controls are `row` (40 px); dense toolbars `row-compact` (32 px); call controls `row-touch` (44 px).
- `space-1/2/3/4/6/8` = 4/8/12/16/24/32. Card padding `tile-pad` (20, 24 at 1280 px); page gutter `gutter` (16, 20 at 1280 px); gap between transcript turns `space-3`.
- Radii: `r-control` 12 (controls, rows), `r-card` 16 (cards, turns), `r-panel` 16 (floating layers), `r-full` (orb, pills, switches). Concentric where frames nest.
- Island sizes: `island-closed` 44, `island-row` 52, `island-max` 560, `island-top` 8. Dock: `dock` 400.
- No box inside a box: two visible levels at most (card, rows). A wrapper between them has no border or fill.
- **No single-side accent borders.** Active and selected states use a tint fill (`surface-2`, or accent at 10 %) plus accent text, or a full 1 px border. The recording surface is the `surface-recording` utility (full 1 px `recording` border + 8 % tint over `surface`).
- Depth: cards are flat (border only). `elev-float` is for floating layers only: selection toolbar, menus, docked panel, dialogs.

### Motion

- `dur-fast` 120 hover and press (press scales 0.98), `dur-panel` 180 popovers and docked panel, `dur-view` 200 fade between views, `dur-layout` 240 reflow. All on `ease` `cubic-bezier(0.2, 0, 0, 1)`.
- Reduced motion: every duration becomes 0 except the view fade, which stays opacity only; the orb keeps its state but drops ambient motion.
- Motion explains a change of state; nothing delays an action.

## Ether

Ether is the character from `@wefaber/orb/rig` (0.2.0+): a dotted sphere with eyes and a 3D ring, driven by a rig. The call screen consumes it through `src/features/call/EtherOrb.tsx` (call state → rig state, mic/playback level → `body.listen`/`body.speak`).

- **State** (`setState`) belongs to the call: `idle`, `listening`, `thinking`, `speaking`, plus `working` (computer use), `attention` (approval needed), `error`, `offline` (sidecar or model missing), `resting` (app idle for long). The ring carries it; the state is always written next to her.
- **Mood** (`setMood`) is rare and lasting: only neutral, happy, curious, focused, tired. The other six (surprised, sad, mischievous, proud, shy, bored) stay out. **Reactions** (`react`) are one-shot: nod, done, think, flash, hop. No spin, laugh or excited.
- Voice: mic level feeds `body.listen`, playback feeds `body.speak`. Barge-in switches `speaking` to `listening` at once.
- One Ether per screen, `awake` mode, fixed in place (`motion.x/y` fixed in the call screen; no `afk` wandering, no `sleep` during a call). She reflects the agent, never data loading. Never a spinner. Sound off by default.
- `aria-label` carries the state in words ("Ether: escuchando"). Under reduced motion the stage draws a calm frame twice a second.

## Privacy and recording

- While a capture or Discord session records, it shows everywhere and cannot be dismissed. On the desktop the **Island** takes its Recording state ("Grabando · Discord · 03:12 · Ver captura"); inside the app window the `RecordingBar` is pinned at the top of every view. Hard rule.
- The Island and the chat dock are hidden from screen sharing and screenshots by default (switch in Preferencias). Hiding them never hides a recording from the user.
- Capturing another app always passes a consent step that says what is recorded, where it is stored and who should be told.
- Screens that hold data name its place: "Se guarda en este equipo, en Documentos/VoiceTalk." Only the voice (Cartesia) and an optional cloud model leave the PC, and the UI says so where they are chosen.

## Layout

VoiceTalk lives in two places: the **Island** on the desktop (always there, mostly closed) and the **app window** (sessions, preferences, long work).

### Desktop: the Island

- A dark capsule at the top center of the screen, `island-top` (8 px) from the edge, over every app. Model: Crest's Dynamic Island for Windows and macOS.
- Closed by default: a 44 px circle with Ether. It opens only for a reason: a message, Ether's comment on what is on screen, or a recording. It never opens to show it exists.
- One row (`island-row`, 52 px) for comments and recording; up to two lines for messages; never wider than `island-max` (560 px). Optional data goes in an `InfoPill` beside it, not inside.
- Text chat opens as a `ChatDock` on the right edge (`dock`, 400 px); calls in Discord and similar open `CallNotes`. Both float over other apps and move nothing.
- Full screen and games: the Island stays closed and Ether's comments wait for a pause unless the user turned them on for that game.
- Always dark in both themes; `island-edge` keeps it visible on dark windows.

### App window

- Sidebar shell: icons only on narrow windows, icon + label from `md`. One view at a time with a `dur-view` fade.
- Lists left, detail right on wide screens (Sesiones). Details otherwise open in a **docked panel on the right** that floats over content and moves nothing.
- Preferencias: one area at a time behind pill navigation, each area a card with its own save. The save button is never disabled; a live summary above it lists what is missing.
- Menus, popovers and the selection toolbar float over content; opening one never reflows anything. Esc closes the topmost layer.

## Components

Catalog from the design system. "App" says where the code stands today; only Button, Field, Switch, RecordingBar, EmptyState (pattern) and the transcript turns exist in the app.

| Component                | What it is                                                                                                                  | Rules that matter                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Button**               | Primary, danger, secondary, ghost. `r-control`; `row` 40, `row-touch` 44 for call controls, `row-compact` 32 in dense bars. | One primary per area. Primary = `accent` + `on-accent`; danger = `danger` + `on-danger`, always with an icon. Never disable a submit button. Labels are verbs ("Iniciar llamada", "Guardar", "Reintentar"). App: `Button` in `src/app/ui.tsx`.                                                                                                                                                                                             |
| **Field / IssueSummary** | Label always visible (`body-lg` medium), hint in `meta` / `muted`.                                                          | Error = `CircleAlert` + `danger` text + `aria-invalid`. On submit, `IssueSummary` lists what is missing and focus moves to it. Each Preferencias area is one card with its own save.                                                                                                                                                                                                                                                       |
| **Switch**               | On/off, 44 x 24, `r-full`.                                                                                                  | Track `surface-3` off, `accent` on, thumb `surface`, moves in `dur-fast`. Label on the left says what is on. `role="switch"` + `aria-checked`. Applies at once only when the area has no save button.                                                                                                                                                                                                                                      |
| **EmptyState**           | What a view shows with nothing yet. Dashed `border`, `r-card`, `body` in `muted`.                                           | Say what to do next and where data goes. At most one action (the view's primary). No illustrations, no orb.                                                                                                                                                                                                                                                                                                                                |
| **RecordingBar**         | Pinned at the top of every view while anything records; cannot be dismissed.                                                | "Grabando llamada · origen · mm:ss · Ver captura". `recording` dot + title, full 1 px `recording` border, 8 % tint over `surface` (`surface-recording`). Dot static: recording never pulses. `aria-live="assertive"` on start and stop.                                                                                                                                                                                                    |
| **TranscriptTurn**       | One turn; voice and text share timeline and component.                                                                      | User turns right on `surface`, Ether's left on `bg`; `border`, `r-card`, max 85 %, `chat` font; speaker line in `meta` / `muted` UI sans ("Tú" or "Ether" + offset). Typed turn adds `Keyboard` + "escrito". The turn being spoken has a dashed border and grows in place. List is `aria-live="polite"`. Ether's words are neutral Spanish.                                                                                                |
| **SessionRow**           | A row in Sesiones. Rows sit directly in the list card.                                                                      | Icon by source: `Phone`, `AudioLines`, `Hash`. Title `body-lg` medium, one line; source and date `meta`, tabular. Hover `surface-2`; the open one has an accent tint and a full accent hairline, never a side bar.                                                                                                                                                                                                                         |
| **SelectionToolbar**     | Floats over text selected in a transcript.                                                                                  | Responder, Corregir, Más (Continuar tema, Bifurcar, Resaltar). Right-click and `Shift+F10` open the same items as a context menu. `elev-float`, `r-control`, `dur-panel`; never moves text; Esc closes and keeps the selection.                                                                                                                                                                                                            |
| **ApprovalStep**         | One computer-use action in a vertical timeline.                                                                             | Done = `success` + `Check` + "Hecho". Pending = `review` + "Esperando tu OK", in a card with the only primary ("Permitir"), plus Saltear and Detener. Spending money, sending messages and deleting data always wait. Ether shows `attention` while waiting, `working` while acting.                                                                                                                                                       |
| **EtherOrb**             | Ether in a stage (see Ether above).                                                                                         | One per screen; state written beside her; `aria-label` with the state.                                                                                                                                                                                                                                                                                                                                                                     |
| **Island**               | Dark capsule at the top center of the screen.                                                                               | States: Closed (44 circle), Message (up to 560, `chat` text + one `island-accent` action), Expanded (52 row, comment on the screen), Recording (dot + "Grabando" + source + timer + "Ver captura", never closes). Messages close after reading time (about 1 s per 15 chars, at least 4 s) and on Esc; hover pauses. Size animates with `dur-layout`; cross-fade under reduced motion. `role="status"`; recording `aria-live="assertive"`. |
| **InfoPill**             | Second dark capsule beside the expanded Island.                                                                             | `ui` 14/20 medium, `tabular-nums`; units in `island-muted`. Opt-in items (time default, weather, FPS, CPU, GPU), four at most, update at most once a second, no threshold colors. Never alone, never during recording.                                                                                                                                                                                                                     |
| **ChatDock**             | Text chat docked right, `dock` 400, `elev-float`.                                                                           | Header: small Ether (32), "Ether" in display 16/24, state word in `meta`, one close button. Body = `TranscriptTurn` (`role="log"`). Composer in `chat` font, placeholder "Escribile a Ether", one round send button (`accent` / `on-accent`). Enter sends, Shift+Enter breaks the line. Shares one timeline with the call. Opens with `dur-panel`.                                                                                         |
| **CallNotes**            | Call mode for Discord, Zoom, Meet: Ether large left, notes panel `dock` wide right.                                         | Stage 200 px, state word, timer in `display`, source in `meta`. Notes: "Notas" in `h3`, then Resumen, Quedó pendiente, Salieron estos temas in their exact words; "Se actualizan en vivo" in `meta`. Recording stays visible on the Island.                                                                                                                                                                                                |

## Design decisions

Proposed answers to the brief's open questions; kept until Faku changes them.

- **Call screen with Ether.** On wide windows (`lg`), the orb sits in a fixed left column (about 280 px) with the state word, timer (`display`) and call controls under it; the transcript is the main content on the right. On narrow windows the orb sits on top at 120 px and the transcript scrolls below. Before the call starts the orb is centered alone with one primary button. Reason: content first. The transcript is what grows and what the user reads; Ether stays in place and never moves mid-call.
- **Transcript and chat.** One timeline. Voice and text turns are the same `TranscriptTurn`; a text turn shows a `Keyboard` icon next to the speaker. The composer sits at the bottom of the call view and of every session detail. Two tabs would split one conversation in two.
- **Selection actions.** A floating `SelectionToolbar` over the selection with three visible actions (Responder, Corregir, Más). "Más" opens Continuar tema, Bifurcar, Resaltar. Right-click and `Shift+F10` open the same items as a context menu, so the keyboard path exists.
- **Generative views.** Inline cards in the timeline at the agent's turn, as a leaf on the canvas (the card replaces the bubble, never sits inside it). Anything bigger than a card ("Ver todo") opens in the docked right panel.
- **Computer use.** Each action is an `ApprovalStep` in a vertical timeline; the pending one carries the only primary button ("Permitir"). Ether shows `attention` while waiting and `working` while acting.
- **Theme.** Keep Azul. VoiceTalk shares Ether, the orb blue and the JobIt family; a separate theme would add a palette without adding meaning.

## Iconography

- `lucide-react` only, 16 px in text rows, 20 px in nav, stroke 2, color inherits the text role.
- Recurring icons: `Mic` (iniciar), `PhoneOff` (terminar), `CircleDot` (grabando), `CircleAlert` (error), `Keyboard` (turno escrito), `Reply`, `PenLine` (corregir), `GitBranch` (bifurcar), `Highlighter`, `Check`.
- Platform logos (Discord, Zoom, Teams, Meet, WhatsApp, Slack) as inline Simple Icons SVG, single ink in `text-muted`, never from a CDN.

## Accessibility

- `:focus-visible` ring 2 px solid `accent`, offset 2 px (3:1 or better on `bg`, `surface` and `surface-2` in both themes); provided by the kit base layer.
- Full keyboard: every action reachable, `Esc` closes layers, call start/end has a shortcut shown in its tooltip.
- Live regions: the call state, new transcript turns (polite) and recording start/stop (assertive).
- AA contrast in both themes; ratios are written next to each token above.

## Known gaps in the app

Not covered by the foundation work; tracked for follow-ups.

- Ether (`@wefaber/orb/rig`) is not wired: call state is still an icon + word.
- Ongoing animations that break "one living element": `animate-spin` on the call thinking icon, model download and Discord loaders; `animate-pulse` on service starting and the update progress rail. Replace with static state text or progress.
- The Island, `ChatDock`, `CallNotes`, `SelectionToolbar`, `ApprovalStep` and `SessionRow` as specified are not built.
- Call screen layout (Ether column + transcript) and the composer are pending.
