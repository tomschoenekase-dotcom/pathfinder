import { createHash, createHmac } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'

const hashText = (value) => createHash('sha256').update(value).digest('hex')
const hmac = (key, value, encoding) => createHmac('sha256', key).update(value).digest(encoding)

async function fileDigest(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

function encodeKey(key) {
  if (typeof key !== 'string' || !key || key.startsWith('/') || key.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('archive-sink-key-invalid')
  return key.split('/').map((part) => encodeURIComponent(part)
    .replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')
}

function configUrl(config) {
  let url
  try { url = new URL(config.endpoint) } catch { throw new Error('archive-sink-config-invalid') }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !loopback) || url.username || url.password || url.search || url.hash) throw new Error('archive-sink-config-invalid')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(config.bucket ?? '') || !/^[a-z0-9-]+$/u.test(config.region ?? '')) throw new Error('archive-sink-config-invalid')
  if (!config.credentials?.accessKeyId || !config.credentials?.secretAccessKey) throw new Error('archive-sink-config-invalid')
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120_000)) throw new Error('archive-sink-config-invalid')
  return url
}

function signatureHeaders(url, config, payloadHash, now) {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/gu, '')
  const day = date.slice(0, 8)
  const sessionToken = config.credentials.sessionToken
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n${sessionToken ? `x-amz-security-token:${sessionToken}\n` : ''}`
  const signedHeaders = `host;x-amz-content-sha256;x-amz-date${sessionToken ? ';x-amz-security-token' : ''}`
  const canonicalRequest = `PUT\n${url.pathname}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`
  const scope = `${day}/${config.region}/s3/aws4_request`
  const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hashText(canonicalRequest)}`
  const dateKey = hmac(`AWS4${config.credentials.secretAccessKey}`, day)
  const regionKey = hmac(dateKey, config.region)
  const serviceKey = hmac(regionKey, 's3')
  const signingKey = hmac(serviceKey, 'aws4_request')
  const signature = hmac(signingKey, stringToSign, 'hex')
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${config.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    date,
    ...(sessionToken ? { sessionToken } : {}),
  }
}

export function createS3CompatibleArchiveSink(config) {
  const endpoint = configUrl(config)
  const transport = endpoint.protocol === 'https:' ? https : http
  const basePath = endpoint.pathname.replace(/\/$/u, '')
  return {
    async putFile(filePath, key) {
      const objectKey = encodeKey(key)
      const metadata = await stat(filePath).catch(() => { throw new Error('archive-sink-file-unavailable') })
      const payloadHash = await fileDigest(filePath).catch(() => { throw new Error('archive-sink-file-unavailable') })
      const url = new URL(endpoint)
      url.pathname = `${basePath}/${encodeURIComponent(config.bucket)}/${objectKey}`
      const signed = signatureHeaders(url, config, payloadHash, new Date())
      const headers = {
        authorization: signed.authorization,
        'content-length': String(metadata.size),
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': signed.date,
        ...(signed.sessionToken ? { 'x-amz-security-token': signed.sessionToken } : {}),
      }
      await new Promise((resolve, reject) => {
        const request = transport.request(url, { method: 'PUT', headers }, (response) => {
          response.resume()
          response.on('end', () => {
            if (response.statusCode >= 200 && response.statusCode < 300) resolve()
            else if (response.statusCode === 403) reject(new Error('archive-sink-auth-rejected'))
            else if (response.statusCode === 404 || response.statusCode === 400) reject(new Error('archive-sink-bucket-or-request-invalid'))
            else reject(new Error('archive-sink-upload-failed'))
          })
        })
        request.setTimeout(config.timeoutMs ?? 30_000, () => request.destroy(new Error('archive-sink-upload-failed')))
        request.on('error', () => reject(new Error('archive-sink-upload-failed')))
        createReadStream(filePath).on('error', () => request.destroy(new Error('archive-sink-file-unavailable'))).pipe(request)
      }).catch((error) => {
        if (['archive-sink-file-unavailable', 'archive-sink-auth-rejected', 'archive-sink-bucket-or-request-invalid'].includes(error?.message)) throw error
        throw new Error('archive-sink-upload-failed')
      })
      return { key, size: metadata.size, sha256: payloadHash }
    },
  }
}

export function s3SinkFromEnvironment(env = process.env) {
  if (!env.STAGING_ARCHIVE_S3_ENDPOINT && !env.STAGING_ARCHIVE_S3_BUCKET) return null
  return createS3CompatibleArchiveSink({
    endpoint: env.STAGING_ARCHIVE_S3_ENDPOINT,
    bucket: env.STAGING_ARCHIVE_S3_BUCKET,
    region: env.STAGING_ARCHIVE_S3_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: env.STAGING_ARCHIVE_S3_ACCESS_KEY_ID,
      secretAccessKey: env.STAGING_ARCHIVE_S3_SECRET_ACCESS_KEY,
      sessionToken: env.STAGING_ARCHIVE_S3_SESSION_TOKEN,
    },
  })
}
