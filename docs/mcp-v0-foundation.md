# PathFinder MCP v0 foundation

Status: contract and adapter foundation only; dark and not deployable.

This foundation targets the official MCP protocol revision `2026-07-28`:

- <https://modelcontextprotocol.io/specification/2026-07-28/server/tools>
- <https://modelcontextprotocol.io/specification/2026-07-28/server/resources>
- <https://modelcontextprotocol.io/specification/2026-07-28/schema>

The shared catalog is in `packages/contracts/src/mcp-v0.ts`. It describes deterministic resource
templates and a deliberately narrow tool set. Every definition carries explicit PathFinder scope,
capability, tenant/client/venue binding, effect, risk, default-enable, and approval metadata.
Standard MCP tool annotations remain conservative. Tool results include validated
`structuredContent` and the same serialized JSON in a text content block for backwards
compatibility.

The server-only registry is in `packages/api/src/mcp/registry.ts`. It validates input, verified
credential scope, capability grants, approval presence, and output around injected canonical domain
actions. It does not implement business logic or accept tenant authority from arguments.

## Deliberate limitations

- No MCP network listener, transport, `server/discover` handler, HTTP headers, or protocol request
  dispatcher exists.
- No OAuth/credential issuer, token validation, Clerk adapter, API-key persistence, or authorization
  server exists. The registry requires a credential scope already verified by the embedding server.
- No database, Prisma schema, migration, environment variable, feature-flag change, or external
  database action is included. The external database incident stop remains active.
- No canonical domain actions are bound yet. Production binding must reuse the existing authorized
  domain services rather than call Prisma or duplicate router logic.
- Draft/evaluation tools are disabled unless the embedding server explicitly enables them, and every
  such call additionally requires opaque approval evidence and invokes an injected canonical approval
  verifier for the exact tool, capability, client, and venue. Draft tools cannot publish or apply changes.
- Resource reads and evaluation execution are not production-ready until real action adapters,
  transport authorization, audit events, rate limits, and staging adversarial evidence exist.
