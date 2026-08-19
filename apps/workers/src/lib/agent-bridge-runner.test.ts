import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))

import {
  buildAgentCliInvocation,
  createAgentBridgeHttpClient,
  executeAgentBridgeTask,
  parseAgentBridgeRunnerConfig,
  runAgentBridge,
} from './agent-bridge-runner'

const base = {
  endpoint: 'https://torchiko.test/api/agent-bridge/tenant-1/venue-1',
  secret: `pf_mcp_${'a'.repeat(43)}`,
  venueId: 'venue-1',
  label: 'Desktop runner',
  workdir: 'C:\\workspace',
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  modelName: 'subscription-default',
  pollMs: 2_000,
  taskTimeoutMs: 60_000,
} as const

describe('desktop agent bridge runner', () => {
  it('builds fixed no-shell read-only Codex and plan-only Claude invocations', () => {
    const codex = buildAgentCliInvocation(
      parseAgentBridgeRunnerConfig({ ...base, provider: 'CODEX_SUBSCRIPTION' }),
    )
    expect(codex).toEqual({
      command: 'codex',
      args: expect.arrayContaining(['exec', '--ephemeral', '--sandbox', 'read-only', 'never', '-']),
    })
    expect(codex.args).not.toContain('--dangerously-bypass-approvals-and-sandbox')
    const claude = buildAgentCliInvocation(
      parseAgentBridgeRunnerConfig({ ...base, provider: 'CLAUDE_SUBSCRIPTION' }),
    )
    expect(claude.command).toBe('claude')
    expect(claude.args).toEqual(
      expect.arrayContaining([
        '--permission-mode',
        'plan',
        '--tools',
        '',
        '--no-session-persistence',
      ]),
    )
    expect(claude.args).not.toContain('--dangerously-skip-permissions')
  })

  it('accepts HTTPS or loopback HTTP only and never permits URL credentials', () => {
    for (const endpoint of [
      'http://remote.test/bridge',
      'https://user:pass@torchiko.test/bridge',
      'https://torchiko.test/bridge?secret=bad',
    ]) {
      expect(() =>
        parseAgentBridgeRunnerConfig({ ...base, endpoint, provider: 'CODEX_SUBSCRIPTION' }),
      ).toThrow('INVALID_BRIDGE_ENDPOINT')
    }
    expect(
      parseAgentBridgeRunnerConfig({
        ...base,
        endpoint: 'http://127.0.0.1:3000/bridge',
        provider: 'CODEX_SUBSCRIPTION',
      }).endpoint,
    ).toBe('http://127.0.0.1:3000/bridge')
  })

  it('permits local inference only on an exact loopback HTTP endpoint', () => {
    const parsed = parseAgentBridgeRunnerConfig({
      ...base,
      provider: 'OPENAI_COMPATIBLE',
      modelName: 'qwen3.5:9b',
      localInferenceUrl: 'http://127.0.0.1:11434/v1/',
    })
    expect(parsed.localInferenceUrl).toBe('http://127.0.0.1:11434/v1/chat/completions')
    for (const localInferenceUrl of [
      'https://127.0.0.1:11434/v1',
      'http://192.168.1.5:11434/v1',
      'http://user:pass@localhost:11434/v1',
      'http://localhost:11434/v1?key=bad',
    ]) {
      expect(() =>
        parseAgentBridgeRunnerConfig({
          ...base,
          provider: 'OPENAI_COMPATIBLE',
          localInferenceUrl,
        }),
      ).toThrow('INVALID_LOCAL_INFERENCE_ENDPOINT')
    }
  })

  it('requires a bounded named profile for Hermes', () => {
    expect(() => parseAgentBridgeRunnerConfig({ ...base, provider: 'HERMES' })).toThrow(
      'HERMES_PROFILE_REQUIRED',
    )
    expect(() =>
      parseAgentBridgeRunnerConfig({
        ...base,
        provider: 'HERMES',
        hermesProfile: '../default',
      }),
    ).toThrow()
    expect(
      parseAgentBridgeRunnerConfig({
        ...base,
        provider: 'HERMES',
        hermesProfile: 'pathfinder_architect',
      }).hermesProfile,
    ).toBe('pathfinder_architect')
  })

  it('uses Hermes ACP over stdin and denies every permission request', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const child = new EventEmitter() as EventEmitter & {
      stdin: { write: (value: string) => boolean; end: () => void }
      stdout: PassThrough
      stderr: PassThrough
      kill: () => boolean
    }
    const writes: Array<Record<string, unknown>> = []
    child.stdout = stdout
    child.stderr = stderr
    child.kill = vi.fn(() => true)
    child.stdin = {
      end: vi.fn(),
      write: vi.fn((value: string) => {
        const message = JSON.parse(value) as Record<string, unknown>
        writes.push(message)
        if (message.id === 1)
          queueMicrotask(() =>
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`),
          )
        if (message.id === 2)
          queueMicrotask(() => {
            stdout.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 'permission-1', method: 'session/request_permission', params: {} })}\n`,
            )
            stdout.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'hermes-session' } })}\n`,
            )
          })
        if (message.id === 3)
          queueMicrotask(() => {
            stdout.write(
              `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'hermes-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hermes result.' } } } })}\n`,
            )
            stdout.write(
              `${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } })}\n`,
            )
          })
        return true
      }),
    }
    vi.mocked(spawn).mockReturnValueOnce(child as never)
    const config = parseAgentBridgeRunnerConfig({
      ...base,
      provider: 'HERMES',
      hermesProfile: 'pathfinder_architect',
    })
    await expect(
      executeAgentBridgeTask(
        {
          id: 'run-hermes',
          venueId: 'venue-1',
          prompt: 'Review architecture.',
          modelName: 'subscription-default',
          leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        config,
      ),
    ).resolves.toEqual({
      content: 'Hermes result.',
      modelName: 'subscription-default',
      costE8Usd: '0',
    })
    expect(spawn).toHaveBeenCalledWith(
      'hermes',
      ['-p', 'pathfinder_architect', 'acp'],
      expect.objectContaining({ shell: false }),
    )
    expect(writes).toContainEqual({
      jsonrpc: '2.0',
      id: 'permission-1',
      result: { outcome: { outcome: 'cancelled' } },
    })
    expect(JSON.stringify(writes)).toContain('Review architecture.')
    expect(spawn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['-z']),
      expect.anything(),
    )
  })

  it('executes an OpenAI-compatible local model without exposing its key', async () => {
    const config = parseAgentBridgeRunnerConfig({
      ...base,
      provider: 'OPENAI_COMPATIBLE',
      modelName: 'qwen3.5:9b',
      localInferenceUrl: 'http://localhost:11434/v1',
      localInferenceKey: 'local-secret',
    })
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'Grounded local result.' } }] }),
          { status: 200 },
        ),
      )
    await expect(
      executeAgentBridgeTask(
        {
          id: 'run-local',
          venueId: 'venue-1',
          prompt: 'Summarize this.',
          modelName: 'subscription-default',
          leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
        config,
      ),
    ).resolves.toEqual({
      content: 'Grounded local result.',
      modelName: 'qwen3.5:9b',
      costE8Usd: '0',
    })
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    expect(init?.headers).toEqual({
      authorization: 'Bearer local-secret',
      'content-type': 'application/json',
    })
    expect(init?.body).not.toContain('local-secret')
    fetcher.mockRestore()
  })

  it('sends the machine secret only in authorization and bounds response bytes', async () => {
    const config = parseAgentBridgeRunnerConfig({ ...base, provider: 'CODEX_SUBSCRIPTION' })
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, result: { task: null } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const call = createAgentBridgeHttpClient(config, fetcher)
    await expect(call('claimTask', { venueId: 'venue-1' })).resolves.toEqual({ task: null })
    const init = fetcher.mock.calls[0]![1]!
    expect(init.headers).toEqual({
      authorization: `Bearer ${base.secret}`,
      'content-type': 'application/json',
    })
    expect(init.body).not.toContain(base.secret)
  })

  it('renews session and task leases together and propagates durable cancellation', async () => {
    vi.useFakeTimers()
    const config = parseAgentBridgeRunnerConfig({ ...base, provider: 'CODEX_SUBSCRIPTION' })
    const controller = new AbortController()
    const task = {
      id: 'run-1',
      venueId: 'venue-1',
      prompt: 'Review the plan.',
      modelName: 'subscription-default',
      leaseToken: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    }
    let claims = 0
    const call = vi.fn(async (method: string) => {
      if (method === 'claimTask') return { task: claims++ === 0 ? task : null }
      if (method === 'heartbeatTask') return { cancelRequested: true }
      if (method === 'failTask') controller.abort()
      return {}
    })
    const execute = vi.fn(
      (_task: unknown, _config: unknown, signal?: AbortSignal) =>
        new Promise<never>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('TASK_CANCELLED')), {
            once: true,
          }),
        ),
    )
    const running = runAgentBridge(config, controller.signal, {
      call: call as never,
      execute: execute as never,
      heartbeatMs: 100,
    })
    await vi.advanceTimersByTimeAsync(101)
    await running
    expect(
      call.mock.calls.filter(([method]) => method === 'heartbeatSession').length,
    ).toBeGreaterThanOrEqual(2)
    expect(call).toHaveBeenCalledWith(
      'heartbeatTask',
      expect.objectContaining({ runId: 'run-1' }),
      expect.anything(),
    )
    expect(call).toHaveBeenCalledWith(
      'failTask',
      expect.objectContaining({ errorCode: 'TASK_CANCELLED', retryable: false }),
    )
    vi.useRealTimers()
  })
})
