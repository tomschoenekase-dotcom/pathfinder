'use client'

import { useEffect, useMemo, useState } from 'react'

import {
  CHARACTER_PRESENTATION_CONTEXTS,
  CHARACTER_STATES,
  resolveCharacterState,
  type CharacterAssetManifest,
  type CharacterDefinition,
  type CharacterPresentationContext,
  type CharacterState,
} from '@pathfinder/contracts/character-system'
import {
  CharacterPresence,
  type CharacterAssetError,
  type CharacterMotion,
  type CharacterSize,
} from '@pathfinder/ui/character'

const backgrounds = {
  mist: 'border-slate-200 bg-slate-100',
  ink: 'border-slate-800 bg-slate-950',
  warm: 'border-amber-200 bg-amber-50',
  transparent:
    'border-slate-300 bg-[linear-gradient(45deg,#e2e8f0_25%,transparent_25%),linear-gradient(-45deg,#e2e8f0_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#e2e8f0_75%),linear-gradient(-45deg,transparent_75%,#e2e8f0_75%)] bg-[length:24px_24px] bg-[position:0_0,0_12px,12px_-12px,-12px_0px]',
} as const

const viewportWidths = {
  mobile: 'max-w-[22rem]',
  tablet: 'max-w-[40rem]',
  desktop: 'max-w-[64rem]',
} as const

type Background = keyof typeof backgrounds
type Viewport = keyof typeof viewportWidths

export type CharacterLabInitialState = {
  state: CharacterState
  context: CharacterPresentationContext
  motion: CharacterMotion
  background: Background
  viewport: Viewport
  size: CharacterSize
  intensity: number
  lookAtX: number
  lookAtY: number
}

export type CharacterLabProps = {
  definition: CharacterDefinition
  manifest: CharacterAssetManifest
  initial: CharacterLabInitialState
}

function labelForState(state: CharacterState) {
  return state.replace(/([A-Z])/g, ' $1').replace(/^./, (value) => value.toUpperCase())
}

export function CharacterLab({ definition, manifest, initial }: CharacterLabProps) {
  const [state, setState] = useState(initial.state)
  const [context, setContext] = useState(initial.context)
  const [motion, setMotion] = useState(initial.motion)
  const [background, setBackground] = useState(initial.background)
  const [viewport, setViewport] = useState(initial.viewport)
  const [size, setSize] = useState(initial.size)
  const [intensity, setIntensity] = useState(initial.intensity)
  const [lookAtX, setLookAtX] = useState(initial.lookAtX)
  const [lookAtY, setLookAtY] = useState(initial.lookAtY)
  const [paused, setPaused] = useState(false)
  const [simulateFailure, setSimulateFailure] = useState(false)
  const [replayKey, setReplayKey] = useState(0)
  const [assetErrors, setAssetErrors] = useState<CharacterAssetError[]>([])

  const previewManifest = useMemo<CharacterAssetManifest>(
    () =>
      simulateFailure
        ? {
            ...manifest,
            publicBasePath: '/characters/tochi/simulated-missing-pack',
          }
        : manifest,
    [manifest, simulateFailure],
  )
  const resolution = resolveCharacterState(manifest, state)
  const totalBytes = manifest.assets.reduce((total, asset) => total + asset.bytes, 0)

  useEffect(() => {
    const query = new URLSearchParams()
    query.set('state', state)
    query.set('context', context)
    query.set('motion', motion)
    query.set('background', background)
    query.set('viewport', viewport)
    query.set('size', size)
    query.set('intensity', intensity.toFixed(2))
    query.set('lookAtX', lookAtX.toFixed(2))
    query.set('lookAtY', lookAtY.toFixed(2))
    window.history.replaceState(null, '', `${window.location.pathname}?${query.toString()}`)
  }, [background, context, intensity, lookAtX, lookAtY, motion, size, state, viewport])

  return (
    <div className="space-y-6">
      <header className="border-b border-slate-200 pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">
          Platform admin · Character registry
        </p>
        <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Character Lab</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Inspect semantic states, motion behavior, viewport fit, and asset failure fallbacks
              against the trusted local registry.
            </p>
          </div>
          <span className="inline-flex w-fit rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
            Temporary development assets
          </span>
        </div>
      </header>

      <section className="grid gap-6 xl:grid-cols-[minmax(18rem,0.72fr)_minmax(0,1.28fr)]">
        <div className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <h2 className="font-semibold text-slate-950">Pack and environment</h2>
            <p className="mt-1 text-xs text-slate-500">
              Registry values are read-only. Controls affect this preview only.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
            <label className="text-sm font-medium text-slate-800">
              Character
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-sm"
                value={definition.id}
                disabled
              >
                <option value={definition.id}>{definition.displayName}</option>
              </select>
            </label>
            <label className="text-sm font-medium text-slate-800">
              Asset pack
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 text-sm"
                value={manifest.assetPackId}
                disabled
              >
                <option value={manifest.assetPackId}>
                  {manifest.assetPackId} · {manifest.version}
                </option>
              </select>
            </label>
            <label className="text-sm font-medium text-slate-800">
              Context
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                value={context}
                onChange={(event) => setContext(event.target.value as CharacterPresentationContext)}
              >
                {CHARACTER_PRESENTATION_CONTEXTS.map((value) => (
                  <option
                    key={value}
                    value={value}
                    disabled={!manifest.supportedContexts.includes(value)}
                  >
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-slate-800">
              Viewport
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                value={viewport}
                onChange={(event) => setViewport(event.target.value as Viewport)}
              >
                {Object.keys(viewportWidths).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-slate-800">
              Background
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                value={background}
                onChange={(event) => setBackground(event.target.value as Background)}
              >
                {Object.keys(backgrounds).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-slate-800">
              Motion
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                value={motion}
                onChange={(event) => setMotion(event.target.value as CharacterMotion)}
              >
                <option value="system">System preference</option>
                <option value="reduced">Reduced / static</option>
                <option value="full">Full preview</option>
              </select>
            </label>
            <label className="text-sm font-medium text-slate-800">
              Presentation
              <select
                className="mt-1 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
                value={size}
                onChange={(event) => setSize(event.target.value as CharacterSize)}
              >
                <option value="compact">Compact text chat</option>
                <option value="standard">Standard portal presence</option>
                <option value="stage">Larger future voice stage</option>
              </select>
            </label>
          </div>

          <div className="space-y-4 border-t border-slate-200 pt-4">
            <label
              htmlFor="character-lab-intensity"
              className="block text-sm font-medium text-slate-800"
            >
              Intensity <output className="float-right tabular-nums">{intensity.toFixed(2)}</output>
              <input
                id="character-lab-intensity"
                className="mt-2 block w-full accent-sky-700"
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={intensity}
                onChange={(event) => setIntensity(Number(event.target.value))}
              />
            </label>
            <label
              htmlFor="character-lab-look-x"
              className="block text-sm font-medium text-slate-800"
            >
              Look left / right{' '}
              <output className="float-right tabular-nums">{lookAtX.toFixed(2)}</output>
              <input
                id="character-lab-look-x"
                className="mt-2 block w-full accent-sky-700"
                type="range"
                min="-1"
                max="1"
                step="0.1"
                value={lookAtX}
                onChange={(event) => setLookAtX(Number(event.target.value))}
              />
            </label>
            <label
              htmlFor="character-lab-look-y"
              className="block text-sm font-medium text-slate-800"
            >
              Look up / down{' '}
              <output className="float-right tabular-nums">{lookAtY.toFixed(2)}</output>
              <input
                id="character-lab-look-y"
                className="mt-2 block w-full accent-sky-700"
                type="range"
                min="-1"
                max="1"
                step="0.1"
                value={lookAtY}
                onChange={(event) => setLookAtY(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              className="min-h-11 rounded-xl border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              onClick={() => setPaused((value) => !value)}
              aria-pressed={paused}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              className="min-h-11 rounded-xl bg-slate-950 px-3 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
              onClick={() => setReplayKey((value) => value + 1)}
            >
              Replay state
            </button>
            <button
              type="button"
              className="col-span-2 min-h-11 rounded-xl border border-rose-300 bg-rose-50 px-3 text-sm font-semibold text-rose-900 hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
              onClick={() => {
                setAssetErrors([])
                setSimulateFailure((value) => !value)
                setReplayKey((value) => value + 1)
              }}
              aria-pressed={simulateFailure}
            >
              {simulateFailure ? 'Restore verified assets' : 'Simulate asset failure'}
            </button>
          </div>
        </div>

        <div className="min-w-0 space-y-5">
          <section
            aria-label={`${definition.displayName} selection preview`}
            className={`mx-auto overflow-hidden rounded-3xl border shadow-sm ${backgrounds[background]} ${viewportWidths[viewport]}`}
          >
            <div
              className={`flex flex-col items-center justify-center p-6 sm:p-10 ${
                size === 'compact' ? 'min-h-56' : size === 'standard' ? 'min-h-80' : 'min-h-[30rem]'
              }`}
              data-character-presentation={size}
            >
              <CharacterPresence
                key={`${replayKey}:${simulateFailure}`}
                definition={definition}
                manifest={previewManifest}
                state={state}
                context={context}
                motion={paused ? 'reduced' : motion}
                intensity={intensity}
                lookAt={{ x: lookAtX, y: lookAtY }}
                size={size}
                onAssetError={(error) =>
                  setAssetErrors((current) =>
                    current.some(
                      (item) => item.code === error.code && item.assetId === error.assetId,
                    )
                      ? current
                      : [...current, error],
                  )
                }
              />
              <p
                className={`mt-4 text-sm font-semibold ${background === 'ink' ? 'text-white' : 'text-slate-900'}`}
              >
                {labelForState(state)}
              </p>
              <p
                className={`mt-1 text-xs ${background === 'ink' ? 'text-slate-400' : 'text-slate-500'}`}
              >
                Semantic state is always represented here as text; the character visual is
                decorative.
              </p>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-950">Semantic state matrix</h2>
            <p className="mt-1 text-xs text-slate-500">
              Every product surface sends one of these semantic intents to the same renderer.
            </p>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {CHARACTER_STATES.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setState(value)
                    setReplayKey((current) => current + 1)
                  }}
                  aria-pressed={state === value}
                  className={`min-h-11 rounded-xl border px-3 py-2 text-left text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
                    state === value
                      ? 'border-sky-600 bg-sky-50 text-sky-950'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {labelForState(value)}
                </button>
              ))}
            </div>
          </section>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold text-slate-950">Fallback diagnostics</h2>
          <dl className="mt-4 grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Requested</dt>
            <dd className="font-mono text-slate-900">{state}</dd>
            <dt className="text-slate-500">Resolution</dt>
            <dd className="font-mono text-slate-900">
              {resolution.kind === 'state' ? resolution.resolvedState : resolution.assetId}
            </dd>
            <dt className="text-slate-500">Source</dt>
            <dd className="font-mono text-slate-900">{resolution.source}</dd>
            <dt className="text-slate-500">Failure simulation</dt>
            <dd className="font-semibold text-slate-900">{simulateFailure ? 'On' : 'Off'}</dd>
          </dl>
          <div className="mt-4 rounded-xl bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-300">
            requested → manifest fallback → idle → pack static → Torchiko brand → no character
          </div>
          <div aria-live="polite" className="mt-4 text-xs text-slate-600">
            {assetErrors.length > 0
              ? `${assetErrors.length} asset fallback ${assetErrors.length === 1 ? 'event' : 'events'} observed: ${assetErrors.map((error) => error.code).join(', ')}`
              : 'No asset fallback events observed.'}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold text-slate-950">Manifest diagnostics</h2>
          <dl className="mt-4 grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-slate-500">Renderer</dt>
            <dd className="font-mono text-slate-900">{manifest.renderer}</dd>
            <dt className="text-slate-500">Art status</dt>
            <dd className="font-semibold text-amber-800">{manifest.artStatus}</dd>
            <dt className="text-slate-500">Publishable</dt>
            <dd className="font-semibold text-slate-900">{manifest.publishable ? 'Yes' : 'No'}</dd>
            <dt className="text-slate-500">Canvas</dt>
            <dd className="font-mono text-slate-900">
              {manifest.canvas.width} × {manifest.canvas.height}
            </dd>
            <dt className="text-slate-500">Pack bytes</dt>
            <dd className="font-mono text-slate-900">{totalBytes.toLocaleString()}</dd>
            <dt className="text-slate-500">Contexts</dt>
            <dd className="text-slate-900">{manifest.supportedContexts.join(', ')}</dd>
          </dl>
          <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
            This immutable pack is intentionally non-publishable. Final artwork must arrive as a new
            approved pack rather than changing these development files in place.
          </p>
        </div>
      </section>
    </div>
  )
}
