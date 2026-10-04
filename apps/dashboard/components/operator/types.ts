import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'

type AdminOutputs = inferRouterOutputs<AppRouter>['admin']

export type OperatorReviewItemView = AdminOutputs['operatorReview']
export type ReviewStepView = OperatorReviewItemView['steps'][number]
export type OperatorAutonomyRow = AdminOutputs['operatorAutonomy'][number]
export type OperatorConnectionRow = AdminOutputs['operatorConnections'][number]
export type OperatorJobGrantPanel = AdminOutputs['operatorJobGrants']
export type OperatorAuditRowView = AdminOutputs['operatorAudit'][number]
