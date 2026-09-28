'use client'

import { useState } from 'react'
import { ADMIN_AGENT_SURFACE_MAP } from './CopyForCodexMap'

export type AdminContextRoute = {
  routeTemplate: string
  match: RegExp
  pageName: string
  mcp: readonly string[]
  procedures: readonly string[]
  registryFiles: readonly string[]
}

export type CopyForCodexProps = {
  pageName?: string
  route: string
  tenant?: { id: string; name: string } | null
  venue?: { id: string; name: string } | null
  filters?: Readonly<Record<string, string | number | boolean | null | undefined>>
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/u
const SAFE_LABEL = /^[\p{L}\p{N} .,'’()&-]{1,100}$/u
const FILTER_KEYS = new Set(['status', 'tab', 'category', 'sort', 'view', 'selection'])
const SECRET_OR_PRIVATE =
  /(?:@|https?:\/\/|bearer\s|token|secret|password|cookie|session|visitor|message|transcript|email|api[_ -]?key)/iu

function safeId(value: string | undefined) {
  return value && SAFE_ID.test(value) && !SECRET_OR_PRIVATE.test(value) ? value : undefined
}

function safeLabel(value: string | undefined) {
  return value && SAFE_LABEL.test(value) && !SECRET_OR_PRIVATE.test(value) ? value : undefined
}

function safeFilterValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) return undefined
  const text = String(value)
  if (text.length > 80 || SECRET_OR_PRIVATE.test(text) || /[<>\r\n]/u.test(text)) return undefined
  return text
}

export function resolveAdminContextRoute(route: string, entries: readonly AdminContextRoute[]) {
  return entries
    .filter((entry) => entry.match.test(route))
    .sort(
      (a, b) =>
        (a.routeTemplate.match(/\[[^/]+\]/gu)?.length ?? 0) -
        (b.routeTemplate.match(/\[[^/]+\]/gu)?.length ?? 0),
    )[0]
}

export function buildCopyForCodexText(
  props: CopyForCodexProps,
  entry: AdminContextRoute | undefined,
) {
  const lines = [
    'Torchiko admin context',
    `Page: ${safeLabel(props.pageName) ?? entry?.pageName ?? 'Admin page'}`,
    `Route: ${safeAdminRoute(props.route)}`,
  ]
  const tenantId = safeId(props.tenant?.id)
  const tenantName = safeLabel(props.tenant?.name)
  if (tenantId || tenantName)
    lines.push(`Tenant: ${tenantName ?? 'Unknown'}${tenantId ? ` (${tenantId})` : ''}`)
  const venueId = safeId(props.venue?.id)
  const venueName = safeLabel(props.venue?.name)
  if (venueId || venueName)
    lines.push(`Venue: ${venueName ?? 'Unknown'}${venueId ? ` (${venueId})` : ''}`)

  const filters = Object.entries(props.filters ?? {})
    .filter(([key]) => FILTER_KEYS.has(key))
    .map(([key, value]) => [key, safeFilterValue(value)] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
  if (filters.length)
    lines.push(
      `Current filters or selection: ${filters.map(([key, value]) => `${key}=${value}`).join(', ')}`,
    )
  if (entry) {
    lines.push(`Related MCP surfaces: ${entry.mcp.join(', ')}`)
    lines.push(`Related admin procedures: ${entry.procedures.join(', ')}`)
  }
  return lines.join('\n')
}

export function readPageContext(props: CopyForCodexProps) {
  const tenantName =
    safeLabel(props.tenant?.name) ??
    safeLabel(
      document.querySelector<HTMLElement>('[data-admin-tenant-name]')?.dataset.adminTenantName,
    )
  const venueName =
    safeLabel(props.venue?.name) ??
    safeLabel(
      document.querySelector<HTMLElement>('[data-admin-venue-name]')?.dataset.adminVenueName,
    )
  const filters =
    props.filters ??
    Object.fromEntries(
      ['status', 'tab', 'category', 'sort', 'view', 'selection']
        .map((key) => [key, new URLSearchParams(window.location.search).get(key)] as const)
        .filter((pair): pair is readonly [string, string] => pair[1] !== null),
    )
  return {
    ...props,
    tenant: props.tenant
      ? { ...props.tenant, name: tenantName ?? '' }
      : tenantName
        ? { id: '', name: tenantName }
        : null,
    venue: props.venue
      ? { ...props.venue, name: venueName ?? '' }
      : venueName
        ? { id: '', name: venueName }
        : null,
    filters,
  }
}

function safeAdminRoute(route: string) {
  // Routes may carry only the route path. Strip any query/hash before copying.
  let path = route.split(/[?#]/u, 1)[0] ?? '/admin'
  if (!/^\/admin(?:\/[A-Za-z0-9_./-]*)?$/u.test(path)) return '/admin'
  const redactId = (_match: string, prefix: string, id: string) =>
    `${prefix}${safeId(id) ?? '[redacted]'}`
  path = path
    .replace(/(\/clients\/)([^/]+)/u, redactId)
    .replace(/(\/venues\/)([^/]+)/u, redactId)
    .replace(/(\/(?:reports|chatlogs|media|analysis)\/)([^/]+)/u, redactId)
    .replace(/(\/agents\/runs\/)([^/]+)/u, redactId)
    .replace(/(\/outreach\/)([^/]+)/u, redactId)
  const prospectSegment = path.match(/^\/admin\/prospects\/([^/]+)/u)?.[1]
  if (
    prospectSegment &&
    ![
      'pipeline',
      'new',
      'inbound',
      'imports',
      'outreach',
      'review-proposals',
      'duplicates',
    ].includes(prospectSegment)
  ) {
    path = path.replace(/(\/prospects\/)([^/]+)/u, redactId)
  }
  return path
}

export function CopyForCodex({ pageName, route, tenant, venue, filters }: CopyForCodexProps) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const entry = resolveAdminContextRoute(route, ADMIN_AGENT_SURFACE_MAP)

  async function copyContext() {
    setCopied(false)
    setFailed(false)
    try {
      const contextProps: CopyForCodexProps = {
        route,
        ...(pageName !== undefined ? { pageName } : {}),
        ...(tenant !== undefined ? { tenant } : {}),
        ...(venue !== undefined ? { venue } : {}),
        ...(filters !== undefined ? { filters } : {}),
      }
      await navigator.clipboard.writeText(
        buildCopyForCodexText(readPageContext(contextProps), entry),
      )
      setCopied(true)
    } catch {
      setFailed(true)
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={copyContext}
        className="min-h-10 rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600"
      >
        Copy for Codex
      </button>
      <span aria-live="polite" className="text-xs text-slate-600">
        {copied ? 'Context copied' : failed ? 'Could not copy context' : ''}
      </span>
    </div>
  )
}
