import { useSyncExternalStore } from 'react'

/*
 * The installable app: service worker registration, the "new version" prompt,
 * the install prompt, and whether the device is online.
 *
 * The worker (public/sw.js) only runs in production builds on https or localhost.
 * A new version waits until the student chooses Reload, so nothing reloads mid-study.
 */

type Listener = () => void

function store<T>(initial: T) {
  let value = initial
  const listeners = new Set<Listener>()
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return
      value = next
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: Listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

/* ---------- Service worker and updates ---------- */

const waitingWorker = store<ServiceWorker | null>(null)
let reloading = false

function secureEnough() {
  const { protocol, hostname } = window.location
  return protocol === 'https:' || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function watchRegistration(registration: ServiceWorkerRegistration) {
  // Only an update (a page already controlled by an older worker) needs a prompt.
  const offer = (worker: ServiceWorker | null) => {
    if (worker && navigator.serviceWorker.controller) waitingWorker.set(worker)
  }
  offer(registration.waiting)
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed') offer(registration.waiting ?? installing)
    })
  })
  // Look for a new deploy when the app comes back to the foreground, at most every 30 minutes.
  let lastCheck = Date.now()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 30 * 60_000) return
    lastCheck = Date.now()
    void registration.update().catch(() => undefined)
  })
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !secureEnough()) return
  const register = () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(watchRegistration, () => undefined)
  }
  // The new worker takes over only after the student chose Reload; then reload once.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) return
    window.location.reload()
  })
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}

export function useUpdateReady() {
  return useSyncExternalStore(waitingWorker.subscribe, () => waitingWorker.get() !== null, () => false)
}

export function applyUpdate() {
  const worker = waitingWorker.get()
  if (!worker) return
  reloading = true
  worker.postMessage({ type: 'SKIP_WAITING' })
}

export function dismissUpdate() {
  waitingWorker.set(null)
}

/* ---------- Online / offline ---------- */

function subscribeOnline(listener: Listener) {
  window.addEventListener('online', listener)
  window.addEventListener('offline', listener)
  return () => {
    window.removeEventListener('online', listener)
    window.removeEventListener('offline', listener)
  }
}

export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

export function useOnline() {
  return useSyncExternalStore(subscribeOnline, () => !isOffline(), () => true)
}

/* ---------- Install prompt ---------- */

type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

// A cosmetic, per-device key (COSMETIC_KEYS in lib/auth.ts keeps it across accounts).
export const INSTALL_DISMISSED_KEY = 'bindit:install-dismissed'

const installPrompt = store<InstallPromptEvent | null>(null)
const installDismissed = store<boolean>(readDismissed())
const installed = store<boolean>(false)

function readDismissed() {
  try {
    return localStorage.getItem(INSTALL_DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

function standalone() {
  const nav = navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true
}

/* iPhone or iPad Safari (not Chrome or Firefox on iOS, which can't add to the Home Screen the same way). */
function iosSafari() {
  const agent = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(agent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  return ios && /Safari/.test(agent) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(agent)
}

/* Chromium offers installing through this event; keep it for the Install button instead of the browser's own banner. */
export function listenForInstallPrompt() {
  installed.set(standalone())
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    installPrompt.set(event as InstallPromptEvent)
  })
  window.addEventListener('appinstalled', () => {
    installPrompt.set(null)
    installed.set(true)
  })
}

export type InstallOffer = 'prompt' | 'ios' | null

function currentOffer(): InstallOffer {
  if (installed.get()) return null
  if (installPrompt.get()) return 'prompt'
  return iosSafari() && !standalone() ? 'ios' : null
}

function subscribeInstall(listener: Listener) {
  const stops = [installPrompt.subscribe(listener), installed.subscribe(listener), installDismissed.subscribe(listener)]
  return () => stops.forEach((stop) => stop())
}

/* How bindit can be installed here, if at all. */
export function useInstallOffer(): InstallOffer {
  return useSyncExternalStore(subscribeInstall, currentOffer, () => null)
}

export function useInstallDismissed() {
  return useSyncExternalStore(subscribeInstall, installDismissed.get, () => false)
}

export async function promptInstall() {
  const event = installPrompt.get()
  if (!event) return
  // A prompt can be shown once; Chromium fires a fresh event later if the student says no.
  installPrompt.set(null)
  await event.prompt()
  const choice = await event.userChoice.catch(() => null)
  if (choice?.outcome === 'accepted') installed.set(true)
}

export function dismissInstall() {
  installDismissed.set(true)
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
  } catch {
    // Storage unavailable: hidden for this visit only.
  }
}
