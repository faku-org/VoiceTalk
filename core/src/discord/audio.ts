// PCM conversion between Discord (48 kHz stereo) and the rest of VoiceTalk (STT 16 kHz mono, TTS 24 kHz mono).
// Stateful so chunk boundaries do not click or drift. No native deps.

const TAPS = 31
const CUTOFF = 7000 / 48000 // cycles per sample at 48 kHz: just under the 8 kHz Nyquist of the 16 kHz output

// Hamming-windowed sinc low-pass, unity gain at DC.
const LOWPASS: Float32Array = (() => {
  const h = new Float32Array(TAPS)
  const mid = (TAPS - 1) / 2
  let sum = 0
  for (let i = 0; i < TAPS; i++) {
    const x = i - mid
    const sinc =
      x === 0 ? 2 * CUTOFF : Math.sin(2 * Math.PI * CUTOFF * x) / (Math.PI * x)
    h[i] = sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1)))
    sum += h[i] as number
  }
  for (let i = 0; i < TAPS; i++) h[i] = (h[i] as number) / sum
  return h
})()

const clamp16 = (v: number): number =>
  v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v)

/** Int16 view of little-endian bytes (copies, so the byte offset never has to be even). */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const n = bytes.byteLength >> 1
  const out = new Int16Array(n)
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true)
  return out
}

export function int16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++)
    view.setInt16(i * 2, samples[i] as number, true)
  return out
}

/** 48 kHz stereo pcm_s16le (what an Opus decoder yields) -> 16 kHz mono pcm_s16le. */
export class Downsampler48kStereoTo16kMono {
  #hist = new Float32Array(TAPS - 1)
  #phase = 0
  #carry: number[] = []

  push(bytes: Uint8Array): Uint8Array {
    // Keep whole stereo frames (4 bytes): a chunk may split one.
    const joined = this.#carry.length
      ? Uint8Array.from([...this.#carry, ...bytes])
      : bytes
    const whole = joined.byteLength - (joined.byteLength % 4)
    this.#carry = Array.from(joined.subarray(whole))
    const st = bytesToInt16(joined.subarray(0, whole))
    const n = st.length >> 1
    const c = new Float32Array(TAPS - 1 + n)
    c.set(this.#hist, 0)
    for (let i = 0; i < n; i++)
      c[TAPS - 1 + i] = ((st[2 * i] as number) + (st[2 * i + 1] as number)) / 2
    const out: number[] = []
    let i = this.#phase
    for (; i < n; i += 3) {
      let y = 0
      for (let j = 0; j < TAPS; j++)
        y += (LOWPASS[j] as number) * (c[i + TAPS - 1 - j] as number)
      out.push(clamp16(y))
    }
    this.#phase = i - n
    this.#hist = c.slice(c.length - (TAPS - 1))
    return int16ToBytes(Int16Array.from(out))
  }
}

/** 24 kHz mono pcm_s16le (Cartesia) -> 48 kHz stereo pcm_s16le (what Discord's Opus encoder takes). */
export class Upsampler24kMonoTo48kStereo {
  #prev = 0
  #carry: number | null = null

  push(bytes: Uint8Array): Uint8Array {
    let data = bytes
    if (this.#carry !== null) {
      data = Uint8Array.from([this.#carry, ...bytes])
      this.#carry = null
    }
    if (data.byteLength % 2 === 1) {
      this.#carry = data[data.byteLength - 1] as number
      data = data.subarray(0, data.byteLength - 1)
    }
    const mono = bytesToInt16(data)
    const out = new Int16Array(mono.length * 4)
    let o = 0
    for (const x of mono) {
      const mid = clamp16((this.#prev + x) / 2)
      out[o++] = mid
      out[o++] = mid
      out[o++] = x
      out[o++] = x
      this.#prev = x
    }
    return int16ToBytes(out)
  }
}

export const STT_SAMPLE_RATE = 16000

/** Zero PCM (pcm_s16le 16 kHz mono) of the given length. Discord sends nothing during silence; this closes the VAD segment. */
export function silence(ms: number): Uint8Array {
  return new Uint8Array(Math.round((STT_SAMPLE_RATE * ms) / 1000) * 2)
}

/** Root-mean-square level of pcm_s16le, 0..1. */
export function rms(bytes: Uint8Array): number {
  const s = bytesToInt16(bytes)
  if (s.length === 0) return 0
  let sum = 0
  for (const v of s) sum += (v / 32768) ** 2
  return Math.sqrt(sum / s.length)
}
