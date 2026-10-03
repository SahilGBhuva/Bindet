import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { fileToAvatarDataUrl } from './session'
import { useData } from './dataSource'
import { toneClass, toneForName } from './tones'
import './AvatarControl.css'

type AvatarControlProps = {
  /* Used for the initials and stable tone shown until a photo is chosen. */
  name?: string
  onError?: (message: string) => void
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'B'
  return (parts.length > 1 ? `${parts[0][0]}${parts[parts.length - 1][0]}` : parts[0][0]).toUpperCase()
}

export function AvatarControl({ name = '', onError }: AvatarControlProps) {
  const data = useData()
  const [src, setSrc] = useState(() => data.loadAvatar())
  const inputRef = useRef<HTMLInputElement>(null)

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0]
    event.target.value = ''
    if (!next) return
    if (!next.type.startsWith('image/')) {
      onError?.('Pick an image file for your avatar.')
      return
    }
    try {
      const dataUrl = await fileToAvatarDataUrl(next)
      data.saveAvatar(dataUrl)
      setSrc(dataUrl)
    } catch {
      onError?.('Could not use that image. Try another photo.')
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        className="file-input"
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onPick}
      />
      <button
        className={`avatar ${src ? 'has-photo' : toneClass(toneForName(name || 'bindit'))}`}
        type="button"
        onClick={() => inputRef.current?.click()}
        aria-label={src ? 'Change avatar image' : 'Choose avatar image'}
        title={src ? 'Change photo' : 'Add a photo'}
      >
        {src ? <img src={src} alt="" /> : <span className="avatar__initials">{initials(name)}</span>}
        <span className="avatar__edit" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.5-2h6l1.5 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" />
            <circle cx="12" cy="12.5" r="3.2" />
          </svg>
        </span>
      </button>
    </>
  )
}
