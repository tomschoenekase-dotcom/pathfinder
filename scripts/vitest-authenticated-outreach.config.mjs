export default {
  test: { environment: 'node', pool: 'forks', maxWorkers: 1, minWorkers: 1,
    include: ['packages/db/src/helpers/agent-bridge-actions.test.ts',
      'packages/api/src/agent-bridge/registry.test.ts',
      'packages/api/src/prospect-agent/registry-native-writer.test.ts',
      'packages/db/src/helpers/prospect-native-writer-agent.test.ts',
      'packages/db/src/helpers/prospect-sales-writer.test.ts',
      'packages/config/src/local-crm-sales-components.test.ts',
      'apps/dashboard/components/admin/ProspectWriterRoundtrip.test.tsx'],
    passWithNoTests: false, fileParallelism: false },
}
