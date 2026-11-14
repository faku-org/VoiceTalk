import { describe, expect, test } from 'bun:test'
import {
  anchorHighlight,
  cleanSelection,
  mergeLive,
  messageToItem,
  parseSse,
  preview,
  segmentText,
  sessionHeaderFor,
  streamingItem,
  upsertItem,
  type ChatItem,
} from './protocol'
import { isTyped, itemLabel, itemSide, itemStamp } from './view'

const ev = (type: string, payload: object): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`

describe('parseSse', () => {
  test('reads complete events and keeps the partial tail', () => {
    const a = ev('delta', { text: 'Ho' }) + ev('delta', { text: 'la' })
    const cut = ev('done', { message: { id: 'm1' } })
    const first = parseSse(a + cut.slice(0, 20))
    expect(first.events).toEqual([
      { type: 'delta', text: 'Ho' },
      { type: 'delta', text: 'la' },
    ])
    const second = parseSse(first.rest + cut.slice(20))
    expect(second.events).toHaveLength(1)
    expect(second.events[0]?.type).toBe('done')
    expect(second.rest).toBe('')
  })

  test('handles CRLF and drops unknown or malformed events', () => {
    const raw =
      ev('delta', { text: 'a' }).replace(/\n/g, '\r\n') +
      'event: x\ndata: {nope\n\n' +
      ev('mystery', { x: 1 })
    const { events } = parseSse(raw)
    expect(events).toEqual([{ type: 'delta', text: 'a' }])
  })

  test('keeps the text of a delta intact, including newlines and quotes', () => {
    const { events } = parseSse(ev('delta', { text: 'a\n"b"\n' }))
    expect(events).toEqual([{ type: 'delta', text: 'a\n"b"\n' }])
  })
})

describe('highlight anchoring', () => {
  test('uses the stored range while it still holds the quote', () => {
    expect(
      anchorHighlight('Hola mundo', { start: 5, end: 10, quoted: 'mundo' }),
    ).toEqual({ start: 5, end: 10 })
  })

  test('re-anchors by the quote when the text shifted (a correction)', () => {
    expect(
      anchorHighlight('Un cambio. Hola mundo', {
        start: 5,
        end: 10,
        quoted: 'mundo',
      }),
    ).toEqual({ start: 16, end: 21 })
  })

  test('returns null when the quote is gone', () => {
    expect(
      anchorHighlight('otra cosa', { start: 0, end: 4, quoted: 'mundo' }),
    ).toBeNull()
  })

  test('segments text around highlights, in order, without overlap', () => {
    const segs = segmentText('uno dos tres cuatro', [
      { id: 'h2', start: 8, end: 12, quoted: 'tres' },
      { id: 'h1', start: 4, end: 7, quoted: 'dos' },
    ])
    expect(segs).toEqual([
      { text: 'uno ', highlightId: null },
      { text: 'dos', highlightId: 'h1' },
      { text: ' ', highlightId: null },
      { text: 'tres', highlightId: 'h2' },
      { text: ' cuatro', highlightId: null },
    ])
    expect(segs.map((s) => s.text).join('')).toBe('uno dos tres cuatro')
  })

  test('overlapping highlights do not duplicate text', () => {
    const segs = segmentText('abcdefgh', [
      { id: 'a', start: 0, end: 5, quoted: 'abcde' },
      { id: 'b', start: 3, end: 7, quoted: 'defg' },
    ])
    expect(segs.map((s) => s.text).join('')).toBe('abcdefgh')
  })

  test('a text with no placeable highlight stays one plain segment', () => {
    expect(
      segmentText('hola', [{ id: 'x', start: 0, end: 2, quoted: 'zz' }]),
    ).toEqual([{ text: 'hola', highlightId: null }])
  })
})

describe('selection and previews', () => {
  test('cleanSelection collapses whitespace and rejects empty selections', () => {
    expect(cleanSelection('  hola \n  mundo ')).toBe('hola mundo')
    expect(cleanSelection('  a ')).toBeNull()
    expect(cleanSelection('   ')).toBeNull()
  })

  test('cleanSelection caps the length', () => {
    const out = cleanSelection('x'.repeat(2000), 50)
    expect(out?.length).toBe(50)
    expect(out?.endsWith('…')).toBe(true)
  })

  test('preview shortens long text on one line', () => {
    expect(preview('a\nb')).toBe('a b')
    expect(preview('x'.repeat(200), 20).length).toBe(20)
  })
})

describe('stream messages', () => {
  test('messageToItem fills the keys a stream action does not carry', () => {
    const item = messageToItem({
      id: 'm1',
      at: 5,
      role: 'assistant',
      text: 'hecho',
      status: 'done',
      replyTo: null,
      quote: null,
      actions: [{ type: 'fork', threadId: 't2', title: 'Rama' }],
    })
    expect(item.kind).toBe('message')
    expect(item.actions[0]).toMatchObject({
      type: 'fork',
      threadId: 't2',
      title: 'Rama',
      utteranceId: null,
      utteranceIds: null,
    })
  })
})

const utt = (id: string, at: number, sessionId: string): ChatItem => ({
  ...streamingItem(id, at, 't'),
  kind: 'utterance',
  role: null,
  status: null,
  sessionId,
})

describe('timeline helpers', () => {
  test('upsertItem replaces by id and keeps chronological order', () => {
    const a = streamingItem('m1', 20, 'x')
    const b = streamingItem('m2', 10, 'y')
    const list = upsertItem(upsertItem([], a), b)
    expect(list.map((i) => i.id)).toEqual(['m2', 'm1'])
    const updated = upsertItem(list, { ...a, text: 'nuevo' })
    expect(updated).toHaveLength(2)
    expect(updated.find((i) => i.id === 'm1')?.text).toBe('nuevo')
  })

  test('an utterance and a message with the same id are different items', () => {
    const u = utt('same', 1, 's1')
    const m = streamingItem('same', 2, 'hola')
    expect(upsertItem([u], m)).toHaveLength(2)
  })

  test('draws a session header only when the call changes', () => {
    const items = [
      utt('u1', 1, 's1'),
      utt('u2', 2, 's1'),
      streamingItem('m1', 3, 'hola'),
      utt('u3', 4, 's1'),
      utt('u4', 5, 's2'),
    ]
    expect(items.map((_, i) => sessionHeaderFor(items, i))).toEqual([
      's1',
      null,
      null,
      null,
      's2',
    ])
  })
})

describe('mergeLive', () => {
  const stored = {
    ...utt('u1', 100, 'call-1'),
    text: 'guardado',
    speaker: 'user' as const,
  }

  test('keeps the stored line and adds the ones not stored yet as pending', () => {
    const live = [
      { id: 'u1', speaker: 'user' as const, text: 'sin corregir', t: 100 },
      { id: 'u2', speaker: 'agent' as const, text: 'hola', t: 150 },
    ]
    const merged = mergeLive([stored], live, 'call-1')
    expect(merged.map((i) => i.id)).toEqual(['u1', 'u2'])
    expect(merged[0]?.text).toBe('guardado')
    expect(merged[0]?.pending).toBeUndefined()
    expect(merged[1]).toMatchObject({
      kind: 'utterance',
      speaker: 'agent',
      sessionId: 'call-1',
      pending: true,
    })
  })

  test('orders by time against typed turns and skips empty lines', () => {
    const typed = streamingItem('m1', 120, 'hola Ether')
    const live = [
      { id: 'u2', speaker: 'user' as const, text: '  ', t: 90 },
      { id: 'u3', speaker: 'user' as const, text: 'sigo', t: 130 },
    ]
    const merged = mergeLive([stored, typed], live, null)
    expect(merged.map((i) => i.id)).toEqual(['u1', 'm1', 'u3'])
  })

  test('returns the same list when there is nothing to add', () => {
    const items = [stored]
    expect(mergeLive(items, [], 'call-1')).toBe(items)
    expect(
      mergeLive(
        items,
        [{ id: 'u1', speaker: 'user', text: 'x', t: 100 }],
        null,
      ),
    ).toBe(items)
  })
})

describe('turn helpers', () => {
  const sessions = new Map([
    [
      'call-1',
      {
        id: 'call-1',
        title: null,
        startedAt: 1000,
        endedAt: null,
        source: 'call',
      },
    ],
  ])

  test('labels and sides: own mic right, Ether and named speakers left', () => {
    const mine = { ...utt('a', 1, 's'), speaker: 'user' as const }
    const ether = { ...utt('b', 1, 's'), speaker: 'agent' as const }
    const named = { ...mine, speakerName: 'Ana' }
    expect([itemLabel(mine), itemSide(mine)]).toEqual(['Tú', 'user'])
    expect([itemLabel(ether), itemSide(ether)]).toEqual(['Ether', 'other'])
    expect([itemLabel(named), itemSide(named)]).toEqual(['Ana', 'other'])
    const typedMine = { ...streamingItem('m', 1, 'x'), role: 'user' as const }
    expect([
      itemLabel(typedMine),
      itemSide(typedMine),
      isTyped(typedMine),
    ]).toEqual(['Tú', 'user', true])
    expect(itemLabel(streamingItem('m', 1, 'x'))).toBe('Ether')
    expect(isTyped(mine)).toBe(false)
  })

  test('the stamp is the offset in its call when the call is known', () => {
    const line = { ...utt('a', 66_000, 'call-1') }
    expect(itemStamp(line, sessions, null)).toBe('01:05')
    expect(itemStamp({ ...line, sessionId: null }, sessions, 'call-1')).toBe(
      '01:05',
    )
  })
})
