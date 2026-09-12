import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { DispositionPsqlSession } from './lib/guest-conversation-disposition-psql.mjs'

function fixture(mode) {
  const code = `let input='';process.stdin.on('data',b=>{input+=b;const match=input.match(/\\\\echo (GUEST_DISPOSITION_[a-f0-9]+)\\n/);if(!match)return;input='';const marker=match[1];switch(${JSON.stringify(mode)}){case 'delayed-marker':process.stdout.write('{"committed":true}\\n');setTimeout(()=>process.stdout.write(marker+'\\n'),100);break;case 'malformed':process.stdout.write('no-json\\n'+marker+'\\n');break;case 'multiple':process.stdout.write('{}\\n{}\\n'+marker+'\\n');break;case 'stderr':process.stderr.write('synthetic notice\\n',()=>setTimeout(()=>process.stdout.write('{}\\n'+marker+'\\n'),30));break;case 'loss':process.stdout.write('{"maybeCommitted":true}\\n',()=>process.exit(1));break;case 'timeout':break;}})`
  return new DispositionPsqlSession(process.execPath, ['-e', code], {
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
    timeoutMs: mode === 'timeout' ? 100 : 2000,
    maxBytes: 4096,
  })
}
test('result is not acknowledged before the post-command marker', async () => {
  const session = fixture('delayed-marker')
  let settled = false
  const promise = session.query('SELECT true').then((value) => {
    settled = true
    return value
  })
  await wait(50)
  assert.equal(settled, false)
  assert.deepEqual(await promise, { committed: true })
  await session.close()
})
for (const mode of ['malformed', 'multiple', 'stderr', 'loss', 'timeout']) {
  test(`${mode} retires exact channel and forbids later queries`, async () => {
    const session = fixture(mode)
    await assert.rejects(session.query('SELECT true'), /PSQL_/u)
    assert.equal(session.retired, true)
    await assert.rejects(session.query('SELECT false'), /PSQL_SESSION_UNAVAILABLE/u)
    await session.close()
  })
}

test('native named refusal is retained as a safe code without raw SQL or error detail', async () => {
  const session = new DispositionPsqlSession(
    process.execPath,
    [
      '-e',
      "process.stdin.once('data',()=>process.stderr.write('ERROR:  VOICE_DISPOSITION_UNRESOLVED\\nCONTEXT: private synthetic detail\\n',()=>process.exit(1)))",
    ],
    { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, timeoutMs: 2000 },
  )
  await assert.rejects(
    session.query('SELECT true'),
    (error) => error.code === 'VOICE_DISPOSITION_UNRESOLVED' && !error.message.includes('private'),
  )
  assert.equal(session.retired, true)
})
