#!/usr/bin/env node
import path from 'node:path'
import { createOutreachWorkflow, exactOutreachReview } from './lib/torchiko-outreach-workflow.mjs'
import { createLocalCrmClient, readTorchikoWritingGuide } from './lib/torchiko-crm-client.mjs'
import { compileNativeOutreachResult, codexOutreachTextSchema } from './lib/torchiko-outreach-result.mjs'
import { loadOutreachProfile } from './lib/torchiko-outreach-discovery.mjs'
import { createOutreachRetryArtifacts } from './lib/torchiko-outreach-retry.mjs'

const root = path.resolve(import.meta.dirname, '..')
const emit = value => console.log(JSON.stringify(value, null, 2))
const usage = () => emit({
  commands: ['doctor', 'inspect "Venue name"', 'prepare "Venue name"', 'inspect --venue-id ID',
    'prepare --venue-id ID', 'review --venue-id ID', 'import --stdin', 'compile --stdin', 'retain --stdin',
    'recover --task-id TASK', 'read-result --task-id TASK --sha256 HASH', 'retry --task-id TASK --sha256 HASH', 'schema'],
  notes: 'Preparation returns a native writer task. The active Codex model writes original text from it; this CLI is not a writer or sender. Compile takes {task,candidate,modelIdentity} and automatically retains the exact result. Import also retains before its first network call. Recover locates exact request bodies, not CRM state. Retry that same retained result after an unknown response.',
  endpoint: 'Existing opt-in local no-send operator endpoint; not authenticated agent access', SEND_AUTHORIZED: false,
})
async function stdinJson() {
  const chunks = []; let bytes = 0
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 250000) throw new Error('Bounded input exceeds 250,000 bytes'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
async function main() {
  const [action, ...args] = process.argv.slice(2)
  const profile = await loadOutreachProfile(root)
  const workflow = createOutreachWorkflow({ readGuide: () => readTorchikoWritingGuide(profile.vault) })
  const retry = createOutreachRetryArtifacts(root)
  if (!action || action === 'help') return usage()
  if (action === 'schema') return emit(codexOutreachTextSchema)
  if (action === 'doctor') {
    const checks = await Promise.allSettled([createLocalCrmClient().status(), readTorchikoWritingGuide(profile.vault)])
    return emit({ schema: 'torchiko.outreach-discovery/1', projectRoot: root,
      local: checks[0].status === 'fulfilled' ? checks[0].value : { available: false, error: checks[0].reason.message },
      writingReference: checks[1].status === 'fulfilled' ? { sourceRef: checks[1].value.sourceRef, sha256: checks[1].value.sha256 }
        : { available: false, error: checks[1].reason.message },
      nativeAgentAccess: 'NOT_PROVEN_BY_LOCAL_DIAGNOSTIC',
      sender: 'tomschoenekase@torchiko.com', mailboxAuthentication: 'NOT_PROVEN_BY_CODEX_LOGIN', SEND_AUTHORIZED: false })
  }
  if (action === 'recover') {
    if (args.length !== 2 || args[0] !== '--task-id') throw new Error('Select one exact native --task-id.')
    return emit(await retry.locate(args[1]))
  }
  if (['retry', 'read-result'].includes(action)) {
    if (args.length !== 4 || args[0] !== '--task-id' || args[2] !== '--sha256') throw new Error('Select one exact --task-id and retained --sha256.')
    const result = await retry.read(args[1], args[3])
    return emit(action === 'retry' ? await workflow.importResult(result) : result)
  }
  if (['import', 'compile', 'retain'].includes(action)) {
    if (args.length !== 1 || args[0] !== '--stdin') throw new Error('Use the exact bounded JSON input through --stdin.')
    const input = await stdinJson()
    const result = action === 'compile' ? compileNativeOutreachResult(input.task, input.candidate, input.modelIdentity) : input
    const artifact = await retry.retain(result)
    return emit(action === 'import' ? await workflow.importResult(result) : action === 'retain' ? artifact : result)
  }
  const selection = args[0] === '--venue-id' && args.length === 2 ? { venueId: args[1] }
    : args.length === 1 ? { name: args[0] } : null
  if (!selection) throw new Error('Select exactly one venue name or --venue-id ID.')
  if (action === 'inspect') return emit(await workflow.inspect(selection))
  if (action === 'prepare') return emit(await workflow.prepare(selection))
  if (action === 'review') return emit(exactOutreachReview((await workflow.inspect(selection)).view))
  throw new Error('Unsupported action. This tool has no approval, send, delivery-enablement or mailbox mutation command.')
}
main().catch(error => { emit({ error: error.code ?? 'OUTREACH_HELD', message: error.message,
  details: error.details ?? null, SEND_AUTHORIZED: false }); process.exitCode = 1 })
