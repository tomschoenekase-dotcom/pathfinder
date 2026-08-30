// eslint-disable-next-line no-extra-semi -- Prettier keeps this ASI-safe classic-script IIFE prefix.
;(function () {
  'use strict'

  var READY_MESSAGE_TYPE = 'pathfinder:embed-ready'
  var READY_MESSAGE_VERSION = 1
  var READY_TIMEOUT_MS = 10000
  var AVAILABILITY_TIMEOUT_MS = 10000
  var script = document.currentScript
  if (!script || script.tagName !== 'SCRIPT' || script.dataset.pathfinderMounted) return

  var venueSlug = script.getAttribute('data-pathfinder-venue')
  if (!venueSlug || venueSlug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(venueSlug)) {
    return
  }

  var sourceUrl
  try {
    if (!script.src) return
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
    sourceUrl.password ||
    sourceUrl.pathname !== '/widget.js'
  ) {
    return
  }

  var host
  var shadow
  var launcher
  var panel
  var closeButton
  var startGuard
  var endGuard
  var frame
  var ready = false
  var opening = false
  var readyTimer
  var availabilityTimer
  var availabilityAbort
  var modalQuery
  var listening = false
  var stylesheetReady = false
  var venueReady = false
  var domReadyListening = false
  var failed = false

  function failInvisible() {
    if (failed) return
    failed = true
    if (readyTimer !== undefined) window.clearTimeout(readyTimer)
    if (availabilityTimer !== undefined) window.clearTimeout(availabilityTimer)
    if (availabilityAbort) availabilityAbort.abort()
    if (modalQuery) modalQuery.removeEventListener('change', updateDialogMode)
    if (listening) window.removeEventListener('message', onReadyMessage)
    if (domReadyListening) document.removeEventListener('DOMContentLoaded', mount)
    listening = false
    domReadyListening = false
    readyTimer = undefined
    availabilityTimer = undefined
    if (host && host.parentNode) host.parentNode.removeChild(host)
    script.dataset.pathfinderMounted = 'failed'
  }

  function revealWhenAvailable() {
    if (failed || !stylesheetReady || !venueReady || !host) return
    if (availabilityTimer !== undefined) window.clearTimeout(availabilityTimer)
    availabilityTimer = undefined
    host.hidden = false
    script.dataset.pathfinderMounted = 'true'
  }

  function checkAvailability() {
    try {
      availabilityAbort = new window.AbortController()
      availabilityTimer = window.setTimeout(failInvisible, AVAILABILITY_TIMEOUT_MS)
      var readinessUrl = new URL(
        '/api/widget-ready/' + encodeURIComponent(venueSlug),
        sourceUrl.origin,
      )
      window
        .fetch(readinessUrl.href, {
          cache: 'no-store',
          credentials: 'omit',
          mode: 'cors',
          referrerPolicy: 'no-referrer',
          signal: availabilityAbort.signal,
        })
        .then(function (response) {
          if (failed) return
          if (
            response.status !== 204 ||
            response.headers.get('X-PathFinder-Widget-Ready') !== '1'
          ) {
            failInvisible()
            return
          }
          venueReady = true
          revealWhenAvailable()
        })
        .catch(failInvisible)
    } catch {
      failInvisible()
    }
  }

  function closePanel() {
    if (!ready || !panel || !launcher) return
    panel.hidden = true
    launcher.hidden = false
    launcher.disabled = false
    launcher.textContent = 'Ask Torchiko'
    launcher.setAttribute('aria-label', 'Open Torchiko venue guide')
    launcher.setAttribute('aria-expanded', 'false')
    launcher.removeAttribute('aria-busy')
    launcher.focus()
  }

  function updateDialogMode() {
    if (!panel || !startGuard || !endGuard) return
    var isModal = Boolean(modalQuery && modalQuery.matches)
    if (isModal) panel.setAttribute('aria-modal', 'true')
    else panel.removeAttribute('aria-modal')
    startGuard.tabIndex = isModal ? 0 : -1
    endGuard.tabIndex = isModal ? 0 : -1
  }

  function showReadyPanel() {
    ready = true
    opening = false
    if (readyTimer !== undefined) window.clearTimeout(readyTimer)
    readyTimer = undefined
    if (listening) window.removeEventListener('message', onReadyMessage)
    listening = false
    launcher.hidden = true
    launcher.disabled = false
    launcher.removeAttribute('aria-busy')
    launcher.setAttribute('aria-expanded', 'true')
    updateDialogMode()
    panel.hidden = false
    closeButton.focus()
  }

  function onReadyMessage(event) {
    if (
      !frame ||
      event.origin !== sourceUrl.origin ||
      event.source !== frame.contentWindow ||
      !event.data ||
      typeof event.data !== 'object' ||
      Array.isArray(event.data)
    ) {
      return
    }

    var keys = Object.keys(event.data).sort()
    if (
      keys.length !== 3 ||
      keys[0] !== 'type' ||
      keys[1] !== 'venueSlug' ||
      keys[2] !== 'version' ||
      event.data.type !== READY_MESSAGE_TYPE ||
      event.data.version !== READY_MESSAGE_VERSION ||
      event.data.venueSlug !== venueSlug
    ) {
      return
    }

    showReadyPanel()
  }

  function createFrame() {
    frame = document.createElement('iframe')
    frame.src = new URL('/embed/' + encodeURIComponent(venueSlug), sourceUrl.origin).href
    frame.title = 'Torchiko venue guide'
    frame.loading = 'eager'
    frame.referrerPolicy = 'no-referrer'
    // Delegate only microphone access to the exact-origin guide frame. The
    // browser still prompts only after the visitor explicitly starts Voice Mode.
    frame.setAttribute('allow', 'microphone')
    frame.setAttribute('data-pathfinder-widget-frame', '')
    frame.setAttribute(
      'sandbox',
      'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts',
    )
    frame.addEventListener('error', failInvisible, { once: true })
    panel.insertBefore(frame, endGuard)
  }

  function openPanel() {
    if (ready) {
      launcher.hidden = true
      launcher.setAttribute('aria-expanded', 'true')
      updateDialogMode()
      panel.hidden = false
      closeButton.focus()
      return
    }
    if (opening) return

    opening = true
    launcher.disabled = true
    launcher.textContent = 'Opening Torchiko…'
    launcher.setAttribute('aria-label', 'Opening Torchiko venue guide')
    launcher.setAttribute('aria-busy', 'true')
    try {
      listening = true
      window.addEventListener('message', onReadyMessage)
      readyTimer = window.setTimeout(failInvisible, READY_TIMEOUT_MS)
      if (!frame) createFrame()
    } catch {
      failInvisible()
    }
  }

  function mount() {
    if (failed || !document.body || host) return
    if (domReadyListening) document.removeEventListener('DOMContentLoaded', mount)
    domReadyListening = false
    if (availabilityTimer !== undefined) window.clearTimeout(availabilityTimer)
    availabilityTimer = undefined

    try {
      host = document.createElement('div')
      host.setAttribute('data-pathfinder-widget', '')
      host.hidden = true

      shadow = host.attachShadow({ mode: 'open' })
      var styles = document.createElement('link')
      styles.rel = 'stylesheet'
      styles.href = new URL('/widget.css', sourceUrl.origin).href
      styles.referrerPolicy = 'no-referrer'
      styles.addEventListener('load', function () {
        stylesheetReady = true
        revealWhenAvailable()
      })
      styles.addEventListener('error', failInvisible, { once: true })

      launcher = document.createElement('button')
      launcher.type = 'button'
      launcher.className = 'pf-launcher'
      launcher.textContent = 'Ask Torchiko'
      launcher.setAttribute('aria-controls', 'pathfinder-widget-panel')
      launcher.setAttribute('aria-expanded', 'false')
      launcher.setAttribute('aria-label', 'Open Torchiko venue guide')
      launcher.addEventListener('click', openPanel)

      panel = document.createElement('section')
      panel.id = 'pathfinder-widget-panel'
      panel.className = 'pf-panel'
      panel.hidden = true
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', 'Torchiko venue guide')

      startGuard = document.createElement('button')
      startGuard.type = 'button'
      startGuard.className = 'pf-focus-guard'
      startGuard.setAttribute('aria-label', 'Keep focus in Torchiko venue guide')
      startGuard.addEventListener('focus', function () {
        if (frame) frame.focus()
        else closeButton.focus()
      })

      closeButton = document.createElement('button')
      closeButton.type = 'button'
      closeButton.className = 'pf-close'
      closeButton.textContent = 'Close'
      closeButton.setAttribute('aria-label', 'Close Torchiko venue guide')
      closeButton.addEventListener('click', closePanel)
      endGuard = document.createElement('button')
      endGuard.type = 'button'
      endGuard.className = 'pf-focus-guard'
      endGuard.setAttribute('aria-label', 'Keep focus in Torchiko venue guide')
      endGuard.addEventListener('focus', function () {
        closeButton.focus()
      })
      panel.appendChild(startGuard)
      panel.appendChild(closeButton)
      panel.appendChild(endGuard)
      if (typeof window.matchMedia === 'function') {
        modalQuery = window.matchMedia('(max-width: 480px)')
        modalQuery.addEventListener('change', updateDialogMode)
      }
      updateDialogMode()

      shadow.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && ready && !panel.hidden) {
          event.preventDefault()
          closePanel()
        }
      })
      shadow.appendChild(styles)
      shadow.appendChild(launcher)
      shadow.appendChild(panel)
      document.body.appendChild(host)
      checkAvailability()
    } catch {
      failInvisible()
    }
  }

  script.dataset.pathfinderMounted = 'pending'
  if (document.body) {
    mount()
  } else {
    domReadyListening = true
    document.addEventListener('DOMContentLoaded', mount, { once: true })
    availabilityTimer = window.setTimeout(failInvisible, AVAILABILITY_TIMEOUT_MS)
  }
})()
