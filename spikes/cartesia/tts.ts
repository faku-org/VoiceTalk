// Spike: Cartesia Sonic TTS samples in Spanish. Reads CARTESIA_API_KEY from env (never logged).
// Usage: bun tts.ts <outDir> <voiceId:label>... ; text from TEXT env or default.
const key = process.env.CARTESIA_API_KEY
if (!key) throw new Error('CARTESIA_API_KEY missing')
const model = process.env.MODEL ?? 'sonic-3'
const text =
  process.env.TEXT ??
  'Hola, ¿cómo estás? Estuve pensando en lo que me contaste ayer sobre el proyecto. Me parece una muy buena idea. Me gustaría saber más: ¿qué es lo que más te entusiasma de todo esto?'
const [outDir, ...voices] = process.argv.slice(2)
for (const spec of voices) {
  const [id, label] = spec.split(':')
  const t = performance.now()
  const res = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      'X-API-Key': key,
      'Cartesia-Version': '2025-04-16',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: model,
      transcript: text,
      voice: { mode: 'id', id },
      language: 'es',
      output_format: {
        container: 'wav',
        encoding: 'pcm_s16le',
        sample_rate: 24000,
      },
    }),
  })
  if (!res.ok) {
    console.log(label, res.status, (await res.text()).slice(0, 300))
    continue
  }
  const buf = await res.arrayBuffer()
  await Bun.write(`${outDir}/${label}.wav`, buf)
  console.log(
    label,
    `${Math.round(performance.now() - t)} ms`,
    `${((buf.byteLength - 44) / 48000).toFixed(1)} s audio`,
  )
}
