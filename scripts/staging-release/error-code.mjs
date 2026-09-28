/** Never forward provider errors or input values to a workflow log. */
export function safeErrorCode(error, allowed, fallback) {
  return allowed.includes(error?.message) ? error.message : fallback
}
