import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chicagoAddInput, chicagoAppendEvidenceInput, chicagoChangeInput, chicagoEvidence, chicagoPublicUrl } from './chicago-intelligence-contract'

const evidence = { url: 'https://www.chicagoparkdistrict.com/parks', researchedAt: '2026-09-22', statement: 'Official venue page identifies the park and its visitor facilities.', firstParty: true }
const add = { idempotencyKey: 'admission-1', name: 'Venue fixture', city: 'Chicago', state: 'IL', territoryId: 'chicago', website: 'https://www.chicagoparkdistrict.com', evidence, territoryRationale: 'The official venue address is in Chicago.' }
const change = { idempotencyKey: 'change-1', venueId: 'venue-fixture', expectedVersion: 1, field: 'website', value: 'https://www.chicagoparkdistrict.com', evidence }

describe('Chicago public source admission', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-22T00:00:01Z')) })
  afterEach(() => vi.useRealTimers())

  it.each([
    'https://www.chicagoparkdistrict.com/parks?name=Lake%20Park#visit',
    'http://museum.example.org/visit', 'HTTPS://MUSEUM.EXAMPLE.ORG/visit',
    'https://www.museum.example.org./visit', 'https://museé.example.org/about',
  ])('accepts syntactically valid public domain URLs: %s', url => {
    expect(chicagoPublicUrl.safeParse(url).success).toBe(true)
    expect(chicagoEvidence.safeParse({ ...evidence, url }).success).toBe(true)
    expect(chicagoAddInput.safeParse({ ...add, website: url }).success).toBe(true)
    expect(chicagoChangeInput.safeParse({ ...change, value: url }).success).toBe(true)
  })

  it.each([
    'javascript:alert(1)', 'file:///C:/private.txt', 'ftp://museum.example.org',
    'data:text/html,Hello', '//museum.example.org/visit', 'https:////museum.example.org',
    'http://127.0.0.1', 'http://10.0.0.1', 'http://172.16.0.1', 'http://172.31.255.255',
    'http://192.168.1.1', 'http://169.254.169.254', 'http://0.0.0.0', 'http://100.64.0.1',
    'http://224.0.0.1', 'http://255.255.255.255', 'http://192.0.2.1', 'https://8.8.8.8',
    'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1', 'http://127.1',
    'http://[::1]', 'http://[::]', 'http://[fe80::1]', 'http://[fc00::1]',
    'http://[::ffff:127.0.0.1]', 'https://[2001:4860:4860::8888]',
    'http://localhost', 'http://child.localhost', 'http://localhost.',
    'http://museum.local', 'http://museum.internal', 'http://museum.intranet',
    'http://museum.lan', 'http://museum.home', 'http://museum.invalid', 'http://museum.test',
    'http://museum', 'http://museum..org', 'http://-museum.org', 'http://museum-.org',
    'http://museum_site.org', `https://${'a'.repeat(64)}.org`,
    'https://user:secret@museum.example.org', 'https://user@museum.example.org', 'https://@museum.example.org',
    'https://museum.example.org\\@127.0.0.1', 'https://museum.example.org\n/visit',
    'https://museum.example.org/visit with spaces',
  ])('rejects unsafe or malformed URL on evidence, addition and website change: %s', url => {
    expect(chicagoPublicUrl.safeParse(url).success).toBe(false)
    expect(chicagoEvidence.safeParse({ ...evidence, url }).success).toBe(false)
    expect(chicagoAddInput.safeParse({ ...add, website: url }).success).toBe(false)
    const result = chicagoChangeInput.safeParse({ ...change, value: url })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues.some(issue => issue.path[0] === 'value')).toBe(true)
  })

  it('does not turn ordinary non-website field values into URL validation', () => {
    expect(chicagoChangeInput.safeParse({ ...change, field: 'venueType', value: 'History museum' }).success).toBe(true)
    expect(chicagoChangeInput.safeParse({ ...change, field: 'description', value: 'Visitor information and history.' }).success).toBe(true)
  })

  it.each(['2024-02-29', '2026-02-28', '2026-09-22', '2000-02-29'])('accepts exact nonfuture calendar dates: %s', researchedAt => {
    expect(chicagoEvidence.safeParse({ ...evidence, researchedAt }).success).toBe(true)
  })

  it.each(['2026-02-29', '2026-02-30', '2026-02-31', '2024-02-30', '1900-02-29',
    '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-09-23',
    '2026-9-22', '2026-09-22T00:00:00Z', ' 2026-09-22', 'not-a-date'])('rejects rollover, malformed and future dates: %s', researchedAt => {
    expect(chicagoEvidence.safeParse({ ...evidence, researchedAt }).success).toBe(false)
    expect(chicagoAddInput.safeParse({ ...add, evidence: { ...evidence, researchedAt } }).success).toBe(false)
    expect(chicagoChangeInput.safeParse({ ...change, evidence: { ...evidence, researchedAt } }).success).toBe(false)
  })

  it('uses the UTC day at admission without caching today at module load', () => {
    vi.setSystemTime(new Date('2026-09-21T23:59:59Z'))
    expect(chicagoEvidence.safeParse(evidence).success).toBe(false)
    vi.setSystemTime(new Date('2026-09-22T00:00:00Z'))
    expect(chicagoEvidence.safeParse(evidence).success).toBe(true)
  })

  it('admits distinct supported observation kinds with no override or authority fields', () => {
    const envelope = { idempotencyKey: 'observation-1', venueId: 'venue', expectedVersion: 2, evidence }
    const observations = [
      { kind: 'fit', key: 'knowledgeRichness', value: 80, reason: 'Official collection pages provide substantial interpretive content.' },
      { kind: 'attainability', key: 'pilotScope', value: 60, reason: 'A single documented visitor center provides a bounded pilot.' },
      { kind: 'contact', channel: 'email', value: 'info@museum.example.org', roleRelevant: null },
      { kind: 'contact', channel: 'phone', value: '+1 (312) 555-0123 ext. 42', roleRelevant: false },
      { kind: 'contact', channel: 'form', value: 'https://museum.example.org/contact', roleRelevant: true },
      { kind: 'contact', channel: 'website', value: 'https://museum.example.org', roleRelevant: null },
      { kind: 'source' },
    ]
    for (const observation of observations) expect(chicagoAppendEvidenceInput.safeParse({ ...envelope, observation }).success).toBe(true)
    for (const observation of [
      { kind: 'source', override: 100 },
      { ...observations[0], value: 101 }, { ...observations[0], value: NaN },
      { ...observations[0], value: Infinity }, { ...observations[0], value: -1 },
      { ...observations[0], key: 'emailAvailable' }, { ...observations[1], key: 'knowledgeRichness' },
      { ...observations[0], reason: 'guess' }, { ...observations[0], actor: 'tom' },
      { kind: 'override', dimension: 'productFit', value: 100 },
    ]) expect(chicagoAppendEvidenceInput.safeParse({ ...envelope, observation }).success).toBe(false)
    expect(chicagoAppendEvidenceInput.safeParse({ ...envelope, observation: { kind: 'source' }, expectedVersion: 0 }).success).toBe(false)
  })

  it.each([
    ['email', 'not-an-email'], ['email', 'mailto:info@museum.example.org'], ['email', 'Name <info@museum.example.org>'], ['email', 'info@museum.local'],
    ['phone', '911'], ['phone', 'call the owner'], ['phone', '1'.repeat(16)],
    ['form', 'javascript:alert(1)'], ['website', 'file:///secret'], ['form', 'http://172.16.0.1'],
  ])('rejects invalid contact route syntax for %s: %s', (channel, value) => {
    expect(chicagoAppendEvidenceInput.safeParse({ idempotencyKey: 'contact-1', venueId: 'venue', expectedVersion: 1, evidence,
      observation: { kind: 'contact', channel, value, roleRelevant: null } }).success).toBe(false)
  })
})
