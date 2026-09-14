import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { fileToAvatarDataUrl, loadAvatar, saveAvatar } from './session'
import './AvatarControl.css'

type AvatarControlProps = {
  onError?: (message: string) => void
}

export function AvatarControl({ onError }: AvatarControlProps) {
  const [src, setSrc] = useState(() => loadAvatar())
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
      saveAvatar(dataUrl)
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
        onChange={onPick}
      />
      <button
        className={`avatar ${src ? 'has-photo' : ''}`}
        type="button"
        onClick={() => inputRef.current?.click()}
        aria-label="Choose avatar image"
      >
        {src ? <img src={src} alt="" /> : 'B'}
      </button>
    </>
  )
}
