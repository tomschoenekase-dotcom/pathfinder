import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { ProspectOutreachReviewDocument } from '../apps/dashboard/components/admin/ProspectOutreachReviewDocument'

async function main() {
  const root = path.resolve(__dirname, '..'),
    qa = path.resolve(root, '../qa')
  const input = process.argv[2] ?? 'NATIVE-COHORT-PROOF.json'
  if (!/^(?:NATIVE-COHORT-PROOF|RESUME-NATIVE-COHORT-PROOF-\d+)\.json$/u.test(input))
    throw Error('Select one exact retained synthetic native proof basename.')
  const run = `r002-${Date.now()}`
  const require = createRequire(path.join(root, 'apps/dashboard/package.json'))
  const { createElement } = require('react'),
    { renderToStaticMarkup } = require('react-dom/server')
  const proof = JSON.parse(await readFile(path.join(qa, input), 'utf8'))
  assert.equal(proof.passed, true)
  assert.equal(proof.firstReview.count, 50)
  const markup = renderToStaticMarkup(
    createElement(ProspectOutreachReviewDocument, { review: proof.firstReview }),
  )
  assert.equal((markup.match(/data-outreach-member=/gu) ?? []).length, 50)
  assert.ok(markup.includes('Synthetic original body'))
  assert.ok(markup.includes('/admin/prospects/SYN-OUTREACH-ORG-001?venue=SYN-OUTREACH-VENUE-001'))
  assert.ok(!/<button[^>]*>Send/iu.test(markup))
  const malicious = structuredClone(proof.firstReview)
  malicious.rows[0].draft.body = '<img src=x onerror=alert(1)>'
  const escaped = renderToStaticMarkup(
    createElement(ProspectOutreachReviewDocument, { review: malicious }),
  )
  assert.ok(!escaped.includes('<img src=x'))
  assert.ok(escaped.includes('&lt;img'))
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'"><title>Torchiko — synthetic exact outreach review</title><style>
  body{font-family:Segoe UI,Arial,sans-serif;background:#f4f7f6;color:#172b27;margin:0;padding:28px;line-height:1.5}main{max-width:1060px;margin:auto}header,article{background:white;border:1px solid #d5dfdc;border-radius:12px;padding:24px;margin:18px 0}h2{font-size:26px;margin:5px 0}h3{font-size:20px;margin:0}h4{font-size:17px}p{margin:10px 0}a{color:#116653}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}details{border-top:1px solid #ddd;padding-top:12px}summary{cursor:pointer;font-weight:600}header>p:first-child{font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#116653}.font-mono{font-family:Consolas,monospace;font-size:11px;overflow-wrap:anywhere}.text-xs{font-size:12px}.text-sm{font-size:14px}.flex{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}[role=note]{padding:12px;border-left:3px solid #996b1d;background:#fff5df}.banner{background:#e2eeea;border-radius:10px;padding:16px} @media(max-width:600px){body{padding:12px}header,article{padding:16px}}
  </style></head><body><main><div class="banner"><strong>Synthetic acceptance rendering — not a deployed or authenticated CRM session.</strong><p>This is the same React review presenter used by the new normal-admin page, with local fixture styling. All 50 native acceptance members remain below. No provider account or send control is present.</p></div>${markup}</main></body></html>`
  const htmlPath = path.join(qa, `outreach-review-synthetic-${run}.html`)
  await writeFile(htmlPath, html, { flag: 'wx' })
  await writeFile(
    path.join(qa, `REVIEW-RENDER-PROOF-${run}.json`),
    JSON.stringify(
      {
        passed: true,
        count: 50,
        exactModelOrSourceTextEscaped: true,
        nativeVenueLinks: true,
        noSendControl: true,
        presenter: 'apps/dashboard/components/admin/ProspectOutreachReviewDocument.tsx',
        sourceProof: input,
        htmlPath,
        scope:
          'Shared React SSR presenter with local fixture CSS; not normal authenticated end-to-end browser proof',
      },
      null,
      2,
    ),
    { flag: 'wx' },
  )
  console.log(JSON.stringify({ passed: true, count: 50, html: htmlPath }))
}
void main().catch((error) => {
  console.error(error.stack)
  process.exitCode = 1
})
