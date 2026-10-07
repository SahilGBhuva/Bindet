import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react'

/*
 * Shared behaviour for phone drawers and sheets (the Menu sheet, the Tutor and Messages
 * conversation lists, the task details drawer): while open the page behind does not
 * scroll, focus moves into the drawer and stays there, Esc closes it, and focus goes
 * back to whatever opened it. Tapping outside is handled by each drawer's scrim.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

let locks = 0
let saved = ''

function lockScroll() {
  if (locks++ > 0) return
  const root = document.documentElement
  saved = root.style.overflow
  root.style.overflow = 'hidden'
}

function unlockScroll() {
  if (--locks > 0) return
  locks = 0
  document.documentElement.style.overflow = saved
}

type DrawerOptions = {
  open: boolean
  onClose: () => void
  panel: RefObject<HTMLElement | null>
  /* Where focus returns on close. Defaults to the element focused when the drawer opened. */
  returnFocus?: RefObject<HTMLElement | null>
  /* Moves focus into the drawer on open (first control, or the panel itself). */
  autoFocus?: boolean
}

export function useDrawer({ open, onClose, panel, returnFocus, autoFocus = true }: DrawerOptions) {
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose }, [onClose])

  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const node = panel.current
    const back = returnFocus?.current ?? opener
    lockScroll()
    if (autoFocus) {
      const first = node?.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? node)?.focus({ preventScroll: true })
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        close.current()
        return
      }
      if (event.key !== 'Tab' || !panel.current) return
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null || item === document.activeElement)
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !panel.current.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !panel.current.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      unlockScroll()
      // Only hand focus back if it would otherwise be lost (still in the closed drawer, or on <body>).
      const active = document.activeElement
      if (back?.isConnected && (!active || active === document.body || node?.contains(active))) back.focus({ preventScroll: true })
    }
  }, [open, panel, returnFocus, autoFocus])
}

/* True while a media query matches; follows changes (rotation, resizing). */
export function useMediaQuery(query: string) {
  const subscribe = useCallback((onChange: () => void) => {
    const media = window.matchMedia(query)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}
