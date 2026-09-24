import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, link, unlink } from 'node:fs/promises'
import path from 'node:path'

const taskPattern = /^writer-task_[a-f0-9]{64}$/u
const hashPattern = /^[a-f0-9]{64}$/u
const sha256 = value => createHash('sha256').update(value).digest('hex')
const fail = message => { const error = new Error(message); error.code = 'EXACT_RETRY_ARTIFACT_HELD'; throw error }
function validateResult(result) {
  if (!result || result.schema !== 'torchiko.native-writer-result/1' || !taskPattern.test(result.taskId) ||
      result.generatedBy?.kind !== 'model' || !result.binding || typeof result.binding !== 'object' ||
      typeof result.subject !== 'string' || typeof result.body !== 'string' || !Array.isArray(result.annotations) ||
      !Array.isArray(result.languageUses) || result.assessment !== null)
    fail('One exact model-authored native result is required. Retention does not grant native validity or approval.')
  const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n', 'utf8')
  if (bytes.length > 60000) fail('The native result exceeds the bounded private retry artifact size.')
  return bytes
}

/** Create-only exact request bodies, not a CRM or sending queue. No status,
 * recipient selection, current draft head or review approval is owned here. */
export function createOutreachRetryArtifacts(root) {
  async function directory(taskId, create = false) {
    if (!taskPattern.test(taskId)) fail('An exact native writer task ID is required.')
    const base = await realpath(root)
    let current = base
    for (const name of ['.outreach-retry', taskId]) {
      current = path.join(current, name)
      if (create) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
      let stat
      try { stat = await lstat(current) } catch (error) { if (!create && error.code === 'ENOENT') return null; throw error }
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(base, await realpath(current)).startsWith('..'))
        fail('Private retry directories must be ordinary directories inside the selected checkout.')
    }
    return current
  }
  async function read(taskId, hash) {
    if (!hashPattern.test(hash)) fail('An exact retained SHA-256 is required; no path or URL is accepted.')
    const dir = await directory(taskId)
    if (!dir) fail('No retained result exists for this task. Do not regenerate an uncertain import.')
    const file = path.join(dir, `${hash}.json`), stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 60000) fail('Retry artifact is not one bounded ordinary file.')
    const bytes = await readFile(file)
    if (sha256(bytes) !== hash) fail('Retained bytes changed. The original native outcome must be reconciled; nothing was imported.')
    const result = JSON.parse(bytes.toString('utf8')); validateResult(result)
    if (result.taskId !== taskId) fail('Retained task identity does not match the selected task.')
    return result
  }
  return {
    read,
    async retain(result) {
      const bytes = validateResult(result), hash = sha256(bytes), dir = await directory(result.taskId, true)
      const file = path.join(dir, `${hash}.json`), temporary = path.join(dir, `.${randomUUID()}.tmp`)
      let handle
      try {
        handle = await open(temporary, 'wx', 0o600); await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null
        try { await link(temporary, file) } catch (error) {
          if (error.code !== 'EEXIST') throw error
          await read(result.taskId, hash)
        }
      } finally { await handle?.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
      await read(result.taskId, hash)
      return { taskId: result.taskId, sha256: hash, file, bytes: bytes.length,
        kind: 'EXACT_NATIVE_REQUEST_BODY_ONLY', SEND_AUTHORIZED: false }
    },
    async locate(taskId) {
      const dir = await directory(taskId)
      if (!dir) return { taskId, artifacts: [], state: 'NO_RETAINED_RESULT', SEND_AUTHORIZED: false }
      const files = (await readdir(dir)).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).sort()
      if (files.length > 20) fail('More than twenty exact versions exist. Native receipt review is required; no partial list was substituted.')
      const artifacts = []
      for (const file of files) { const hash = file.slice(0, -5); await read(taskId, hash); artifacts.push({ sha256: hash, file: path.join(dir, file) }) }
      return { taskId, artifacts, state: artifacts.length === 1 ? 'ONE_EXACT_RETAINED_RESULT' : artifacts.length ? 'SELECT_EXACT_RETAINED_RESULT' : 'NO_RETAINED_RESULT', SEND_AUTHORIZED: false }
    },
  }
}
