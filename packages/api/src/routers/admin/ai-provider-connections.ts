import { env } from '@pathfinder/config'
import type { AiProviderId } from '@pathfinder/ai'

const VISITOR_PROVIDER_DEFINITIONS = [
  { id: 'anthropic', name: 'Anthropic', environmentVariable: 'ANTHROPIC_API_KEY' },
  { id: 'openai', name: 'OpenAI', environmentVariable: 'OPENAI_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', environmentVariable: 'DEEPSEEK_API_KEY' },
] as const

export function providerHasExecutionKey(provider: string): boolean {
  if (provider === 'anthropic') return Boolean(env.ANTHROPIC_API_KEY)
  if (provider === 'openai') return Boolean(env.OPENAI_API_KEY)
  if (provider === 'deepseek') return Boolean(env.DEEPSEEK_API_KEY)
  return false
}

export function getVisitorProviderSetup() {
  const providerKeyAvailability = {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    openai: Boolean(env.OPENAI_API_KEY),
    deepseek: Boolean(env.DEEPSEEK_API_KEY),
  } satisfies Record<AiProviderId, boolean>

  return {
    providerKeyAvailability,
    providerConnections: VISITOR_PROVIDER_DEFINITIONS.map((provider) => ({
      ...provider,
      configured: providerKeyAvailability[provider.id],
    })),
  }
}
