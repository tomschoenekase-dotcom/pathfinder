import { createHash } from 'node:crypto'

export const MAX_MEDIA_SOURCE_ID_LENGTH = 64

type MediaSource = {
  filename: string
}

function normalizedArchivePath(filename: string): string {
  return filename.replaceAll('\\', '/').normalize('NFC')
}

function preferredSourceId(filename: string, index: number): string {
  const leaf = normalizedArchivePath(filename).split('/').at(-1) ?? filename
  return (
    leaf.match(/(?:P|V)\d{3,4}/i)?.[0]?.toUpperCase() ?? `S${String(index + 1).padStart(4, '0')}`
  )
}

/**
 * Assigns one stable source identity per archive entry without merging entries
 * that happen to share a human label such as P001. The archive ordinal makes a
 * collision suffix unique even when a malformed archive repeats an exact path;
 * the path digest keeps the identity useful when comparing inventories.
 */
export function assignMediaSourceIds<T extends MediaSource>(
  files: readonly T[],
): Array<
  T & {
    sourceId: string
  }
> {
  const used = new Set<string>()

  return files.map((file, index) => {
    const preferred = preferredSourceId(file.filename, index)
    const foldedPreferred = preferred.toLowerCase()
    let sourceId = preferred

    if (used.has(foldedPreferred)) {
      const ordinal = String(index + 1).padStart(5, '0')
      const digest = createHash('sha256')
        .update(JSON.stringify([normalizedArchivePath(file.filename).toLowerCase(), index]))
        .digest('hex')
        .slice(0, 12)
      const suffix = `-${ordinal}-${digest}`
      sourceId = `${preferred.slice(0, MAX_MEDIA_SOURCE_ID_LENGTH - suffix.length)}${suffix}`
    }

    used.add(sourceId.toLowerCase())
    return { ...file, sourceId }
  })
}
