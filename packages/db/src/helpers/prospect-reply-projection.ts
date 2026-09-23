import { createHash } from 'node:crypto'
import type { NativeSalesSnapshot } from './prospect-sales-snapshot'

/** Conservative writer/display projection. Original body bytes and source remain
 * with correspondence; unfamiliar quotation layouts are not certified clean. */
export function projectReplyText(raw: string) {
  const lines = raw.replace(/\r\n?/gu, '\n').split('\n')
  const kept: string[] = []
  let omittedQuotedText = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const following = lines.slice(index + 1, index + 7)
    const remainingContent = lines.slice(index + 1).filter((next) => next.trim())
    const quotedAfterHeader = remainingContent.length > 0 &&
      remainingContent.every((next) => /^\s*>/u.test(next))
    const mailHeaderCount = following.filter((next) =>
      /^\s*(?:Sent|Date|To|Subject):\s*\S/iu.test(next),
    ).length
    if (
      (/^\s*On .{2,300}wrote:\s*$/iu.test(line) && quotedAfterHeader) ||
      /^\s*-{2,}\s*(?:Original Message|Forwarded message)/iu.test(line) ||
      (/^\s*From:\s*.+/iu.test(line) && mailHeaderCount >= 2)
    ) { omittedQuotedText = true; break }
    // A standalone blockquote may be the sender's own question or citation.
    // Only a confirmed reply/forward delimiter licenses dropping the tail.
    kept.push(line)
  }
  return {
    text: kept.join('\n').trim(), omittedQuotedText,
    scope: 'CONSERVATIVE_DISPLAY_PROJECTION_NOT_RAW_SOURCE' as const,
  }
}

/** Both API preparation and worker revalidation feed identical context to Composer. */
export function nativeWithReplyProjections(native: NativeSalesSnapshot) {
  return {
    ...native,
    threads: native.threads.map((thread) => ({
      ...thread,
      messages: thread.messages.map((message) => ({
        ...message,
        ...(message.textBody === null ? {} : {
          replyProjection: {
            ...projectReplyText(message.textBody),
            rawBodySha256: createHash('sha256').update(message.textBody, 'utf8').digest('hex'),
            sourceReference: message.sourceReference,
          },
        }),
      })),
    })),
  }
}
