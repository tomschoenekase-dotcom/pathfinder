import { FounderOperatingExchangeError, recordFounderOperatingExchange } from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  deriveFounderOperatingExchange,
  type FounderConversationSource,
} from './founder-operating-conversation'

export const founderAskInput = z
  .object({
    operationId: z.string().uuid(),
    prompt: z.string().trim().min(1).max(10_000),
  })
  .strict()

type FounderOperatingConversationInput = z.output<typeof founderAskInput>

export async function recordFounderOperatingConversation(
  operatorUserId: string,
  input: FounderOperatingConversationInput,
  source: FounderConversationSource,
  record: typeof recordFounderOperatingExchange = recordFounderOperatingExchange,
) {
  const derived = deriveFounderOperatingExchange(input.prompt, source)
  try {
    return await record({
      operationId: input.operationId,
      operatorUserId,
      prompt: input.prompt,
      ...derived,
    })
  } catch (error) {
    if (error instanceof FounderOperatingExchangeError) {
      throw new TRPCError({ code: error.code, message: error.message, cause: error })
    }
    throw error
  }
}

export function createFounderAskHandler(
  readSource: (
    operatorUserId: string,
    query: { limit: number },
  ) => Promise<FounderConversationSource>,
) {
  return async ({
    ctx,
    input,
  }: {
    ctx: { session: { userId: string } }
    input: FounderOperatingConversationInput
  }) => {
    const source = await readSource(ctx.session.userId, { limit: 10 })
    return recordFounderOperatingConversation(ctx.session.userId, input, source)
  }
}
