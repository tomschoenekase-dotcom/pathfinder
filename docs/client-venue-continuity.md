# Client venue continuity

The client shell keeps the selected venue when moving from its materials page to Help, Today, its QR kit, and a reviewed preview. A venue path takes precedence over an unrelated query value; shared routes retain the explicit venue query. Generic setup/new-venue routes remain generic. Query-bearing links keep their active-state indication.

The mobile drawer closes on route/query changes. Focus moves to the destination after the drawer releases inert content; Escape still returns focus to its trigger. Its mobile dialog and desktop complementary landmark now use valid semantics.

The client assistant follows same-path venue query changes and decoded venue paths. A changed route/client identity hides the prior context synchronously. Generation fences and cancellation prevent a late bootstrap, manual venue selection, or preference response from replacing the new context. In-panel venue selection remains an explicit separate user action.

## Local evidence

[Evidence record](evidence/client-venue-continuity-local-2026-09-08.json) retains 20 source hashes and 12 screenshot hashes. Seventy-one focused component/server-route tests pass, including six related admin-shell checks. Four browser tests pass at 320, 820, 1024, and 1440 pixels with reduced motion, keyboard navigation, zero axe violations/page errors, and no horizontal overflow. Typecheck and scoped lint pass.

The dev-only client-navigation fixture renders the actual shared components and preserves original link hrefs. Its allowlisted adapter maps those links to synthetic fixture targets; tRPC transport is stubbed. Each viewport submits exactly one support request for the intended second venue and reaches that venue's QR URL. Server-route tests independently prove real page selection/attachment/request/QR scope with mocked callers. This is not a claim of live Clerk transport, stored support mutation, uploaded bytes, provider extraction, or physical scanning.

The local fixture server was stopped and its port verified absent. Existing plain branding and layout were preserved; the final Tochi mascot/custom wordmark remains held.
