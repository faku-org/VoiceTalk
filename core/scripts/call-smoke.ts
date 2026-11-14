// Call smoke: streams a 16 kHz mono wav into WS /call in real time, records the agent audio and prints
// the per-turn latency table. Then runs a barge-in check: speech injected while the agent is speaking
// must trigger stop_playback.
//
// Needs core (VT_VOICE_PORT, VT_LLM_URL, CARTESIA_API_KEY), voice and llama-server already running.
// Usage: bun core/scripts/call-smoke.ts <input.wav> [out.wav] [--url ws://127.0.0.1:4310/call]
import type { ServerEvent, TurnLatency } from '../src/call/protocol.ts'
import { PCM_BITS, PCM_CHANNELS, PCM_SAMPLE_RATE } from '../src/tts/index.ts'

const FRAME_MS = 20
const FRAME_BYTES = 16 * FRAME_MS * 2 // 16 kHz s16le
const SILENCE_TAIL_MS = 1800
const TURN_TIMEOUT_MS = 30_000

const args = process.argv.slice(2)
const urlIdx = args.indexOf('--url')
const url =
  urlIdx >= 0 ? (args.splice(urlIdx, 2)[1] ?? '') : 'ws://127.0.0.1:4310/call'
const [inPath, outPath = 'call-smoke.wav'] = args
if (!inPath) {
  console.error(
    'usage: bun core/scripts/call-smoke.ts <input.wav> [out.wav] [--url ws://...]',
  )
  process.exit(1)
}

function parseWav(buf: Buffer): Buffer {
  if (
    buf.toString('ascii', 0, 4) !== 'RIFF' ||
    buf.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('not a wav')
  let pos = 12
  let fmtOk = false
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      const rate = buf.readUInt32LE(pos + 12)
      const channels = buf.readUInt16LE(pos + 10)
      const bits = buf.readUInt16LE(pos + 22)
      if (rate !== 16000 || channels !== 1 || bits !== 16)
        throw new Error(
          `need 16 kHz mono s16, got ${rate} Hz ${channels}ch ${bits}b`,
        )
      fmtOk = true
    } else if (id === 'data') {
      if (!fmtOk) throw new Error('data before fmt')
      return buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size))
    }
    pos += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(PCM_CHANNELS, 22)
  h.writeUInt32LE(PCM_SAMPLE_RATE, 24)
  h.writeUInt32LE((PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BITS) / 8, 28)
  h.writeUInt16LE((PCM_CHANNELS * PCM_BITS) / 8, 32)
  h.writeUInt16LE(PCM_BITS, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const pcm = parseWav(Buffer.from(await Bun.file(inPath).arrayBuffer()))

function firstSpeechOffset(): number {
  for (let off = 0; off + FRAME_BYTES <= pcm.length; off += FRAME_BYTES) {
    let sum = 0
    for (let i = 0; i < FRAME_BYTES; i += 2) {
      const s = pcm.readInt16LE(off + i) / 32768
      sum += s * s
    }
    if (Math.sqrt(sum / (FRAME_BYTES / 2)) > 0.02)
      return Math.max(0, off - 5 * FRAME_BYTES)
  }
  return 0
}

// --- connection -------------------------------------------------------------------------------

const ws = new WebSocket(url)
ws.binaryType = 'arraybuffer'
const audio: Buffer[] = []
let audioBytes = 0
let audioStartedAt: number | null = null
const events: Array<{ at: number; event: ServerEvent }> = []
const latencies: Array<{ turn: number; latency: TurnLatency }> = []
let state = 'idle'
const waiters: Array<() => void> = []

ws.addEventListener('message', (ev: MessageEvent<unknown>) => {
  const at = performance.now()
  if (typeof ev.data !== 'string') {
    const b = Buffer.from(ev.data as ArrayBuffer)
    audio.push(b)
    audioBytes += b.length
    audioStartedAt ??= at
    return
  }
  const event = JSON.parse(ev.data) as ServerEvent
  events.push({ at, event })
  if (event.type === 'state') state = event.state
  if (event.type === 'latency')
    latencies.push({ turn: event.turn, latency: event.latency })
  if (event.type === 'error') console.error(`[server error] ${event.message}`)
  for (const w of waiters.splice(0)) w()
})

await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve())
  ws.addEventListener('error', () =>
    reject(new Error(`cannot connect to ${url}`)),
  )
})
console.log(`connected ${url}`)

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!pred()) {
    const left = deadline - performance.now()
    if (left <= 0) throw new Error(`timeout waiting for ${what}`)
    await Promise.race([
      new Promise<void>((r) => waiters.push(r)),
      sleep(Math.min(left, 250)),
    ])
  }
}

// Real-time pacing, drift-corrected. `stopWhen` aborts early (barge-in test).
async function stream(data: Buffer, stopWhen?: () => boolean): Promise<void> {
  const t0 = performance.now()
  let n = 0
  for (let off = 0; off < data.length; off += FRAME_BYTES, n++) {
    if (stopWhen?.()) return
    ws.send(
      data.subarray(
        off,
        Math.min(data.length, off + FRAME_BYTES),
      ) as BufferSource,
    )
    const wait = t0 + (n + 1) * FRAME_MS - performance.now()
    if (wait > 0) await sleep(wait)
  }
}

const silence = Buffer.alloc((16 * SILENCE_TAIL_MS * 2) | 0)

// --- phase 1: full wav, latency table ---------------------------------------------------------

console.log(
  `phase 1: streaming ${(pcm.length / 32000).toFixed(1)} s of speech in real time`,
)
const streamed = stream(Buffer.concat([pcm, silence]))
await streamed
// Let the last turn finish: no new latency or state change for a while and the agent is not speaking.
let lastActivity = performance.now()
const bump = () => (lastActivity = performance.now())
waiters.push(function again() {
  bump()
  waiters.push(again)
})
await waitFor(
  () =>
    state !== 'thinking' &&
    state !== 'speaking' &&
    performance.now() - lastActivity > 4000,
  TURN_TIMEOUT_MS,
  'the agent to finish',
)

console.log(
  '\nturn  stt  llm-ttft  tts-ttfa  total   (ms; speech end -> first audio byte)',
)
for (const { turn, latency: l } of latencies) {
  console.log(
    `${String(turn).padStart(4)}  ${String(Math.round(l.speechEndToFinalMs)).padStart(4)}  ${String(Math.round(l.finalToFirstTokenMs)).padStart(8)}  ${String(Math.round(l.firstTokenToFirstAudioMs)).padStart(8)}  ${String(Math.round(l.totalMs)).padStart(5)}`,
  )
}
if (latencies.length) {
  const totals = latencies.map((x) => x.latency.totalMs).sort((a, b) => a - b)
  const median = totals[Math.floor(totals.length / 2)] ?? 0
  console.log(
    `turns ${latencies.length}  median total ${Math.round(median)} ms  max ${Math.round(totals.at(-1) ?? 0)} ms`,
  )
} else {
  console.log('no latency events received')
}

const transcript = new Map<string, string>()
for (const { event } of events)
  if (event.type === 'transcript' && event.final)
    transcript.set(
      event.entry.id,
      `${event.entry.speaker}: ${event.entry.text}`,
    )
console.log('\ntranscript:')
for (const line of transcript.values()) console.log(`  ${line}`)

const all = Buffer.concat(audio)
await Bun.write(outPath, Buffer.concat([wavHeader(all.length), all]))
console.log(
  `\nagent audio ${(all.length / (PCM_SAMPLE_RATE * 2)).toFixed(2)} s -> ${outPath}`,
)

// --- phase 2: barge-in -------------------------------------------------------------------------

console.log('\nphase 2: barge-in')
const turnsBefore = latencies.length
const stopsBefore = events.filter(
  (e) => e.event.type === 'stop_playback',
).length
const speech = pcm.subarray(
  firstSpeechOffset(),
  firstSpeechOffset() + 16000 * 2 * 25,
)
// Fresh utterance: stream speech until the agent starts talking, then keep going with the same
// speech (the VAD sees a new speech_start while the agent is speaking).
const bargeStream = stream(
  Buffer.concat([speech.subarray(0, 16000 * 2 * 8), silence]),
  () => state === 'speaking',
)
await waitFor(() => state === 'speaking', TURN_TIMEOUT_MS, 'the agent to speak')
await bargeStream
const injectedAt = performance.now()
const injected = stream(
  speech,
  () =>
    events.filter((e) => e.event.type === 'stop_playback').length > stopsBefore,
)
let bargeMs: number | null = null
try {
  await waitFor(
    () =>
      events.filter((e) => e.event.type === 'stop_playback').length >
      stopsBefore,
    8000,
    'stop_playback',
  )
  const stop = events.filter((e) => e.event.type === 'stop_playback').at(-1)
  bargeMs = stop ? stop.at - injectedAt : null
} catch (err) {
  console.error(String(err))
}
await injected

ws.send(JSON.stringify({ type: 'stop' }))
await sleep(200)
ws.close()

const stopSeen = bargeMs !== null
console.log(
  stopSeen
    ? `barge-in OK: stop_playback ${Math.round(bargeMs ?? 0)} ms after injecting speech (turns ${turnsBefore} -> ${latencies.length})`
    : 'barge-in FAILED: no stop_playback',
)
console.log(
  `audio bytes received overall: ${audioBytes}${audioStartedAt === null ? ' (none)' : ''}`,
)
process.exit(stopSeen && latencies.length > 0 ? 0 : 1)
