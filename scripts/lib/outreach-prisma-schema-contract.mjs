import { createHash } from 'node:crypto'

/** Compare ALL schema tokens, permitting only generated alignment/comments.
 * Quoted literal bytes, token boundaries, identifiers and punctuation remain
 * exact. No model/enum/field is excluded from this full-schema admission.
 */
export function fullPrismaSchemaTokenHash(schema) {
  if (typeof schema !== 'string' || schema.length === 0) throw new Error('Schema text required')
  const token = /\s+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[^\s"]/gy
  const tokens = []
  let offset = 0
  while (offset < schema.length) {
    if (schema.startsWith('/*', offset) && schema.indexOf('*/', offset + 2) < 0)
      throw new Error('Unterminated schema comment')
    token.lastIndex = offset
    const match = token.exec(schema)
    if (!match) throw new Error('Unrecognized or unterminated schema token')
    offset = token.lastIndex
    const value = match[0]
    if (/^\s/u.test(value) || value.startsWith('//') || value.startsWith('/*')) continue
    tokens.push(value)
  }
  if (tokens.length === 0) throw new Error('Empty schema token stream')
  return createHash('sha256').update(JSON.stringify(tokens)).digest('hex')
}
