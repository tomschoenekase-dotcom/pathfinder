import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { applyNativeGuestContentRead, resolveNativeGuestReadSnapshotAction } from '@pathfinder/db'

import { guestAnswerShape } from '../../lib/guest-answer-shape'
import {
  assembleGuestEvidence,
  guestEvidenceAssemblyMode,
  guestEvidenceRecordFromKnowledge,
  guestEvidenceRecordFromPlace,
  type GuestEvidenceAssembly,
} from '../../lib/guest-evidence-assembly'
import { parseGuestRecordSemantics } from '../../lib/guest-record-semantics'
import { loadGuestVenueDirectory } from '../../lib/guest-venue-directory'
import { escapeUntrustedPromptData } from '../../lib/venue-context'
import { operatorUntrustedText } from '../crm-projection'
import { assertVenueInGrant, OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'

const MAX_EVIDENCE_CHARS = 20_000
const MAX_CANDIDATE_CHARS = 400_000

/** No provider, ranking search, conversation reads, session writes or shared directory cache. */
export const previewGuestEvidence: OperatorReadTool = {
  name: 'venues.preview_guest_evidence',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['venues.preview_guest_evidence'].parse(raw)
    await assertVenueInGrant(context.grant, input.tenantId, input.venueId, context.database)
    const venue = await context.database.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { isActive: true },
    })
    if (!venue) throw new OperatorNotFoundError()
    const flag = guestEvidenceAssemblyMode()
    const result = {
      venueId: input.venueId,
      status: 'unavailable' as 'ready' | 'partial' | 'unavailable',
      readPath: null as 'LEGACY' | 'DARK' | 'NATIVE' | null,
      reason: '',
      runtime: {
        flag,
        chat:
          flag === 'on'
            ? ('enabled' as const)
            : flag === 'luna'
              ? ('model_dependent' as const)
              : ('disabled' as const),
        voice: flag === 'on' ? ('enabled' as const) : ('disabled' as const),
        evaluation: 'not_wired' as const,
        scope: 'operator_process_configuration' as const,
      },
      coverage: {
        loadedRecords: 0,
        directoryIncomplete: false,
        outputTruncated: false,
        retrieval: 'not_run' as const,
        continuity: 'visitor_only_replay' as const,
        maxRecords: input.maxRecords,
        maxEvidenceChars: MAX_EVIDENCE_CHARS,
        maxCandidateChars: MAX_CANDIDATE_CHARS,
      },
      records: [] as Array<{
        ref: string
        version: string | null
        title: ReturnType<typeof operatorUntrustedText>
        semantics: ReturnType<typeof operatorUntrustedText>
      }>,
      evidence: operatorUntrustedText(''),
      notices: operatorUntrustedText('[]'),
      trace: operatorUntrustedText('{}'),
    }
    if (!venue.isActive) {
      result.reason =
        'Venue inactive: the public guest route refuses guests. No content was loaded.'
      return result
    }
    try {
      const snapshot = await resolveNativeGuestReadSnapshotAction({
        client: context.database as never,
        tenantId: input.tenantId,
        venueId: input.venueId,
      })
      if (snapshot.path === 'NATIVE' && !snapshot.state) {
        result.readPath = 'NATIVE'
        result.reason =
          'Native snapshot has no authoritative state. No compatibility content is exposed.'
        return result
      }
      const directory = await loadGuestVenueDirectory({
        reader: context.database,
        tenantId: input.tenantId,
        venueId: input.venueId,
        includeSecondLayer: false,
        asOf: context.now,
      })
      const projected = applyNativeGuestContentRead({
        snapshot,
        legacyPlaces: directory.places,
        legacyKnowledgeEntries: directory.knowledge.map((entry) => ({ ...entry, distance: 0 })),
      })
      result.readPath = snapshot.path
      result.coverage.directoryIncomplete = directory.incomplete
      if (projected.path !== snapshot.path) {
        result.reason =
          'Native projection mismatch: the public directory cannot be represented by this exact release. No legacy fallback content is exposed.'
        return result
      }
      const records = [
        ...projected.places.map(guestEvidenceRecordFromPlace),
        ...projected.knowledgeEntries.map((entry) =>
          guestEvidenceRecordFromKnowledge({
            ...entry,
            // Never attach a legacy revision to a native projection.
            updatedAt:
              projected.path === 'NATIVE'
                ? null
                : directory.knowledge.find((row) => row.id === entry.id)?.updatedAt ?? null,
          }),
        ),
      ]
      result.coverage.loadedRecords = records.length
      if (
        records.reduce((total, record) => total + record.content.length + record.title.length, 0) >
        MAX_CANDIDATE_CHARS
      ) {
        result.coverage.outputTruncated = true
        result.reason =
          'Authorized directory exceeds the candidate character bound. No partial record bodies were assembled.'
        return result
      }
      let previous: GuestEvidenceAssembly['state'] | null = null
      let assembly: GuestEvidenceAssembly | null = null
      const messages = [...input.visitorHistory, input.question]
      for (let index = 0; index < messages.length; index += 1) {
        assembly = assembleGuestEvidence({
          question: messages[index]!,
          visitorMessages: messages.slice(0, index + 1),
          shape: guestAnswerShape(messages[index]!),
          records,
          retrievedRefs: [],
          previous,
          unavailableRefs: [],
          coverage: {
            mode: 'DIRECTORY',
            incomplete: directory.incomplete,
            retrievalPartial: true,
            loadFailed: false,
          },
          escape: escapeUntrustedPromptData,
          maxRecords: input.maxRecords,
          maxChars: MAX_EVIDENCE_CHARS,
        })
        previous = assembly.state
      }
      if (!assembly) throw new Error('No preview question')
      const evidenceRecords = [...assembly.rendered, ...assembly.supporting]
      result.records = evidenceRecords.slice(0, input.maxRecords).map((record) => ({
        ref: record.ref,
        version: record.version,
        title: operatorUntrustedText(record.title, 300),
        semantics: operatorUntrustedText(
          JSON.stringify(parseGuestRecordSemantics(record)),
          MAX_EVIDENCE_CHARS,
        ),
      }))
      result.evidence = operatorUntrustedText(assembly.data, MAX_EVIDENCE_CHARS)
      result.notices = operatorUntrustedText(JSON.stringify(assembly.notices), MAX_EVIDENCE_CHARS)
      result.trace = operatorUntrustedText(JSON.stringify(assembly.trace), 2_000)
      result.coverage.outputTruncated =
        evidenceRecords.length > input.maxRecords ||
        assembly.trace.truncated ||
        result.evidence.truncated ||
        result.notices.truncated ||
        result.records.some((record) => record.title.truncated || record.semantics.truncated)
      result.status = directory.incomplete || result.coverage.outputTruncated ? 'partial' : 'ready'
      result.reason =
        'Deterministic public-directory preview only; semantic retrieval was not run. History is visitor-only replay, without assistant-based subject refinement. Ready describes preview completion, not factual correctness or a prediction of the live answer.'
      return result
    } catch {
      // Raw infrastructure exceptions may contain private connection or record details.
      result.status = 'unavailable'
      result.records = []
      result.evidence = operatorUntrustedText('')
      result.notices = operatorUntrustedText('[]')
      result.trace = operatorUntrustedText('{}')
      result.reason =
        'The effective guest snapshot or deterministic assembly could not be read safely. No content is returned.'
      return result
    }
  },
}
