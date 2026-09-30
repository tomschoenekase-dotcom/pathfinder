import { reportDisposableRunnerFailure } from './lib/disposable-runner-failure.mjs'
import { runDisposableServiceShakedown } from './lib/disposable-intake-upload-verification.mjs'

try {
  process.exitCode = await runDisposableServiceShakedown({
    configuration: {
      resourceFamily: 'agentbridge',
      databasePrefix: 'pathfinder_disposable_agent_bridge_',
      optInEnvironmentKey: 'PATHFINDER_ALLOW_DISPOSABLE_AGENT_BRIDGE_SHAKEDOWN',
      lifecycleEvent: 'test:mcp-venue-appearance:disposable',
      successAction: 'mcp.venue-appearance.disposable-lifecycle.passed',
      proofScope: [
        'client-scoped-mcp-credential-issued-disabled',
        'least-privilege-client-activation-evidence',
        'postgres-migration-trigger-enforcement',
        'http-initialize-and-tool-catalog',
        'venue-create-and-client-list',
        'appearance-read-and-idempotent-update',
        'cross-tenant-credential-denial',
        'credential-revocation-denial',
      ],
      failureScope: [
        'postgres-migration-failure',
        'activation-scope-or-capability-rejection',
        'credential-verification-failure',
        'tool-or-domain-action-failure',
      ],
      integration: {
        packageDirectory: 'packages/api',
        testFile: 'src/mcp/mcp-venue-appearance-disposable.integration.test.ts',
        expectedPassed: 1,
        environment: {
          RUN_MCP_VENUE_APPEARANCE_DB_INTEGRATION: '1',
          MCP_WRITE_TOOLS_ENABLED: 'true',
          AGENT_BRIDGE_HTTP_ENABLED: 'true',
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
} catch (error) {
  if (error instanceof Error) process.stderr.write(`${error.name}: ${error.message}\n`)
  process.exitCode = reportDisposableRunnerFailure(error, import.meta.url)
}
