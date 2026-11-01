/** Prevent untrusted text from forging the prompt's structural data tags. */
export function escapeUntrustedPromptData(value: string): string {
  return value.normalize('NFC').replace(/[<>&\u2028\u2029]/gu, (character) => {
    switch (character) {
      case '<':
        return '\\u003c'
      case '>':
        return '\\u003e'
      case '&':
        return '\\u0026'
      case '\u2028':
        return '\\u2028'
      default:
        return '\\u2029'
    }
  })
}
