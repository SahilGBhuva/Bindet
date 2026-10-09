// Applies the saved theme before first paint (lib/theme.ts keeps it in sync).
// An external file, loaded synchronously in <head>, because the
// Content-Security-Policy (vercel.json) blocks inline scripts.
(function () {
  var pref = null
  try { pref = localStorage.getItem('bindit:theme') } catch { /* storage blocked: follow the system */ }
  var dark = pref === 'dark' || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  var meta = document.querySelector('meta[name="theme-color"]')
  if (dark && meta) meta.setAttribute('content', '#1b1c20')
})()

// A Google sign-in comes back to /?flow=<id>&code=<one-time code> (or ?error=…).
// Move those parameters out of the address bar and history into this tab's
// sessionStorage before any other script, image or request runs, so the code is
// never sent in a Referer header or kept in history. lib/auth.ts reads them once.
// Without storage they stay in the URL and lib/auth.ts strips them itself.
;(function () {
  try {
    var url = new URL(window.location.href)
    var params = url.searchParams
    var ours = params.has('code') || params.has('flow') ||
      (params.has('error') && (params.has('error_code') || params.has('error_description')))
    if (!ours) return
    var taken = {}
    ;['code', 'flow', 'error', 'error_code', 'error_description', 'state'].forEach(function (key) {
      if (params.has(key)) {
        taken[key] = params.get(key)
        params.delete(key)
      }
    })
    sessionStorage.setItem('bindit-auth-return', JSON.stringify({ at: Date.now(), params: taken }))
    var search = params.toString()
    window.history.replaceState(window.history.state, document.title, url.pathname + (search ? '?' + search : '') + url.hash)
  } catch {
    // Storage blocked: lib/auth.ts handles the parameters from the URL.
  }
})()
