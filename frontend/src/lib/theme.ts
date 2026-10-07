/*
 * Theme preference: 'system' follows the OS; 'light' and 'dark' pin it.
 * index.html applies the saved choice before first paint; this module keeps
 * <html data-theme> in sync afterwards. Stored per device only.
 */
import { useSyncExternalStore } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

/* Fired on window whenever the saved preference changes, so every theme control stays in step. */
export const THEME_CHANGED_EVENT = 'bindit:theme-changed'

const KEY = 'bindit:theme'
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

export function loadThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

function resolve(preference: ThemePreference): 'light' | 'dark' {
  if (preference !== 'system') return preference
  return media?.matches ? 'dark' : 'light'
}

export function applyTheme(preference: ThemePreference = loadThemePreference()) {
  const theme = resolve(preference)
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#111113' : '#f6f5f1')
}

export function saveThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, preference)
  } catch {
    // Storage can be unavailable; the choice still applies for this visit.
  }
  applyTheme(preference)
  window.dispatchEvent(new Event(THEME_CHANGED_EVENT))
}

function subscribeTheme(onChange: () => void) {
  // Another tab changing the theme arrives as a storage event; apply it here too.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY && event.key !== null) return
    applyTheme()
    onChange()
  }
  window.addEventListener(THEME_CHANGED_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(THEME_CHANGED_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

const ignore = () => () => undefined
const SYSTEM = (): ThemePreference => 'system'

/*
 * The saved preference, shared by every theme control (Home, Settings, the phone menu).
 * With enabled false (the landing page's sandboxed demo) it never touches storage.
 */
export function useThemePreference(enabled = true): ThemePreference {
  return useSyncExternalStore(enabled ? subscribeTheme : ignore, enabled ? loadThemePreference : SYSTEM, SYSTEM)
}

/* Follow OS changes while the preference is 'system'. Call once at startup. */
export function watchSystemTheme() {
  media?.addEventListener('change', () => { if (loadThemePreference() === 'system') applyTheme('system') })
}
