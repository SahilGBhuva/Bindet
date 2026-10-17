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
  // The browser's own decode errors ("The source image cannot be decoded.") mean nothing to a
  // student: a file that isn't a photo it can read gets a plain answer and a next step.
  const image = await decode(file).catch(() => {
    throw new Error('That photo couldn’t be opened. Try taking it again, or use Upload a file for a PDF or document.')
  })
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

/* A camera photo of notes on its way in: prepared once, so Retry resends the same image. */
export type PhotoStage = 'preparing' | 'uploading' | 'reading' | 'added' | 'failed'
export type PhotoJob = {
  file: File
  preview: string
  name: string
  course: string
  unit: string
  stage: PhotoStage
}

const photoDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/*
 * Each page is its own note, numbered within its unit and day: "Photo notes – Oct 7, page 2".
 * `notes` are the unit's notes so far (on any device), so the next page follows the last one.
 */
export function photoNoteName(now: number, notes: readonly { fileName: string }[]) {
  const base = `Photo notes – ${photoDay.format(new Date(now))}`
  const page = notes.filter((note) => note.fileName.startsWith(base)).length + 1
  return `${base}, page ${page}`
}
