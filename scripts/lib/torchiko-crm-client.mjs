/** One-shot client for the EXISTING opt-in local CRM surface. No server, worker,
 * credentials, synthetic AgentRun, arbitrary URL or general RPC forwarding.
 * The receiving route owns its SYSTEM recorder; this client never supplies one. */
import { open, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BASE = 'http://127.0.0.1:58618'
const DIRECTORY = '/dev-fixtures/prospect-research/data'
const SALES = '/dev-fixtures/prospect-research/sales'
const GEOGRAPHY = '/dev-fixtures/prospect-research/territories/data'
const HASH = /^[a-f0-9]{64}$/u
const MAX_RESPONSE = 2_000_000
const GUIDE_RELATIVE = ['95 AI Staging', 'Torchiko Sales Writing Reference 2026-09-21',
  'v0.2-r001', 'TORCHIKO-WRITING-REFERENCE.md']

export class CrmClientError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CrmClientError'
    this.code = code
  }
}
const fail = (code, message) => { throw new CrmClientError(code, message) }
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 191 || /[\r\n\0]/u.test(value))
    fail('INVALID_ID', 'Use the exact native ID returned by a CRM read.')
  return value
}
function exact(value, keys, required = keys) {
  if (!object(value) || Object.keys(value).some((key) => !keys.includes(key)) ||
      required.some((key) => !(key in value)))
    fail('INVALID_INPUT', 'Unexpected or missing fields. Actors, approvals and arbitrary RPC are not accepted.')
}
function inputJson(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 60_000)
    fail('INPUT_TOO_LARGE', 'One UTF-8 JSON input of at most 60,000 bytes is required.')
  try { return JSON.parse(raw.replace(/^\uFEFF/u, '')) }
  catch { fail('INVALID_JSON', 'Use one JSON object, not Markdown, an archive or a file path.') }
}
/** Explicit small JSON file inside this checkout. No HTTP path, UNC share,
 * archive, symlink escape, implicit encoding conversion or source-file execution. */
export async function readLocalCrmInput(file) {
  if (typeof file !== 'string' || !file || file.length > 4096 ||
      /^(?:[\\/]{2}|[a-z][a-z0-9+.-]*:\/\/)/iu.test(file) || path.extname(file).toLowerCase() !== '.json')
    fail('INVALID_INPUT_FILE', 'Select one local .json file inside this CRM checkout, not a URL, share or archive.')
  let handle
  try {
    const actual = await realpath(path.resolve(file))
    const relative = path.relative(await realpath(ROOT), actual)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
      fail('INVALID_INPUT_FILE', 'Input must remain inside this CRM checkout after resolving links.')
    handle = await open(actual, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 60_000)
      fail('INPUT_TOO_LARGE', 'Select a regular JSON file of at most 60,000 bytes.')
    const bytes = Buffer.alloc(60_001)
    let used = 0
    while (used < bytes.length) {
      const part = await handle.read(bytes, used, bytes.length - used, null)
      if (part.bytesRead === 0) break
      used += part.bytesRead
    }
    if (used > 60_000) fail('INPUT_TOO_LARGE', 'The input file grew beyond the bounded result size.')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used))
  } catch (error) {
    if (error instanceof CrmClientError) throw error
    fail('INVALID_INPUT_FILE', 'The selected local JSON file could not be read as bounded UTF-8.')
  } finally { await handle?.close() }
}
/** Select the one owner-supplied compact guide explicitly. Only these bounded
 * bytes cross into native preparation; the rest of the vault stays local. */
export async function readTorchikoWritingGuide(vaultRoot = process.env.TORCHIKO_CRM_VAULT) {
  if (typeof vaultRoot !== 'string' || !path.isAbsolute(vaultRoot))
    fail('WRITING_GUIDE_UNAVAILABLE', 'Set TORCHIKO_CRM_VAULT to the local AwesomeVault path before selecting the Torchiko guide.')
  let handle
  try {
    const root = await realpath(vaultRoot)
    const guide = await realpath(path.join(root, ...GUIDE_RELATIVE))
    if (path.relative(root, guide) !== path.join(...GUIDE_RELATIVE))
      fail('WRITING_GUIDE_UNAVAILABLE', 'The selected guide moved outside its exact owner path.')
    handle = await open(guide, 'r')
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > 32_000)
      fail('WRITING_GUIDE_TOO_LARGE', 'The selected guide exceeds the native 32,000-byte limit; select complete relevant sections explicitly.')
    const bytes = Buffer.alloc(32_001)
    let used = 0
    while (used < bytes.length) {
      const part = await handle.read(bytes, used, bytes.length - used, null)
      if (!part.bytesRead) break
      used += part.bytesRead
    }
    if (used > 32_000) fail('WRITING_GUIDE_TOO_LARGE', 'The guide changed while reading and now exceeds 32,000 bytes.')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used))
    if (!text.trim() || text.length > 20_000 || text.includes('\0'))
      fail('WRITING_GUIDE_TOO_LARGE', 'The selected guide is empty or exceeds the native text limit; select complete sections explicitly.')
    return { label: 'Torchiko sales writing reference v0.2',
      sourceRef: 'torchiko-writing-reference:v0.2-r001/TORCHIKO-WRITING-REFERENCE.md',
      text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') }
  } catch (error) {
    if (error instanceof CrmClientError) throw error
    fail('WRITING_GUIDE_UNAVAILABLE', 'The selected Torchiko guide could not be read as bounded UTF-8 from the configured local vault.')
  } finally { await handle?.close() }
}
function nativeView(value, venueId, allowReceiptOnly = false) {
  if (allowReceiptOnly && object(value) &&
      value.schema === 'torchiko.native-writer-import-receipt-only/1' &&
      value.currentViewAvailable === false && value.venueId === venueId &&
      HASH.test(value.originalSnapshotHash ?? '') &&
      typeof value.writerImportReceipt?.id === 'string' &&
      typeof value.writerImportReceipt?.draftId === 'string' &&
      typeof value.writerImportReceipt.replayed === 'boolean' &&
      value.SEND_AUTHORIZED === false && value.senderAvailable === false)
    return value
  if (!object(value) || value.venueId !== venueId || !HASH.test(value.snapshotHash ?? '') ||
      value.SEND_AUTHORIZED !== false || value.senderAvailable !== false)
    fail('INVALID_CRM_RESPONSE', 'The response is not an exact native no-send workflow.')
  return value
}
async function boundedResponse(response) {
  if (!response.body) fail('INVALID_CRM_RESPONSE', 'The CRM returned no response body.')
  const reader = response.body.getReader(), chunks = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_RESPONSE) {
        await reader.cancel()
        fail('RESPONSE_TOO_LARGE', 'Select a smaller CRM scope; no response was silently truncated.')
      }
      chunks.push(Buffer.from(part.value))
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { fail('INVALID_CRM_RESPONSE', 'The existing local CRM did not return JSON.') }
}

export const crmUsage = `Torchiko local CRM client (not a configured Codex MCP server)
  node scripts/torchiko.mjs crm status
  node scripts/torchiko.mjs crm territories --stdin
  node scripts/torchiko.mjs crm geography <native-venue-id>
  node scripts/torchiko.mjs crm geography-search --stdin
  node scripts/torchiko.mjs crm geography-proposals --stdin
  node scripts/torchiko.mjs crm geography-propose --stdin
  node scripts/torchiko.mjs crm search --stdin
  node scripts/torchiko.mjs crm read <native-venue-id>
  node scripts/torchiko.mjs crm task <native-venue-id>
  node scripts/torchiko.mjs crm prepare --stdin
  node scripts/torchiko.mjs crm submit --stdin
  node scripts/torchiko.mjs crm prepare --input <local-input.json>
  node scripts/torchiko.mjs crm prepare --with-torchiko-guide --input <local-input.json>
  node scripts/torchiko.mjs crm prepare --with-torchiko-guide --stdin
  node scripts/torchiko.mjs crm submit --input <local-result.json>

search input: {"search":"explicit query","limit":10,"cursor":"optional returned cursor"}
territories input: {"query":"Chicago","page":1,"limit":25}; optional exact code, state, corridor.
geography-search input: {"query":"museum","status":"HELD","page":1,"limit":25}; optional legacyTerritoryId, territoryCode, state.
geography-proposals input: {"venueId":"exact native ID","page":1,"limit":20,"status":"OPEN"}.
geography-propose input: exact current venue/time/geography revision, registry hash and physical-county evidence.
Geography proposals enter the existing review queue. This client cannot approve, assign counties or send.
prepare input: {"venueId":"exact ID","expectedSnapshotHash":"exact read hash"}
Optional prepare fields: answerText; selectedThreadId (exact returned thread candidate); writingReference={label,sourceRef,text,sha256}.
Reference text is selected guidance, not venue evidence or approved reusable language.
--with-torchiko-guide reads only the exact selected v0.2 guide from TORCHIKO_CRM_VAULT and binds its current UTF-8 hash.
submit input: one exact torchiko.native-writer-result/1 object from an exported task.
No implicit search paging, preparation, re-export, retry, approval, release or send.
This client neither starts the preview nor changes Codex, account or authentication settings.
`

/** fetch injection is for deterministic tests, never a CLI URL/transport override. */
export function createLocalCrmClient(fetchImpl = globalThis.fetch) {
  async function request(relative, body) {
    const mutation = body !== undefined
    const writerImport = body?.action === 'importWriterResult'
    const encoded = mutation ? JSON.stringify(body) : undefined
    if (encoded && Buffer.byteLength(encoded, 'utf8') > 64_000)
      fail('INPUT_TOO_LARGE', 'The wrapped request exceeds the existing 64,000-byte CRM boundary.')
    let response
    try {
      response = await fetchImpl(BASE + relative, {
        method: mutation ? 'POST' : 'GET',
        redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
        headers: {
          Accept: 'application/json',
          ...(mutation ? { Origin: BASE, 'Content-Type': 'application/json', 'X-Torchiko-No-Send': '1' } : {}),
        },
        ...(mutation ? { body: encoded } : {}),
      })
    } catch {
      fail(relative === GEOGRAPHY && mutation ? 'GEOGRAPHY_PROPOSAL_OUTCOME_UNCONFIRMED' : writerImport ? 'IMPORT_OUTCOME_UNCONFIRMED'
        : mutation ? 'PREPARATION_OUTCOME_UNCONFIRMED' : 'LOCAL_CRM_UNAVAILABLE',
      relative === GEOGRAPHY && mutation
        ? 'The proposal response was not confirmed. Retry only the identical proposal and idempotency key; do not invent a new approval.'
        : writerImport
        ? 'The response was not confirmed. Retry only the identical result; an already committed writer result is recovered by its immutable native receipt. Do not regenerate the task or change the result.'
        : mutation
          ? 'The preparation response was not confirmed. Read the current CRM record before preparing again; no writer import receipt applies to preparation.'
          : 'The existing opt-in loopback CRM is unavailable. No preview, mailbox or worker was started.')
    }
    if ([301, 302, 303, 307, 308].includes(response.status))
      fail('REDIRECT_REFUSED', 'The local CRM client never follows redirects to another target.')
    let value
    try { value = await boundedResponse(response) }
    catch (error) {
      if (mutation)
        fail(relative === GEOGRAPHY ? 'GEOGRAPHY_PROPOSAL_OUTCOME_UNCONFIRMED' : writerImport ? 'IMPORT_OUTCOME_UNCONFIRMED' : 'PREPARATION_OUTCOME_UNCONFIRMED',
          relative === GEOGRAPHY
            ? 'The proposal response was lost. Retry only the identical proposal and key; no approval authority is available.'
            : writerImport
            ? 'The result response was lost. Retry only the identical result; the native receipt reconciles an already committed import.'
            : 'The preparation response was lost. Read the current CRM record before preparing again.')
      if (error instanceof CrmClientError) throw error
      fail('INVALID_CRM_RESPONSE', 'The CRM response could not be read. Check the current record before another action.')
    }
    if (!response.ok) {
      const detail = object(value) && typeof value.error === 'string'
        ? value.error.slice(0, 2000) : 'The local CRM refused this operation.'
      fail(`CRM_HTTP_${response.status}`, detail)
    }
    return value
  }
  async function read(venueId) {
    identifier(venueId)
    return nativeView(await request(`${SALES}?venueId=${encodeURIComponent(venueId)}`), venueId)
  }
  async function search(query) {
    exact(query, ['search', 'limit', 'cursor'], ['search'])
    if (typeof query.search !== 'string' || !query.search.trim() || query.search.length > 200 ||
        (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 25)) ||
        (query.cursor !== undefined && (typeof query.cursor !== 'string' || !query.cursor || query.cursor.length > 1000)))
      fail('BOUNDED_SEARCH_REQUIRED', 'Supply an explicit query, at most 25 results, and only a returned cursor.')
    const envelope = await request(`${DIRECTORY}?input=${encodeURIComponent(JSON.stringify({ ...query, limit: query.limit ?? 10 }))}`)
    const value = envelope?.json
    if (!object(value) || !Array.isArray(value.items) ||
        !(value.nextCursor === null || typeof value.nextCursor === 'string'))
      fail('INVALID_CRM_RESPONSE', 'The existing directory did not return its bounded SuperJSON list.')
    return { representation: 'superjson', ...envelope, automaticPagination: false }
  }
  return {
    read, search,
    async territories(input) {
      exact(input,['query','code','state','corridor','page','limit'],[])
      return geographyRead('territories',input)
    },
    async geography(venueId) { return geographyRead('geography',{venueId:identifier(venueId)}) },
    async 'geography-search'(input) {
      exact(input,['query','status','state','legacyTerritoryId','territoryCode','countyGeoid','page','limit'],[])
      return geographyRead('records',input)
    },
    async 'geography-proposals'(input) {
      exact(input,['venueId','status','page','limit'],['venueId']);identifier(input.venueId)
      return geographyRead('proposals',input)
    },
    async 'geography-propose'(input) {
      exact(input,['idempotencyKey','venueId','expectedVenueUpdatedAt','expectedRevision','expectedRegistryHash','evidence'])
      identifier(input.venueId)
      if(!HASH.test(input.expectedRegistryHash??''))fail('EXACT_REGISTRY_REQUIRED','Read the current installed geography hash first.')
      const value=await request(GEOGRAPHY,{operation:'propose',input})
      if(!object(value?.json)||typeof value.json.receiptId!=='string'||value.json.venueId!==input.venueId||value.json.canonicalFieldsApplied!==false||value.json.outreachAuthorized!==false)
        fail('GEOGRAPHY_PROPOSAL_OUTCOME_UNCONFIRMED','The response lacked a proposal-only receipt. Retry the identical request.')
      return {representation:'superjson',...value,approvalAvailable:false}
    },
    async status() {
      // Exact empty-match diagnostic, not a prospect dump or a resource/ownership probe.
      const result = await search({ search: 'SYN-CRM-CONNECTION-PROBE-NOT-A-VENUE', limit: 1 })
      return {
        schema: 'torchiko.local-crm-connection/1', directoryReachable: Boolean(result),
        endpoint: BASE, route: 'EXISTING_OPT_IN_LOCAL_OPERATOR',
        codexMcpConfigured: 'NOT_ESTABLISHED_BY_THIS_HTTP_CHECK',
        authenticatedHuman: false, operationalDeploymentVerified: false,
        companyMailboxConnected: 'NOT_CHECKED', mutationPerformed: false, SEND_AUTHORIZED: false,
      }
    },
    async task(venueId) {
      const view = await read(venueId)
      if (!view.writerTask || view.preparation?.stale || view.writerHold)
        fail('WRITER_TASK_HELD', view.writerHold ?? 'Persist a current supported preparation explicitly first.')
      const task = view.writerTask
      if (task.schema !== 'torchiko.native-writer-task/1' || task.binding?.venueId !== venueId ||
          task.binding?.preparationId !== view.preparation?.id || task.SEND_AUTHORIZED !== false ||
          Buffer.byteLength(JSON.stringify(task), 'utf8') > 180_000)
        fail('INVALID_WRITER_TASK', 'The current persisted task did not match this exact native preparation.')
      return task
    },
    async prepare(input) {
      exact(input, ['venueId', 'expectedSnapshotHash', 'answerText', 'selectedThreadId', 'writingReference'], ['venueId', 'expectedSnapshotHash'])
      identifier(input.venueId)
      if (!HASH.test(input.expectedSnapshotHash ?? '')) fail('EXACT_SNAPSHOT_REQUIRED', 'Use the exact current snapshot hash.')
      return nativeView(await request(SALES, { action: 'prepare', input }), input.venueId)
    },
    async submit(result) {
      exact(result, ['schema', 'taskId', 'binding', 'generatedBy', 'subject', 'body', 'annotations', 'languageUses', 'assessment'])
      if (result.schema !== 'torchiko.native-writer-result/1' || !object(result.binding) ||
          result.generatedBy?.kind !== 'model' || (result.assessment && result.assessment.reviewer?.kind !== 'model'))
        fail('WRITER_RESULT_REQUIRED', 'Use the exact versioned model-result contract, not a human approval or source upload.')
      identifier(result.binding.venueId)
      if (!HASH.test(result.binding.nativeSnapshotHash ?? '') || Buffer.byteLength(JSON.stringify(result), 'utf8') > 60_000)
        fail('WRITER_RESULT_REQUIRED', 'Use a bounded exact native writer result.')
      // No GET/reprepare before POST: the exported binding remains authoritative input.
      // The original strict server schema, CAS and atomic draft/meaning owners validate it.
      const accepted = await request(SALES, {
        action: 'importWriterResult', input: {
          venueId: result.binding.venueId,
          expectedSnapshotHash: result.binding.nativeSnapshotHash, result,
        },
      })
      try {
        const confirmed = nativeView(accepted, result.binding.venueId, true)
        const receipt = confirmed.writerImportReceipt
        if (!object(receipt) || typeof receipt.id !== 'string' || !receipt.id ||
            typeof receipt.draftId !== 'string' || !receipt.draftId ||
            typeof receipt.replayed !== 'boolean')
          fail('INVALID_CRM_RESPONSE', 'The import response lacked an immutable native receipt.')
        return confirmed
      }
      catch (error) {
        if (error instanceof CrmClientError && error.code === 'INVALID_CRM_RESPONSE')
          fail('IMPORT_OUTCOME_UNCONFIRMED', 'The import response lacked an exact native receipt or view. Retry only the identical result to reconcile its immutable receipt.')
        throw error
      }
    },
  }
  async function geographyRead(operation,input) {
    const value=await request(`${GEOGRAPHY}?operation=${operation}&input=${encodeURIComponent(JSON.stringify(input))}`)
    if(!object(value?.json))fail('INVALID_CRM_RESPONSE','Expected the existing geography service SuperJSON response.')
    return {representation:'superjson',...value,automaticPagination:false,approvalAvailable:false}
  }
}

export async function runCrmCommand(args, readStdin, client = createLocalCrmClient()) {
  const [operation, ...rest] = args
  if (operation === 'help' && rest.length === 0) return { usage: crmUsage, SEND_AUTHORIZED: false }
  if (operation === 'status' && rest.length === 0) return client.status()
  if (['read', 'task','geography'].includes(operation) && rest.length === 1) return client[operation](rest[0])
  if (operation === 'prepare' && rest[0] === '--with-torchiko-guide' &&
      ((rest.length === 2 && rest[1] === '--stdin') ||
       (rest.length === 3 && rest[1] === '--input'))) {
    const input = inputJson(rest[1] === '--stdin'
      ? await readStdin(60_000) : await readLocalCrmInput(rest[2]))
    if (!object(input) || 'writingReference' in input)
      fail('INVALID_INPUT', 'The selected guide cannot replace an already supplied writing reference.')
    return client.prepare({ ...input, writingReference: await readTorchikoWritingGuide() })
  }
  if (['search', 'prepare', 'submit','territories','geography-search','geography-proposals','geography-propose'].includes(operation) && rest.length === 1 && rest[0] === '--stdin')
    return client[operation](inputJson(await readStdin(60_000)))
  if (['search', 'prepare', 'submit','territories','geography-search','geography-proposals','geography-propose'].includes(operation) && rest.length === 2 && rest[0] === '--input')
    return client[operation](inputJson(await readLocalCrmInput(rest[1])))
  fail('UNSUPPORTED_CRM_COMMAND', crmUsage)
}
