import { AI_EMBEDDING_MODEL_KEYS, generateEmbedding, type AiUsageSink } from '@pathfinder/ai'

export async function generateGuestQueryEmbedding(
  text: string,
  usageSink: AiUsageSink,
): Promise<number[]> {
  const result = await generateEmbedding({
    modelKey: AI_EMBEDDING_MODEL_KEYS.GUEST_QUERY,
    text,
    usageSink,
  })
  return result.embedding
}
