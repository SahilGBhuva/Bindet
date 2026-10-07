/*
 * bindit service worker: keeps the static app shell so the installed app opens offline.
 *
 * What it caches: only files that are the same for every visitor — the page shell
 * (index.html, the legal pages), the hashed build files under /assets/, and the
 * static icons, mascot and scripts in /public. It never caches /api/*, Supabase,
 * any other origin, or any request that carries credentials, so no account data
 * ever lands in the Cache Storage. Study data kept for offline use (saved
 * flashcards) lives in IndexedDB instead, and is deleted on sign-out
 * (lib/offlineCards.ts).
 *
 * The build (vite.config.ts) replaces the two placeholders below with this
 * build's version and its file list, so every deploy installs a fresh cache.
 * A new worker waits until the student chooses "Reload" (lib/pwa.ts), so a
 * study session is never reloaded under them.
 */
const VERSION = '__BINDIT_SW_VERSION__'
const PRECACHE = /* __BINDIT_SW_PRECACHE__ */ ['/index.html']

const CACHE_PREFIX = 'bindit-shell-'
const CACHE = `${CACHE_PREFIX}${VERSION}`
// Routes the server rewrites to a static page (vercel.json), and the page they serve.
const STATIC_PAGES = { '/privacy': '/privacy/index.html', '/terms': '/terms/index.html' }
// Static files from /public that are safe to keep once fetched (never personal data).
const STATIC_FILE = /\.(?:webp|png|svg|ico|woff2?|css|js|webmanifest)$/i

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // cache: 'reload' skips the HTTP cache so the shell matches this build exactly.
      cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload', credentials: 'same-origin' }))),
    ),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

// The page asks the waiting worker to take over only after the student clicks "Reload".
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

/* True for anything that must always go to the network and never be stored. */
function networkOnly(request, url) {
  if (request.method !== 'GET') return true
  if (url.origin !== self.location.origin) return true // Supabase, Google Fonts, everything else
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return true
  if (url.pathname === '/sw.js') return true
  if (request.headers.has('Authorization')) return true
  return false
}

/* Only plain, successful, same-origin responses that allow storing are kept. */
function storable(response) {
  if (!response || !response.ok || response.type !== 'basic') return false
  const control = response.headers.get('Cache-Control') || ''
  if (/no-store|private/i.test(control)) return false
  if (response.headers.has('Set-Cookie')) return false
  return true
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request, { ignoreSearch: false })
  if (hit) return hit
  const response = await fetch(request)
  if (storable(response)) cache.put(request, response.clone()).catch(() => undefined)
  return response
}

/* Pages: always try the network first (fresh deploys, sign-in returns); offline, open the cached shell. */
async function navigation(request, url) {
  try {
    return await fetch(request)
  } catch (error) {
    const cache = await caches.open(CACHE)
    const page = STATIC_PAGES[url.pathname.replace(/\/$/, '')]
    const fallback = (page && (await cache.match(page))) || (await cache.match('/index.html'))
    if (fallback) return fallback
    throw error
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (networkOnly(request, url)) return // the browser handles it; nothing is cached
  if (request.mode === 'navigate') {
    event.respondWith(navigation(request, url))
    return
  }
  // Hashed build files never change under the same name; static public files are versioned by this worker.
  if (url.pathname.startsWith('/assets/') || PRECACHE.includes(url.pathname) || STATIC_FILE.test(url.pathname)) {
    event.respondWith(cacheFirst(request))
  }
})
