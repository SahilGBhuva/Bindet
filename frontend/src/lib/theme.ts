/*
 * Theme preference: 'system' follows the OS; 'light' and 'dark' pin it.
 * index.html applies the saved choice before first paint; this module keeps
 * <html data-theme> in sync afterwards. Stored per device only.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

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
}

/* Follow OS changes while the preference is 'system'. Call once at startup. */
export function watchSystemTheme() {
  media?.addEventListener('change', () => { if (loadThemePreference() === 'system') applyTheme('system') })
}
