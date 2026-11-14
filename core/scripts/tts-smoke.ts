// Smoke test: streams one neutral Spanish sentence from Cartesia and writes a wav.
// Usage: CARTESIA_API_KEY=... bun core/scripts/tts-smoke.ts [out.wav]
import {
  CartesiaTts,
  PCM_BITS,
  PCM_CHANNELS,
  PCM_SAMPLE_RATE,
} from '../src/tts/index.ts'

const apiKey = process.env.CARTESIA_API_KEY?.trim()
if (!apiKey) {
  console.error('CARTESIA_API_KEY not set')
  process.exit(1)
}

const outPath = process.argv[2] ?? 'tts-smoke.wav'
const text =
  'Hola, ¿cómo va todo? Te escribo para contarte que ya estoy listo para ayudarte.'

function wavHeader(dataBytes: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(44))
  const byteRate = (PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BITS) / 8
  const blockAlign = (PCM_CHANNELS * PCM_BITS) / 8
  const write = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++)
      header.setUint8(offset + i, s.charCodeAt(i))
  }
  write(0, 'RIFF')
  header.setUint32(4, 36 + dataBytes, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, PCM_CHANNELS, true)
  header.setUint32(24, PCM_SAMPLE_RATE, true)
  header.setUint32(28, byteRate, true)
  header.setUint16(32, blockAlign, true)
  header.setUint16(34, PCM_BITS, true)
  write(36, 'data')
  header.setUint32(40, dataBytes, true)
  return new Uint8Array(header.buffer)
}

const tts = new CartesiaTts({ apiKey })
const started = performance.now()
let firstAudioMs: number | undefined
const parts: Uint8Array[] = []
let total = 0

for await (const chunk of tts.stream(text)) {
  if (firstAudioMs === undefined) firstAudioMs = performance.now() - started
  parts.push(chunk)
  total += chunk.byteLength
}

const header = Buffer.from(wavHeader(total))
await Bun.write(
  outPath,
  Buffer.concat([header, ...parts.map((p) => Buffer.from(p))]),
)

const seconds = total / (PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS / 8))
console.log(`TTFA ${Math.round(firstAudioMs ?? -1)} ms`)
console.log(`audio ${seconds.toFixed(2)} s, ${total} bytes, ${outPath}`)
