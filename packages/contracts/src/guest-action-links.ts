import { z } from 'zod'

import { parseChatAppearance } from './chat-appearance'
import {
  isSafeHttpsHref,
  type GuestResponseBlock,
  type GuestResponsePlace,
  type GuestResponseTextLink,
  type GuestVisitorAction,
} from './guest-response'

/**
 * Venue-approved guest actions: official ordering, ticketing, pass and booking destinations the
 * guide may offer as an inline link or a single button. The model only ever names an approved
 * action ID; the server resolves the destination, enforces the venue's presentation settings and
 * drops anything disabled, expired, missing or unsafe.
 */

export const GUEST_ACTION_LIMIT = 40
export const GUEST_ACTION_MAX_INLINE_LINKS = 2
export const GUEST_ACTION_MAX_BUTTONS = 1

export const GuestActionId = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, 'Use lowercase letters, numbers and single hyphens')

export const GuestActionType = z.enum([
  'ORDER_AHEAD',
  'BUY_TICKETS',
  'BUY_PASS',
  'BOOK_EXPERIENCE',
  'RESERVE',
  'OTHER',
])
export type GuestActionType = z.infer<typeof GuestActionType>

const privateHost =
  /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/iu

/** Rejects anything but a public HTTPS destination with no credentials or secret-like keys. */
export function isApprovedGuestActionUrl(value: string): boolean {
  if (value.length > 2_000 || /\s/u.test(value) || !isSafeHttpsHref(value)) return false
  const host = new URL(value).hostname
  return host.includes('.') && !privateHost.test(host)
}

const isoDateTime = z.string().datetime({ offset: true })

export const GuestActionDefinition = z
  .object({
    id: GuestActionId,
    label: z.string().trim().min(2).max(60),
    /** Stored exactly as verified so legitimate booking parameters are preserved. */
    url: z
      .string()
      .trim()
      .refine(
        isApprovedGuestActionUrl,
        'Use a public HTTPS link with no credentials, tokens or keys',
      ),
    actionType: GuestActionType,
    /** Related place (eatery, ride, exhibit) in this venue; null for venue-wide actions. */
    placeId: z.string().trim().min(1).max(191).nullable().default(null),
    /** Official third-party ordering or booking provider, shown to operators only. */
    provider: z.string().trim().min(1).max(80).nullable().default(null),
    enabled: z.boolean().default(true),
    /** Brief relevance or availability note for the guide, e.g. "Mobile ordering 11am-8pm". */
    conditions: z.string().trim().min(1).max(300).nullable().default(null),
    availableFrom: isoDateTime.nullable().default(null),
    availableUntil: isoDateTime.nullable().default(null),
  })
  .strict()
  .superRefine((action, ctx) => {
    if (
      action.availableFrom &&
      action.availableUntil &&
      Date.parse(action.availableUntil) <= Date.parse(action.availableFrom)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['availableUntil'],
        message: 'The end must be after the start',
      })
  })
export type GuestActionDefinition = z.infer<typeof GuestActionDefinition>
export type GuestActionDefinitionInput = z.input<typeof GuestActionDefinition>

export const GuestActionCatalog = z
  .array(GuestActionDefinition)
  .max(GUEST_ACTION_LIMIT)
  .superRefine((actions, ctx) => {
    const seen = new Set<string>()
    actions.forEach((action, index) => {
      if (seen.has(action.id))
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Action ID "${action.id}" is used more than once`,
        })
      seen.add(action.id)
    })
  })
export type GuestActionCatalog = z.infer<typeof GuestActionCatalog>

export type GuestActionSettings = { inlineLinks: boolean; buttons: boolean }
export type GuestActionPresentation = 'INLINE' | 'BUTTON'

/** Persisted per assistant turn: which approved action was offered where, never its URL. */
export const GuestActionPlacement = z.discriminatedUnion('presentation', [
  z
    .object({
      presentation: z.literal('INLINE'),
      actionId: GuestActionId,
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    })
    .strict(),
  z.object({ presentation: z.literal('BUTTON'), actionId: GuestActionId }).strict(),
])
export type GuestActionPlacement = z.infer<typeof GuestActionPlacement>

/**
 * Parses a stored catalog leniently: one malformed or unsafe entry is dropped instead of
 * disabling every action. Returns only enabled actions whose availability window includes `now`.
 */
export function activeGuestActions(stored: unknown, now: Date): GuestActionDefinition[] {
  if (!Array.isArray(stored)) return []
  const seen = new Set<string>()
  return stored.flatMap((raw) => {
    const parsed = GuestActionDefinition.safeParse(raw)
    if (!parsed.success || seen.has(parsed.data.id)) return []
    seen.add(parsed.data.id)
    const action = parsed.data
    if (!action.enabled) return []
    if (action.availableFrom && Date.parse(action.availableFrom) > now.getTime()) return []
    if (action.availableUntil && Date.parse(action.availableUntil) <= now.getTime()) return []
    return [action]
  })
}

/**
 * Storage: the catalog lives under `guestActions` in the venue's existing `chat_appearance` JSON
 * document, beside the two presentation switches, so no schema migration is needed. Public
 * appearance projections go through parseChatAppearance, which drops this key.
 */
export const GUEST_ACTIONS_STORAGE_KEY = 'guestActions'

export function readStoredGuestActions(chatAppearance: unknown): unknown[] {
  if (!chatAppearance || typeof chatAppearance !== 'object' || Array.isArray(chatAppearance))
    return []
  const stored = (chatAppearance as Record<string, unknown>)[GUEST_ACTIONS_STORAGE_KEY]
  return Array.isArray(stored) ? stored : []
}

export function readGuestActionSettings(chatAppearance: unknown): GuestActionSettings {
  const appearance = parseChatAppearance(chatAppearance)
  return {
    inlineLinks: appearance.actionLinks ?? false,
    buttons: appearance.actionButtons ?? false,
  }
}

/** Combines an appearance document (or null) with a catalog for storage. */
export function withStoredGuestActions(
  appearance: Record<string, unknown> | null,
  actions: readonly unknown[],
): Record<string, unknown> | null {
  const rest = appearance ? { ...appearance } : null
  if (rest) delete rest[GUEST_ACTIONS_STORAGE_KEY]
  if (actions.length === 0) return rest
  return { ...(rest ?? {}), [GUEST_ACTIONS_STORAGE_KEY]: [...actions] }
}

export function guestActionsAllowed(settings: GuestActionSettings): boolean {
  return settings.inlineLinks || settings.buttons
}

/**
 * Model instructions for the approved actions. Returns null when no style is permitted or no
 * action is active, so a disabled venue never even shows the model an action.
 */
export function renderGuestActionPrompt(input: {
  actions: readonly GuestActionDefinition[]
  settings: GuestActionSettings
  placeNames: ReadonlyMap<string, string>
}): string | null {
  if (!guestActionsAllowed(input.settings) || input.actions.length === 0) return null
  const lines = input.actions.map((action) => {
    const place = action.placeId ? input.placeNames.get(action.placeId) : null
    return [
      `- id: ${action.id}`,
      `label: ${JSON.stringify(action.label)}`,
      `type: ${action.actionType}`,
      place ? `for: ${JSON.stringify(place)}` : 'for: the whole venue',
      ...(action.conditions ? [`note: ${JSON.stringify(action.conditions)}`] : []),
    ].join('; ')
  })
  const styles: string[] = []
  if (input.settings.inlineLinks)
    styles.push(
      'Inline link (default): wrap a few words of your sentence as [[link:ACTION_ID|those words]], e.g. "You can [[link:order-ahead|order ahead]] to skip the line."',
    )
  if (input.settings.buttons)
    styles.push(
      `Button: put [[button:ACTION_ID]] at the end of your answer${input.settings.inlineLinks ? ' only when taking that action is the main point of the guest message (for example "I want to buy a season pass")' : ' when taking that action would genuinely help the guest'}.`,
    )
  return [
    'OFFICIAL GUEST ACTIONS',
    'Answer the question yourself first. Offer at most one of these approved actions, and only when the guest wants to take it or it directly helps with what they asked. Never offer an action for an unrelated question, never add sales suggestions, and never write a URL.',
    'Use only an exact id from this list, matching the place the guest asked about:',
    ...lines,
    'Formats:',
    ...styles,
    'Use one format per action, never both. Offering a link does not complete anything: never say an order, booking or purchase was made.',
  ].join('\n')
}

const markerPattern = /\[\[(link|button):([a-z0-9-]{1,63})(?:\|([^[\]|\n]{1,120}))?\]\]/gu
const wellFormedMarker = /^\[\[(link|button):([a-z0-9-]{1,63})(?:\|([^[\]|\n]{1,120}))?\]\]$/u
const looseMarker = /( ?)(\[\[(?:link|button):[^\]\n]{0,200}\]\])/gu
const markerPrefixes = ['[[link:', '[[button:']

/** Malformed markers never reach the guest: keep any visible link text, drop the syntax. */
function normalizeMarkers(text: string): string {
  return text.replace(
    looseMarker,
    (whole: string, space: string, marker: string, offset: number, source: string) => {
      if (wellFormedMarker.test(marker)) return whole
      const pipe = marker.indexOf('|')
      const visible = pipe >= 0 ? marker.slice(pipe + 1, -2).trim() : ''
      if (visible) return `${space}${visible}`
      const next = source[offset + whole.length]
      return next === undefined || /[\s.,!?;:)]/u.test(next) ? '' : space
    },
  )
}

type MarkerRequest = {
  kind: 'link' | 'button'
  actionId: string
  text: string | null
  index: number
  length: number
}

/**
 * Turns the model's action markers into clean text plus placements, enforcing the venue settings:
 * a disallowed style falls back to the permitted one, each action appears once, a button wins over
 * a link for the same action, and unknown, inactive or excess actions become plain text.
 */
export function applyGuestActionMarkers(input: {
  text: string
  actions: readonly GuestActionDefinition[]
  settings: GuestActionSettings
}): { text: string; placements: GuestActionPlacement[] } {
  const text = normalizeMarkers(input.text)
  const requests: MarkerRequest[] = [...text.matchAll(markerPattern)].map((match) => ({
    kind: match[1] as 'link' | 'button',
    actionId: match[2]!,
    text: match[3]?.trim() || null,
    index: match.index!,
    length: match[0].length,
  }))
  const known = new Map(input.actions.map((action) => [action.id, action]))
  const allowed = guestActionsAllowed(input.settings)

  // Decide each action's single presentation before projecting text.
  const decided = new Map<
    string,
    { presentation: GuestActionPresentation; request: MarkerRequest }
  >()
  let buttons = 0
  let inline = 0
  const wantsButton = (request: MarkerRequest) =>
    request.kind === 'button' ? input.settings.buttons : !input.settings.inlineLinks
  if (allowed) {
    for (const request of requests) {
      if (!known.has(request.actionId) || decided.has(request.actionId)) continue
      if (wantsButton(request) && input.settings.buttons) {
        if (buttons >= GUEST_ACTION_MAX_BUTTONS) continue
        buttons += 1
        decided.set(request.actionId, { presentation: 'BUTTON', request })
      }
    }
    for (const request of requests) {
      if (!known.has(request.actionId) || decided.has(request.actionId)) continue
      if (!input.settings.inlineLinks || inline >= GUEST_ACTION_MAX_INLINE_LINKS) continue
      inline += 1
      decided.set(request.actionId, { presentation: 'INLINE', request })
    }
  }

  let output = ''
  let cursor = 0
  const placements: GuestActionPlacement[] = []
  const pendingButtons: GuestActionPlacement[] = []
  const appendedLinks: string[] = []
  for (const request of requests) {
    output += text.slice(cursor, request.index)
    cursor = request.index + request.length
    const decision = decided.get(request.actionId)
    const isChosen = decision?.request === request
    if (request.kind === 'link' && request.text) {
      if (isChosen && decision.presentation === 'INLINE') {
        placements.push({
          presentation: 'INLINE',
          actionId: request.actionId,
          start: output.length,
          end: output.length + request.text.length,
        })
      }
      output += request.text
    } else {
      if (isChosen && decision.presentation === 'INLINE') appendedLinks.push(request.actionId)
      // A removed bare marker should not leave a doubled or trailing space behind.
      const next = text[cursor]
      if (output.endsWith(' ') && (next === undefined || /[\s.,!?;:)]/u.test(next)))
        output = output.slice(0, -1)
    }
    if (isChosen && decision.presentation === 'BUTTON')
      pendingButtons.push({ presentation: 'BUTTON', actionId: request.actionId })
  }
  output += text.slice(cursor)
  output = output.trimEnd()
  // Stored answers are trimmed, so offsets must be relative to the trimmed text.
  const leading = output.length - output.trimStart().length
  if (leading) {
    output = output.slice(leading)
    for (const placement of placements)
      if (placement.presentation === 'INLINE') {
        placement.start = Math.max(0, placement.start - leading)
        placement.end -= leading
      }
  }
  for (const actionId of appendedLinks) {
    // Only reached when buttons are off: show the approved label as the inline link.
    const label = known.get(actionId)!.label
    output = output ? `${output}\n\n` : ''
    placements.push({
      presentation: 'INLINE',
      actionId,
      start: output.length,
      end: output.length + label.length,
    })
    output += label
  }
  return { text: output, placements: [...placements, ...pendingButtons] }
}

/**
 * The visible text of a partial provider stream: complete markers become their link text, and a
 * trailing marker that is still being written is held back. The result only grows as text arrives.
 */
export function projectGuestActionStreamText(providerText: string): string {
  let projected = normalizeMarkers(providerText).replace(
    markerPattern,
    (_match, kind: string, _id: string, text?: string) =>
      kind === 'link' && text ? text.trim() : '',
  )
  const open = projected.lastIndexOf('[')
  if (open >= 0) {
    const start = projected[open - 1] === '[' ? open - 1 : open
    const tail = projected.slice(start)
    const couldBeMarker =
      tail.length <= 200 &&
      !tail.includes(']]') &&
      !tail.includes('\n') &&
      markerPrefixes.some((prefix) =>
        tail.length <= prefix.length ? prefix.startsWith(tail) : tail.startsWith(prefix),
      )
    if (couldBeMarker) projected = projected.slice(0, start)
  }
  return projected
}

function visitorActionType(type: GuestActionType): GuestVisitorAction['type'] {
  return type === 'BUY_TICKETS' || type === 'BUY_PASS' ? 'BUY_TICKETS' : 'OPEN_WEBSITE'
}

export function guestActionAnalyticsKey(actionId: string): string {
  return `guest-action.${actionId}`
}

/**
 * Builds structured response blocks for an answer that offered approved actions. Placements are
 * re-resolved against the venue's current catalog and settings, so a since-disabled, removed,
 * expired or no-longer-permitted action degrades to plain text, and a changed URL follows the
 * venue's latest verified destination. Returns null when nothing actionable remains, letting the
 * caller keep the ordinary plain-text response shape.
 */
export function composeGuestActionBlocks(input: {
  content: string
  placements: readonly GuestActionPlacement[]
  catalog: unknown
  settings: GuestActionSettings
  now: Date
  places?: readonly GuestResponsePlace[]
  citations?: readonly { label: string; href?: string | undefined; detail?: string | undefined }[]
  citationsHeading?: 'sources' | 'links'
}): GuestResponseBlock[] | null {
  if (!guestActionsAllowed(input.settings) || input.placements.length === 0) return null
  const active = new Map(activeGuestActions(input.catalog, input.now).map((a) => [a.id, a]))
  const links: GuestResponseTextLink[] = []
  const buttons: GuestVisitorAction[] = []
  const used = new Set<string>()
  let previousEnd = 0
  for (const placement of input.placements) {
    const action = active.get(placement.actionId)
    if (!action || used.has(action.id)) continue
    if (placement.presentation === 'INLINE') {
      if (!input.settings.inlineLinks || links.length >= GUEST_ACTION_MAX_INLINE_LINKS) continue
      if (
        placement.start < previousEnd ||
        placement.end > input.content.length ||
        placement.end <= placement.start ||
        !input.content.slice(placement.start, placement.end).trim()
      )
        continue
      links.push({
        start: placement.start,
        end: placement.end,
        href: action.url,
        analyticsKey: guestActionAnalyticsKey(action.id),
      })
      previousEnd = placement.end
    } else {
      if (!input.settings.buttons || buttons.length >= GUEST_ACTION_MAX_BUTTONS) continue
      buttons.push({
        type: visitorActionType(action.actionType),
        label: action.label,
        target: { kind: 'URL', url: action.url },
        style: 'primary',
        icon:
          action.actionType === 'BUY_TICKETS' || action.actionType === 'BUY_PASS'
            ? 'ticket'
            : 'external-link',
        analyticsKey: guestActionAnalyticsKey(action.id),
        permissionRequirement: 'PUBLIC',
        confirmationRequired: false,
      })
    }
    used.add(action.id)
  }
  if (links.length === 0 && buttons.length === 0) return null
  return [
    ...(input.content.trim()
      ? [{ type: 'text' as const, text: input.content, ...(links.length ? { links } : {}) }]
      : []),
    ...(buttons.length ? [{ type: 'actions' as const, actions: buttons }] : []),
    ...(input.places?.length ? [{ type: 'places' as const, places: [...input.places] }] : []),
    ...(input.citations?.length
      ? [
          {
            type: 'citations' as const,
            ...(input.citationsHeading ? { heading: input.citationsHeading } : {}),
            citations: input.citations.map((citation) => ({
              label: citation.label,
              ...(citation.href ? { href: citation.href } : {}),
              ...(citation.detail ? { detail: citation.detail } : {}),
            })),
          },
        ]
      : []),
  ]
}
