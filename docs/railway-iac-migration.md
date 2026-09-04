# Railway Infrastructure-as-Code migration readiness

Railway Config as Code (`railway.json` / `railway.toml`) stops being read after **2026-12-01**.
Railway's replacement is one project-level `.railway/railway.ts` file. This repository must not run
`railway config migrate --apply`, `railway config apply`, clear Config File settings, or delete an
existing config file until an exact plan represents the complete staging graph without destructive or
unrelated changes.

## Current bounded finding — 2026-08-31

- `railway config migrate` dry-run found only the two generic legacy `railway.json` files.
- `railway config migrate --service` found no Config-as-Code file for `staging-web`,
  `staging-dashboard`, or `staging-workers`.
- A secret-safe `railway config pull --json` found all nine required staging resources, but the pulled
  dashboard graph reports Railpack and omits the Dockerfile, web migration predeploy, healthcheck, and
  restart-policy settings supplied by `railway.staging.*.json`.
- The generated TypeScript preview used `preserve()` for retained variables and exposed no variable
  values, but it is incomplete and must not be applied.
- The current `railway` TypeScript SDK release requires Node 22 while repository CI remains on Node 20.
  Runtime/toolchain alignment is a separate explicit migration decision.

These findings are expected consequences of Railway's documented boundary: Config-as-Code settings
override dashboard values but are not synchronized back into dashboard state.

## Secret-free readiness audit

From the linked staging checkout, pipe the raw imported graph directly into the bounded verifier:

```powershell
npx --yes @railway/cli@5.45.10 config pull --json | pnpm verify:railway-iac-readiness
```

The verifier reads at most 1 MiB, never emits variable names or values, requires all nine known staging
resources, and compares only build/deploy field identities against the three checked-in staging config
files. Exit `2` means the graph is valid but still omits one or more required Config-as-Code settings.
Exit `1` means the input/provider result could not be admitted. Exit `0` is necessary but not sufficient
for migration.

The checked-in proposal can be validated against the authenticated live project without printing the
full graph:

```powershell
pnpm verify:railway-iac-plan:live
```

This pins Railway CLI `5.45.10` and SDK `3.11.0` in the isolated `.railway` workspace, requires Node 22
or newer for the authoring tool only, validates the exact staging project and source branch, accepts
only the 13 expected safe legacy-setting updates, and rejects literal variable values or any destructive,
unrelated, production, or resource-topology change. It does not apply the plan.

CI uses a separate Node 22 job to compile and audit the checked-in source without Railway credentials:

```powershell
pnpm verify:railway-iac-source
```

The application test job remains on Node 20; the IaC SDK does not become an application runtime dependency.

## Cutover gate

Before any apply:

1. Produce one reviewed `.railway/railway.ts` containing all nine resources and all required staging
   Dockerfile, predeploy, healthcheck, restart, domain, volume, bucket, source, and preservation intent.
2. Resolve the Node 20/Node 22 authoring-runtime mismatch without weakening application compatibility.
3. Run the readiness audit above and retain only its bounded output.
4. Run `railway config plan --json` and `--detailed-exit-code`; reject any resource deletion, variable
   deletion, unrelated environment change, source-branch drift, volume/bucket replacement, or missing
   application setting.
5. Retain a fresh staging backup/recovery proof and the exact currently admitted deployment identities.
6. Require a reviewed maintenance window before `config migrate --apply` or `config apply` because
   those commands clear or replace live configuration ownership.
7. Re-run topology, runtime, migration-ledger, health, and hosted staging verification after cutover.

Production is outside this migration. Nothing in this document authorizes a production plan or apply.
