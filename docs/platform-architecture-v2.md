# PathFinder platform architecture v2

## Product hierarchy and surfaces

The canonical hierarchy is Client/Organization → one or many Venues. A future Experience scope is
reserved in contracts and configuration precedence without forcing a premature user-facing entity.
Four surfaces have distinct trust and complexity boundaries:

- PathFinder OS: platform operations and cross-client attention.
- Internal Client Workspace: operator-only deep venue work.
- Client Portal: calm, task-oriented client actions with no analytics.
- Guest PathFinder: public, branded, mobile-first conversation and structured responses.

## Domain boundaries

Contracts are browser-safe. Database helpers own canonical transactional actions. API routers perform
authentication, authorization, validation, and response projection; they do not become alternate
business-logic implementations. Workers consume neutral packages and domain helpers, never app code.
MCP and partner registries are adapters over injected canonical actions and cannot bypass scope or
approval.

## Content and configuration

Places and Knowledge remain compatibility systems. Universal content adds typed identities,
immutable revisions, separate Service, Policy, Event, Operational Fact, and Relationship payloads,
and append-only evidence. Configuration axes—archetype, preset, audiences, capabilities, and feature
flags—remain independent. Effective values preserve their source layer and reset semantics.

## Packages and intake

Venue Deployment Manifest v2 represents complete and granular patch deployments with stable IDs,
canonical hashes, immutable assets, configuration provenance, and evaluation/readiness evidence.
The shared Intake Engine orchestrates source-specific adapters into evidence, discrepancies, and a
draft proposal. Validation, review, evaluation, preview, approval, and apply remain separate stages.

## AI, agents, and approvals

Every provider call passes through the AI gateway, admission controls, budgets, and usage evidence.
Agent identity, run, action, timeline, and approval records are durable and scope-bound. Access and
autonomy are independent. Approval decisions are immutable human evidence and do not trigger work.

## Security and operations

Tenant and venue scope are enforced in middleware, explicit query predicates, composite foreign
keys, migration guards, and adversarial tests. Public errors are safe. Risky systems are default-off.
The external database incident stop prohibits live inspection and migration until separately
authorized; local schemas and unapplied forward migrations are not live-readiness proof.

## Compatibility

Legacy venue package v1-v3, tone fields, guest links, QR codes, widget paths, and current content IDs
remain compatibility surfaces. New systems add adapters and versioned contracts rather than silently
rewriting durable history.
