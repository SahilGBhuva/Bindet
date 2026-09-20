import type { ReactNode } from 'react'

/*
 * bindit's brand illustrations: simple ink line drawings with at most one accent.
 * These are for the landing page's compositions. Interface icons stay in Icons.tsx.
 * Ink follows currentColor; the accent follows --accent.
 */

function Drawing({ viewBox, className = '', children }: { viewBox: string; className?: string; children: ReactNode }) {
  return (
    <svg className={`lp-ink ${className}`} viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export function Paperclip({ className }: { className?: string }) {
  return (
    <Drawing viewBox="0 0 28 64" className={className}>
      <path d="M20 16v30a8 8 0 0 1-16 0V12a6 6 0 0 1 12 0v32a3 3 0 0 1-6 0V18" />
    </Drawing>
  )
}

export function Pencil({ className }: { className?: string }) {
  return (
    <Drawing viewBox="0 0 120 24" className={className}>
      <path d="M4 12 20 5h82a6 6 0 0 1 6 6v2a6 6 0 0 1-6 6H20z" />
      <path d="M20 5v14M94 5v14" />
      <path d="M4 12l7-3v6z" fill="currentColor" />
      <path d="M94 5h8a6 6 0 0 1 6 6v2a6 6 0 0 1-6 6h-8z" fill="var(--accent, currentColor)" fillOpacity="0.18" stroke="none" />
    </Drawing>
  )
}

export function Bookmark({ className }: { className?: string }) {
  return (
    <Drawing viewBox="0 0 28 44" className={className}>
      <path d="M4 3h20v37l-10-8-10 8z" fill="var(--accent, none)" fillOpacity="0.14" />
    </Drawing>
  )
}

export function BinderRings({ className }: { className?: string }) {
  return (
    <Drawing viewBox="0 0 24 120" className={className}>
      {[14, 60, 106].map((y) => (
        <g key={y}>
          <path d={`M4 ${y}a8 6 0 0 1 16 0`} />
          <circle cx="4" cy={y} r="1.6" fill="currentColor" stroke="none" />
          <circle cx="20" cy={y} r="1.6" fill="currentColor" stroke="none" />
        </g>
      ))}
    </Drawing>
  )
}

/* A hand-drawn underline for a handwritten word. */
export function Scribble({ className }: { className?: string }) {
  return (
    <Drawing viewBox="0 0 120 12" className={className}>
      <path d="M3 8c18-5 34-5 52-2s40 3 62-3" stroke="var(--accent, currentColor)" strokeWidth="2.2" />
    </Drawing>
  )
}
