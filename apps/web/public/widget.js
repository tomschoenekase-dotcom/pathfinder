// eslint-disable-next-line no-extra-semi -- Prettier keeps this ASI-safe classic-script IIFE prefix.
;(function () {
  'use strict'

  var script = document.currentScript
  if (!script || script.tagName !== 'SCRIPT' || script.dataset.pathfinderMounted === 'true') return

  var venueSlug = script.getAttribute('data-pathfinder-venue')
  if (!venueSlug || venueSlug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(venueSlug)) {
    return
  }

  var sourceUrl
  try {
    sourceUrl = new URL(script.src, document.baseURI)
  } catch {
    return
  }

  var isLoopbackHttp =
    sourceUrl.protocol === 'http:' &&
    (sourceUrl.hostname === 'localhost' ||
      sourceUrl.hostname === '127.0.0.1' ||
      sourceUrl.hostname === '[::1]')
  if (
    (sourceUrl.protocol !== 'https:' && !isLoopbackHttp) ||
    sourceUrl.username ||
    sourceUrl.password
  ) {
    return
  }

  var frame = document.createElement('iframe')
  frame.src = new URL('/embed/' + encodeURIComponent(venueSlug), sourceUrl.origin).href
  frame.title = 'PathFinder venue guide'
  frame.loading = 'lazy'
  frame.referrerPolicy = 'strict-origin-when-cross-origin'
  frame.setAttribute('data-pathfinder-widget', '')
  frame.style.border = '0'
  frame.style.display = 'block'
  frame.style.minHeight = '640px'
  frame.style.width = '100%'

  script.insertAdjacentElement('afterend', frame)
  script.dataset.pathfinderMounted = 'true'
})()
