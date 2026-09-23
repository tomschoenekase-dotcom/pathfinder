import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalCrmClient, readLocalCrmInput, readTorchikoWritingGuide, runCrmCommand } from './lib/torchiko-crm-client.mjs'

const h = 'a'.repeat(64)
const view = { venueId: 'SYN-CRM-CLIENT', snapshotHash: h, SEND_AUTHORIZED: false, senderAvailable: false }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status })
const result = () => ({
  schema: 'torchiko.native-writer-result/1', taskId: 'writer-task_' + h,
  binding: { venueId: view.venueId, nativeSnapshotHash: h },
  generatedBy: { kind: 'model', identity: 'SYNTHETIC client unit writer' },
  subject: 'NON-SALES transport check', body: 'caf\u00e9 \u{1f33f}',
  annotations: [], languageUses: [], assessment: null,
})

test('reads the fixed existing local owner without credentials or redirects', async () => {
  const calls = []
  const client = createLocalCrmClient(async (...args) => { calls.push(args); return response(view) })
  assert.deepEqual(await client.read(view.venueId), view)
  assert.equal(calls[0][0], 'http://127.0.0.1:58618/dev-fixtures/prospect-research/sales?venueId=SYN-CRM-CLIENT')
  assert.equal(calls[0][1].credentials, 'omit')
  assert.equal(calls[0][1].redirect, 'error')
  assert.equal(calls[0][1].method, 'GET')
})
test('never substitutes a returned wrong venue', async () => {
  const client = createLocalCrmClient(async () => response({ ...view, venueId: 'wrong' }))
  await assert.rejects(client.read(view.venueId), { code: 'INVALID_CRM_RESPONSE' })
})
test('explicit preparation sends only native action data with the existing CSRF marker', async () => {
  let sent
  const client = createLocalCrmClient(async (_url, options) => { sent = options; return response(view) })
  const input = { venueId: view.venueId, expectedSnapshotHash: h }
  await client.prepare(input)
  assert.deepEqual(JSON.parse(sent.body), { action: 'prepare', input })
  assert.equal(sent.headers.Origin, 'http://127.0.0.1:58618')
  assert.equal(sent.headers['X-Torchiko-No-Send'], '1')
  await assert.rejects(client.prepare({ ...input, actor: 'admin' }), { code: 'INVALID_INPUT' })
})
test('result submission preserves Unicode and does not re-read or regenerate a stale task', async () => {
  const calls = []
  const client = createLocalCrmClient(async (...args) => {
    calls.push(args)
    return response({ error: 'STALE_WRITER_HEAD' }, 409)
  })
  const r = result()
  await assert.rejects(client.submit(r), { code: 'CRM_HTTP_409', message: 'STALE_WRITER_HEAD' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0][1].body).input.result, r)
})
test('ambiguous HTTP acceptance is not retried or reported as a failed database write', async () => {
  let calls = 0
  const client = createLocalCrmClient(async () => { calls++; throw new Error('lost response') })
  await assert.rejects(client.submit(result()), { code: 'IMPORT_OUTCOME_UNCONFIRMED' })
  assert.equal(calls, 1)
})
test('lost success body reports uncertain commit and permits exact caller retry', async () => {
  let calls = 0
  const receiptOnly = {
    schema: 'torchiko.native-writer-import-receipt-only/1', venueId: view.venueId,
    originalSnapshotHash: h, currentViewAvailable: false,
    writerImportReceipt: { id: 'immutable-receipt', draftId: 'draft-1', replayed: true },
    SEND_AUTHORIZED: false, senderAvailable: false,
  }
  const client = createLocalCrmClient(async () => {
    calls++
    return calls === 1
      ? new Response(new ReadableStream({ pull(controller) { controller.error(new Error('lost body')) } }), { status: 200 })
      : response(receiptOnly)
  })
  const exactResult = result()
  await assert.rejects(client.submit(exactResult), { code: 'IMPORT_OUTCOME_UNCONFIRMED' })
  assert.deepEqual(await client.submit(exactResult), receiptOnly)
  assert.equal(calls, 2)
})
test('a success-shaped import without a native receipt remains unconfirmed', async () => {
  const client = createLocalCrmClient(async () => response(view))
  await assert.rejects(client.submit(result()), { code: 'IMPORT_OUTCOME_UNCONFIRMED' })
})
test('uncertain preparation asks for a read instead of claiming import retry safety', async () => {
  const client = createLocalCrmClient(async () => { throw new Error('lost response') })
  await assert.rejects(client.prepare({ venueId: view.venueId, expectedSnapshotHash: h }),
    { code: 'PREPARATION_OUTCOME_UNCONFIRMED' })
})
test('selected guide is exact bounded UTF-8 content and changes require new binding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'torchiko-guide-'))
  t.after(async () => { if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true }) })
  const folder = join(root, '95 AI Staging', 'Torchiko Sales Writing Reference 2026-09-21', 'v0.2-r001')
  await mkdir(folder, { recursive: true })
  const file = join(folder, 'TORCHIKO-WRITING-REFERENCE.md')
  await writeFile(file, 'Selected café 🌿 guidance')
  const first = await readTorchikoWritingGuide(root)
  assert.equal(first.text, 'Selected café 🌿 guidance')
  assert.equal(first.sha256, createHash('sha256').update(first.text).digest('hex'))
  await writeFile(file, 'Selected café 🌿 guidance, revised')
  const second = await readTorchikoWritingGuide(root)
  assert.notEqual(first.sha256, second.sha256)
  const previousVault = process.env.TORCHIKO_CRM_VAULT
  process.env.TORCHIKO_CRM_VAULT = root
  try {
    const prepared = await runCrmCommand(['prepare', '--with-torchiko-guide', '--stdin'],
      async () => JSON.stringify({ venueId: view.venueId, expectedSnapshotHash: h }),
      { prepare: async (input) => input })
    assert.deepEqual(prepared.writingReference, second)
    await assert.rejects(runCrmCommand(['prepare', '--with-torchiko-guide', '--stdin'],
      async () => JSON.stringify({ venueId: view.venueId, expectedSnapshotHash: h, writingReference: first }),
      { prepare: async (input) => input }), { code: 'INVALID_INPUT' })
  } finally {
    if (previousVault === undefined) delete process.env.TORCHIKO_CRM_VAULT
    else process.env.TORCHIKO_CRM_VAULT = previousVault
  }
})
test('an immutable replay receipt is returned honestly when current CRM context cannot load', async () => {
  const receiptOnly = {
    schema: 'torchiko.native-writer-import-receipt-only/1',
    venueId: view.venueId, originalSnapshotHash: h,
    writerImportReceipt: { id: 'writer-import-old', draftId: 'draft-old',
      meaningReviewId: null, replayed: true },
    currentViewAvailable: false, SEND_AUTHORIZED: false, senderAvailable: false,
  }
  const client = createLocalCrmClient(async () => response(receiptOnly))
  assert.deepEqual(await client.submit(result()), receiptOnly)
  await assert.rejects(client.read(view.venueId), { code: 'INVALID_CRM_RESPONSE' })
})
test('client refuses human authorship, approval fields and arbitrary commands before HTTP', async () => {
  const client = createLocalCrmClient(async () => { throw new Error('MUST NOT CALL') })
  await assert.rejects(client.submit({ ...result(), approved: true }), { code: 'INVALID_INPUT' })
  await assert.rejects(client.submit({ ...result(), generatedBy: { kind: 'human', identity: 'Tom' } }), { code: 'WRITER_RESULT_REQUIRED' })
  for (const command of ['send', 'release', 'approve', 'activate', 'rpc'])
    await assert.rejects(runCrmCommand([command], async () => '', client), { code: 'UNSUPPORTED_CRM_COMMAND' })
})
test('directory queries are explicit and do not auto-page', async () => {
  let calls = 0
  const client = createLocalCrmClient(async () => {
    calls++
    return response({ json: { items: [], nextCursor: 'returned-cursor', totalCount: 0 } })
  })
  await assert.rejects(client.search({ search: '', limit: 100 }), { code: 'BOUNDED_SEARCH_REQUIRED' })
  const found = await client.search({ search: 'SYNTHETIC', limit: 1 })
  assert.equal(found.json.nextCursor, 'returned-cursor')
  assert.equal(found.automaticPagination, false)
  assert.equal(calls, 1)
})
test('task export is a read and fails visibly without a current preparation', async () => {
  const client = createLocalCrmClient(async () => response({ ...view, writerTask: null, writerHold: 'STALE_WRITER_TASK' }))
  await assert.rejects(client.task(view.venueId), { code: 'WRITER_TASK_HELD' })
})
test('input JSON and file boundaries reject archives, URLs, shares and authority payloads', async () => {
  for (const file of ['https://example.invalid/result.json', '\\\\host\\share\\result.json', 'bundle.zip'])
    await assert.rejects(readLocalCrmInput(file), { code: 'INVALID_INPUT_FILE' })
  await assert.rejects(runCrmCommand(['submit', '--stdin'], async () => 'not JSON'), { code: 'INVALID_JSON' })
  await assert.rejects(runCrmCommand(['submit', '--stdin'], async () => 'x'.repeat(60_001)), { code: 'INPUT_TOO_LARGE' })
})
test('stdin does not change the explicit model bytes or binding', async () => {
  const r = result()
  const returned = await runCrmCommand(['submit', '--stdin'], async () => JSON.stringify(r), {
    submit: async (input) => input,
  })
  assert.deepEqual(returned, r)
})
