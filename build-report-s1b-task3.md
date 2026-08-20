# S1-B Task 3 - Workers Docker Image Build Verification

Date: 2026-08-07 (updated after fix verification)

## Commands run

```text
docker version --format '{{.Server.Version}}'
docker build --file Dockerfile.workers --tag pathfinder-workers:s1b-verify .
docker images --filter reference=pathfinder-workers:s1b-verify --format '{{.ID}} {{.Size}}'
```

## Results (initial run)

- Docker server version: `29.4.3`
- Build result: **FAILED**.
- Failing step: Dockerfile.workers line 14 - `RUN pnpm --filter @pathfinder/db exec prisma generate`.
- Error: `Cannot find module '/app/packages/db/node_modules/prisma/build/index.js'` (Node.js `v20.20.2`), causing `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`.
- Root cause: the Docker build context contained host `node_modules` / `.pnpm-store` directories (2.09 GB transferred), so `pnpm install --frozen-lockfile` inside the Linux container could not perform a clean install and the Prisma CLI module was missing.

## Fix applied (approved as part of the S1-B execution batch)

- Added root `.dockerignore` excluding host `node_modules/`, `.pnpm-store/`, `.corepack/`, `.corepack-bin/`, build artifacts, env files, and `.git/` so the container gets a clean Linux dependency install.
- Committed as `6eef9d3 fix(workers): exclude host dependencies from Docker context`.

## Results (after fix — verified 2026-08-07)

- Build result: **PASSED**.
- Image: `pathfinder-workers:s1b-verify` = `bf24d580e19d` (3.17 GB).
- Regression: `pnpm typecheck`, `pnpm lint`, `pnpm test` all green.

## Files changed

- Created `.dockerignore` (root).
- Created this report: `build-report-s1b-task3.md` (superseded by the S1-B work log verdict).
