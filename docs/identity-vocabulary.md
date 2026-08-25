# Torchiko identity and ownership vocabulary

Status: current internal architecture contract as of 2026-08-25.

This vocabulary prevents customer experience, internal operations, character identity, and
engineering responsibility from collapsing into one ambiguous name. It changes no legal entity,
company-formation fact, trademark claim, customer promise, or external authorization.

## Names and owners

- **Torchiko is the customer-facing product and service identity.** Visitor pages, client
  onboarding, transactional customer communication, marketing, and human-readable operational
  notices use Torchiko.
- **PathFinder is a retained internal technical namespace** for the repository, package names,
  historical architecture, machine protocol identifiers, compatibility headers, environment
  variables, and other stable contracts. It is not a second customer product and should not appear
  in new customer-facing copy. Stable technical identifiers are not mechanically renamed because
  doing so would create migration and compatibility risk without improving the experience.
- **The Founder Control Room is Torchiko's founder operating interface.** It is the mobile-first
  surface for company state, compact decisions, approvals, incidents, and AI-worker conversation.
  It is not a general-purpose coding environment.
- **Tochi is the character and assistant identity** used where a visitor or client benefits from a
  consistent guide presence. Tochi is not the company, the repository, or the entire AI workforce.
  Useful assistance outranks decorative choreography.
- **Hermes is an optional operational worker and bridge runtime** outside this repository. Torchiko
  owns the durable capabilities, policies, evidence, and approvals; Hermes may exercise only the
  authority granted to its exact identity and run. Its trust may increase through evidence but is
  not assumed equal to Codex engineering authority.
- **Codex is the engineering worker** responsible for meaningful application and infrastructure
  changes through the separate repository workflow. Codex is not presented as a coding interface
  inside the Founder Control Room.

## Copy rule

New visitor-, customer-, and founder-readable product copy says **Torchiko**. A technical
PathFinder identifier may remain when it is part of an API, schema, environment, package, migration,
hash domain, or backwards-compatible integration contract. Internal prose should explain that
boundary rather than presenting PathFinder as another product the customer must understand.

The deterministic `scripts/visible-brand-contract.test.mjs` gate inventories rendered application
sources, retains an exact technical allowlist, verifies the welcome-email identity and domain, and
requires current-state documents to reference this contract.

## Change policy

Changing these ownership meanings is a product-direction decision. Mechanical copy convergence and
safe maintenance of the technical allowlist are ordinary engineering work. Any future legal entity,
trademark, contractual, or customer-facing commitment still requires its own explicit authority.
