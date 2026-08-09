const CACHE_PREFIX = 'pathfinder-offline-'
const CACHE_NAME = `${CACHE_PREFIX}v2`
const OFFLINE_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .open(CACHE_NAME)
        .then((cache) =>
          cache.add(new Request(new URL(OFFLINE_URL, self.location.origin), { cache: 'reload' })),
        ),
      self.skipWaiting(),
    ]),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((cacheName) => cacheName.startsWith(CACHE_PREFIX) && cacheName !== CACHE_NAME)
            .map((cacheName) => caches.delete(cacheName)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const requestUrl = new URL(request.url)

  if (
    request.mode !== 'navigate' ||
    request.method !== 'GET' ||
    requestUrl.origin !== self.location.origin
  ) {
    return
  }

  event.respondWith(
    fetch(request).catch(async () => {
      try {
        const cache = await caches.open(CACHE_NAME)
        const fallback = await cache.match(new Request(new URL(OFFLINE_URL, self.location.origin)))
        return fallback ?? Response.error()
      } catch {
        return Response.error()
      }
    }),
  )
})
