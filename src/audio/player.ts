// Gapless playback of pcm_s16le 24 kHz mono chunks, with an immediate flush for barge-in.

export const PLAYBACK_RATE = 24000
// Scheduling lead so the first chunk never starts in the past.
const LEAD_S = 0.03
// Short fade on flush so cutting the signal does not click. Well under the 100 ms budget.
const FADE_S = 0.012

export class PcmPlayer {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private nextTime = 0
  private sources = new Set<AudioBufferSourceNode>()
  // PCM16 chunks can split a sample across frames: keep the dangling byte.
  private carry: number | null = null

  // Must run from a user gesture (autoplay policy): call it from the Start handler.
  async prepare(): Promise<void> {
    if (!this.ctx) {
      this.ctx = new AudioContext({
        sampleRate: PLAYBACK_RATE,
        latencyHint: 'interactive',
      })
      this.master = this.makeMaster(this.ctx)
    }
    if (this.ctx.state !== 'running') await this.ctx.resume()
  }

  push(chunk: ArrayBuffer): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    let bytes = new Uint8Array(chunk)
    if (this.carry !== null) {
      const merged = new Uint8Array(bytes.length + 1)
      merged[0] = this.carry
      merged.set(bytes, 1)
      bytes = merged
      this.carry = null
    }
    if (bytes.length % 2 === 1) {
      this.carry = bytes[bytes.length - 1] ?? null
      bytes = bytes.subarray(0, bytes.length - 1)
    }
    const samples = bytes.length / 2
    if (samples === 0) return

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
    const buffer = ctx.createBuffer(1, samples, PLAYBACK_RATE)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < samples; i++)
      channel[i] = view.getInt16(i * 2, true) / 0x8000

    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(master)
    const startAt = Math.max(this.nextTime, ctx.currentTime + LEAD_S)
    source.start(startAt)
    this.nextTime = startAt + buffer.duration
    this.sources.add(source)
    source.onended = () => this.sources.delete(source)
  }

  // Drops everything queued or playing. Synchronous: audible silence within FADE_S.
  flush(): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master) return
    const now = ctx.currentTime
    master.gain.cancelScheduledValues(now)
    master.gain.setValueAtTime(master.gain.value, now)
    master.gain.linearRampToValueAtTime(0, now + FADE_S)
    for (const source of this.sources) {
      source.onended = null
      try {
        source.stop(now + FADE_S)
      } catch {
        // not started yet or already stopped
      }
    }
    this.sources.clear()
    this.carry = null
    this.nextTime = 0
    // Later audio goes through a fresh gain so it is not muted by the fade-out above.
    this.master = this.makeMaster(ctx)
  }

  // Seconds of audio still queued ahead of the playhead.
  get queuedSeconds(): number {
    return this.ctx ? Math.max(0, this.nextTime - this.ctx.currentTime) : 0
  }

  async close(): Promise<void> {
    this.flush()
    const ctx = this.ctx
    this.ctx = null
    this.master = null
    if (ctx && ctx.state !== 'closed') await ctx.close()
  }

  private makeMaster(ctx: AudioContext): GainNode {
    const gain = ctx.createGain()
    gain.connect(ctx.destination)
    return gain
  }
}
