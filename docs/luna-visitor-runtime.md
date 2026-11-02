# Luna visitor runtime

Both `guest-chat-luna` and `guest-chat-luna-reasoning` use the same visitor baseline:
GPT-6 Luna, high reasoning effort, Fast service tier, 8192 output tokens and a
60-second per-attempt timeout. Reasoning and visible answer tokens share that cap.
The cap and timeout match the controlled high/Fast diagnostic; they provide room
for reasoning without changing the guest answer length instructions.

Fast reservations and usage estimates use twice standard rates per million tokens:
$0.20 input, $1 output, $0.25 cache write and $0.02 cache read. Existing retry limits
remain two attempts. Explicit workload/client/venue limits still take precedence.
Selecting either Luna key uses this profile through ordinary streaming and
nonstreaming generation; no evaluation-only override is required.

The explicitly selected `LOCAL_LUNA_STANDARD_V1` / `LOCAL_LUNA_FAST_V1` planner
experiments retain their separate low-effort, standard-price base specification,
1024-token cap and 20-second timeout. Their observed-tier accounting and guards
remain in force. The legacy `LOCAL_CORPUS_EVALUATION_V1` evaluation profile still
forces Standard tier and cannot establish visitor Fast parity.

This source change does not select Luna for a deployed guide or update live
configuration. Other model profiles and evidence-assembly flags are unchanged.
