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
): Promise<number[]> {
  const result = await generateEmbedding({
    modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
    text,
    usageSink,
    admissionGuard,
    budgetGate,
  })
  return result.embedding
}
