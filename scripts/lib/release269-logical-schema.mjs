import assert from 'node:assert/strict'

// A logical pg_dump restore assigns enum positions 1..n, while ADD VALUE can
// leave fractional positions. Preserve every type, label and comparison order.
export function logicalEnumRows(rows) {
  const groups = new Map()
  for (const row of rows) {
    assert.equal(typeof row.typname, 'string')
    assert.equal(typeof row.enumlabel, 'string')
    assert.ok(Number.isFinite(row.enumsortorder), 'release269-enum-position-invalid')
    const group = groups.get(row.typname) ?? []
    group.push(row)
    groups.set(row.typname, group)
  }
  return [...groups.values()].flatMap((group) => {
    assert.equal(new Set(group.map((row) => row.enumlabel)).size, group.length)
    assert.equal(new Set(group.map((row) => row.enumsortorder)).size, group.length)
    return [...group]
      .sort((left, right) => left.enumsortorder - right.enumsortorder)
      .map((row, index) => ({ ...row, enumsortorder: index + 1 }))
  })
}

// pg_restore can move a varchar[] -> text[] cast to each constant element.
// Match only that exact unbounded-varchar literal form. No expression, NULL,
// bounded type, identifier, predicate, operator or literal value is discarded.
function literalTextArray(source) {
  if (!source.startsWith('ARRAY[')) return null
  let offset = 6
  const items = []
  for (;;) {
    const match = /^('(?:[^']|'')*')::character varying(::text)?/u.exec(source.slice(offset))
    if (!match) return null
    items.push({ literal: match[1], text: Boolean(match[2]) })
    offset += match[0].length
    if (source.startsWith(', ', offset)) {
      offset += 2
      continue
    }
    if (source[offset] !== ']') return null
    offset++
    break
  }
  const outerText = source.startsWith('::text[]', offset)
  if (outerText) offset += 8
  if (!outerText && !items.every((item) => item.text)) return null
  return {
    length: offset,
    text: `ARRAY[${items.map((item) => `${item.literal}::character varying::text`).join(', ')}]`,
  }
}

export function logicalConstraintDefinition(definition) {
  let output = ''
  for (let offset = 0; offset < definition.length; ) {
    // Never rewrite text inside SQL strings or quoted identifiers. Backslash
    // strings and dollar quoting are uncommon in pg_get_constraintdef output,
    // but preserve them too instead of interpreting their contents as SQL.
    const rest = definition.slice(offset)
    const quoted = /^(?:[eE]'(?:\\.|[^']|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*")/u.exec(rest)
    if (quoted) {
      output += quoted[0]
      offset += quoted[0].length
      continue
    }
    const dollar = /^(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)/u.exec(rest)
    if (dollar) {
      const end = definition.indexOf(dollar[1], offset + dollar[1].length)
      if (end < 0) return definition
      const length = end + dollar[1].length - offset
      output += rest.slice(0, length)
      offset += length
      continue
    }
    const array =
      (offset === 0 || !/[A-Za-z0-9_$]/u.test(definition[offset - 1])) && literalTextArray(rest)
    if (array) {
      output += array.text
      offset += array.length
    } else {
      output += definition[offset++]
    }
  }
  return output
}
