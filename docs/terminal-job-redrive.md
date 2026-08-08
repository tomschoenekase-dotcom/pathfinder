# Terminal job redrive

PathFinder can redrive one retained BullMQ job that exhausted its configured attempts. The command is staging-only, defaults to a read-only preview, and accepts only approved leaf processing jobs. Scheduler, dispatcher, recovery, missing, nonterminal, retry-eligible, and unrecoverable jobs are refused.

Before using it, independently verify that `DATABASE_URL`, `DIRECT_DATABASE_URL`, and `REDIS_URL` all identify the same isolated staging environment. The command verifies the exact queue/job identity in both PostgreSQL and Redis, the job name, non-null tenant identity, canonical payload digest, failed state, matching started/completed attempt counts, and the `ATTEMPTS_EXHAUSTED` disposition. It never accepts a replacement payload.

Preview the current evidence:

```powershell
$env:RAILWAY_ENVIRONMENT = 'staging'
pnpm jobs:terminal-redrive --actor-id <operator-id> --queue <exact-staging-queue> --job-id <bull-job-id>
```

The preview returns a confirmation token bound to the exact `JobRecord` identity, terminal timestamp, queue, job name, and attempt counts. Re-inspect the result, then execute only if the job is safe to repeat:

```powershell
$env:PATHFINDER_ALLOW_TERMINAL_REDRIVE = 'staging-terminal-redrive'
pnpm jobs:terminal-redrive --actor-id <operator-id> --queue <exact-staging-queue> --job-id <bull-job-id> --execute true --confirm <preview-token>
```

Execution writes a strict `JOB_TERMINAL_REDRIVE_REQUESTED` audit row before asking BullMQ to atomically move the job from failed to waiting with both attempt counters reset. It then writes `JOB_TERMINAL_REDRIVE_ACCEPTED`. If the second audit write fails, the command reports `mutationAccepted: true`; inspect Redis and the audit log before doing anything else. A second concurrent or stale invocation cannot move the same job again from the failed set.

This tool does not decide whether a job's external side effects are semantically safe to repeat. That remains an operator review using the job type, failure evidence, and downstream idempotency contract. Production enablement requires a separate approved gate and is not available through this command.
