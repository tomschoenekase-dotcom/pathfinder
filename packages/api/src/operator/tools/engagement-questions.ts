import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'
import { engagementQuestionSelect } from '@pathfinder/db'
import { operatorUntrustedText } from '../crm-projection'
import { assertTenantInGrant } from '../grants'
import type { OperatorReadTool } from '../registry'
import { pageResult, requireCursorInScope } from './page'

export const engagementQuestionsList: OperatorReadTool = {
  name: 'engagement.list_questions',
  capability: 'company:read',
  async handler(raw, context) {
    const args = OPERATOR_MCP_INPUTS['engagement.list_questions'].parse(raw)
    await assertTenantInGrant(context.grant, args.tenantId, context.database)
    const where = { tenantId: args.tenantId }
    await requireCursorInScope(args.cursor, (id) =>
      context.database.engagementQuestion.findFirst({
        where: { ...where, id },
        select: { id: true },
      }),
    )
    const rows = await context.database.engagementQuestion.findMany({
      where,
      select: engagementQuestionSelect,
      orderBy: { id: 'asc' },
      take: 26,
      ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, 25)
    return pageResult(
      page.map((row) => ({
        questionId: row.id,
        tenantId: row.tenantId,
        questionType: row.questionType,
        prompt: operatorUntrustedText(row.prompt, 500),
        choiceOptions: row.choiceOptions.map((value) => operatorUntrustedText(value, 100)),
        intensity: row.intensity,
        isActive: row.isActive,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
      rows.length > 25 ? page.at(-1)!.id : null,
    )
  },
}
