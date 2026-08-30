import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'

import {
  runDisposableServiceShakedown,
} from './lib/disposable-intake-upload-verification.mjs'

async function run() {
  return runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'agentbridge',
      databasePrefix: 'pathfinder_disposable_agent_bridge_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_AGENT_BRIDGE_SHAKEDOWN',
      lifecycleEvent: 'test:agent-bridge:disposable',
      successAction: 'agent-bridge.runner-lifecycle.disposable-shakedown.passed',
      proofScope: [
        'machine-credential-authentication',
        'http-transport',
        'session-registration',
        'heterogeneous-concurrent-workers',
        'same-role-multiple-instances',
        'explicit-role-and-capability-routing',
        'strict-shared-task-contract',
        'actor-agent-scope-model-provenance',
        'null-prompt-operation-fallback',
        'retryable-failure',
        'lease-reclaim',
        'stale-worker-settlement-fenced',
        'duplicate-completion-prevented',
        'system-initiated-founder-independent-workflow',
        'seven-role-realistic-workforce-routing',
        'research-candidates-without-authoritative-promotion',
        'venue-location-proposal-without-canonical-mutation',
        'venue-update-draft-without-publication',
        'support-triage-awaiting-human-approval',
        'analyst-improvement-proposal-without-execution',
        'crm-inbound-reply-without-outbound-send',
        'conflicting-idempotent-domain-write-rejected',
        'concurrent-budget-exhaustion-denied-and-released-before-dispatch',
        'provider-failure-terminal-without-false-completion',
        'stale-current-truth-rejected-before-proposal',
        'approval-denial-without-execution',
        'expired-approval-rejected-without-execution',
        'founder-unavailable-retains-pending-approval',
        'tool-db-structured-and-partial-failures-recover-exactly-once',
        'customer-publication-billing-authority-dark',
        'durable-artifact-readback',
        'explicit-unreported-cost-status',
      ],
      failureScope: [
        'provider-or-venue-contract-drift',
        'executor-failure',
        'provider-unavailable',
        'tool-http-500',
        'database-transient',
        'invalid-structured-output',
        'partial-result-rejected',
        'budget-exhausted',
        'stale-current-truth',
        'conflicting-domain-write',
        'approval-denied',
        'approval-expired',
        'founder-unavailable',
      ],
      integration: {
        packageDirectory: 'apps/workers',
        testFile: 'src/lib/agent-bridge-runner.disposable.integration.test.ts',
        expectedPassed: 2,
        environment: {
          RUN_AGENT_BRIDGE_RUNNER_DB_INTEGRATION: '1',
          OUTBOUND_PROVIDER_WORKERS_ENABLED: 'false',
          CRM_BACKGROUND_WORKERS_ENABLED: 'false',
          INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
          WORKER_SCHEDULERS_ENABLED: 'false',
          PROSPECT_OUTREACH_DELIVERY_ENABLED: 'false',
          OPERATIONAL_ALERT_DELIVERY_ENABLED: 'false',
          STRIPE_MODE: 'test',
          STRIPE_LIVE_MODE_ALLOWED: 'false',
        },
      },
    },
  })
}

try {
  process.exitCode = await run()
} catch (error) {
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
