// Applies the web-font stylesheet once it has loaded, without blocking first paint.
// Kept as an external file so the Content-Security-Policy can forbid inline scripts.
;(function () {
  var link = document.getElementById('bindit-fonts')
  if (!link) return
  var apply = function () {
    link.media = 'all'
  }
  if (link.sheet) apply()
  else link.addEventListener('load', apply)
})()
