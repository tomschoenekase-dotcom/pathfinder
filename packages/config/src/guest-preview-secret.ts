import { z } from 'zod'

const GuestPreviewSigningSecret = z.string().min(32).max(512)

/**
 * The server-only HMAC key for private guest preview links. Read at call time so a rotation takes
 * effect on the next request. A missing or short secret returns null: no link can then be minted
 * or accepted, so previews fail closed rather than falling back to an unsigned or public form.
 */
export function readGuestPreviewSigningSecret(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const parsed = GuestPreviewSigningSecret.safeParse(source.GUEST_PREVIEW_SIGNING_SECRET)
  return parsed.success ? parsed.data : null
}
