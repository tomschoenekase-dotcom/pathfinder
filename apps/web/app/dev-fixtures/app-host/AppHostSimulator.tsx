'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

// Invented attractions matching the `conversation=pass` guide fixture's public place IDs.
const ATTRACTIONS = [
  { id: 'fixture-pass-aquarium', name: 'Harbor Aquarium', note: 'Timed entry · 9 AM–6 PM' },
  { id: 'fixture-pass-science', name: 'Riverfront Science Center', note: 'Walk-in · 10 AM–5 PM' },
  {
    id: 'fixture-pass-skyline',
    name: 'Skyline Observation Deck',
    note: 'Sunset slots · 9 AM–10 PM',
  },
] as const

const GUIDE_URL =
  '/dev-fixtures/visitor-chat?presentation=webview&appHeader=none&mode=classic&conversation=pass&placeAction=See%20in%20app'

type Screen = { kind: 'home' } | { kind: 'ask' } | { kind: 'attraction'; id: string; name: string }
type GuideWindow = Window & {
  ReactNativeWebView?: { postMessage: (message: string) => void }
  Function: FunctionConstructor
}

/**
 * Plays the part of a partner's native app: it injects the same `ReactNativeWebView` channel that
 * react-native-webview provides, validates guide messages like a real host, and injects `prefill`
 * by evaluating a script inside the guide document, as `injectJavaScript` would.
 */
export function AppHostSimulator() {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [screen, setScreen] = useState<Screen>({ kind: 'home' })
  const [guideReady, setGuideReady] = useState(false)
  const [log, setLog] = useState<string[]>([])

  const receive = useCallback((serialized: string) => {
    let message: { source?: unknown; v?: unknown; type?: unknown; payload?: unknown }
    try {
      message = JSON.parse(serialized) as typeof message
    } catch {
      return
    }
    if (message.source !== 'torchiko' || message.v !== 1 || typeof message.type !== 'string') return
    setLog((current) => [...current.slice(-4), message.type as string])
    if (message.type === 'ready') setGuideReady(true)
    if (message.type === 'close-requested') setScreen({ kind: 'home' })
    const payload = message.payload as { placeId?: unknown; name?: unknown } | null
    if (message.type === 'place-action' && typeof payload?.placeId === 'string') {
      const known = ATTRACTIONS.find((attraction) => attraction.id === payload.placeId)
      setScreen({
        kind: 'attraction',
        id: payload.placeId,
        name: known?.name ?? (typeof payload.name === 'string' ? payload.name : 'Attraction'),
      })
    }
  }, [])

  const connectGuide = useCallback(() => {
    const guide = frameRef.current?.contentWindow as GuideWindow | null | undefined
    if (!guide) return
    guide.ReactNativeWebView = { postMessage: receive }
    // The guide may have announced itself before this channel existed; it is loaded by now.
    setGuideReady(true)
  }, [receive])

  // A server-rendered frame can finish loading before hydration attaches `onLoad`.
  useEffect(() => {
    if (frameRef.current?.contentDocument?.readyState === 'complete') connectGuide()
  }, [connectGuide])

  const askAbout = (attraction: { id: string; name: string }) => {
    setScreen({ kind: 'ask' })
    const guide = frameRef.current?.contentWindow as GuideWindow | null | undefined
    if (!guide || !guideReady) return
    const envelope = {
      source: 'torchiko',
      v: 1,
      type: 'prefill',
      payload: {
        place: attraction.id,
        ask: `What should we know before visiting ${attraction.name}?`,
      },
    }
    // Evaluate inside the guide's own realm so the event source is the guide window, exactly like
    // a native script injection. Development-only simulator code.
    const inject = new guide.Function(
      'envelope',
      'window.postMessage(envelope, window.location.origin)',
    ) as (value: typeof envelope) => void
    inject(envelope)
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-slate-200 p-4">
      <div
        data-simulator="app-host"
        data-guide-ready={guideReady}
        className="flex h-[min(820px,calc(100dvh-2rem))] w-full max-w-[400px] flex-col overflow-hidden rounded-[2.5rem] border-[10px] border-slate-900 bg-white shadow-2xl"
      >
        <header className="flex min-h-14 items-center justify-between bg-indigo-700 px-4 text-white">
          <h1 className="text-base font-bold">
            {screen.kind === 'ask'
              ? 'Ask the guide'
              : screen.kind === 'attraction'
                ? screen.name
                : 'Your pass'}
          </h1>
          {screen.kind !== 'home' ? (
            <button
              type="button"
              className="min-h-11 rounded-full px-3 text-sm font-semibold"
              onClick={() => setScreen({ kind: 'home' })}
            >
              Close
            </button>
          ) : null}
        </header>

        <div className="relative flex-1">
          {/* The guide stays mounted while other native screens are shown, as partners must. */}
          <iframe
            ref={frameRef}
            title="Torchiko guide"
            src={GUIDE_URL}
            onLoad={connectGuide}
            className={`absolute inset-0 h-full w-full border-0 ${screen.kind === 'ask' ? '' : 'invisible'}`}
            aria-hidden={screen.kind !== 'ask'}
            tabIndex={screen.kind === 'ask' ? 0 : -1}
          />
          {screen.kind === 'home' ? (
            <section
              className="absolute inset-0 overflow-y-auto bg-white p-4"
              aria-label="Attractions"
            >
              <p className="mb-3 text-sm text-slate-600">Three attractions included in your pass</p>
              <ul className="space-y-3">
                {ATTRACTIONS.map((attraction) => (
                  <li key={attraction.id} className="rounded-2xl border border-slate-200 p-4">
                    <p className="font-semibold text-slate-900">{attraction.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">{attraction.note}</p>
                    <button
                      type="button"
                      className="mt-3 min-h-10 rounded-full bg-indigo-700 px-4 text-sm font-semibold text-white"
                      onClick={() => askAbout(attraction)}
                    >
                      Ask the guide about {attraction.name}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {screen.kind === 'attraction' ? (
            <section className="absolute inset-0 bg-white p-5" aria-label="Attraction screen">
              <p className="text-sm font-semibold uppercase tracking-wide text-indigo-700">
                Native app screen
              </p>
              <p className="mt-2 text-2xl font-bold text-slate-900">{screen.name}</p>
              <p className="mt-2 text-sm text-slate-600">
                Opened from the guide with place ID <code>{screen.id}</code>. A real app shows this
                attraction&apos;s ticket, map pin or booking page here.
              </p>
              <button
                type="button"
                className="mt-5 min-h-11 w-full rounded-full bg-indigo-700 px-4 text-sm font-semibold text-white"
                onClick={() => askAbout(screen)}
              >
                Ask the guide about this
              </button>
            </section>
          ) : null}
        </div>

        <nav className="grid grid-cols-2 border-t border-slate-200" aria-label="App tabs">
          {(['home', 'ask'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={screen.kind === tab}
              className={`min-h-14 text-sm font-semibold ${screen.kind === tab ? 'text-indigo-700' : 'text-slate-500'}`}
              onClick={() => setScreen({ kind: tab })}
            >
              {tab === 'home' ? 'Pass' : 'Ask'}
            </button>
          ))}
        </nav>
        <p className="sr-only" aria-live="polite" data-host-log={log.join(',')}>
          {log.at(-1) ? `Guide message: ${log.at(-1)}` : ''}
        </p>
      </div>
    </main>
  )
}
