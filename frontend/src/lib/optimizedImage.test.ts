import { afterEach, describe, expect, it, vi } from 'vitest'
import { optimizedImage } from './api'

// api.ts listens on window when it loads (vi.hoisted runs before imports).
vi.hoisted(() => vi.stubGlobal('window', new EventTarget()))

type BlobCallback = (blob: Blob | null) => void

/* A browser whose canvas can't encode WebP (Safari): asked for WebP, it returns a PNG. */
function stubCanvas(encode: (type: string) => Blob | null) {
  const requested: string[] = []
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: '', fillRect: vi.fn(), drawImage: vi.fn() }),
    toBlob: (callback: BlobCallback, type: string) => {
      requested.push(type)
      callback(encode(type))
    },
  }
  vi.stubGlobal('OffscreenCanvas', undefined)
  vi.stubGlobal('document', { createElement: () => canvas })
  vi.stubGlobal('createImageBitmap', async () => ({ width: 4000, height: 3000, close: vi.fn() }))
  return requested
}

const photo = () => new File([new Uint8Array(3_000_000)], 'IMG_0042.jpeg', { type: 'image/jpeg' })

describe('optimizedImage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('window', new EventTarget())
  })

  it('falls back to JPEG when the browser returns a PNG for a WebP request', async () => {
    const requested = stubCanvas((type) => new Blob([new Uint8Array(type === 'image/png' || type === 'image/webp' ? 5_000_000 : 400_000)], {
      type: type === 'image/webp' ? 'image/png' : type,
    }))
    const result = await optimizedImage(photo())
    expect(requested).toEqual(['image/webp', 'image/jpeg'])
    expect(result.type).toBe('image/jpeg')
    expect(result.name).toBe('IMG_0042.jpg')
    expect(result.size).toBe(400_000)
  })

  it('keeps WebP where the browser can encode it, named from the real type', async () => {
    stubCanvas((type) => new Blob([new Uint8Array(300_000)], { type }))
    const result = await optimizedImage(photo())
    expect(result.type).toBe('image/webp')
    expect(result.name).toBe('IMG_0042.webp')
  })

  it('sends the original when nothing smaller could be made', async () => {
    stubCanvas((type) => new Blob([new Uint8Array(5_000_000)], { type: type === 'image/webp' ? 'image/png' : type }))
    const original = photo()
    expect(await optimizedImage(original)).toBe(original)
  })
})
