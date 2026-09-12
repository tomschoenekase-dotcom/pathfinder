import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import {
  assertGuestDispositionRuntimeBytes,
  renderGuestDispositionRuntime,
  verifyGuestDispositionRuntimeArtifacts,
} from './lib/guest-disposition-runtime-artifacts.mjs'
import {
  GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
  resolveGuestConversationDispositionPolicy,
} from '../packages/config/src/guest-conversation-disposition-policy.runtime.mjs'
import { GuestConversationDispositionRequest } from '../packages/contracts/src/guest-conversation-disposition.runtime.mjs'

test('committed runtime artifacts exactly match canonical TypeScript', async () => {
  await verifyGuestDispositionRuntimeArtifacts()
  assert.equal(
    GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
    '99c7e6170ebe8817d6bc4fed0c7964b52919bab083619de9fe19f1d21b8ce580',
  )
  assert.equal(
    resolveGuestConversationDispositionPolicy(
      'guest-conversations-terminal-text-v1',
      GUEST_CONVERSATION_DISPOSITION_POLICY_SHA256,
    ).retentionDays,
    365,
  )
  assert.equal(GuestConversationDispositionRequest.safeParse({}).success, false)
})

test('stale, empty and altered artifacts refuse and canonical CRLF generates identical LF', async () => {
  const name = 'packages/config/src/guest-conversation-disposition-policy.ts'
  const source = await readFile(new URL('../' + name, import.meta.url), 'utf8')
  const generated = renderGuestDispositionRuntime(source, name)
  for (const actual of ['', generated + '\n', generated.replace('365', '366')])
    assert.throws(
      () => assertGuestDispositionRuntimeBytes(source, actual, name),
      /Stale runtime artifact/u,
    )
  assert.equal(
    renderGuestDispositionRuntime(source.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'), name),
    generated,
  )
})
