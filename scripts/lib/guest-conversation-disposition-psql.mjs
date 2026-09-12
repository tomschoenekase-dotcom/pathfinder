import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { GuestConversationDispositionRefusal } from '../../packages/contracts/src/guest-conversation-disposition.runtime.mjs'
const refusalCodes = new Set(GuestConversationDispositionRefusal.options)

/** Persistent psql channel. No credentials, .env, shell or SQL in command argv.
 * Each result is acknowledged only after the post-command psql marker. A timeout,
 * malformed output or process loss irreversibly retires this connection.
 */
export class DispositionPsqlSession {
  constructor(command, args, { env, timeoutMs = 40000, maxBytes = 4 * 1024 * 1024 } = {}) {
    this.pending = null
    this.retired = false
    this.buffer = ''
    this.stderrBytes = 0
    this.stderrText = ''
    this.serverRefusal = null
    this.stderrHash = createHash('sha256')
    this.timeoutMs = timeoutMs
    this.maxBytes = maxBytes
    this.child = spawn(command, args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stdout.on('data', (bytes) => this.consume(bytes))
    this.child.stderr.on('data', (bytes) => {
      this.stderrBytes += bytes.length
      this.stderrHash.update(bytes)
      if (this.stderrBytes <= 65536) {
        this.stderrText += bytes.toString('utf8')
        for (const line of this.stderrText.split(/\r?\n/u)) {
          const match = /^ERROR:\s+([A-Z_]+)\s*$/u.exec(line)
          if (match && refusalCodes.has(match[1])) this.serverRefusal = match[1]
        }
      }
      if (this.stderrBytes > 65536) this.fail('PSQL_STDERR_BOUND')
    })
    this.child.on('error', () => this.fail('PSQL_SPAWN_FAILED'))
    this.child.on('exit', () => this.fail('PSQL_CONNECTION_ENDED'))
  }
  fail(code) {
    code = this.serverRefusal ?? code
    this.retired = true
    if (this.pending) {
      clearTimeout(this.pending.timer)
      const { reject } = this.pending
      this.pending = null
      reject(Object.assign(new Error(code), { code }))
    }
    this.child.stdin.destroy()
    // Retire only this exact process; never terminate a database backend or any
    // other operator process. A sent statement may already have committed.
    if (this.child.exitCode === null) this.child.kill()
  }
  consume(bytes) {
    this.buffer += bytes.toString('utf8')
    if (Buffer.byteLength(this.buffer) > this.maxBytes) {
      this.fail('PSQL_OUTPUT_BOUND')
      return
    }
    while (this.buffer.includes('\n')) {
      const index = this.buffer.indexOf('\n')
      const line = this.buffer.slice(0, index).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(index + 1)
      const pending = this.pending
      if (!pending) {
        this.fail('PSQL_UNEXPECTED_OUTPUT')
        return
      }
      pending.bytes += Buffer.byteLength(line) + 1
      if (pending.bytes > this.maxBytes) {
        this.fail('PSQL_OUTPUT_BOUND')
        return
      }
      if (line === pending.marker) {
        clearTimeout(pending.timer)
        this.pending = null
        if (pending.lines.length !== 1 || this.stderrBytes !== pending.stderrStart) {
          pending.reject(
            Object.assign(new Error('PSQL_RESULT_REFUSED'), { code: 'PSQL_RESULT_REFUSED' }),
          )
          this.fail('PSQL_RESULT_REFUSED')
          return
        }
        try {
          pending.resolve(JSON.parse(pending.lines[0]))
        } catch {
          pending.reject(
            Object.assign(new Error('PSQL_JSON_REFUSED'), { code: 'PSQL_JSON_REFUSED' }),
          )
          this.fail('PSQL_JSON_REFUSED')
        }
      } else if (line) pending.lines.push(line)
    }
  }
  query(sql) {
    if (this.retired || this.pending)
      return Promise.reject(
        Object.assign(new Error('PSQL_SESSION_UNAVAILABLE'), { code: 'PSQL_SESSION_UNAVAILABLE' }),
      )
    const marker = 'GUEST_DISPOSITION_' + randomBytes(16).toString('hex')
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        marker,
        lines: [],
        bytes: 0,
        stderrStart: this.stderrBytes,
        timer: setTimeout(() => this.fail('PSQL_QUERY_TIMEOUT'), this.timeoutMs),
      }
      this.child.stdin.write(sql.replace(/;\s*$/u, '') + ';\n\\echo ' + marker + '\n', (error) => {
        if (error) this.fail('PSQL_WRITE_UNCONFIRMED')
      })
    })
  }
  async close() {
    if (this.retired) return
    if (this.pending) {
      this.fail('PSQL_CLOSE_DURING_QUERY')
      return
    }
    this.retired = true
    this.child.stdin.end('\\q\n')
    await new Promise((resolve) => {
      if (this.child.exitCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        this.child.kill()
        resolve()
      }, 2000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}
