// Applies the saved theme before first paint (lib/theme.ts keeps it in sync).
// An external file, loaded synchronously in <head>, because the
// Content-Security-Policy (vercel.json) blocks inline scripts.
(function () {
  var pref = null
  try { pref = localStorage.getItem('bindit:theme') } catch (e) {}
  var dark = pref === 'dark' || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  var meta = document.querySelector('meta[name="theme-color"]')
  if (dark && meta) meta.setAttribute('content', '#111113')
})()
