import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareReleaseEvidencePayload } from './lib/release-evidence-payload.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

function value(flag) {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

function resolveArtifact(candidate, label) {
  if (!candidate) throw new Error(`Missing ${label}.`)
  const absolute = path.resolve(repositoryRoot, candidate)
  const relative = path.relative(repositoryRoot, absolute)
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a repository-contained file.`)
  }
  return absolute
}

const assessmentPath = resolveArtifact(value('--assessment'), '--assessment')
const handoffArgument = value('--handoff')
const handoffPath = handoffArgument ? resolveArtifact(handoffArgument, '--handoff') : null
const assessmentBytes = await readFile(assessmentPath)
const handoffBytes = handoffPath ? await readFile(handoffPath) : null

const payload = prepareReleaseEvidencePayload({
  assessment: JSON.parse(assessmentBytes.toString('utf8')),
  assessmentBytes,
  assessmentPath,
  handoff: handoffBytes ? JSON.parse(handoffBytes.toString('utf8')) : null,
  handoffBytes,
  handoffPath,
  repositoryRoot,
  sourceReference: value('--source-reference'),
})

process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)

