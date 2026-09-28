// eslint-disable-next-line no-extra-semi -- Prettier keeps this ASI-safe classic-script IIFE prefix.
;(function () {
  'use strict'

  var READY_MESSAGE_TYPE = 'pathfinder:embed-ready'
  var READY_MESSAGE_VERSION = 1
  var BRIDGE_VERSION = 1
  var BRIDGE_SOURCE = 'torchiko'
  var READY_TIMEOUT_MS = 10000
  var AVAILABILITY_TIMEOUT_MS = 10000
  var script = document.currentScript
  if (!script || script.tagName !== 'SCRIPT' || script.dataset.pathfinderMounted || script.dataset.torchikoMounted) return

  function isValidVenueSlug(value) {
    return Boolean(value && value.length <= 200 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value))
  }
  var venueSlug = script.getAttribute('data-torchiko-venue') || script.getAttribute('data-pathfinder-venue')
  if (venueSlug && !isValidVenueSlug(venueSlug)) return

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
  var inlineDomReadyListening = false
  var inlineObserver
  var widgetPresentation = null
  var viewportListening = false
  var failed = false
  var pendingOpen = false
  var pendingPrefill = null
  var closeWhileOpening = false
  var inlineFrames = []
  var subscribers = { ready: [], open: [], close: [] }

  function emit(type) {
    subscribers[type].slice().forEach(function (listener) {
      try { listener() } catch { /* A host callback cannot interrupt the guide. */ }
    })
  }

  function normalizeOptions(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return null
    var result = {}
    if (typeof options.ask === 'string' && options.ask.length > 0 && options.ask.length <= 400 &&
      Array.from(options.ask).length <= 200) {
      result.ask = options.ask
    }
    if (typeof options.place === 'string') {
      var place = options.place.trim()
      var safe = place.length > 0 && place.length <= 191
      for (var i = 0; safe && i < place.length; i += 1) {
        var code = place.charCodeAt(i)
        if (code < 32 || code === 127) safe = false
      }
      if (safe) result.place = place
    }
    return Object.keys(result).length ? result : null
  }

  function bridgeMessage(type, payload) {
    return { source: BRIDGE_SOURCE, v: BRIDGE_VERSION, type: type, payload: payload || null }
  }

  function sendToGuide(type, payload) {
    if (!frame || !frame.contentWindow || !ready) return
    frame.contentWindow.postMessage(bridgeMessage(type, payload), sourceUrl.origin)
  }

  function applyPrefill(options) {
    var value = normalizeOptions(options)
    if (!value) return
    if (ready) sendToGuide('prefill', value)
    else pendingPrefill = value
  }

  function acceptBridgeMessage(event, expectedFrame) {
    var data = event.data
    if (event.origin !== sourceUrl.origin || event.source !== expectedFrame.contentWindow ||
      !data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).sort().join(',') !== 'payload,source,type,v' ||
      data.source !== BRIDGE_SOURCE || data.v !== BRIDGE_VERSION || data.payload !== null ||
      (data.type !== 'ready' && data.type !== 'open' && data.type !== 'close-requested')) return null
    return data.type
  }

  function onBridgeMessage(event) {
    if (frame && event.source === frame.contentWindow) {
      var type = acceptBridgeMessage(event, frame)
      if (type === 'ready') {
        if (opening && !ready) showReadyPanel()
      } else if (type === 'close-requested') {
        closePanel()
      }
      return
    }
    inlineFrames.forEach(function (item) {
      if (event.source !== item.frame.contentWindow || event.origin !== sourceUrl.origin) return
      var data = event.data
      if (!data || typeof data !== 'object' || Array.isArray(data) ||
        Object.keys(data).sort().join(',') !== 'payload,source,type,v' ||
        data.source !== BRIDGE_SOURCE || data.v !== BRIDGE_VERSION) return
      if (data.type === 'ready' && data.payload === null) {
        item.finish(true)
      } else if (item.ready && !item.open && data.type === 'open' && data.payload === null) {
        item.open = true
        emit('open')
      } else if (item.ready && data.type === 'height' && data.payload &&
        typeof data.payload === 'object' && !Array.isArray(data.payload) &&
        Object.keys(data.payload).join(',') === 'height' &&
        Number.isInteger(data.payload.height) && data.payload.height >= 320 && data.payload.height <= 1600 &&
        data.payload.height !== item.lastHeight) {
        item.lastHeight = data.payload.height
        item.frame.style.height = data.payload.height + 'px'
        if (!item.container.style.height) item.container.style.height = data.payload.height + 'px'
      }
    })
  }

  window.addEventListener('message', onBridgeMessage)

  function probe(slug, onReady, onFailure) {
    var timer = window.setTimeout(onFailure, AVAILABILITY_TIMEOUT_MS)
    var probeUrl = new URL('/api/widget-ready/' + encodeURIComponent(slug), sourceUrl.origin)
    probeUrl.searchParams.set('v', '2')
    window.fetch(probeUrl.href, {
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      referrerPolicy: 'no-referrer',
    }).then(function (response) {
      if (response.status === 204 && response.headers.get('X-PathFinder-Widget-Ready') === '1') {
        window.clearTimeout(timer)
        onReady(null)
        return
      }
      if (response.status !== 200) throw new Error('not-ready')
      return response.json().then(function (payload) {
        var keys = payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).sort() : []
        if (keys.length !== 5 || keys[0] !== 'accent' || keys[1] !== 'background' || keys[2] !== 'label' || keys[3] !== 'theme' || keys[4] !== 'v' ||
          payload.v !== 2 || typeof payload.label !== 'string' || payload.label.length > 40 ||
          typeof payload.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(payload.accent) ||
          typeof payload.background !== 'string' || !/^#[0-9a-f]{6}$/i.test(payload.background) ||
          (payload.theme !== 'light' && payload.theme !== 'dark')) throw new Error('invalid-presentation')
        window.clearTimeout(timer)
        onReady({ label: payload.label, accent: payload.accent, theme: payload.theme, background: payload.background })
      })
    }).catch(function () {
      window.clearTimeout(timer)
      onFailure()
    })
  }

  function mountInline(container) {
    var slug = container.getAttribute('data-torchiko-inline')
    if (!isValidVenueSlug(slug) || container.dataset.torchikoInlineMounted) return
    container.dataset.torchikoInlineMounted = 'pending'
    probe(slug, function (presentation) {
      var inlineFrame = document.createElement('iframe')
      var timer
      var finished = false
      var item = { frame: inlineFrame, container: container, ready: false, open: false, lastHeight: 0, finish: finish }
      function finish(success) {
        if (finished) return
        finished = true
        window.removeEventListener('message', onMessage)
        if (timer !== undefined) window.clearTimeout(timer)
        if (!success) {
          inlineFrames = inlineFrames.filter(function (candidate) { return candidate !== item })
          if (failed && !inlineFrames.length) window.removeEventListener('message', onBridgeMessage)
          if (inlineFrame.parentNode) inlineFrame.parentNode.removeChild(inlineFrame)
          container.dataset.torchikoInlineMounted = 'failed'
          return
        }
        item.ready = true
        inlineFrame.hidden = false
        container.dataset.torchikoInlineMounted = 'true'
        emit('ready')
      }
      function onMessage(event) {
        var data = event.data
        if (event.origin !== sourceUrl.origin || event.source !== inlineFrame.contentWindow ||
          !data || typeof data !== 'object' || Array.isArray(data)) return
        var keys = Object.keys(data).sort()
        if (keys.length === 3 && keys[0] === 'type' && keys[1] === 'venueSlug' && keys[2] === 'version' &&
          data.type === READY_MESSAGE_TYPE && data.version === READY_MESSAGE_VERSION && data.venueSlug === slug) {
          finish(true)
        }
      }
      inlineFrame.src = new URL('/embed/' + encodeURIComponent(slug) + '/inline', sourceUrl.origin).href
      inlineFrame.title = 'Torchiko venue guide'
      inlineFrame.loading = 'eager'
      inlineFrame.referrerPolicy = 'no-referrer'
      inlineFrame.width = '100%'
      inlineFrame.height = '100%'
      inlineFrame.hidden = true
      inlineFrame.style.border = '0'
      inlineFrame.style.display = 'block'
      inlineFrame.style.backgroundColor = presentation ? presentation.background : '#fff'
      var containerHeight = parseFloat(window.getComputedStyle(container).height)
      if (!isFinite(containerHeight) || containerHeight < 320) {
        inlineFrame.style.minHeight = 'min(720px, 85vh)'
      }
      inlineFrame.setAttribute('allow', 'microphone')
      inlineFrame.setAttribute('data-pathfinder-widget-frame', '')
      inlineFrame.setAttribute('sandbox', 'allow-forms allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts')
      inlineFrame.addEventListener('error', function () { finish(false) }, { once: true })
      window.addEventListener('message', onMessage)
      inlineFrames.push(item)
      timer = window.setTimeout(function () { finish(false) }, READY_TIMEOUT_MS)
      container.appendChild(inlineFrame)
    }, function () {
      container.dataset.torchikoInlineMounted = 'failed'
    })
  }

  function mountInlineElements(root) {
    if (!root) return
    var candidates = []
    if (root.nodeType === 1 && root.matches && root.matches('[data-torchiko-inline]')) {
      candidates.push(root)
    }
    if (root.querySelectorAll) {
      candidates = candidates.concat(Array.prototype.slice.call(root.querySelectorAll('[data-torchiko-inline]')))
    }
    candidates.forEach(mountInline)
  }

  function observeInlineMounts() {
    if (inlineObserver || !document.body || typeof window.MutationObserver !== 'function') return
    inlineObserver = new window.MutationObserver(function (records) {
      records.forEach(function (record) {
        Array.prototype.forEach.call(record.addedNodes, mountInlineElements)
      })
    })
    inlineObserver.observe(document.body, { childList: true, subtree: true })
  }

  function startInlineMounting() {
    if (inlineDomReadyListening) document.removeEventListener('DOMContentLoaded', startInlineMounting)
    inlineDomReadyListening = false
    mountInlineElements(document.body)
    observeInlineMounts()
  }

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
    if (!inlineFrames.length) window.removeEventListener('message', onBridgeMessage)
    script.dataset.pathfinderMounted = 'failed'
  }

  function revealWhenAvailable() {
    if (failed || !stylesheetReady || !venueReady || !host) return
    if (availabilityTimer !== undefined) window.clearTimeout(availabilityTimer)
    availabilityTimer = undefined
    host.hidden = false
    script.dataset.pathfinderMounted = 'true'
    if (pendingOpen) {
      pendingOpen = false
      openPanel()
    }
  }

  function checkAvailability() {
    probe(venueSlug, function (presentation) {
      if (failed) return
      venueReady = true
      if (presentation) {
        widgetPresentation = presentation
        launcher.textContent = presentation.label
        launcher.dataset.label = presentation.label
        launcher.setAttribute('aria-label', presentation.label + ', opens venue guide')
        host.style.setProperty('--torchiko-widget-accent', presentation.accent)
        host.style.setProperty('--torchiko-widget-background', presentation.background)
        panel.style.backgroundColor = presentation.background
        host.style.setProperty('color-scheme', presentation.theme)
      }
      revealWhenAvailable()
    }, failInvisible)
  }

  function closePanel() {
    pendingOpen = false
    if (opening && !ready) {
      closeWhileOpening = true
      return
    }
    if (!ready || !panel || !launcher || panel.hidden) return
    sendToGuide('close')
    stopPanelViewportSync()
    panel.hidden = true
    launcher.hidden = false
    launcher.disabled = false
    launcher.textContent = launcher.dataset.label || 'Ask Torchiko'
    launcher.setAttribute('aria-label', launcher.textContent + ', opens venue guide')
    launcher.setAttribute('aria-expanded', 'false')
    launcher.removeAttribute('aria-busy')
    launcher.focus()
    emit('close')
  }

  function updateDialogMode() {
    if (!panel || !startGuard || !endGuard) return
    var isModal = Boolean(modalQuery && modalQuery.matches)
    if (isModal) panel.setAttribute('aria-modal', 'true')
    else panel.removeAttribute('aria-modal')
    startGuard.tabIndex = isModal ? 0 : -1
    endGuard.tabIndex = isModal ? 0 : -1
    if (isModal && !panel.hidden) startPanelViewportSync()
    else stopPanelViewportSync()
  }

  function syncPanelToViewport() {
    var viewport = window.visualViewport
    if (!viewport || !panel || panel.hidden || !modalQuery || !modalQuery.matches) return
    panel.style.top = Math.round(viewport.offsetTop) + 'px'
    panel.style.height = Math.round(viewport.height) + 'px'
    panel.style.bottom = 'auto'
  }

  function startPanelViewportSync() {
    var viewport = window.visualViewport
    if (!viewport) return
    if (viewportListening) {
      syncPanelToViewport()
      return
    }
    viewport.addEventListener('resize', syncPanelToViewport)
    viewport.addEventListener('scroll', syncPanelToViewport)
    viewportListening = true
    syncPanelToViewport()
  }

  function stopPanelViewportSync() {
    var viewport = window.visualViewport
    if (viewport && viewportListening) {
      viewport.removeEventListener('resize', syncPanelToViewport)
      viewport.removeEventListener('scroll', syncPanelToViewport)
    }
    viewportListening = false
    if (panel) {
      panel.style.top = ''
      panel.style.height = ''
      panel.style.bottom = ''
    }
  }

  function showReadyPanel() {
    ready = true
    opening = false
    if (readyTimer !== undefined) window.clearTimeout(readyTimer)
    readyTimer = undefined
    if (listening) window.removeEventListener('message', onReadyMessage)
    listening = false
    if (pendingPrefill) {
      sendToGuide('prefill', pendingPrefill)
      pendingPrefill = null
    }
    emit('ready')
    if (closeWhileOpening) {
      closeWhileOpening = false
      launcher.disabled = false
      launcher.textContent = launcher.dataset.label || 'Ask Torchiko'
      launcher.setAttribute('aria-label', launcher.textContent + ', opens venue guide')
      launcher.removeAttribute('aria-busy')
      return
    }
    launcher.hidden = true
    launcher.disabled = false
    launcher.removeAttribute('aria-busy')
    launcher.setAttribute('aria-expanded', 'true')
    panel.hidden = false
    updateDialogMode()
    closeButton.focus()
    sendToGuide('open')
    emit('open')
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
    frame.style.backgroundColor = widgetPresentation ? widgetPresentation.background : '#fff'
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
    if (failed) return
    closeWhileOpening = false
    if (!host || host.hidden) {
      pendingOpen = true
      return
    }
    if (ready) {
      if (!panel.hidden) return
      launcher.hidden = true
      launcher.setAttribute('aria-expanded', 'true')
      panel.hidden = false
      updateDialogMode()
      closeButton.focus()
      sendToGuide('open')
      emit('open')
      return
    }
    if (opening) return

    opening = true
    launcher.disabled = true
    launcher.textContent = 'Opening ' + (launcher.dataset.label || 'Ask Torchiko') + '…'
    launcher.setAttribute('aria-label', launcher.textContent + ', opening venue guide')
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

  if (!window.Torchiko) {
    window.Torchiko = {
      version: BRIDGE_VERSION,
      open: function (options) {
        applyPrefill(options)
        if (venueSlug) openPanel()
      },
      close: closePanel,
      on: function (event, listener) {
        if (!Object.prototype.hasOwnProperty.call(subscribers, event) || typeof listener !== 'function') {
          return function () {}
        }
        subscribers[event].push(listener)
        return function () {
          subscribers[event] = subscribers[event].filter(function (candidate) { return candidate !== listener })
        }
      },
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
      launcher.dataset.label = 'Ask Torchiko'
      launcher.setAttribute('aria-controls', 'pathfinder-widget-panel')
      launcher.setAttribute('aria-expanded', 'false')
      launcher.setAttribute('aria-label', 'Ask Torchiko, opens venue guide')
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

  script.dataset.torchikoMounted = 'true'
  if (document.readyState === 'loading' || !document.body) {
    inlineDomReadyListening = true
    document.addEventListener('DOMContentLoaded', startInlineMounting, { once: true })
  } else {
    startInlineMounting()
  }
  if (!venueSlug) {
    script.dataset.pathfinderMounted = 'true'
    return
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
