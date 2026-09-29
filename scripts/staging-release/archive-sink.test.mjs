import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { createS3CompatibleArchiveSink } from './archive-sink.mjs'

test('S3 compatible sink streams encrypted files with SigV4 headers and a content digest', async () => {
  const root = process.env.STAGING_RELEASE_TMP
  if (!root) throw new Error('STAGING_RELEASE_TMP must name a task-owned temporary directory')
  let requestPath, requestHeaders, received
  const server = createServer((request, response) => {
    requestPath = request.url
    requestHeaders = request.headers
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => { received = Buffer.concat(chunks); response.writeHead(200); response.end() })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const directory = await mkdtemp(path.join(root, 'p13-s3-sink-'))
  try {
    const file = path.join(directory, 'backup.enc')
    const bytes = Buffer.from('synthetic encrypted archive bytes')
    await writeFile(file, bytes)
    const port = server.address().port
    const sink = createS3CompatibleArchiveSink({
      endpoint: `http://127.0.0.1:${port}`,
      bucket: 'private-archive-bucket',
      region: 'us-east-1',
      credentials: { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' },
    })
    const result = await sink.putFile(file, 'staging-backups/fixture!.backup.enc')
    assert.equal(requestPath, '/private-archive-bucket/staging-backups/fixture%21.backup.enc')
    assert.match(requestHeaders.authorization, /^AWS4-HMAC-SHA256 Credential=synthetic-access\//u)
    assert.equal(requestHeaders['x-amz-content-sha256'], createHash('sha256').update(bytes).digest('hex'))
    assert.equal(requestHeaders['content-length'], String(bytes.length))
    assert.deepEqual(received, bytes)
    assert.equal(result.sha256, requestHeaders['x-amz-content-sha256'])
  } finally {
    server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('S3 sink rejects non-loopback plaintext endpoints and unsafe keys', async () => {
  assert.throws(() => createS3CompatibleArchiveSink({ endpoint: 'http://storage.example', bucket: 'private-archive-bucket', region: 'us-east-1', credentials: { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' } }), /archive-sink-config-invalid/u)
  await assert.rejects(createS3CompatibleArchiveSink({ endpoint: 'http://127.0.0.1:9000', bucket: 'private-archive-bucket', region: 'us-east-1', credentials: { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' } }).putFile('unused', '../unsafe'), /archive-sink-key-invalid/u)
})

test('S3 sink aborts a stalled upload within its configured timeout', async () => {
  const root = process.env.STAGING_RELEASE_TMP
  if (!root) throw new Error('STAGING_RELEASE_TMP must name a task-owned temporary directory')
  const server = createServer((_request, _response) => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const directory = await mkdtemp(path.join(root, 'p13-s3-timeout-'))
  try {
    const file = path.join(directory, 'backup.enc')
    await writeFile(file, Buffer.from('synthetic encrypted bytes'))
    const sink = createS3CompatibleArchiveSink({
      endpoint: `http://127.0.0.1:${server.address().port}`,
      bucket: 'private-archive-bucket', region: 'us-east-1', timeoutMs: 50,
      credentials: { accessKeyId: 'synthetic-access', secretAccessKey: 'synthetic-secret' },
    })
    await assert.rejects(sink.putFile(file, 'staging-backups/fixture.backup.enc'), /archive-sink-upload-failed/u)
  } finally {
    server.closeAllConnections()
    server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
