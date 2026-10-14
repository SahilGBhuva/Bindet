import { afterEach, describe, expect, it, vi } from 'vitest'
import { isChunkLoadError, reloadOnce } from './recover'

describe('isChunkLoadError', () => {
  it('recognizes Chrome and Edge', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://bindet.app/assets/Tools-abc123.js'))).toBe(true)
  })

  it('recognizes Safari', () => {
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true)
  })

  it('recognizes Firefox', () => {
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://bindet.app/assets/Goals-x.js'))).toBe(true)
  })

  it('recognizes Vite CSS preload and MIME-type failures', () => {
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/Tools-abc.css'))).toBe(true)
    expect(isChunkLoadError(new TypeError('Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".'))).toBe(true)
  })

  it('matches on the error name too (webpack-style ChunkLoadError)', () => {
    const error = new Error('Loading chunk 7 failed.')
    error.name = 'ChunkLoadError'
    expect(isChunkLoadError(error)).toBe(true)
  })

  it('accepts plain strings and ignores case', () => {
    expect(isChunkLoadError('IMPORTING A MODULE SCRIPT FAILED')).toBe(true)
  })

  it('does not treat ordinary errors as stale chunks', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
    expect(isChunkLoadError(undefined)).toBe(false)
  })
})

describe('reloadOnce', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function stubBrowser(storage: Map<string, string> | 'blocked') {
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })
    vi.stubGlobal('sessionStorage', storage === 'blocked'
      ? { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('SecurityError') } }
      : { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) })
    return reload
  }

  it('reloads the first time and refuses again within 30 seconds', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const reload = stubBrowser(new Map())
    expect(reloadOnce()).toBe(true)
    vi.setSystemTime(1_000_000 + 29_000)
    expect(reloadOnce()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads again once the guard has passed', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const reload = stubBrowser(new Map())
    reloadOnce()
    vi.setSystemTime(1_000_000 + 31_000)
    expect(reloadOnce()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('still reloads when storage is blocked', () => {
    const reload = stubBrowser('blocked')
    expect(reloadOnce()).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
