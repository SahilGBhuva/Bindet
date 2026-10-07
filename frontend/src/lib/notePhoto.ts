/*
 * Photos of notes taken with the phone camera: turned the right way up (EXIF orientation),
 * shrunk so the long edge is at most 1800px (the size uploadNote already aims for, so it
 * is not re-encoded) and saved as JPEG, which every browser can encode. A 12-megapixel
 * camera photo of 3–5 MB becomes a few hundred KB, well under the 10 MB note limit.
 */

const MAX_EDGE = 1800
const TARGET_BYTES = 950_000

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' })
    } catch {
      // Older Safari rejects the options object; some formats (HEIC) only decode through <img>.
      try {
        return await createImageBitmap(file)
      } catch { /* fall through to <img> */ }
    }
  }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

function encode(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

export async function prepareNotePhoto(file: File, name: string): Promise<File> {
  const image = await decode(file)
  const width = image instanceof HTMLImageElement ? image.naturalWidth : image.width
  const height = image instanceof HTMLImageElement ? image.naturalHeight : image.height
  if (!width || !height) throw new Error('That photo could not be opened. Try taking it again.')
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('That photo could not be prepared. Try again.')
  // JPEG has no transparency: paper-white behind any transparent pixels.
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  if ('close' in image) image.close()
  let blob = await encode(canvas, 0.85)
  if (blob && blob.size > TARGET_BYTES) blob = await encode(canvas, 0.72)
  canvas.width = 0
  canvas.height = 0
  if (!blob) throw new Error('That photo could not be prepared. Try again.')
  return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: Date.now() })
}
