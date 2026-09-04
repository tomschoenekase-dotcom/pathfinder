# Torchiko Railway staging configuration

This project defines its Railway infrastructure in code.

```txt
.railway/railway.ts
```

This is the proposed project-level replacement for the staging project's legacy per-service Config-as-Code files. It is intentionally limited to the existing `serene-inspiration` staging project. Production is out of scope.

The TypeScript file imports `railway/iac`. Install the pinned SDK from the repository root with Node 22 or newer:

```bash
pnpm install --frozen-lockfile
```

## Common commands

Run the authenticated, bounded staging plan verifier:

```bash
pnpm --dir .railway plan
```

## Notes

- `railway config plan` is safe and does not change Railway.
- The wrapper also supplies the native CLI identity required by Railway SDK 3.11 on Windows, then emits only a bounded verdict rather than the full environment graph.
- Do **not** run `railway config apply`, `railway config migrate --apply`, or clear any Railway Config File setting from an unattended session.
- A plan must be reviewed against `docs/railway-iac-migration.md` before a human-approved staging maintenance window.
- Services already managed by `railway.json` must be migrated before `.railway/railway.ts` can manage them.
- Keep one `.railway` file for the whole project. A named `export const partial` (or `PARTIAL` / `const Partial`) is a last resort for separate repos that cannot share that file. Do not add it unless omit=delete across repos is a blocker.
- Use `replicas` for scaling; advanced placement can still specify region names.
- Secrets imported from Railway are rendered as `preserve()` so existing values are retained without writing secret values to source. Use `railway config pull --omit-preserved-variables` for a smaller import. `railway config pull --include-variables` decrypts and inlines non-sealed values (including secrets that were never sealed).
- Never use `railway config pull --include-variables` in this repository.
