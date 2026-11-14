import { describe, expect, test } from 'bun:test'
import {
  describeUpdateError,
  downloadPercent,
  initialUpdateState,
  updateReducer,
  type UpdateState,
} from './updater'

describe('updateReducer', () => {
  test('happy path: check, available, download, ready', () => {
    let s: UpdateState = initialUpdateState
    s = updateReducer(s, { type: 'check' })
    expect(s.kind).toBe('checking')
    s = updateReducer(s, { type: 'available', version: '0.5.1', notes: null })
    expect(s).toEqual({ kind: 'available', version: '0.5.1', notes: null })
    s = updateReducer(s, { type: 'download', version: '0.5.1' })
    s = updateReducer(s, { type: 'progress', received: 50, total: 100 })
    expect(s).toMatchObject({ kind: 'downloading', received: 50, total: 100 })
    s = updateReducer(s, { type: 'installed' })
    expect(s).toEqual({ kind: 'ready', version: '0.5.1' })
  })

  test('a check does not interrupt a download', () => {
    const downloading: UpdateState = {
      kind: 'downloading',
      version: '1',
      received: 1,
      total: 2,
    }
    expect(updateReducer(downloading, { type: 'check' })).toBe(downloading)
  })

  test('progress and installed are ignored outside a download', () => {
    expect(
      updateReducer(initialUpdateState, {
        type: 'progress',
        received: 1,
        total: 2,
      }),
    ).toBe(initialUpdateState)
    expect(updateReducer(initialUpdateState, { type: 'installed' })).toBe(
      initialUpdateState,
    )
  })

  test('errors and reset', () => {
    const failed = updateReducer(initialUpdateState, {
      type: 'fail',
      message: 'x',
    })
    expect(failed).toEqual({ kind: 'error', message: 'x' })
    expect(updateReducer(failed, { type: 'reset' })).toEqual(initialUpdateState)
    expect(updateReducer(failed, { type: 'check' }).kind).toBe('checking')
  })
})

describe('helpers', () => {
  test('downloadPercent', () => {
    expect(downloadPercent(50, 200)).toBe(25)
    expect(downloadPercent(300, 200)).toBe(100)
    expect(downloadPercent(1, null)).toBeNull()
    expect(downloadPercent(1, 0)).toBeNull()
  })

  test('describeUpdateError maps the usual causes', () => {
    expect(describeUpdateError(new Error('404 Not Found'))).toContain(
      'publicada',
    )
    expect(describeUpdateError('network error')).toContain('conectar')
    expect(describeUpdateError('bad signature')).toContain('firma')
    expect(describeUpdateError('boom')).toContain('boom')
  })
})
