/** Optional pilot isolation; absent or unknown scope preserves existing all-model behavior. */
export function guestDateCueLunaScope(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GUEST_CHAT_DATE_CUES_MODEL_SCOPE?.trim().toLowerCase() === 'luna'
}

export function guestDateCuesForModel(
  primaryModelKey: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !guestDateCueLunaScope(env) || /^guest-chat-luna(?:-|$)/u.test(primaryModelKey ?? '')
}
