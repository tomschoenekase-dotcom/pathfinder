// Regenerates venue-authoring-text.ts from docs/operator/venue-authoring.md.
// Run after editing the doc: node packages/api/src/operator/venue-authoring/sync-text.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const doc = fileURLToPath(
  new URL('../../../../../docs/operator/venue-authoring.md', import.meta.url),
)
const out = fileURLToPath(new URL('./venue-authoring-text.ts', import.meta.url))
const text = readFileSync(doc, 'utf8').replaceAll('\r\n', '\n')
writeFileSync(
  out,
  `/**
 * The text of docs/operator/venue-authoring.md, embedded so operator.get_manual never reads the
 * filesystem at runtime. A test keeps it equal to the doc. Edit the doc, then run
 * node packages/api/src/operator/venue-authoring/sync-text.mjs
 */
export const VENUE_AUTHORING_VERSION = 'torchiko-venue-authoring-v2'

export const VENUE_AUTHORING_TEXT = ${JSON.stringify(text)}
`,
)
console.log(`wrote ${out} (${text.length} characters)`)
