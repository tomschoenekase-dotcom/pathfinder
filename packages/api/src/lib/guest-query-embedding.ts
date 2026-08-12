import {
  AI_EMBEDDING_MODEL_KEYS,
  generateEmbedding,
  type AiAdmissionGuard,
  type AiBudgetGate,
  type AiUsageSink,
} from '@pathfinder/ai'

export async function generateGuestQueryEmbedding(
  text: string,
  usageSink: AiUsageSink,
  admissionGuard: AiAdmissionGuard,
  budgetGate: AiBudgetGate,
  invocationId?: string,
  onBeforeFirstDispatch?: () => Promise<void>,
): Promise<number[]> {
  const result = await generateEmbedding({
    modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
    text,
    usageSink,
    admissionGuard,
    budgetGate,
    ...(invocationId ? { invocationId } : {}),
    ...(onBeforeFirstDispatch ? { onBeforeFirstDispatch } : {}),
  })
  return result.embedding
}
