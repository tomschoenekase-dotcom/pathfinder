#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const [baselinePath, patchedPath] = process.argv.slice(2)
if (!baselinePath || !patchedPath) {
  process.stderr.write(
    'Usage: node scripts/compare-visitor-first-text-benchmark.mjs BASELINE.json PATCHED.json\n',
  )
  process.exit(2)
}

const readSamples = (path) => {
  const payload = JSON.parse(readFileSync(path, 'utf8'))
  if (payload.schema !== 'torchiko-first-text-benchmark/v1' || !Array.isArray(payload.samples)) {
    throw new Error(`Unsupported benchmark payload: ${path}`)
  }
  if (payload.samples.length !== 24) throw new Error(`Expected 24 samples: ${path}`)
  for (const delay of [0, 80]) {
    const samples = payload.samples.filter((sample) => sample.adjacentDelayMs === delay)
    if (samples.length !== 12) throw new Error(`Expected 12 samples at ${delay} ms: ${path}`)
    if (new Set(samples.map((sample) => sample.iteration)).size !== 12) {
      throw new Error(`Duplicate iteration at ${delay} ms: ${path}`)
    }
    if (samples.some((sample) => !Number.isFinite(sample.firstVisibleMs))) {
      throw new Error(`Missing first visible text at ${delay} ms: ${path}`)
    }
  }
  return payload.samples
}

const baseline = readSamples(baselinePath)
const patched = readSamples(patchedPath)
const unique = (samples, key) => [...new Set(samples.map((sample) => sample[key]))]
for (const key of ['reply', 'providerInputSha256']) {
  const values = unique([...baseline, ...patched], key)
  if (values.length !== 1 || values[0] == null) {
    throw new Error(`${key} changed across benchmark revisions or iterations`)
  }
}
if (baseline.some((sample) => sample.adjacentReadCount !== 1)) {
  throw new Error('Baseline did not make exactly one adjacent read per turn')
}
if (patched.some((sample) => sample.adjacentReadCount !== 0)) {
  throw new Error('Patched revision made an adjacent read on a first turn')
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return (sorted[5] + sorted[6]) / 2
}
const p90 = (values) => [...values].sort((a, b) => a - b)[10]
const round = (value) => Math.round(value * 1000) / 1000
const summarize = (samples, delay) => {
  const selected = samples.filter((sample) => sample.adjacentDelayMs === delay)
  const phases = [
    'claimStartedMs',
    'adjacentReadStartedMs',
    'adjacentReadFinishedMs',
    'embeddingProviderStartedMs',
    'placeRetrievalStartedMs',
    'answerProviderStartedMs',
    'firstVisibleMs',
  ]
  const timeline = Object.fromEntries(
    phases.map((phase) => {
      const values = selected.map((sample) => sample[phase]).filter(Number.isFinite)
      return [
        phase,
        values.length === selected.length
          ? { median: round(median(values)), p90: round(p90(values)) }
          : null,
      ]
    }),
  )
  const telemetry = Object.fromEntries(
    [
      'turnSetupMs',
      'preEmbeddingMs',
      'embeddingMs',
      'retrievalMs',
      'modelMs',
      'requestFirstTextMs',
    ].map((phase) => {
      const values = selected.map((sample) => sample.telemetry?.[phase]).filter(Number.isFinite)
      return [phase, values.length === selected.length ? round(median(values)) : null]
    }),
  )
  return { timeline, telemetry }
}
const scenarios = [0, 80].map((adjacentDelayMs) => {
  const before = summarize(baseline, adjacentDelayMs)
  const after = summarize(patched, adjacentDelayMs)
  return {
    adjacentDelayMs,
    samplesPerRevision: 12,
    baseline: before,
    patched: after,
    firstVisibleMedianReductionMs: round(
      before.timeline.firstVisibleMs.median - after.timeline.firstVisibleMs.median,
    ),
  }
})
process.stdout.write(
  `${JSON.stringify(
    {
      schema: 'torchiko-first-text-benchmark-comparison/v1',
      fixtureEquivalent: true,
      baselineAdjacentReadsPerTurn: 1,
      patchedAdjacentReadsPerTurn: 0,
      scenarios,
    },
    null,
    2,
  )}\n`,
)
