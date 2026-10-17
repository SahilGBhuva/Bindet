/* In memory only (never written to storage): survives switching pages, not a reload. */
const signedUrls = new Map<string, { url: string; expires: number }>()
/* Images this device just sent, shown from the local copy instead of being downloaded again. */
const localPreviews = new Map<string, string>()

export function cachedImageUrl(path: string) {
  if (!path) return ''
  const local = localPreviews.get(path)
  if (local) return local
  const signed = signedUrls.get(path)
  return signed && signed.expires > Date.now() + 60_000 ? signed.url : ''
}

export function rememberSignedUrl(path: string, url: string) {
  signedUrls.set(path, { url, expires: Date.now() + 3_600_000 })
}

export function rememberLocalPreview(path: string, url: string) {
  localPreviews.set(path, url)
}
