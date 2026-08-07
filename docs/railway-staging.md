# Railway staging configuration

Create a Railway **staging environment** in the existing project, then add a
web service using `railway.staging.web.json` and a workers service using
`railway.staging.workers.json`. Set `RAILWAY_ENVIRONMENT=staging` on both
services in the Railway dashboard.

`RAILWAY_ENVIRONMENT` is the deployment boundary:

- `production` serves live traffic and must never run the synthetic seed.
- `staging` permits the synthetic seed in `@pathfinder/db` only.
- `preview` is reserved for ephemeral review deployments and cannot run the
  synthetic seed.

The staging web service uses `/api/health` as its Railway health check. The
workers service has no HTTP listener, so it intentionally has no HTTP health
check path.
