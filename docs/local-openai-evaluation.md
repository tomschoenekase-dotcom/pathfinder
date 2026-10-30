# Local Torchiko OpenAI evaluation

Launch approved local paid harnesses with:

```text
node scripts/with-torchiko-openai.mjs -- python <reviewed-case-runner> <arguments>
```

This uses `TORCHIKO_OPENAI_API_KEY` from the process environment and supplies it
as the child's `OPENAI_API_KEY`. It never falls back to the generic key, loads
dotenv files, persists secrets, or changes global/production configuration.
The SDK client must start inside this child process; existing clients cache keys.
Endpoint/project overrides fail closed pending explicit routing review.

October 21 investigation: the generic key returned 401 while the scoped Torchiko
key authenticated through the installed SDK. Do not conclude a key is missing
merely because the generic variable is rejected. Check variable selection first,
without printing secrets. Authentication success is not an answer-quality result.

This launcher grants no spending permission. Retain the approved cumulative cap,
reviewed current-head source/capture bindings, Gold isolation, per-call reservation,
and first transport failure stop. Never resume a stopped measurement journal.
