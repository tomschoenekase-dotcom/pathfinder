import type { JsonValue } from '@pathfinder/contracts/mcp-v0'
import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import {
  createEngagementQuestionAction,
  updateEngagementQuestionAction,
  EngagementQuestionActionError,
  engagementQuestionSelect,
} from '@pathfinder/db'
import { assertTenantInGrant, OperatorNotFoundError } from '../grants'
import {
  OperatorStaleError,
  type OperatorProposalKind,
  type OperatorKindContext,
} from '../proposals'
import { venueActor } from './shared'
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue
async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof EngagementQuestionActionError && error.code === 'CONFLICT')
      throw new OperatorStaleError(error.message)
    if (error instanceof EngagementQuestionActionError && error.code === 'NOT_FOUND')
      throw new OperatorNotFoundError()
    throw error
  }
}
const createInput = OPERATOR_MCP_INPUTS['engagement.propose_question_create']
type CreateArgs = ReturnType<typeof createInput.parse>
const authorize = (args: { tenantId: string }, context: OperatorKindContext) =>
  assertTenantInGrant(context.grant, args.tenantId, context.database)
export const engagementQuestionCreateKind: OperatorProposalKind<CreateArgs> = {
  kind: 'engagement.question-create',
  tool: 'engagement.propose_question_create',
  capability: 'customers:propose',
  parse: (raw) => createInput.parse(raw),
  target: (args) => ({ tenantId: args.tenantId }),
  authorize,
  targetVersion: async () => null,
  currentVersion: async () => null,
  describe: (args) => ({ title: 'Create tenant engagement question', lines: [args.prompt] }),
  snapshot: async () => null,
  apply: async (args, context) => {
    const after = await guard(() =>
      createEngagementQuestionAction({
        db: context.database,
        tenantId: args.tenantId,
        questionType: args.questionType,
        prompt: args.prompt,
        choiceOptions: args.choiceOptions,
        intensity: args.intensity,
        actor: venueActor(context.actor, 'OWNER'),
      }),
    )
    return { result: { questionId: after.id, question: json(after) }, after: json(after) }
  },
}
const updateInput = OPERATOR_MCP_INPUTS['engagement.propose_question_update']
type UpdateArgs = ReturnType<typeof updateInput.parse>
const read = (args: UpdateArgs, context: OperatorKindContext) =>
  context.database.engagementQuestion.findFirst({
    where: { id: args.questionId, tenantId: args.tenantId },
    select: engagementQuestionSelect,
  })
export const engagementQuestionUpdateKind: OperatorProposalKind<UpdateArgs> = {
  kind: 'engagement.question-update',
  tool: 'engagement.propose_question_update',
  capability: 'customers:propose',
  parse: (raw) => updateInput.parse(raw),
  target: (args) => ({ tenantId: args.tenantId }),
  authorize,
  targetVersion: async (args) => new Date(args.expectedUpdatedAt).toISOString(),
  currentVersion: async (args, context) =>
    (await read(args, context))?.updatedAt.toISOString() ?? null,
  describe: (args) => ({
    title: 'Update tenant engagement question',
    lines: [
      `Question: ${args.questionId}`,
      ...(args.isActive === undefined ? [] : [`Active: ${args.isActive}`]),
    ],
  }),
  snapshot: async (args, context) => json(await read(args, context)),
  apply: async (args, context) => {
    const { tenantId, questionId, expectedUpdatedAt } = args
    const patch = {
      ...(args.questionType !== undefined ? { questionType: args.questionType } : {}),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.choiceOptions !== undefined ? { choiceOptions: args.choiceOptions } : {}),
      ...(args.intensity !== undefined ? { intensity: args.intensity } : {}),
      ...(args.isActive !== undefined ? { isActive: args.isActive } : {}),
    }
    const after = await guard(() =>
      updateEngagementQuestionAction({
        db: context.database,
        tenantId,
        questionId,
        expectedUpdatedAt: new Date(expectedUpdatedAt),
        patch,
        actor: venueActor(context.actor, 'OWNER'),
        now: context.now,
      }),
    )
    return { result: { questionId: after.id, question: json(after) }, after: json(after) }
  },
}
export const ENGAGEMENT_QUESTION_KINDS = [
  engagementQuestionCreateKind,
  engagementQuestionUpdateKind,
]
