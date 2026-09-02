const SECRET_ASSIGNMENT =
  /\b((?:[A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD)|DATABASE_URL|DIRECT_DATABASE_URL|REDIS_URL))\s*[=:]\s*([^\s,;]+)/giu
const BASIC_AUTH_URL = /(https?:\/\/[^\s:/]+:)[^@\s]+@/giu
const BEARER_TOKEN = /\b(Bearer)\s+[^\s]+/giu

export function sanitizeDiagnosticLine(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(BASIC_AUTH_URL, '$1[REDACTED]@')
    .replace(BEARER_TOKEN, '$1 [REDACTED]')
}

export function createDiagnosticTail(limit = 120) {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new TypeError('Diagnostic tail limit must be a positive integer')
  }

  const lines = []
  return {
    push(line) {
      lines.push(String(line))
      if (lines.length > limit) lines.splice(0, lines.length - limit)
    },
    values() {
      return [...lines]
    },
  }
}
