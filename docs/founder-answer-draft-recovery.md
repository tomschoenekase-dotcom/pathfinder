# Founder answer draft recovery

Unsent founder answers can be recovered after reloading or revisiting a question in the same browser tab. The admin operations page and venue agent page supply the signed-in actor from the server session. Drafts are separated by actor, tenant, venue, question, and exact question revision. Missing actor identity disables storage.

Recovery preserves free text, selected options, and optional multi-select context. A small note appears when a draft is restored. Loading a draft never submits an answer, resumes a worker, approves an action, or grants publication rights. The existing answer API remains the authority boundary.

The session store expires drafts after 24 hours and retains at most 20 entries, with a 12 KiB draft limit and 48 KiB total serialized limit. New writes evict older entries when needed. Reads validate the envelope and its bounds. Invalid, unavailable, or full browser storage must not prevent normal answering. Previous revisions are removed when the current revision is loaded; expired questions and confirmed answers or dismissals clear their exact draft. A recorded answer awaiting a worker wake-up retry is no longer an unsent draft.

Hydration starts with the same empty form on server and client, then restores storage behind a save fence. Early user input is protected from a delayed restore. Scope changes and completed mutations are fenced so an old response cannot clear another question and a refreshed page cannot re-save a recorded answer.

## Verification boundary

The browser acceptance uses the existing development-only founder triage fixture with the explicit synthetic identity `fixture-founder-admin`. It exercises actual React rendering, browser session storage, reloads, failed-save recovery, successful clearing, and exact mutation payloads with intercepted network responses. It does not authenticate a real account or call a live API.

Rendered proof covers 1440, 1024, 820, and 390 pixel widths, keyboard focus, horizontal overflow, reduced motion, and automated accessibility checks. The existing exact worker wake-up retry browser test also passes. The interface retains its current evidence-first composition; the only new visible element is the brief restored-draft note. Final Tochi artwork and wordmark design remain deferred.

This is bounded same-tab recovery, not server-backed or cross-device draft storage. Browser-session termination, storage eviction, or privacy settings can remove drafts. Semantic question deduplication, bulk answers, and the full integrated founder workload remain separate campaign requirements.
