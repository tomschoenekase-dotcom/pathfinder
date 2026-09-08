import { randomUUID } from 'node:crypto'

import { z } from 'zod'

const Input = z.object({
  endpoint: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value)
      return (
        url.protocol === 'http:' &&
        (url.hostname === '127.0.0.1' || url.hostname === '::1') &&
        !url.username &&
        !url.password
      )
    }, 'Fixture endpoint must be credential-free loopback HTTP'),
  secret: z.string(),
  venueId: z.string(),
  phase: z.enum(['INTERRUPT', 'REPLACE']),
})

async function readInput() {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > 16_384) throw new Error('FIXTURE_INPUT_TOO_LARGE')
    chunks.push(buffer)
  }
  return Input.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}

async function main() {
  const input = await readInput()
  const sessionId = randomUUID()
  const call = async (method: string, params: unknown) => {
    const response = await fetch(input.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, params }),
    })
    const envelope = (await response.json()) as {
      ok: boolean
      result?: unknown
      error?: { code?: string }
    }
    if (!response.ok || !envelope.ok) {
      const code = envelope.error?.code ?? 'BRIDGE_REJECTED'
      throw new Error(`FIXTURE_${input.phase}_${method}_${code}`)
    }
    return envelope.result
  }
  const session = { sessionId, venueId: input.venueId }
  await call('register', {
    ...session,
    provider: 'CODEX_SUBSCRIPTION',
    label: `Fresh-process fixture ${input.phase.toLowerCase()}`,
    runnerVersion: 'deterministic-fresh-process-adapter/1',
    supportedModels: ['subscription-default'],
  })
  const claimed = z
    .object({
      task: z.object({
        id: z.string(),
        leaseToken: z.string(),
        attemptNumber: z.number(),
        prompt: z.string(),
      }),
    })
    .parse(await call('claimTask', session))
  if (input.phase === 'INTERRUPT') {
    process.stdout.write(
      JSON.stringify({
        phase: input.phase,
        runId: claimed.task.id,
        processId: process.pid,
        sessionId,
        leaseToken: claimed.task.leaseToken,
      }),
    )
    return
  }
  const capacity = claimed.task.prompt.match(/approved visitor capacity is exactly (\d+)/iu)?.[1]
  if (!capacity) throw new Error('PERSISTED_ANSWER_NOT_FOUND')
  const content = `DRAFT_FROM_PERSISTED_ANSWER: capacity ${capacity}`
  await call('completeTask', {
    ...session,
    runId: claimed.task.id,
    leaseToken: claimed.task.leaseToken,
    summary: content,
    artifacts: [{ type: 'markdown', title: 'Deterministic fixture draft', content }],
    modelName: 'subscription-default',
    costE8Usd: '0',
    costStatus: 'UNREPORTED',
  })
  process.stdout.write(
    JSON.stringify({
      phase: input.phase,
      runId: claimed.task.id,
      attemptNumber: claimed.task.attemptNumber,
      derivedCapacity: capacity,
      processId: process.pid,
    }),
  )
}

void main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : 'FRESH_PROCESS_FIXTURE_FAILED')
  process.exitCode = 1
})
