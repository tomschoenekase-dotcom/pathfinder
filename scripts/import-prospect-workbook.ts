import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

import { parseProspectStagingPackage } from '../packages/contracts/src/prospect-staging-package-node'
// The converter is plain ESM so Node's script-test runner can adversarially test it without a DB.
// @ts-expect-error Local ESM script intentionally has no declaration file.
import { buildProspectStagingPackage } from './prospect-workbook-package.mjs'
// @ts-expect-error Local ESM safety boundary is independently tested with Node.
import {
  assertLocalProspectImportEnvironment,
  assertSourceOnlyWorkbookPackage,
} from './prospect-import-environment.mjs'

type Options = {
  workbook?: string
  package?: string
  output?: string
  receipt?: string
  sheets: string[]
  actor?: string
  admit: boolean
  commit: boolean
}

function usage(): never {
  throw new Error(
    'Usage: tsx scripts/import-prospect-workbook.ts (--workbook FILE [--sheet NAME ...] [--output PACKAGE.json] | --package PACKAGE.json) [--receipt FILE] [--admit|--commit] --actor ACTOR_ID',
  )
}

function parseArgs(argv: string[]): Options {
  const options: Options = { sheets: [], admit: false, commit: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--workbook') options.workbook = argv[++index]
    else if (argument === '--package') options.package = argv[++index]
    else if (argument === '--output') options.output = argv[++index]
    else if (argument === '--receipt') options.receipt = argv[++index]
    else if (argument === '--sheet') options.sheets.push(argv[++index] ?? usage())
    else if (argument === '--actor') options.actor = argv[++index]
    else if (argument === '--admit') options.admit = true
    else if (argument === '--commit') options.commit = true
    else usage()
  }
  if (Boolean(options.workbook) === Boolean(options.package)) usage()
  if (options.admit && options.commit) usage()
  if (options.package && (options.output || options.sheets.length)) usage()
  if ((options.admit || options.commit) && !options.actor) usage()
  if ((options.admit || options.commit) && options.workbook && !options.output) {
    throw new Error(
      'Database writes from a workbook require --output to retain the exact admitted package',
    )
  }
  return options
}

async function loadPackage(options: Options): Promise<unknown> {
  if (options.package) return JSON.parse(await readFile(path.resolve(options.package), 'utf8'))
  const workbookPath = path.resolve(options.workbook!)
  const packageValue = buildProspectStagingPackage({
    workbookBuffer: await readFile(workbookPath),
    workbookName: workbookPath,
    sheets: options.sheets,
    runId: `local-import:${path.basename(workbookPath)}`,
  })
  return packageValue
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  // Validate before importing the DB module, reading environment files, or writing anything.
  const databaseTarget =
    options.admit || options.commit ? assertLocalProspectImportEnvironment(process.env) : undefined
  const packageValue = await loadPackage(options)
  const parsed = parseProspectStagingPackage(packageValue)
  if (databaseTarget) assertSourceOnlyWorkbookPackage(parsed.package)
  const bytes = `${JSON.stringify(parsed.package, null, 2)}\n`
  if (parseProspectStagingPackage(JSON.parse(bytes)).packageHash !== parsed.packageHash) {
    throw new Error('Package JSON round-trip changed its admitted identity')
  }
  if (options.output) await writeFile(path.resolve(options.output), bytes, { flag: 'wx' })
  const packageFileBytes = options.package
    ? await readFile(path.resolve(options.package))
    : Buffer.from(bytes)
  const summary = {
    mode: options.commit ? 'commit' : options.admit ? 'admit' : 'dry-run',
    packageHash: parsed.packageHash,
    sourceWorkbook: parsed.package.sourceWorkbook,
    counts: parsed.package.counts,
    packageFileSha256: createHash('sha256').update(packageFileBytes).digest('hex'),
    sourceRows: parsed.package.sourceWorkbook.rowCount,
    packageRecords: parsed.package.records.length,
    contactSourceRows: new Set(
      parsed.package.records
        .filter((record) => record.kind === 'CONTACT')
        .map((record) => record.parentExternalId),
    ).size,
    territoryCount: new Set(
      parsed.package.records
        .filter((record) => record.kind === 'PROSPECT')
        .map((record) => record.normalized.territory),
    ).size,
    directWebsites: parsed.package.records.filter(
      (record) => record.kind === 'PROSPECT' && record.normalized.website,
    ).length,
    databaseTarget,
  }
  async function report(value: unknown) {
    const result = `${JSON.stringify(value, null, 2)}\n`
    if (options.receipt) await writeFile(path.resolve(options.receipt), result, { flag: 'wx' })
    process.stdout.write(result)
  }
  if (!options.admit && !options.commit) {
    await report(summary)
    return
  }
  const { db } = await import('../packages/db/src/client')
  try {
    const { admitProspectStagingPackageAction } =
      await import('../packages/db/src/helpers/prospect-package-admission-actions')
    const {
      approveProspectStagingPackageCommitAction,
      claimProspectStagingPackageRecordsAction,
      commitProspectStagingPackageClaimAction,
      finalizeProspectStagingPackageAction,
    } = await import('../packages/db/src/helpers/prospect-package-commit-actions')
    const actor = { type: 'HUMAN' as const, id: options.actor!, role: 'PLATFORM_ADMIN' as const }
    const admitted = await admitProspectStagingPackageAction({ package: parsed.package, actor })
    if (!options.commit) {
      await report({ ...summary, admitted })
      return
    }
    await approveProspectStagingPackageCommitAction({ importId: admitted.importId, actor })
    const workerId = `local-workbook-import:${process.pid}`
    let batches = 0
    let processed = 0
    let failed = 0
    while (true) {
      const claim = await claimProspectStagingPackageRecordsAction({
        importId: admitted.importId,
        workerId,
        limit: 250,
      })
      if (!claim) break
      const result = await commitProspectStagingPackageClaimAction({
        claimToken: claim.claimToken,
        workerId,
      })
      batches += 1
      processed += result.processed
      failed += result.failed
      process.stdout.write(
        `${JSON.stringify({ batch: batches, kind: claim.recordKind, processed, failed })}\n`,
      )
    }
    const finalized = await finalizeProspectStagingPackageAction({ importId: admitted.importId })
    await report({ ...summary, admitted, batches, processed, failed, finalized })
    if (!finalized.finalized || finalized.status !== 'COMPLETE' || failed) process.exitCode = 1
  } finally {
    await db.$disconnect()
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown prospect import failure'
  process.stderr.write(
    `${message.replace(/postgres(?:ql)?:\/\/[^\s]+/gu, '[redacted database URL]')}\n`,
  )
  process.exitCode = 1
})
