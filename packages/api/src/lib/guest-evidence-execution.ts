import { createHash } from 'node:crypto'
import { GuestEvidenceExecutionSchema, type GuestEvidenceExecution } from '@pathfinder/contracts/guest-answer-attribution'
import { GUEST_RECORD_SEMANTICS_VERSION } from '@pathfinder/contracts/guest-evidence/semantics'
import type { GuestEvidenceAssembly } from './guest-evidence-assembly'

/** A bounded receipt of the actual completed turn, independent of next-turn continuity. */
export function guestEvidenceExecution(input: {
  assembly: GuestEvidenceAssembly
  mode: 'on' | 'luna'
  noticesChecked: number
  noticesAppended: number
}): GuestEvidenceExecution {
  const byRef = new Map<string, GuestEvidenceExecution['records'][number]>()
  for (const { ref, version } of input.assembly.rendered)
    byRef.set(ref, { ref, version, purpose: 'rendered' })
  for (const { ref, version } of input.assembly.supporting)
    if (!byRef.has(ref)) byRef.set(ref, { ref, version, purpose: 'scope' })
  const records = [...byRef.values()]
  return GuestEvidenceExecutionSchema.parse({
    schemaVersion: 'guest-evidence-execution-v1',
    mode: input.mode,
    assemblyVersion: input.assembly.trace.version,
    semanticsVersion: GUEST_RECORD_SEMANTICS_VERSION,
    evidenceSha256: createHash('sha256').update(input.assembly.data).digest('hex'),
    recordCount: records.length,
    recordsTruncated: records.length > 100,
    records: records.slice(0, 100),
    noticesChecked: input.noticesChecked,
    noticesAppended: input.noticesAppended,
  })
}
