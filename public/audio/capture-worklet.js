// AudioWorklet: mic -> pcm_s16le 16 kHz mono, 20 ms frames (320 samples).
// Lives in public/ because the Tauri CSP (script-src 'self') forbids blob: and data: modules.
const TARGET_RATE = 16000
const FRAME_SAMPLES = 320

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / TARGET_RATE
    this.acc = 0
    this.count = 0
    this.phase = 0
    this.frame = new Int16Array(FRAME_SAMPLES)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    // Box-filter decimation: average every input sample that falls in one output sample.
    for (let i = 0; i < channel.length; i++) {
      this.acc += channel[i]
      this.count++
      this.phase += 1
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio
        const v = Math.max(-1, Math.min(1, this.acc / this.count))
        this.frame[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff
        this.acc = 0
        this.count = 0
        if (this.filled === FRAME_SAMPLES) {
          const out = this.frame.buffer
          this.port.postMessage(out, [out])
          this.frame = new Int16Array(FRAME_SAMPLES)
          this.filled = 0
        }
      }
    }
    return true
  }
}

registerProcessor('vt-capture', CaptureProcessor)
