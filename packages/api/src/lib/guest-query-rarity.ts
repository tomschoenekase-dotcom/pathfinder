import { normalizeGuestText, type GuestQueryRarity } from './guest-knowledge-retrieval'
import type { GuestVenueDirectory } from './guest-venue-directory'
type Corpus = {
  frequency: Map<string, number>
  names: Array<{ phrase: string; tokens: string[] }>
}
const cache = new Map<string, { corpus: Corpus; bytes: number }>()
let retainedBytes = 0
const MAX_BYTES = 16 * 1024 * 1024
const words = (text: string) => normalizeGuestText(text).match(/[\p{L}\p{N}]+/gu) ?? []
export function guestQueryRarity(directory: GuestVenueDirectory, query: string): GuestQueryRarity {
  // The version owner binds scoped content bytes; native release identity alone does not
  // bind the compatibility-authorized subset. Keep actual typed membership in the key.
  // Incomplete/unversioned snapshots are computed for this call only, never read/retained.
  const key =
    directory.searchVersion && !directory.incomplete
      ? JSON.stringify([
          directory.searchVersion,
          directory.knowledge.map((row) => row.id),
          directory.places.map((row) => row.id),
        ])
      : null
  const hit = key ? cache.get(key) : undefined
  let corpus = hit?.corpus
  if (hit && key) {
    cache.delete(key)
    cache.set(key, hit)
  }
  if (!corpus) {
    const frequency = new Map<string, number>()
    const names: Corpus['names'] = []
    for (const entry of directory.knowledge) {
      for (const word of new Set(words(`${entry.title} ${entry.category} ${entry.content}`)))
        frequency.set(word, (frequency.get(word) ?? 0) + 1)
    }
    for (const place of directory.places) {
      const tokens = words(place.name)
      names.push({ phrase: tokens.join(' '), tokens })
      const text = [
        place.name,
        place.type,
        place.itemType,
        place.areaName,
        place.shortDescription,
        place.longDescription,
        place.hours,
        ...(place.tags ?? []),
      ]
        .filter(Boolean)
        .join(' ')
      for (const word of new Set(words(text))) frequency.set(word, (frequency.get(word) ?? 0) + 1)
    }
    corpus = { frequency, names }
    const bytes =
      [...frequency.keys()].reduce((n, word) => n + 64 + word.length * 2, 0) +
      names.reduce((n, name) => n + 64 + name.phrase.length * 4, 0) +
      (key?.length ?? 0) * 2
    if (key && bytes <= MAX_BYTES) {
      while (cache.size >= 16 || retainedBytes + bytes > MAX_BYTES) {
        const oldest = cache.keys().next().value!
        retainedBytes -= cache.get(oldest)!.bytes
        cache.delete(oldest)
      }
      cache.set(key, { corpus, bytes })
      retainedBytes += bytes
    }
  }
  const question = ` ${words(query).join(' ')} `
  return {
    documentFrequency: corpus.frequency,
    exactNameTokens: new Set(
      corpus.names
        .filter(({ phrase }) => phrase && question.includes(` ${phrase} `))
        .flatMap(({ tokens }) => tokens),
    ),
  }
}
