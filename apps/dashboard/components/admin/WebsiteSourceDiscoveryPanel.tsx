'use client'

import { useEffect, useState } from 'react'
import type {
  WebsitePdfExtractionFailure,
  WebsiteSourceDiscovery,
  WebsiteSourceDiscoveryDisposition,
} from '@pathfinder/contracts/intake-engine'

type Props = {
  review: {
    receiptId: string
    status: 'RECORDED' | 'NOT_RECORDED' | 'INVALID'
    sourceHost: string | null
    inventory: WebsiteSourceDiscovery | null
  }
}

const labels: Record<WebsiteSourceDiscoveryDisposition, string> = {
  FETCHED_TEXT: 'Text collected',
  PDF_TEXT_EXTRACTED: 'PDF text collected',
  PDF_EXTRACTION_FAILED: 'PDF text unavailable',
  TIME_LIMIT: 'Crawl time limit reached',
  UNSUPPORTED_DOCUMENT: 'Document format not supported',
  UNSUPPORTED_VIDEO: 'Video / audio · adapter unavailable',
  UNSUPPORTED_IMAGE: 'Image · adapter unavailable',
  UNSUPPORTED_OTHER: 'Format not supported',
  ROBOTS_DENIED: 'Access denied by robots policy',
  DEPTH_LIMIT: 'Beyond crawl depth',
  PAGE_LIMIT: 'Beyond page budget',
}

const pdfFailureLabels: Record<WebsitePdfExtractionFailure, string> = {
  PDF_PASSWORD_REQUIRED: 'Password required',
  PDF_NO_EXTRACTABLE_TEXT: 'No extractable text',
  PDF_TOO_MANY_PAGES: 'Page-count limit exceeded',
  PDF_EXTRACTION_TIMEOUT: 'Extraction timed out',
  PDF_TOO_LARGE: 'PDF size limit exceeded',
  PDF_PARSE_FAILED: 'PDF could not be parsed',
  UNSAFE_TEXT_CONTROL: 'Unsafe text control detected',
  TEXT_TOO_LARGE: 'Extracted text limit exceeded',
  PDF_EXTRACTION_CANCELLED: 'Extraction cancelled',
}

export function WebsiteSourceDiscoveryPanel({ review }: Props) {
  const [page, setPage] = useState(0)
  useEffect(() => setPage(0), [review.receiptId])
  const inventory = review.inventory
  if (review.status !== 'RECORDED' || !inventory)
    return (
      <p className="mt-4 text-sm text-pf-deep/75" role="status">
        {review.status === 'INVALID'
          ? 'The retained source inventory could not be validated. Its links are unavailable.'
          : 'This research receipt has no retained source inventory. Source breadth is unknown.'}
      </p>
    )
  const webTextCount = inventory.items.filter((item) => item.disposition === 'FETCHED_TEXT').length
  const pdfTextCount = inventory.items.filter(
    (item) => item.disposition === 'PDF_TEXT_EXTRACTED',
  ).length
  const textCount = webTextCount + pdfTextCount
  const duplicateCount = inventory.items.filter((item) => item.duplicateOf).length
  const pageCount = Math.max(1, Math.ceil(inventory.items.length / 20))
  const currentPage = Math.min(page, pageCount - 1)
  const items = inventory.items.slice(currentPage * 20, (currentPage + 1) * 20)
  return (
    <details className="mt-4 border-t border-slate-200 pt-4">
      <summary className="min-h-11 cursor-pointer text-sm font-semibold text-pf-deep">
        Source inventory · {inventory.items.length} references · {textCount} collected text sources
      </summary>
      <p className="mt-2 break-words text-sm text-pf-deep/80">
        Discovered on the submitted website, {review.sourceHost}. Website ownership and topic
        coverage have not been verified.
      </p>
      <p className="mt-1 text-xs leading-5 text-pf-deep/75">
        Observed <time dateTime={inventory.observedAt}>{inventory.observedAt}</time>. This is
        collection time, not the source publication or update date. {duplicateCount} exact-byte
        repeats; repeated pages are not independent corroboration.
      </p>
      <p className="mt-2 text-xs leading-5 text-pf-deep/75">
        {inventory.policyVersion === 1
          ? 'This historical policy did not extract PDF text. '
          : `Collected text includes ${webTextCount} web page${webTextCount === 1 ? '' : 's'} and ${pdfTextCount} PDF${pdfTextCount === 1 ? '' : 's'}. PDFs are parsed for embedded text only; this is not OCR and images are not verified maps. `}
        Other document, video/audio and image formats remain discovery gaps. Links outside the
        allowed website are not collected.
      </p>
      {inventory.omittedCount > 0 ? (
        <p className="mt-2 text-sm text-amber-950">
          {inventory.omittedCount} additional reference observations were omitted at the inventory
          bound.
        </p>
      ) : null}
      {items.length === 0 ? (
        <p className="mt-3 text-sm">No source references were retained.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-200">
          {items.map((item) => (
            <li
              key={item.url}
              className="grid min-w-0 gap-1 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_13rem] sm:gap-x-4"
            >
              <div className="min-w-0">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="break-all font-medium text-sky-800 underline underline-offset-2"
                >
                  {item.url}
                </a>
                {item.parentUrl ? (
                  <p className="mt-1 break-all text-xs text-pf-deep/75">
                    Linked from {item.parentUrl}
                  </p>
                ) : null}
                {item.duplicateOf ? (
                  <p className="mt-1 break-all text-xs text-pf-deep/75">
                    Same received bytes as {item.duplicateOf}
                  </p>
                ) : null}
                {item.exactByteHash ? (
                  <details className="mt-1 text-xs text-pf-deep/75">
                    <summary className="cursor-pointer py-1">Received-byte fingerprint</summary>
                    <p className="break-all font-mono">{item.exactByteHash}</p>
                  </details>
                ) : null}
              </div>
              <div className="text-xs leading-5 text-pf-deep/80">
                <p className="font-semibold">{labels[item.disposition]}</p>
                {item.extractionFailureCode ? (
                  <p className="font-medium text-amber-900">
                    {pdfFailureLabels[item.extractionFailureCode]}
                  </p>
                ) : null}
                <p>
                  Depth {item.depth}
                  {item.byteSize !== undefined
                    ? ` · ${item.byteSize.toLocaleString()} bytes received`
                    : ' · not downloaded'}
                </p>
                {item.contentType ? <p className="break-all">{item.contentType}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {pageCount > 1 ? (
        <nav
          aria-label="Source inventory pages"
          className="mt-3 flex flex-wrap items-center gap-3 text-sm"
        >
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
            className="min-h-11 rounded-lg border border-slate-300 px-3 disabled:opacity-50"
          >
            Previous sources
          </button>
          <span>
            Page {currentPage + 1} of {pageCount}
          </span>
          <button
            type="button"
            disabled={currentPage + 1 >= pageCount}
            onClick={() => setPage(currentPage + 1)}
            className="min-h-11 rounded-lg border border-slate-300 px-3 disabled:opacity-50"
          >
            Next sources
          </button>
        </nav>
      ) : null}
    </details>
  )
}
