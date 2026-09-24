import test from 'node:test'
import assert from 'node:assert/strict'
import { fullPrismaSchemaTokenHash as hash } from './lib/outreach-prisma-schema-contract.mjs'

test('full-schema admission permits only alignment and comment differences', () => {
  assert.equal(hash('model A {\n id String @id\n text String @default("two words")\n}'),
    hash('// generated formatting\r\nmodel A {\r\n  id       String @id\r\n  text     String @default("two words")\r\n}'))
})
test('full-schema admission rejects omitted models, changed fields and literal whitespace', () => {
  const a = 'model A { id String @id text String @default("two words") }'
  for (const changed of [a + '\nmodel B { id String @id }', a.replace('String @id', 'Int @id'),
    a.replace('two words', 'two  words'), a.replace('text String', 'textString')])
    assert.notEqual(hash(a), hash(changed))
})
test('quoted comment markers and escaped quotes remain exact schema content', () => {
  const a = String.raw`model A { text String @default("https://example.invalid/a /* literal */ \"quoted\"") }`
  assert.equal(hash(a), hash('/* ignored */\n' + a))
  assert.notEqual(hash(a), hash(a.replace('literal', 'changed')))
})
test('malformed and empty schema text cannot receive an admission hash', () => {
  assert.throws(() => hash('model A { text String @default("unterminated) }'))
  assert.throws(() => hash('/* unterminated'))
  assert.throws(() => hash(' // comment only\n'))
  assert.throws(() => hash(''))
})
