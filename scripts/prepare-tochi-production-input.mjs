import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')
const briefPath = path.join(
  repositoryRoot,
  'assets',
  'characters',
  'tochi',
  'production-brief-v1.json',
)

export function verifyReferenceBytes(brief, bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== brief.approvedReference.sha256)
    throw new Error(
      `Reference hash mismatch: expected ${brief.approvedReference.sha256}, received ${sha256}.`,
    )
  if (bytes.byteLength !== brief.approvedReference.byteLength)
    throw new Error(
      `Reference byte length mismatch: expected ${brief.approvedReference.byteLength}, received ${bytes.byteLength}.`,
    )
  return sha256
}

export async function prepareTochiProductionInput(referencePath) {
  if (!referencePath) throw new Error('Pass --reference with the approved reference-board path.')
  const [rawBrief, referenceBytes] = await Promise.all([
    readFile(briefPath, 'utf8'),
    readFile(path.resolve(referencePath)),
  ])
  const brief = JSON.parse(rawBrief)
  if (
    brief?.schemaVersion !== 1 ||
    brief?.characterId !== 'tochi' ||
    brief?.creation?.automaticGenerationAvailable !== false ||
    brief?.review?.humanApprovalRequired !== true ||
    brief?.review?.publishable !== false
  )
    throw new Error('The checked-in Tochi production brief is invalid or overclaims readiness.')
  const referenceSha256 = verifyReferenceBytes(brief, referenceBytes)
  return {
    status: 'ready-for-reference-conditioned-candidate-generation',
    briefPath,
    referencePath: path.resolve(referencePath),
    referenceSha256,
    capabilityRequirements: brief.creation.providerRequirements,
    limitations: {
      automaticGenerationAvailable: false,
      factoryIntake: brief.creation.factoryIntake,
      humanApprovalRequired: true,
      publishable: false,
    },
    brief,
  }
}

async function main() {
  const referenceIndex = process.argv.indexOf('--reference')
  const referencePath = referenceIndex >= 0 ? process.argv[referenceIndex + 1] : undefined
  const prepared = await prepareTochiProductionInput(referencePath)
  process.stdout.write(`${JSON.stringify(prepared, null, 2)}\n`)
}

if (path.resolve(process.argv[1] ?? '') === scriptPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
