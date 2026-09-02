const SECRET_ASSIGNMENT =
  /(["']?\b(?:[A-Z][A-Z0-9_-]*(?:KEY|SECRET|TOKEN|PASSWORD)|DATABASE_URL|DIRECT_DATABASE_URL|REDIS_URL|COOKIE|SET_COOKIE)\b["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu
const AUTHORIZATION_HEADER = /\b(authorization\s*[=:]\s*)(?:basic|bearer)\s+[^\s,;]+/giu
const BASIC_AUTH_URL = /(https?:\/\/[^\s:/]+:)[^@\s]+@/giu
const BEARER_TOKEN = /\b(Bearer)\s+[^\s]+/giu

export function sanitizeDiagnosticLine(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]')
    .replace(AUTHORIZATION_HEADER, '$1[REDACTED]')
    .replace(BASIC_AUTH_URL, '$1[REDACTED]@')
    .replace(BEARER_TOKEN, '$1 [REDACTED]')
}

export function createDiagnosticTail(limit = 120, maxLineLength = 4_000) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    !Number.isInteger(maxLineLength) ||
    maxLineLength < 1
  ) {
    throw new TypeError('Diagnostic tail bounds must be positive integers')
  }

  const lines = []
  return {
    push(line) {
      lines.push(String(line).slice(-maxLineLength))
      if (lines.length > limit) lines.splice(0, lines.length - limit)
    },
    values() {
      return [...lines]
    },
  }
}

export function createDiagnosticAnnotation(lines, maxLines = 60, maxLength = 12_000) {
  if (
    !Array.isArray(lines) ||
    !Number.isInteger(maxLines) ||
    maxLines < 1 ||
    !Number.isInteger(maxLength) ||
    maxLength < 1
  ) {
    throw new TypeError('Diagnostic annotation bounds are invalid')
  }

  const selected = lines.slice(-maxLines).map(sanitizeDiagnosticLine)
  while (selected.length > 1 && selected.join('%0A').length > maxLength) selected.shift()
  return selected.join('%0A').slice(0, maxLength)
}
