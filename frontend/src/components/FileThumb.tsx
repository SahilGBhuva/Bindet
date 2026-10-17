/*
 * A neutral stand-in for a photo the browser can't draw (an iPhone HEIC in Chrome or
 * Firefox): an image icon and the file's extension, in place of a broken <img>.
 */
export function FileThumb({ name, size, className = '' }: { name: string; size: number; className?: string }) {
  const extension = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase() ?? 'IMG'
  return (
    <span className={`ui-file-thumb ${className}`.trim()} style={{ width: size, height: size }} role="img" aria-label={`${name} (no preview)`}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2" /><path d="m4 16 5-5 4 4 3-3 4 4" /></svg>
      <small aria-hidden="true">{extension}</small>
    </span>
  )
}
