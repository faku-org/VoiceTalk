// Mic capture: getUserMedia with the browser's AEC/NS/AGC, downsampled to pcm_s16le 16 kHz mono
// by public/audio/capture-worklet.js. Frames are 20 ms (640 bytes).

export interface MicHandle {
  stop(): void
}

export async function startMic(
  onFrame: (pcm: ArrayBuffer) => void,
): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
  const ctx = new AudioContext({ latencyHint: 'interactive' })
  try {
    await ctx.audioWorklet.addModule('/audio/capture-worklet.js')
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'vt-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    })
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => onFrame(ev.data)
    // Some engines only run a worklet that reaches the destination: route it through a muted gain.
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(node).connect(mute).connect(ctx.destination)
    await ctx.resume()
    return {
      stop() {
        node.port.onmessage = null
        node.disconnect()
        source.disconnect()
        for (const track of stream.getTracks()) track.stop()
        void ctx.close()
      },
    }
  } catch (err) {
    for (const track of stream.getTracks()) track.stop()
    void ctx.close()
    throw err
  }
}
