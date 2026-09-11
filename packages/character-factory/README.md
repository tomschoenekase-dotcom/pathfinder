# Character factory architecture slice

This package is the renderer-neutral, agent-callable core for Torchiko P07. It provides:

- imported-source compatibility inspection with integrity, active-content, rig-slot, and identity checks;
- three trusted rig families sharing one semantic state grammar while retaining anatomy-specific controls;
- typed create, revise, inspect, preview, validate, and export jobs;
- request replay, cancellation before writes, optimistic version fencing, and imported provenance retention;
- pinned OpenMoji owl, astronaut, and morph source fixtures for local architecture proof.

The fixture SVGs are quarantined inputs and are never represented as generated assets or final Tochi art.
The package intentionally does not register BullMQ queues or persist database rows. The shared jobs/worker/db
owners must adapt `FactoryJobRequest`, `FactoryJobResult`, and `CharacterFactoryStore` to those canonical systems.

`fixtures/architecture-proof.json` records what this proof establishes and the remaining architecture risks.
