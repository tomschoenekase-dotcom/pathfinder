const EMPLOYEE_CHAT_PATH = /^\/[a-z0-9][a-z0-9-]{0,199}\/layer\/[0-9a-f-]{36}\/chat$/iu

export function safeEmployeeReturnPath(value: string | string[] | undefined): string {
  const candidate = Array.isArray(value) ? value[0] : value
  if (!candidate || !EMPLOYEE_CHAT_PATH.test(candidate)) return '/'

  try {
    const parsed = new URL(candidate, 'https://pathfinder.local')
    if (parsed.origin !== 'https://pathfinder.local' || parsed.search || parsed.hash) return '/'
    return parsed.pathname
  } catch {
    return '/'
  }
}
