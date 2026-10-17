/*
 * iPhone photos (HEIC/HEIF). Safari can usually decode them, Chrome and Firefox can't, so
 * when the browser can't shrink one it is sent as-is and the server converts it to JPEG.
 * The browser may also leave the type empty (Windows without the HEIF extension), so the
 * file name counts too.
 */

export const HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'] as const
export const HEIC_EXTENSIONS = ['.heic', '.heif'] as const
/* For <input accept>: the MIME types plus the extensions, since some pickers only match one. */
export const HEIC_ACCEPT = [...HEIC_TYPES, ...HEIC_EXTENSIONS].join(',')

type FileLike = { name?: string; type?: string }

export function isHeicFile(file: FileLike): boolean {
  const type = (file.type ?? '').toLowerCase()
  if ((HEIC_TYPES as readonly string[]).includes(type)) return true
  if (type && type !== 'application/octet-stream') return false
  const name = (file.name ?? '').toLowerCase()
  return HEIC_EXTENSIONS.some((extension) => name.endsWith(extension))
}

/* An image file by its type, or an iPhone photo the browser didn't label. */
export function isImageFile(file: FileLike): boolean {
  return (file.type ?? '').startsWith('image/') || isHeicFile(file)
}

function megabytes(bytes: number) {
  const value = Math.round((bytes / (1024 * 1024)) * 10) / 10
  return `${value} MB`
}

/* An iPhone photo this browser couldn't shrink that is over the upload limit. */
export class HeicTooLargeError extends Error {
  readonly size: number
  readonly maxBytes: number
  /* A few words for a small attachment chip. */
  readonly short: string

  constructor(size: number, maxBytes: number) {
    super(`This iPhone photo is ${megabytes(size)}. Photos must be ${megabytes(maxBytes)} or smaller. Try a smaller photo, or save it as a JPG first.`)
    this.name = 'HeicTooLargeError'
    this.size = size
    this.maxBytes = maxBytes
    this.short = `Larger than ${megabytes(maxBytes)}`
  }
}

/* The original HEIC, to send unconverted for the server to convert, when it fits under maxBytes. */
export function heicOriginal(file: File, maxBytes: number): File {
  if (file.size > maxBytes) throw new HeicTooLargeError(file.size, maxBytes)
  return file
}

/* A data URL for an image, labelled image/heic when the browser left an iPhone photo untyped. */
export function labelledDataUrl(dataUrl: string, file: FileLike): string {
  if (!isHeicFile(file) || dataUrl.startsWith('data:image/heic') || dataUrl.startsWith('data:image/heif')) return dataUrl
  const comma = dataUrl.indexOf(',')
  return comma < 0 ? dataUrl : `data:image/heic;base64${dataUrl.slice(comma)}`
}
