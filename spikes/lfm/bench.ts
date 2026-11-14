/**
 * Spike: LFM models behind llama-server, for the VoiceTalk text side.
 *
 *   bun spikes/lfm/bench.ts asr       LFM3-Audio-2B, Spanish ASR on spikes/stt/out/tts/u*.wav (WER)
 *   bun spikes/lfm/bench.ts decide    decision-model JSON (none | internal_note | recall)
 *   bun spikes/lfm/bench.ts tools     tool calling for Code Mode ops
 *
 * Env: LLAMA_DIR (llama.cpp binaries), MODEL / MMPROJ (GGUF paths) override the defaults.
 * Writes spikes/lfm/out/<task>-<model>.json.
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const HUB = join(homedir(), '.cache/huggingface/hub')
const LLAMA_DIR =
  process.env.LLAMA_DIR ??
  join(
    homedir(),
    'AppData/Local/Microsoft/WinGet/Packages/ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe',
  )
const HERE = import.meta.dir
const TTS = join(HERE, '../stt/out/tts')

function gguf(repo: string, file: string): string {
  const snaps = join(HUB, `models--${repo.replace('/', '--')}`, 'snapshots')
  for (const s of readdirSync(snaps)) {
    const p = join(snaps, s, file)
    if (existsSync(p)) return p
  }
  throw new Error(`missing ${repo}/${file}`)
}

const DEFAULTS = {
  asr: () => ({
    model: gguf('LiquidAI/LFM3-Audio-2B-GGUF', 'LFM3-Audio-2B-Q8_0.gguf'),
    mmproj: gguf(
      'LiquidAI/LFM3-Audio-2B-GGUF',
      'mmproj-LFM3-Audio-2B-Q8_0.gguf',
    ),
  }),
  decide: () => ({
    model: gguf('LiquidAI/LFM3-1.7B-GGUF', 'LFM3-1.7B-Q4_K_M.gguf'),
    mmproj: undefined,
  }),
  tools: () => ({
    model: gguf('LiquidAI/LFM3-1.7B-GGUF', 'LFM3-1.7B-Q4_K_M.gguf'),
    mmproj: undefined,
  }),
} as const

type Task = keyof typeof DEFAULTS

async function gpuUsedMiB(): Promise<number> {
  const p = Bun.spawn([
    'nvidia-smi',
    '--query-gpu=memory.used',
    '--format=csv,noheader,nounits',
  ])
  return Number((await new Response(p.stdout).text()).trim().split('\n')[0])
}

async function startServer(model: string, mmproj?: string) {
  const port = 18000 + Math.floor(Math.random() * 1000)
  const args = [
    join(LLAMA_DIR, 'llama-server.exe'),
    '-m',
    model,
    '--port',
    String(port),
    '-ngl',
    '99',
    '-c',
    '8192',
    '--jinja',
    '--temp',
    '0',
  ]
  if (mmproj) args.push('--mmproj', mmproj)
  const before = await gpuUsedMiB()
  const proc = Bun.spawn(args, { stdout: 'ignore', stderr: 'pipe' })
  const url = `http://127.0.0.1:${port}`
  const t0 = performance.now()
  for (;;) {
    if (proc.exitCode !== null)
      throw new Error(
        `llama-server exited:\n${await new Response(proc.stderr).text()}`,
      )
    const ok = await fetch(`${url}/health`).then(
      (r) => r.ok,
      () => false,
    )
    if (ok) break
    if (performance.now() - t0 > 180_000)
      throw new Error('llama-server health timeout')
    await Bun.sleep(500)
  }
  const loadS = (performance.now() - t0) / 1000
  const vramMiB = (await gpuUsedMiB()) - before
  return { url, proc, loadS, vramMiB }
}

async function chat(url: string, body: Record<string, unknown>) {
  const t0 = performance.now()
  const r = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      temperature: 0,
      ...(process.env.THINK
        ? {}
        : { chat_template_kwargs: { enable_thinking: false } }),
      ...body,
    }),
  })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  const json = (await r.json()) as any
  return {
    ms: Math.round(performance.now() - t0),
    message: json.choices[0].message,
    usage: json.usage,
  }
}

// ---------------------------------------------------------------- ASR

const REFERENCE: Record<string, string> = {
  u1: 'Hola, ¿cómo estás? Me llamo Faku.',
  u2: 'Estoy probando una aplicación de voz que armé. ¿Qué te parece la idea de charlar con una computadora?',
  u3: 'Contame algo interesante sobre la historia de Buenos Aires.',
  u4: 'Che, ¿te acordás cómo se llama mi perro?',
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

function wer(ref: string, hyp: string): number {
  const a = words(ref)
  const b = words(hyp)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [
    i,
    ...Array(b.length).fill(0),
  ])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
  return d[a.length]![b.length]! / a.length
}

async function asr(url: string) {
  const rows = []
  for (const [id, ref] of Object.entries(REFERENCE)) {
    const data = Buffer.from(
      await Bun.file(join(TTS, `${id}.wav`)).arrayBuffer(),
    ).toString('base64')
    const { ms, message } = await chat(url, {
      messages: [
        { role: 'system', content: 'Perform ASR in Spanish.' },
        {
          role: 'user',
          content: [
            { type: 'input_audio', input_audio: { data, format: 'wav' } },
          ],
        },
      ],
    })
    rows.push({
      id,
      ms,
      ref,
      hyp: message.content,
      wer: Number(wer(ref, message.content).toFixed(3)),
    })
  }
  return {
    rows,
    mean_wer: Number(
      (rows.reduce((s, r) => s + r.wer, 0) / rows.length).toFixed(3),
    ),
  }
}

// ---------------------------------------------------------------- decision model

const DECIDE_SYSTEM = `Sos el modelo de decisión de VoiceTalk. Recibís un fragmento de transcripción de una charla por voz entre Faku y el agente.
Decidí UNA acción:
- "internal_note": Faku dice un dato concreto sobre sí mismo o su vida (nombres, mascotas, gente, salud, sueño, trabajo, emociones, planes). Escribí la nota en "note", factual y breve, en tercera persona.
- "recall": Faku se refiere EXPLÍCITAMENTE a algo charlado antes ("te acordás", "como te decía", "la otra vez"). Escribí en "query" palabras clave para buscar en notas previas.
- "none": saludos, confirmaciones, relleno, o nada nuevo sobre Faku.
Ejemplos:
"Faku: Mi hermana se llama Ana." -> {"action":"internal_note","note":"La hermana de Faku se llama Ana."}
"Faku: Dale, sigamos." -> {"action":"none"}
"Faku: Como te conté ayer del viaje..." -> {"action":"recall","query":"viaje"}
Respondé solo JSON.`

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['none', 'internal_note', 'recall'] },
    note: { type: 'string' },
    query: { type: 'string' },
  },
  required: ['action'],
}

const DECIDE_CASES: { window: string; expect: string }[] = [
  {
    window: 'Faku: Hola, ¿cómo andás?\nAgente: Bien, ¿vos?\nFaku: Bien, bien.',
    expect: 'none',
  },
  {
    window:
      'Faku: Últimamente duermo re mal, me despierto a las cuatro pensando en el laburo.\nAgente: ¿Desde cuándo te pasa?\nFaku: Desde que arrancó el proyecto nuevo.',
    expect: 'internal_note',
  },
  {
    window:
      'Faku: ¿Te acordás de la idea de la app de recetas que te conté la otra vez?\nAgente: Contame de nuevo.',
    expect: 'recall',
  },
  {
    window: 'Faku: Mi perro se llama Toto y tiene ocho años.',
    expect: 'internal_note',
  },
  {
    window:
      'Faku: Como te decía la semana pasada sobre mi viejo, sigo sin hablarle.',
    expect: 'recall',
  },
  {
    window: 'Agente: ¿Querés seguir con otra cosa?\nFaku: Sí, dale.',
    expect: 'none',
  },
]

async function decide(url: string) {
  const rows = []
  for (const c of DECIDE_CASES) {
    const { ms, message, usage } = await chat(url, {
      messages: [
        { role: 'system', content: DECIDE_SYSTEM },
        { role: 'user', content: c.window },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'decision', schema: DECISION_SCHEMA },
      },
    })
    let parsed: any = null
    try {
      parsed = JSON.parse(message.content)
    } catch {}
    rows.push({
      expect: c.expect,
      got: parsed?.action ?? 'INVALID',
      ok: parsed?.action === c.expect,
      ms,
      out_tokens: usage?.completion_tokens,
      out: parsed ?? message.content,
    })
  }
  return { rows, accuracy: rows.filter((r) => r.ok).length / rows.length }
}

// ---------------------------------------------------------------- tool calling

const TOOLS = [
  {
    name: 'fs_list',
    description: 'Lista archivos de una carpeta permitida.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'fs_read',
    description: 'Lee un archivo de texto.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'docs_query',
    description:
      'Busca en los archivos y escritos personales de Faku (carpetas Reflexiones, Ideas, Terapia, AppleJournal). Usala para preguntas sobre lo que Faku escribió.',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' }, folder: { type: 'string' } },
      required: ['q'],
    },
  },
  {
    name: 'notes_query',
    description:
      'Busca en las notas de llamadas de voz anteriores con el agente. Usala para preguntas sobre lo que se habló en sesiones previas.',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
    },
  },
].map((f) => ({ type: 'function', function: f }))

const TOOL_CASES = [
  {
    prompt: '¿Qué escribí sobre la ansiedad en Reflexiones?',
    expect: 'docs_query',
  },
  {
    prompt: 'Listame lo que hay en Documents/Personal/Ideas.',
    expect: 'fs_list',
  },
  {
    prompt: 'Leé el archivo Documents/Personal/Ideas/voice_talk.md.',
    expect: 'fs_read',
  },
  {
    prompt: '¿De qué hablamos en la última sesión sobre mi viejo?',
    expect: 'notes_query',
  },
  { prompt: 'Decime un chiste corto.', expect: 'none' },
]

async function tools(url: string) {
  const rows = []
  for (const c of TOOL_CASES) {
    const { ms, message } = await chat(url, {
      messages: [
        {
          role: 'system',
          content:
            'Sos el asistente de VoiceTalk. Usá las herramientas cuando hagan falta. Las carpetas permitidas están bajo Documents/Personal.',
        },
        { role: 'user', content: c.prompt },
      ],
      tools: TOOLS,
    })
    const call = message.tool_calls?.[0]?.function
    const got = call?.name ?? 'none'
    rows.push({
      prompt: c.prompt,
      expect: c.expect,
      got,
      ok: got === c.expect,
      args: call?.arguments,
      text: message.content,
      ms,
    })
  }
  return { rows, accuracy: rows.filter((r) => r.ok).length / rows.length }
}

// ---------------------------------------------------------------- main

const task = (process.argv[2] ?? 'asr') as Task
if (!(task in DEFAULTS))
  throw new Error(`task: ${Object.keys(DEFAULTS).join(' | ')}`)
const def = DEFAULTS[task]()
const model = process.env.MODEL ?? def.model
const mmproj = process.env.MMPROJ ?? def.mmproj

const server = await startServer(model, mmproj)
try {
  const result = await { asr, decide, tools }[task](server.url)
  const report = {
    task,
    model: basename(model),
    mmproj: mmproj && basename(mmproj),
    load_s: Number(server.loadS.toFixed(1)),
    vram_mib: server.vramMiB,
    ...result,
  }
  mkdirSync(join(HERE, 'out'), { recursive: true })
  await Bun.write(
    join(HERE, 'out', `${task}-${basename(model, '.gguf')}.json`),
    JSON.stringify(report, null, 2),
  )
  console.log(JSON.stringify(report, null, 2))
} finally {
  server.proc.kill()
}
