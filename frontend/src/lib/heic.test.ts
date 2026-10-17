import { describe, expect, it } from 'vitest'
import { HEIC_ACCEPT, HeicTooLargeError, heicOriginal, isHeicFile, isImageFile, labelledDataUrl } from './heic'

describe('isHeicFile', () => {
  it('recognises iPhone photos by type or, when untyped, by name', () => {
    expect(isHeicFile({ name: 'IMG_0001.HEIC', type: 'image/heic' })).toBe(true)
    expect(isHeicFile({ name: 'photo', type: 'image/heif' })).toBe(true)
    expect(isHeicFile({ name: 'IMG_0001.HEIC', type: '' })).toBe(true)
    expect(isHeicFile({ name: 'scan.heif', type: 'application/octet-stream' })).toBe(true)
  })

  it('leaves other files alone, even with a misleading name', () => {
    expect(isHeicFile({ name: 'notes.jpg', type: 'image/jpeg' })).toBe(false)
    expect(isHeicFile({ name: 'IMG_0001.heic', type: 'image/jpeg' })).toBe(false) // Safari already converted it
    expect(isHeicFile({ name: 'notes.pdf', type: '' })).toBe(false)
    expect(isHeicFile({})).toBe(false)
  })

  it('counts untyped HEIC files as images', () => {
    expect(isImageFile({ name: 'IMG_0001.HEIC', type: '' })).toBe(true)
    expect(isImageFile({ name: 'a.png', type: 'image/png' })).toBe(true)
    expect(isImageFile({ name: 'a.txt', type: 'text/plain' })).toBe(false)
  })

  it('lists both MIME types and extensions for file pickers', () => {
    expect(HEIC_ACCEPT.split(',')).toEqual(expect.arrayContaining(['image/heic', 'image/heif', '.heic', '.heif']))
  })
})

describe('heicOriginal', () => {
  const file = (bytes: number) => new File([new Uint8Array(bytes)], 'IMG_0001.HEIC', { type: 'image/heic' })

  it('keeps a photo that fits under the limit', () => {
    const small = file(1024)
    expect(heicOriginal(small, 2048)).toBe(small)
  })

  it('refuses a larger photo with a friendly message', () => {
    const big = file(5 * 1024 * 1024)
    expect(() => heicOriginal(big, 4 * 1024 * 1024)).toThrow(HeicTooLargeError)
    try {
      heicOriginal(big, 4 * 1024 * 1024)
    } catch (error) {
      expect((error as HeicTooLargeError).message).toBe('This iPhone photo is 5 MB. Photos must be 4 MB or smaller. Try a smaller photo, or save it as a JPG first.')
      expect((error as HeicTooLargeError).short).toBe('Larger than 4 MB')
    }
  })
})

describe('labelledDataUrl', () => {
  it('labels an untyped HEIC data URL as image/heic', () => {
    expect(labelledDataUrl('data:application/octet-stream;base64,AAAA', { name: 'a.heic', type: '' })).toBe('data:image/heic;base64,AAAA')
  })

  it('keeps typed or non-HEIC data URLs as they are', () => {
    expect(labelledDataUrl('data:image/heif;base64,AAAA', { name: 'a.heif', type: 'image/heif' })).toBe('data:image/heif;base64,AAAA')
    expect(labelledDataUrl('data:image/png;base64,AAAA', { name: 'a.png', type: 'image/png' })).toBe('data:image/png;base64,AAAA')
  })
})
