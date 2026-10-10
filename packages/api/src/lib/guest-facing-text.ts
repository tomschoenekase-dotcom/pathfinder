/**
 * How record text reads in the visitor guide. The guide renderer and the authoring checks share
 * this one sentence rule, so a package check can show an author every sentence the guide will
 * drop, instead of the two drifting apart and facts disappearing without a warning.
 */

// Research notes describe the record rather than the place: where a pin sits, who took a
// reference photo, which entry to cross-check, when a source was read or that sources disagree.
// Left in, they read to a model like a database talking, and it talks back the same way.
const GUIDE_NOISE =
  /\b(?:approach anchor(?:s|ed)?|feature anchor(?:s|ed)?|this pin|doorway coordinates?|exact doors?|walking[- ]routes?|research locations?|for testing|step-free access have not|signed public queues?|landmark appearances?|visitor photo(?:s|graphs?)?|ground photo(?:s|graphs?|graphy)?|matching visitor-information entry|source caveats?|source conflicts?|summary charts?|checked (?:on )?(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,4}(?:st|nd|rd|th)?)\b/iu
// A sentence carrying several links is a list of research sources (and leaks page taxonomy such
// as a ride filed under a coasters path); one link in a sentence is something a visitor can use.
const LINK = /https?:\/\/\S+/gu
// "The current official ride page lists 52 inches to ride." -> "52 inches to ride." Only a
// sentence that opens with the attribution is shortened, and never one that denies or contrasts
// ("No official ride page lists a height", "The official park site says nothing about ...").
const SOURCE_ATTRIBUTION =
  /^(?:the )?(?:current )?official (?:ride|attraction|dining|park) (?:pages?|website|site) (?:lists?|says|shows|publish(?:es)?)\b\s*/iu
const NEGATION =
  /\b(?:no|not|nothing|never|none|neither|nor|unlike|but|however|although|though)\b|n't\b/iu
// A heading such as "Ride height planning reference and six source conflicts".
const TITLE_RESEARCH_SUFFIX = /\s+(?:and|with) (?:\w+ )?source conflicts?$/iu

const sentencesOf = (line: string) => line.split(/(?<=[.!?])\s+/u)

/** True when the guide leaves a whole sentence out of the visitor-facing text. */
export function isHiddenGuideSentence(sentence: string): boolean {
  return GUIDE_NOISE.test(sentence) || (sentence.match(LINK)?.length ?? 0) >= 2
}

function withoutSourceAttribution(sentence: string): string {
  if (!SOURCE_ATTRIBUTION.test(sentence) || NEGATION.test(sentence)) return sentence
  const plain = sentence
    .replace(SOURCE_ATTRIBUTION, '')
    .replace(/\s{2,}/gu, ' ')
    .trim()
  return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : sentence
}

/** Record text as a visitor-facing guide would say it: research notes and raw links removed. */
export function guestFacingText(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\r/gu, '')
    .split('\n')
    .map((line) =>
      sentencesOf(line)
        .filter((sentence) => !isHiddenGuideSentence(sentence))
        .map(withoutSourceAttribution)
        .join(' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n')
}

/** Every sentence of the text that the visitor guide leaves out, in order. */
export function hiddenGuideSentences(text: string | null | undefined): string[] {
  return (text ?? '')
    .replace(/\r/gu, '')
    .split('\n')
    .flatMap((line) => sentencesOf(line).map((sentence) => sentence.trim()))
    .filter((sentence) => sentence && isHiddenGuideSentence(sentence))
}

/** A record title without research bookkeeping. */
export function guestFacingTitle(title: string): string {
  return title.replace(TITLE_RESEARCH_SUFFIX, '').trim() || title
}
