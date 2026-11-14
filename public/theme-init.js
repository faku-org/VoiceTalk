// Pre-paint theme. Reads the cached preference (written by src/lib/theme.ts)
// and sets data-theme / .dark on <html> before the first frame, so there is no
// flash. Keep the storage key and the logic in sync with src/lib/theme.ts.
;(function () {
  var pref = 'system'
  try {
    var saved = localStorage.getItem('voicetalk.theme')
    if (saved === 'light' || saved === 'dark' || saved === 'system')
      pref = saved
  } catch {}
  var dark =
    pref === 'dark' ||
    (pref === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  var root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.classList.toggle('dark', dark)
})()
