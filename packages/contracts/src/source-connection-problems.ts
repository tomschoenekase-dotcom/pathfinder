/**
 * Plain-language meaning of every failure category and preview issue code the source-connection
 * pipeline records. The dashboard and the operator MCP both read this catalog so an operator never
 * sees a raw machine code. Lookup is case-insensitive: extraction issues are upper case, transport
 * and lifecycle categories are lower case.
 */
const SOURCE_CONNECTION_PROBLEMS: Readonly<Record<string, string>> = {
  // Transport (worker fetch adapter)
  network_error: 'The source could not be reached. The next check will retry.',
  timeout: 'The source took too long to respond. The next check will retry.',
  dns_failure: 'The source address could not be found. The next check will retry.',
  blocked_address: 'The source address points to a private or reserved network and is refused.',
  url_not_approved: 'The source address is not on this connection’s approved list.',
  redirect_blocked:
    'The source redirected somewhere that is not on the approved list. Add that exact address or fix the source URL.',
  redirect_forbidden:
    'The source redirected somewhere that is not on the approved list. Add that exact address or fix the source URL.',
  http_error: 'The source returned an error page instead of content.',
  content_type_invalid: 'The source is not the expected format (a web page or a JSON feed).',
  compressed_response_refused:
    'The source sent a compressed response, which is refused for safety.',
  payload_too_large: 'The source page is larger than the allowed size.',
  unexpected_not_modified: 'The source answered “unchanged” when no saved copy existed.',
  validator_invalid: 'The source sent unusable caching headers.',
  budget_exhausted: 'The daily request limit for this source is used up. Checks resume tomorrow.',
  attempt_limit:
    'The source failed several attempts in a row. The next scheduled check will retry.',
  config_invalid: 'The source setup is invalid and needs repair.',
  // Worker lifecycle
  invalid_config: 'The saved source setup is unreadable and needs repair before it can run.',
  origin_invalid:
    'The source website is no longer approved for this venue. Re-approve it in venue sources.',
  internal_error: 'Checking the source failed on our side. It will be retried.',
  cache_invalid: 'Saved comparison data was unusable. The next check fetches the full page.',
  review_required: 'Extracted changes need review before guests can see them.',
  publication_conflict:
    'Someone edited this content by hand, so the automatic update was held. Manual edits win.',
  // Extraction issues (preview and refresh)
  body_too_large: 'The source page is larger than the allowed size.',
  content_type_mismatch: 'The source is not the format this setup expects (web page or JSON feed).',
  structure_invalid: 'The page no longer matches this setup’s layout.',
  html_complexity_limit: 'The page is too complex to read safely.',
  html_depth_limit: 'The page is nested too deeply to read safely.',
  field_missing: 'A required field was not found on the page.',
  mapped_field_missing: 'A field in this setup was not found on the page.',
  field_invalid: 'A field on the page is empty or too long.',
  date_required: 'An item has no date, but this kind of information needs one.',
  date_invalid: 'A date on the page could not be read. Check the date format and its location.',
  date_ambiguous: 'A date has no year or could mean more than one day.',
  date_order_invalid: 'An item ends before it starts.',
  dst_gap: 'A time falls in a daylight-saving gap and cannot be read safely.',
  dst_ambiguous: 'A time falls in a repeated daylight-saving hour and cannot be read safely.',
  showtime_required: 'A showtime item has no times.',
  showtime_invalid: 'A showtime could not be read.',
  showtime_interval_invalid: 'A showtime ends before it starts or runs too long.',
  showtime_date_required: 'A showtime has no date.',
  showtime_date_mismatch: 'A showtime does not fall on its item’s date.',
  showtime_offset_required: 'A showtime has no time zone or offset.',
  showtime_zone_mismatch: 'A showtime uses a different time zone from this source.',
  showtime_structure_drift: 'The showtime layout on the page changed since it was approved.',
  cancellation_invalid: 'A cancellation marker could not be read.',
  exception_date_mismatch: 'An exception date falls outside its closure.',
  exception_limit: 'An item lists too many exception dates.',
  link_invalid: 'A link on the page could not be read.',
  link_limit: 'An item has too many links.',
  link_not_approved: 'A link on the page is not on the approved address list.',
  duplicate_record_conflict: 'Two items share an identifier but say different things.',
  record_count_drift: 'The page now has far more or far fewer items than expected.',
  record_structure_drift: 'The page layout changed since it was approved.',
}

export function describeSourceConnectionProblem(code: string): string {
  return (
    SOURCE_CONNECTION_PROBLEMS[code.toLowerCase()] ??
    `Something went wrong reading the source (code ${code.slice(0, 64)}).`
  )
}
