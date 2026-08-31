import {
  parseBoundedTopologyJson,
  parseStagingTopologyArgs,
  StagingTopologyAdmissionError,
  validateStagingTopology,
} from './lib/staging-topology-admission.mjs'

try {
  const { expectedRevision } = parseStagingTopologyArgs(process.argv.slice(2))
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const payload = parseBoundedTopologyJson(Buffer.concat(chunks).toString('utf8'))
  process.stdout.write(`${JSON.stringify(validateStagingTopology(payload, expectedRevision))}\n`)
} catch (error) {
  const code =
    error instanceof StagingTopologyAdmissionError ? error.code : 'unexpected-topology-failure'
  process.stderr.write(`Staging topology admission failed: ${code}\n`)
  process.exitCode = 1
}
