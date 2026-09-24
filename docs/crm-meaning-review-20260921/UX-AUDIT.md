# Source-bound review: exercised UX audit

Source: `d67a625b2121144e674a86822c2ff667f80b0664`. Scope: existing native CRM review panel and the new claim/meaning section, not a website redesign or full-product usability certification.

The actual browser journey and receipts are under `artifacts/crm-meaning-review-20260921-r001/browser-r003/`.

## Inspected evidence

`source-bound-reviewed-desktop.png` shows separate read-acknowledgment and assessment states, exact recipient/source binding, six inspectable spans, source category/text/pointer/hash, an attributed review form, and recorded source mappings. The desktop layout uses a text-span column and a wider evidence column rather than another dashboard of cards.

`recorded-evidence-320.png` was visually inspected at narrow width. Source identifiers and hashes wrap within the column. Evidence and the no-send limitation remain legible; no horizontal document overflow was detected at 320px. The local Next development indicator is visible in some screenshots and is not part of the product interface.

`changed-inbound-stale-narrow.png` was visually inspected at 375px. The prominent stale state, historical evidence, disabled controls and retained original-source context remain distinguishable. Historical assessment text does not clear the new source-state hold.

The remaining screenshots cover unsupported claim inspection, retained unsupported findings, full narrow reviewed state and reply evidence. All seven images are retained without cropping away failures or source limitations.

## Interaction and accessibility

Keyboard Tab reached preparation with visible focus; Enter performed the real preparation action. Actual select/input controls were exercised for every span. The first browser run caught an implicit-select-label problem; independent `label`/`htmlFor`/control `id` associations now fix it, with a focused regression assertion.

Three automated WCAG A/AA scans passed with zero violations: desktop meaning review (21 passing rule groups), 375px meaning review (21), and 375px stale reply (18). Document widths at 1440, 375 and 320px matched their viewports. There were no uncaught JavaScript/hydration errors. These results do not establish a comprehensive screen-reader or human accessibility audit.

The form never assigns automatic factual support. Initial spans are visibly unreviewed; reviewers choose category, evidence, verdict and substantive reason. Mixed paragraphs can be split with exact Unicode code-point ranges, resetting the new spans to unreviewed. Source selection is described as an attributed mapping rather than entailment proof.

## Explicit limitations

This is a review interface, not a model that silently certifies copy. It retains failed findings and shows read acknowledgment separately from assessment. The actual reusable-language catalog is empty; there is no approval or send button. Long evidence is deliberately inspectable, with collapsible detail/history. Large historical ledgers are retained underneath a bounded recent-history projection; this pass did not add full-history pagination or conduct longitudinal human usability testing.

Desktop tool observation was unavailable. Proof here comes from a real installed Edge browser at desktop/narrow viewport sizes and visual inspection of its screenshots, not a claimed successful Desktop connector session.
