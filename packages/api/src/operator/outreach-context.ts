import { createHash } from 'node:crypto'

import { PROSPECT_ELIGIBILITY_REASON_TEXT, type ProspectEligibilityReason } from '@pathfinder/db'

import { redactAddresses } from './crm-projection'

/**
 * The outreach context pack: one bounded, deterministic read of what a drafting agent may rely on
 * for one prospect account. This module is pure: it shapes rows already read from the database,
 * calls no model, reads no mailbox, sends nothing and never touches the network. The loader that
 * reads the rows lives in tools/crm-outreach-context.ts.
 *
 * Rules the pack enforces, so an agent cannot forget them:
 * - A contact that fails the shared `draft` eligibility rule (suppressed, do not contact,
 *   unsubscribed, complained, bounced, opted out, prohibited, invalid, archived, address blocked on
 *   another row, no address) makes `drafting.allowed` false, and everything free-text (notes,
 *   evidence, message previews) is withheld.
 * - Every list has a cap and reports `total`, `returned` and `truncated`.
 * - Source URLs are public https only; anything else is withheld and flagged.
 * - Claims the stored evidence does not support are listed as unsupported.
 */

export const OUTREACH_CONTEXT_PACK_VERSION = 'outreach-context-v1' as const

export const OUTREACH_CONTEXT_CAPS = {
  others: 10,
  messages: 5,
  drafts: 3,
  notes: 5,
  evidence: 10,
  legacySources: 5,
} as const

/** Evidence researched within this many days is fresh; older than STALE_DAYS is stale. */
export const OUTREACH_FRESH_DAYS = 90
export const OUTREACH_STALE_DAYS = 365

const DAY_MS = 86_400_000

type Timestamp = Date | null

export type OutreachContactRow = {
  id: string
  venueId: string | null
  fullName: string | null
  title: string | null
  email: string | null
  doNotContact: boolean
  suppressionReason: string | null
  suppressedAt: Timestamp
  unsubscribedAt: Timestamp
  complainedAt: Timestamp
  lastHardBounceAt: Timestamp
  permissionState: string
  emailReadiness: string
  updatedAt: Date
}

export type OutreachEligibility = {
  eligible: boolean
  reasons: readonly string[]
}

export type OutreachContextInput = {
  now: Date
  organization: {
    id: string
    name: string
    website: string | null
    type: string | null
    city: string | null
    region: string | null
    country: string | null
    stage: string | null
    archived: boolean
    updatedAt: Date
    notes: string | null
    customerLinked: boolean
    researchProvenance: unknown
    duplicateReview: 'OPEN' | 'CONFIRMED_DUPLICATE' | null
  }
  venueCount: number
  venue: {
    selection: 'requested' | 'contact' | 'only' | 'first'
    archived: boolean
    row: {
      id: string
      name: string
      website: string | null
      venueType: string | null
      city: string | null
      region: string | null
      country: string | null
      estimatedSize: string | null
      fitAttributes: unknown
      visitorOperations: unknown
      researchSources: unknown
      updatedAt: Date
    }
  } | null
  contact: {
    selection: 'requested' | 'auto' | 'none'
    /** Live contacts of the account, all of them. */
    liveTotal: number
    /** How many of them the eligibility scan covered (auto selection reads a bounded prefix). */
    scanned: number
    chosen: {
      row: OutreachContactRow
      draft: OutreachEligibility
      release: OutreachEligibility
      lastSuppressionEvent: { eventType: string; reasonCode: string; occurredAt: Date } | null
    } | null
    others: { id: string; fullName: string | null; title: string | null; draftEligible: boolean }[]
  }
  correspondence: {
    inboundMessages: number
    outboundMessages: number
    threads: number
    lastInboundAt: Timestamp
    lastOutboundAt: Timestamp
    messageTotal: number
    messages: {
      id: string
      threadId: string
      contactId: string | null
      direction: 'INBOUND' | 'OUTBOUND'
      status: string
      occurredAt: Date
      subject: string
      bodyPreview: string | null
      /** False when the person it belongs to is not contactable: the preview is then withheld. */
      previewReadable: boolean
    }[]
    draftTotal: number
    drafts: {
      id: string
      version: number
      status: string
      createdAt: Date
      subject: string
      escalationFlags: string[]
    }[]
  }
  noteTotal: number
  notes: { id: string; occurredAt: Date; text: string }[]
  evidenceTotal: number
  evidence: {
    id: string
    venueId: string | null
    contactId: string | null
    sourceType: string
    sourceLabel: string | null
    sourceUrl: string | null
    capturedValue: unknown
    researchedAt: Timestamp
  }[]
}

type Blocker = {
  code: string
  scope: 'account' | 'contact' | 'selection'
  contactId: string | null
  text: string
}

export function publicHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 500) return null
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    !host.includes('.') ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) ||
    host.startsWith('[')
  ) {
    return null
  }
  return trimmed
}

function freshnessOf(researchedAt: Timestamp, now: Date) {
  if (researchedAt === null) {
    return { observedAt: null, ageDays: null, status: 'unknown' as const }
  }
  const ageDays = Math.max(0, Math.floor((now.getTime() - researchedAt.getTime()) / DAY_MS))
  return {
    observedAt: researchedAt.toISOString(),
    ageDays,
    status:
      ageDays <= OUTREACH_FRESH_DAYS
        ? ('fresh' as const)
        : ageDays <= OUTREACH_STALE_DAYS
          ? ('aging' as const)
          : ('stale' as const),
  }
}

/** Sorted-key JSON, so an equal value always serializes to equal text. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

function legacySources(
  origin: 'organization' | 'venue',
  value: unknown,
): { origin: 'organization' | 'venue'; sourceUrl: string; label: string | null }[] {
  if (!Array.isArray(value)) return []
  const out: { origin: 'organization' | 'venue'; sourceUrl: string; label: string | null }[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const sourceUrl = publicHttpsUrl(entry)
      if (sourceUrl) out.push({ origin, sourceUrl, label: null })
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>
      const sourceUrl = publicHttpsUrl(record.url ?? record.sourceUrl)
      if (!sourceUrl) continue
      const label = [record.label, record.title].find(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      )
      out.push({ origin, sourceUrl, label: label ?? null })
    }
  }
  return out
}

function section(total: number, returned: number, cap: number) {
  return { total, returned, cap, truncated: total > returned }
}

export function buildOutreachContext(input: OutreachContextInput) {
  const { now } = input
  let textFieldsTruncated = 0

  const text = (value: string, max: number) => {
    const clean = redactAddresses(value)
    if (clean.length > max) {
      textFieldsTruncated += 1
      return { untrusted: true as const, text: clean.slice(0, max), truncated: true }
    }
    return { untrusted: true as const, text: clean, truncated: false }
  }
  const plain = (value: string | null, max: number): string | null => {
    if (value === null) return null
    const clean = redactAddresses(value)
    if (clean.length > max) {
      textFieldsTruncated += 1
      return clean.slice(0, max)
    }
    return clean
  }

  // ---- drafting decision -------------------------------------------------------------------
  const blockers: Blocker[] = []
  const warnings: Blocker[] = []
  const org = input.organization
  if (org.archived) {
    blockers.push({
      code: 'account_archived',
      scope: 'account',
      contactId: null,
      text: 'The account is archived.',
    })
  }
  if (org.stage === 'DO_NOT_CONTACT') {
    blockers.push({
      code: 'organization_do_not_contact',
      scope: 'account',
      contactId: null,
      text: 'The account is marked do not contact.',
    })
  }
  const chosen = input.contact.chosen
  if (chosen === null) {
    blockers.push(
      input.contact.liveTotal === 0
        ? {
            code: 'no_contact',
            scope: 'selection',
            contactId: null,
            text: 'The account has no live contact to write to.',
          }
        : {
            code: 'no_draftable_contact',
            scope: 'selection',
            contactId: null,
            text: `No contact among the first ${input.contact.scanned} of ${input.contact.liveTotal} may be written to.`,
          },
    )
  } else {
    for (const reason of chosen.draft.reasons) {
      if (reason === 'organization_do_not_contact' && org.stage === 'DO_NOT_CONTACT') continue
      blockers.push({
        code: reason,
        scope: 'contact',
        contactId: chosen.row.id,
        text: `The chosen contact ${
          PROSPECT_ELIGIBILITY_REASON_TEXT[reason as ProspectEligibilityReason] ?? reason
        }.`,
      })
    }
    for (const reason of chosen.release.reasons) {
      if (chosen.draft.reasons.includes(reason)) continue
      warnings.push({
        code: reason,
        scope: 'contact',
        contactId: chosen.row.id,
        text: `For release later, the chosen contact ${
          PROSPECT_ELIGIBILITY_REASON_TEXT[reason as ProspectEligibilityReason] ?? reason
        }.`,
      })
    }
  }
  const allowed = blockers.length === 0

  const correspondenceIn = input.correspondence
  const awaitingOurReply =
    correspondenceIn.lastInboundAt !== null &&
    (correspondenceIn.lastOutboundAt === null ||
      correspondenceIn.lastInboundAt.getTime() > correspondenceIn.lastOutboundAt.getTime())
  if (awaitingOurReply) {
    warnings.push({
      code: 'awaiting_our_reply',
      scope: 'account',
      contactId: null,
      text: 'The newest message is inbound: write a reply, not a cold introduction.',
    })
  }
  if (correspondenceIn.drafts.some((draft) => draft.status === 'NEEDS_REVIEW')) {
    warnings.push({
      code: 'draft_awaiting_review',
      scope: 'account',
      contactId: null,
      text: 'A draft for this account is already waiting for review.',
    })
  }
  if (org.duplicateReview !== null) {
    warnings.push({
      code: org.duplicateReview === 'OPEN' ? 'duplicate_review_open' : 'duplicate_confirmed',
      scope: 'account',
      contactId: null,
      text: 'This account is in a duplicate review: another record may already have been contacted.',
    })
  }
  if (input.venue === null) {
    warnings.push({
      code: 'no_venue',
      scope: 'account',
      contactId: null,
      text: 'The account has no recorded venue to write about.',
    })
  } else if (input.venue.archived) {
    warnings.push({
      code: 'venue_archived',
      scope: 'account',
      contactId: null,
      text: 'The chosen venue is archived.',
    })
  }
  if (chosen && input.venue && chosen.row.venueId && chosen.row.venueId !== input.venue.row.id) {
    warnings.push({
      code: 'contact_venue_mismatch',
      scope: 'contact',
      contactId: chosen.row.id,
      text: 'The chosen contact belongs to a different venue than the one described.',
    })
  }

  // ---- facts -------------------------------------------------------------------------------
  const venue = input.venue
    ? {
        venueId: input.venue.row.id,
        name: plain(input.venue.row.name, 200)!,
        website: plain(input.venue.row.website, 500),
        type: plain(input.venue.row.venueType, 80),
        city: plain(input.venue.row.city, 120),
        region: plain(input.venue.row.region, 120),
        country: plain(input.venue.row.country, 80),
        estimatedSize: plain(input.venue.row.estimatedSize, 10),
        selection: input.venue.selection,
        fit: jsonText(input.venue.row.fitAttributes, 2_000),
        visitorOperations: jsonText(input.venue.row.visitorOperations, 1_000),
        updatedAt: input.venue.row.updatedAt.toISOString(),
      }
    : null

  function jsonText(value: unknown, max: number) {
    if (value === null || value === undefined) return null
    if (typeof value === 'object' && Object.keys(value as object).length === 0) return null
    if (Array.isArray(value) && value.length === 0) return null
    return text(stableJson(value), max)
  }

  const chosenView = chosen
    ? {
        contactId: chosen.row.id,
        venueId: chosen.row.venueId,
        displayName: plain(chosen.row.fullName, 200),
        role: plain(chosen.row.title, 200),
        // The address exists in the pack only for a person drafting is allowed to address.
        email: chosen.draft.eligible ? chosen.row.email : null,
        flags: {
          doNotContact: chosen.row.doNotContact,
          suppressed:
            chosen.row.suppressedAt !== null ||
            chosen.row.lastHardBounceAt !== null ||
            chosen.row.permissionState === 'OPTED_OUT' ||
            chosen.row.permissionState === 'PROHIBITED',
          unsubscribed: chosen.row.unsubscribedAt !== null,
          complained: chosen.row.complainedAt !== null,
        },
        draftEligible: chosen.draft.eligible,
        draftReasons: [...chosen.draft.reasons],
        releaseEligible: chosen.release.eligible,
        releaseReasons: [...chosen.release.reasons],
        suppressionReason: plain(
          chosen.row.suppressionReason === null ? null : chosen.row.suppressionReason,
          60,
        ),
        lastSuppressionEvent: chosen.lastSuppressionEvent
          ? {
              eventType: chosen.lastSuppressionEvent.eventType,
              reasonCode: plain(chosen.lastSuppressionEvent.reasonCode, 100)!,
              occurredAt: chosen.lastSuppressionEvent.occurredAt.toISOString(),
            }
          : null,
      }
    : null

  const others = input.contact.others.slice(0, OUTREACH_CONTEXT_CAPS.others).map((other) => ({
    contactId: other.id,
    displayName: plain(other.fullName, 200),
    role: plain(other.title, 200),
    draftEligible: other.draftEligible,
  }))
  const otherTotal = Math.max(0, input.contact.liveTotal - (chosen ? 1 : 0))

  // ---- correspondence, notes, evidence (free text only when drafting is allowed) -------------
  const messages = correspondenceIn.messages
    .slice(0, OUTREACH_CONTEXT_CAPS.messages)
    .map((message) => {
      const readable = allowed && message.previewReadable
      return {
        messageId: message.id,
        threadId: message.threadId,
        direction: message.direction,
        status: message.status,
        occurredAt: message.occurredAt.toISOString(),
        subject: readable
          ? text(message.subject, 200)
          : { untrusted: true as const, text: '[withheld]', truncated: false },
        preview: readable && message.bodyPreview !== null ? text(message.bodyPreview, 300) : null,
        aboutChosenContact: chosen !== null && message.contactId === chosen.row.id,
      }
    })
  const drafts = correspondenceIn.drafts.slice(0, OUTREACH_CONTEXT_CAPS.drafts).map((draft) => ({
    draftId: draft.id,
    version: draft.version,
    status: draft.status,
    createdAt: draft.createdAt.toISOString(),
    subject: allowed
      ? text(draft.subject, 200)
      : { untrusted: true as const, text: '[withheld]', truncated: false },
    escalationFlags: draft.escalationFlags.slice(0, 10).map((flag) => plain(flag, 60)!),
  }))

  const recordedNotes = allowed
    ? input.notes.slice(0, OUTREACH_CONTEXT_CAPS.notes).map((note) => ({
        noteId: note.id,
        occurredAt: note.occurredAt.toISOString(),
        text: text(note.text, 500),
      }))
    : []
  const embeddedNote =
    allowed && org.notes !== null && org.notes.trim().length > 0 ? text(org.notes, 500) : null

  const evidenceItems = allowed
    ? input.evidence.slice(0, OUTREACH_CONTEXT_CAPS.evidence).map((row) => {
        const url = publicHttpsUrl(row.sourceUrl)
        return {
          evidenceId: row.id,
          scope: row.contactId
            ? ('contact' as const)
            : row.venueId
              ? ('venue' as const)
              : ('organization' as const),
          sourceType: plain(row.sourceType, 80)!,
          sourceLabel: plain(row.sourceLabel, 200),
          sourceUrl: url,
          urlWithheld: row.sourceUrl !== null && url === null,
          capturedValue:
            row.capturedValue === null || row.capturedValue === undefined
              ? null
              : text(stableJson(row.capturedValue), 300),
          researchedAt: row.researchedAt ? row.researchedAt.toISOString() : null,
          freshness: freshnessOf(row.researchedAt, now),
        }
      })
    : []
  const legacy = allowed
    ? [
        ...legacySources('organization', org.researchProvenance),
        ...(input.venue ? legacySources('venue', input.venue.row.researchSources) : []),
      ]
    : []
  const legacyShown = legacy.slice(0, OUTREACH_CONTEXT_CAPS.legacySources).map((entry) => ({
    ...entry,
    label: plain(entry.label, 200),
  }))
  const citable = evidenceItems.filter(
    (item) => item.sourceUrl !== null && item.freshness.status !== 'unknown',
  )
  const observed = evidenceItems
    .map((item) => item.researchedAt)
    .filter((value): value is string => value !== null)
    .sort()
  const newestObservedAt = observed.at(-1) ?? null

  // ---- claims the stored data does or does not support --------------------------------------
  const hasConversation =
    correspondenceIn.inboundMessages + correspondenceIn.outboundMessages > 0 && allowed
  const claims = [
    {
      claim: 'organization_identity',
      status: 'supported' as const,
      basis: 'Name, type and location come from the account record.',
    },
    {
      claim: 'venue_specific_facts',
      status: citable.length > 0 ? ('supported' as const) : ('unsupported' as const),
      basis:
        citable.length > 0
          ? 'Only what the cited evidence items state; cite the evidenceId.'
          : 'No dated evidence with a public https URL is stored; state no venue-specific fact.',
    },
    {
      claim: 'recent_news_or_events',
      status: 'unsupported' as const,
      basis:
        'A recent research date does not establish a recent event. Verify a dated event in the cited source before making this claim.',
    },
    {
      claim: 'visitor_volume_or_attendance',
      status: 'unsupported' as const,
      basis: input.venue?.row.estimatedSize
        ? 'The recorded size bucket is an estimate and does not establish attendance or visitor volume.'
        : 'No size or visitor figure is recorded.',
    },
    {
      claim: 'current_pain_or_stated_need',
      status: 'unsupported' as const,
      basis: 'No stored record states a need; do not infer one from the venue type.',
    },
    {
      claim: 'prior_relationship_or_conversation',
      status: hasConversation ? ('supported' as const) : ('unsupported' as const),
      basis: hasConversation
        ? 'Only what the correspondence metadata shows; do not invent what was said.'
        : 'No correspondence is stored for this account; do not imply a prior conversation.',
    },
    {
      claim: 'existing_customer_status',
      status: org.customerLinked ? ('supported' as const) : ('unsupported' as const),
      basis: org.customerLinked
        ? 'The account is linked to a customer record.'
        : 'The account is a prospect; do not write as to an existing customer.',
    },
    {
      claim: 'pricing_budget_or_contract_terms',
      status: 'unsupported' as const,
      basis: 'Nothing in the pack sets a price, budget or term.',
    },
    {
      claim: 'contact_personal_background',
      status: 'unsupported' as const,
      basis: 'Only a name and role are recorded for the contact.',
    },
    {
      claim: 'competitor_or_current_tools',
      status: 'unsupported' as const,
      basis: 'No record states what the venue uses today.',
    },
  ]

  // ---- sections, truncation, fingerprint -----------------------------------------------------
  const sections = {
    contact: section(otherTotal, others.length, OUTREACH_CONTEXT_CAPS.others),
    messages: section(
      correspondenceIn.messageTotal,
      messages.length,
      OUTREACH_CONTEXT_CAPS.messages,
    ),
    drafts: section(correspondenceIn.draftTotal, drafts.length, OUTREACH_CONTEXT_CAPS.drafts),
    notes: section(
      allowed ? input.noteTotal : 0,
      recordedNotes.length,
      OUTREACH_CONTEXT_CAPS.notes,
    ),
    evidence: section(
      allowed ? input.evidenceTotal : 0,
      evidenceItems.length,
      OUTREACH_CONTEXT_CAPS.evidence,
    ),
    legacy: section(legacy.length, legacyShown.length, OUTREACH_CONTEXT_CAPS.legacySources),
  }
  const truncatedSections = Object.entries(sections)
    .filter(([, value]) => value.truncated)
    .map(([key]) => key)
    .sort()
  if (input.contact.scanned < input.contact.liveTotal && !truncatedSections.includes('contact')) {
    truncatedSections.push('contact')
    truncatedSections.sort()
  }

  const fingerprint = createHash('sha256')
    .update(
      stableJson({
        v: OUTREACH_CONTEXT_PACK_VERSION,
        org: [org.id, org.updatedAt.toISOString(), org.stage, org.archived],
        venue: input.venue ? [input.venue.row.id, input.venue.row.updatedAt.toISOString()] : null,
        contact: chosen
          ? [chosen.row.id, chosen.row.updatedAt.toISOString(), chosen.draft.reasons]
          : null,
        others: input.contact.others.map((other) => [other.id, other.draftEligible]),
        counts: [
          input.contact.liveTotal,
          correspondenceIn.inboundMessages,
          correspondenceIn.outboundMessages,
          correspondenceIn.threads,
          correspondenceIn.messageTotal,
          correspondenceIn.draftTotal,
          input.noteTotal,
          input.evidenceTotal,
        ],
        messages: messages.map((message) => message.messageId),
        drafts: drafts.map((draft) => draft.draftId),
        notes: recordedNotes.map((note) => note.noteId),
        evidence: evidenceItems.map((item) => item.evidenceId),
        allowed,
      }),
    )
    .digest('hex')

  const instruction = allowed
    ? 'Draft only from this pack. Cite an evidenceId or a pack field for every specific claim and make none that is listed unsupported. Saving a draft is a separate proposal; nothing here sends anything.'
    : 'Do not draft. Report the blockers to the person and stop; notes, evidence and message previews are withheld.'

  const pack = {
    packVersion: OUTREACH_CONTEXT_PACK_VERSION,
    generatedAt: now.toISOString(),
    sourceFingerprint: fingerprint,
    organizationId: org.id,
    drafting: { allowed, blockers, warnings, instruction },
    organization: {
      name: plain(org.name, 200)!,
      website: plain(org.website, 500),
      type: plain(org.type, 80),
      city: plain(org.city, 120),
      region: plain(org.region, 120),
      country: plain(org.country, 80),
      stage: org.stage as never,
      archived: org.archived,
      updatedAt: org.updatedAt.toISOString(),
      customerLinked: org.customerLinked,
    },
    venue,
    venueCount: input.venueCount,
    contact: {
      selection: input.contact.selection,
      chosen: chosenView,
      others,
      section: sections.contact,
    },
    correspondence: {
      previewsWithheld: !allowed,
      inboundMessages: correspondenceIn.inboundMessages,
      outboundMessages: correspondenceIn.outboundMessages,
      threads: correspondenceIn.threads,
      lastInboundAt: correspondenceIn.lastInboundAt?.toISOString() ?? null,
      lastOutboundAt: correspondenceIn.lastOutboundAt?.toISOString() ?? null,
      awaitingOurReply,
      recentMessages: messages,
      messageSection: sections.messages,
      priorDrafts: drafts,
      draftSection: sections.drafts,
    },
    notes: {
      withheld: !allowed,
      embedded: embeddedNote,
      recorded: recordedNotes,
      section: sections.notes,
    },
    evidence: {
      withheld: !allowed,
      items: evidenceItems,
      legacySources: legacyShown,
      section: sections.evidence,
      legacySection: sections.legacy,
      citableCount: citable.length,
      newestObservedAt,
    },
    claims,
    limits: {
      complete: truncatedSections.length === 0 && textFieldsTruncated === 0,
      truncatedSections,
      textFieldsTruncated,
      approxChars: 0,
      freshnessWindows: { freshDays: OUTREACH_FRESH_DAYS, staleDays: OUTREACH_STALE_DAYS },
    },
  }
  pack.limits.approxChars = JSON.stringify(pack).length
  return pack
}

export type OutreachContextPack = ReturnType<typeof buildOutreachContext>
