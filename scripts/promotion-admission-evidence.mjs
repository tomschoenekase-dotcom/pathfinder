import { readFile, appendFile } from 'node:fs/promises'
import {
  MAX_EVIDENCE_BYTES,
  MAX_LOG_BYTES,
  parseBoundedEvidence,
  parseTrustedAdmissionLog,
  PromotionAdmissionError,
  selectTrustedRun,
  verifyPromotionAdmissionEvidence,
} from './lib/promotion-admission-evidence.mjs'

async function readEvidence(path) {
  if (!path) throw new PromotionAdmissionError('missing-evidence-path')
  const bytes = await readFile(path)
  if (bytes.length > MAX_EVIDENCE_BYTES) throw new PromotionAdmissionError('invalid-evidence-size')
  return parseBoundedEvidence(bytes.toString('utf8'))
}

async function readLog(path) {
  if (!path) throw new PromotionAdmissionError('missing-admission-log')
  const bytes = await readFile(path)
  if (bytes.length > MAX_LOG_BYTES) throw new PromotionAdmissionError('invalid-admission-log-size')
  return parseTrustedAdmissionLog(bytes.toString('utf8'))
}

function options(args) {
  if (args.length % 2 !== 0) throw new PromotionAdmissionError('invalid-options')
  const values = new Map()
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || values.has(args[i]))
      throw new PromotionAdmissionError('invalid-options')
    values.set(args[i], args[i + 1])
  }
  return values
}

try {
  const [mode, ...rest] = process.argv.slice(2)
  const values = options(rest)
  const repository = values.get('--repository')
  const runs = await readEvidence(values.get('--runs'))
  const workflow = await readEvidence(values.get('--workflow'))
  const now = Date.now()
  if (mode === 'select' && values.size === 4 && values.has('--output')) {
    const run = selectTrustedRun(runs, workflow, { repository, now })
    await appendFile(values.get('--output'), `run_id=${run.id}\n`, { encoding: 'utf8' })
  } else if (
    mode === 'verify' &&
    values.size === 5 &&
    values.has('--log') &&
    values.has('--release-sha')
  ) {
    const result = verifyPromotionAdmissionEvidence({
      runs,
      workflow,
      proof: await readLog(values.get('--log')),
      releaseSha: values.get('--release-sha'),
      repository,
      now,
    })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } else {
    throw new PromotionAdmissionError('invalid-options')
  }
} catch (error) {
  const code = error instanceof PromotionAdmissionError ? error.code : 'promotion-admission-failed'
  process.stderr.write(`Promotion admission failed: ${code}\n`)
  process.exitCode = 1
}
