import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

const canary = (key) => `PFCLIENTBUNDLECANARY_${key}_8F4C2D91`

export const CLIENT_BUNDLE_SECRET_CANARIES = Object.freeze({
  DATABASE_URL: {
    marker: canary('DATABASE_URL'),
    value: `postgresql://bundle_scan:${canary('DATABASE_URL')}@127.0.0.1:5432/pathfinder_bundle_scan`,
  },
  DIRECT_DATABASE_URL: {
    marker: canary('DIRECT_DATABASE_URL'),
    value: `postgresql://bundle_scan:${canary('DIRECT_DATABASE_URL')}@127.0.0.1:5432/pathfinder_bundle_scan`,
  },
  REDIS_URL: {
    marker: canary('REDIS_URL'),
    value: `redis://:${canary('REDIS_URL')}@127.0.0.1:6379`,
  },
  CLERK_SECRET_KEY: {
    marker: canary('CLERK_SECRET_KEY'),
    value: `sk_test_${canary('CLERK_SECRET_KEY')}`,
  },
  CLERK_WEBHOOK_SECRET: {
    marker: canary('CLERK_WEBHOOK_SECRET'),
    value: `whsec_${canary('CLERK_WEBHOOK_SECRET')}`,
  },
  ANTHROPIC_API_KEY: {
    marker: canary('ANTHROPIC_API_KEY'),
    value: `sk-ant-api03-${canary('ANTHROPIC_API_KEY')}`,
  },
  OPENAI_API_KEY: {
    marker: canary('OPENAI_API_KEY'),
    value: `sk-proj-${canary('OPENAI_API_KEY')}`,
  },
  INTEGRATION_ENCRYPTION_KEY: {
    marker: canary('INTEGRATION_ENCRYPTION_KEY'),
    value: canary('INTEGRATION_ENCRYPTION_KEY'),
  },
  STORAGE_ACCESS_KEY_ID: {
    marker: canary('STORAGE_ACCESS_KEY_ID'),
    value: canary('STORAGE_ACCESS_KEY_ID'),
  },
  STORAGE_SECRET_ACCESS_KEY: {
    marker: canary('STORAGE_SECRET_ACCESS_KEY'),
    value: canary('STORAGE_SECRET_ACCESS_KEY'),
  },
  RESEND_API_KEY: {
    marker: canary('RESEND_API_KEY'),
    value: `re_${canary('RESEND_API_KEY')}`,
  },
})

const secretKeyPattern =
  /^(?:DATABASE_URL|DIRECT_DATABASE_URL|REDIS_URL|.*(?:SECRET|API_KEY|ACCESS_KEY|ENCRYPTION_KEY|TOKEN|PASSWORD|PRIVATE_KEY).*)$/u
const prerenderExtensions = new Set(['.body', '.html', '.json', '.meta', '.rsc', '.txt'])
const hardcodedSecretPatterns = [
  ['anthropic-api-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/gu],
  ['openai-api-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/gu],
  ['clerk-or-stripe-secret-key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gu],
  ['webhook-signing-secret', /\bwhsec_[A-Za-z0-9]{16,}\b/gu],
  ['aws-access-key-id', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/gu],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu],
  ['supabase-secret-key', /\bsb_secret_[A-Za-z0-9_-]{20,}\b/gu],
  ['resend-api-key', /\bre_[A-Za-z0-9]{20,}\b/gu],
  ['private-key-pem', /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/gu],
  [
    'credentialed-database-url',
    /\b(?:postgres(?:ql)?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+|redis(?:s)?:\/\/(?:[^\s/:@]+)?:[^\s/@]+@[^\s/]+)/gu,
  ],
]

export function assertSecretCanaryRegistryCoversConfig(configSource) {
  const objectStart = configSource.indexOf('.object({')
  const objectEnd = configSource.indexOf('\n  .superRefine', objectStart)
  if (objectStart === -1 || objectEnd === -1) {
    throw new Error('Could not locate the raw environment schema object')
  }
  const objectSource = configSource.slice(objectStart, objectEnd)
  const configuredKeys = new Set(
    Array.from(objectSource.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gmu), (match) => match[1]),
  )
  const secretKeys = [...configuredKeys].filter((key) => secretKeyPattern.test(key)).sort()
  const canaryKeys = Object.keys(CLIENT_BUNDLE_SECRET_CANARIES).sort()
  const missing = secretKeys.filter((key) => !canaryKeys.includes(key))
  const stale = canaryKeys.filter((key) => !secretKeys.includes(key))
  if (missing.length > 0 || stale.length > 0) {
    throw new Error(
      `Client-bundle secret canary registry drift (missing: ${missing.join(', ') || 'none'}; stale: ${stale.join(', ') || 'none'})`,
    )
  }
  return secretKeys
}

export function buildSecretCanaryEnvironment(baseEnvironment = process.env) {
  const environment = { ...baseEnvironment }
  for (const key of [
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
    'GITHUB_TOKEN',
    'NODE_AUTH_TOKEN',
    'NPM_TOKEN',
    'TURBO_TEAM',
    'TURBO_TOKEN',
  ]) {
    delete environment[key]
  }
  for (const [key, entry] of Object.entries(CLIENT_BUNDLE_SECRET_CANARIES)) {
    environment[key] = entry.value
  }
  environment.NEXT_TELEMETRY_DISABLED = '1'
  return environment
}

async function collectFiles(root, directory = root, files = []) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Refusing symbolic link in browser-deliverable output: ${relative(root, path)}`,
      )
    }
    if (entry.isDirectory()) await collectFiles(root, path, files)
    else if (entry.isFile()) files.push(path)
  }
  return files
}

function scanContent(content, artifactPath) {
  const findings = []
  for (const [key, entry] of Object.entries(CLIENT_BUNDLE_SECRET_CANARIES)) {
    let offset = content.indexOf(entry.marker)
    while (offset !== -1) {
      findings.push({ label: `canary:${key}`, artifactPath, offset })
      offset = content.indexOf(entry.marker, offset + entry.marker.length)
    }
  }
  for (const [label, pattern] of hardcodedSecretPatterns) {
    pattern.lastIndex = 0
    for (const match of content.matchAll(pattern)) {
      findings.push({ label: `pattern:${label}`, artifactPath, offset: match.index })
    }
  }
  return findings
}

export async function scanClientBundleTargets(targets) {
  const findings = []
  let scannedFiles = 0
  const applications = new Set()
  for (const target of targets) {
    const root = resolve(target.root)
    let files
    try {
      files = await collectFiles(root)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        if (target.required) throw new Error(`Browser-deliverable root is missing: ${target.label}`)
        continue
      }
      throw error
    }
    const selectedFiles = target.prerenderOnly
      ? files.filter((file) => prerenderExtensions.has(extname(file).toLowerCase()))
      : files
    if (target.required && selectedFiles.length === 0) {
      throw new Error(`Browser-deliverable root contains no files: ${target.label}`)
    }
    if (selectedFiles.length > 0) applications.add(target.application)
    for (const file of selectedFiles) {
      scannedFiles += 1
      const artifactPath = `${target.label}/${relative(root, file).split(sep).join('/')}`
      findings.push(...scanContent((await readFile(file)).toString('utf8'), artifactPath))
    }
  }
  if (findings.length > 0) {
    const summary = findings
      .map(({ label, artifactPath, offset }) => `${label} in ${artifactPath} at offset ${offset}`)
      .join('; ')
    throw new Error(`Browser-deliverable secret material detected: ${summary}`)
  }
  return { applications: applications.size, scannedFiles, targets: targets.length }
}

export async function discoverNextClientBundleTargets(repositoryRoot) {
  const appsRoot = join(repositoryRoot, 'apps')
  const entries = await readdir(appsRoot, { withFileTypes: true })
  const applications = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in apps/: ${entry.name}`)
    if (!entry.isDirectory()) continue
    const names = await readdir(join(appsRoot, entry.name))
    if (names.some((name) => /^next\.config\.(?:cjs|js|mjs|ts)$/u.test(name))) {
      applications.push(entry.name)
    }
  }
  applications.sort()
  if (applications.length === 0) throw new Error('No Next.js applications were discovered')

  return applications.flatMap((application) => {
    const appRoot = join(appsRoot, application)
    return [
      {
        application,
        root: join(appRoot, '.next', 'static'),
        label: `apps/${application}/.next/static`,
        required: true,
      },
      {
        application,
        root: join(appRoot, 'public'),
        label: `apps/${application}/public`,
        required: false,
      },
      {
        application,
        root: join(appRoot, '.next', 'server', 'app'),
        label: `apps/${application}/.next/server/app`,
        required: false,
        prerenderOnly: true,
      },
      {
        application,
        root: join(appRoot, '.next', 'server', 'pages'),
        label: `apps/${application}/.next/server/pages`,
        required: false,
        prerenderOnly: true,
      },
    ]
  })
}
