import test from 'node:test'
import assert from 'node:assert/strict'
import {
  logicalConstraintDefinition as canonical,
  logicalEnumRows,
} from './lib/release269-logical-schema.mjs'

const source =
  "CHECK (state::text = ANY (ARRAY['OPEN'::character varying, 'CLOSED'::character varying]::text[]))"
const restored =
  "CHECK (state::text = ANY (ARRAY['OPEN'::character varying::text, 'CLOSED'::character varying::text]))"
test('logical restore constant-array cast forms compare equally and idempotently', () => {
  assert.equal(canonical(source), restored)
  assert.equal(canonical(restored), restored)
  assert.equal(canonical(source + ' AND ' + source), restored + ' AND ' + restored)
})
test('literal contents, restrictions, operators and array order remain significant', () => {
  for (const changed of [
    source.replace('OPEN', 'OPENED'),
    source.replace('ANY', 'ALL'),
    source.replace(' = ', ' <> '),
    source.replace('state::text', 'other_state::text'),
    source.replace("'OPEN'::character varying, 'CLOSED'", "'CLOSED'::character varying, 'OPEN'"),
    source.replace('CHECK (', 'CHECK (false AND '),
    source.replace('CHECK (', 'CHECK (true OR '),
  ])
    assert.notEqual(canonical(changed), canonical(source))
})
test('unknown cast, bounded varchar, expressions, null and mixed arrays are not normalized', () => {
  for (const value of [
    "ARRAY['OPEN'::character varying(4)]::text[]",
    'ARRAY[NULL::character varying]::text[]',
    "ARRAY[lower('OPEN')::character varying]::text[]",
    "ARRAY['OPEN'::character varying]",
    "ARRAY['OPEN'::character varying, 'CLOSED'::text]::text[]",
    "ARRAY[E'OPEN'::character varying]::text[]",
    "ARRAY['OPEN'::character varying]::citext[]",
    "ARRAY['OPEN'::character]::text[]",
    "MYARRAY['OPEN'::character varying]::text[]",
  ])
    assert.equal(canonical(value), value)
})
test('quoted SQL strings and identifiers cannot masquerade as arrays', () => {
  for (const value of [
    "CHECK (note = 'ARRAY[''OPEN''::character varying]::text[]')",
    'CHECK ("ARRAY[\'OPEN\'::character varying]::text[]" IS NULL)',
    "CHECK (note = $$ARRAY['OPEN'::character varying]::text[]$$)",
    "CHECK (note = $tag$ARRAY['OPEN'::character varying]::text[]$tag$)",
    "CHECK (note = E'quote\\\'ARRAY[''OPEN''::character varying]::text[]')",
  ])
    assert.equal(canonical(value), value)
})
test('apostrophes and SQL-like contents inside array values remain byte-exact', () => {
  const value =
    "ARRAY['it''s ARRAY[odd]'::character varying, '::text[]'::character varying]::text[]"
  assert.equal(
    canonical(value),
    "ARRAY['it''s ARRAY[odd]'::character varying::text, '::text[]'::character varying::text]",
  )
})
test('enum comparison retains type, labels and their relative order', () => {
  const row = (enumlabel, enumsortorder, typname = 'FixtureStatus') => ({
    typname,
    enumlabel,
    enumsortorder,
  })
  const a = [row('OPEN', 1), row('REVIEW', 1.5), row('CLOSED', 2)]
  const b = [row('OPEN', 1), row('REVIEW', 2), row('CLOSED', 3)]
  assert.deepEqual(logicalEnumRows(a), logicalEnumRows(b))
  for (const changed of [
    [row('REVIEW', 1), row('OPEN', 2), row('CLOSED', 3)],
    [row('OPEN', 1), row('CLOSED', 2)],
    [row('OPEN', 1), row('REVIEW', 2), row('CLOSED', 3, 'OtherStatus')],
  ])
    assert.notDeepEqual(logicalEnumRows(a), logicalEnumRows(changed))
  for (const invalid of [
    [row('OPEN', 1), row('CLOSED', 1)],
    [row('OPEN', 1), row('OPEN', 2)],
    [row('OPEN', NaN)],
  ])
    assert.throws(() => logicalEnumRows(invalid))
})

test('lowercase escape strings remain untouched', () => {
  const value = "CHECK (note = e'quote\\\'ARRAY[''OPEN''::character varying]::text[]')"
  assert.equal(canonical(value), value)
})
