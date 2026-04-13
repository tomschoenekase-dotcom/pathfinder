import { PrismaClient } from '@prisma/client'

import { tenantIsolationMiddleware } from './middleware/tenant-isolation'

// Prisma v6 removed $use() middleware. Tenant isolation is wired via $extends query hooks.
function createClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  }).$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: { model: string | undefined; operation: string; args: unknown; query: (args: unknown) => Promise<unknown> }) {
          // Raw operations ($queryRaw, $executeRaw, etc.) have no model.
          // Pass them directly — the middleware cannot inspect them and the
          // args format for raw SQL must not be round-tripped through params.
          if (!model) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (query as (...queryArgs: any[]) => unknown)(args as any)
          }
          return tenantIsolationMiddleware(
            {
              action: operation,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              args: args as any,
              model,
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (params) => (query as (...queryArgs: any[]) => Promise<unknown>)(params.args as any),
          )
        },
      },
    },
  })
}

type PrismaClientWithExtensions = ReturnType<typeof createClient>

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClientWithExtensions
}

export const db = globalForPrisma.prisma ?? createClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
}
