// Parses the optional space-separated `--filter=<workspace>` list produced by the CI change plan.
// Anything that is not an exact workspace-name filter is rejected so a crafted value can never
// inject turbo flags; callers fall back to the unfiltered (full) graph on rejection.
const FILTER = /^--filter=((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)$/u

export function parseTurboFilters(value) {
  const text = (value ?? '').trim()
  if (text === '') return { filters: [], rejected: false }
  const parts = text.split(/\s+/u)
  if (!parts.every((part) => FILTER.test(part))) return { filters: [], rejected: true }
  return { filters: parts, rejected: false }
}
