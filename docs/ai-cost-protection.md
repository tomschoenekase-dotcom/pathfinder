# AI cost protection and founder alerts

Torchiko's tenant AI cost budget is an explicit operator-configured hard boundary. It uses fixed
`1e-8 USD` units for exact reservation arithmetic, but its values are estimates and never invoices
or customer prices. No budget exists by default, and this implementation does not choose a dollar
limit, warning percentage, customer cutoff policy, or automatic budget increase.

## Enforcement

Every covered provider attempt reserves its registered worst-case cost before dispatch. A request
that cannot fit is denied before provider I/O. Dispatched attempts settle exact observed cost when
possible; ambiguous or expired attempts retain their conservative ceiling. A response observed
above its reserved ceiling marks the configured budget breached and blocks new covered requests
until a human reviews and resets or replaces the window.

Cost-control rejection is authoritative. Failure to persist an alert never reopens capacity,
changes the admission result, or causes another provider call.

## Founder Control Room evidence

The cost-control boundary publishes tenant-scoped, deduplicated `OperationalEvent` evidence for:

- `ai-cost-budget.request-denied` when a bounded reservation cannot fit the configured capacity;
- `ai-cost-budget.breached` when an observed over-ceiling settlement records a breach, and when a
  later request encounters that recorded breach.

Both events are `ERROR`, require action, link to the exact `AiCostBudget`, and group by budget epoch
so repeated denials do not flood the Control Room. The Founder briefing treats them as current
customer/system risk and links directly to that tenant's AI cost budget controls. Acknowledging or
resolving the alert does not reset, increase, disable, or otherwise mutate the budget.

## Agent-readable cost protection

An exact client/venue worker with `resources:read` and `ai-usage:read` can retrieve the current
configured `gateway-v1` hard-budget state alongside venue daily usage rollups. The projection
includes only the configured window, exact limit/remaining/reserved/committed values, epoch,
revision, breach time, and descriptive lifecycle state. It omits the operator-entered reason and
operator identity and exposes no write path.

The response explicitly records that anomaly thresholds remain unresolved, estimated costs are not
invoices, automatic budget mutation and service suspension are unauthorized, and customer pricing
is unaffected. An absent budget is returned as `NOT_CONFIGURED`; the system does not invent one.

## Retained gates

- No pre-breach anomaly threshold is invented. Warning thresholds and automatic emergency policy
  remain a founder/operating-policy decision.
- No event automatically disables the venue, cancels a customer, changes pricing, or promises a
  credit or SLA remedy.
- In-app Control Room evidence is implemented. External push, SMS, email, or wake-up escalation is
  not activated.
- Provider, staging, and production behavior require their own authorized smoke evidence.

## Verification

The disposable PostgreSQL integration applies the full migration chain and proves concurrent
capacity enforcement, one grouped request-denial event, over-ceiling breach persistence, a breach
event, and future-request blocking. API and dashboard contracts prove that cost events become a
Founder briefing risk and route to the correct tenant controls rather than unrelated chat logs.
The agent-observability disposable proof separately verifies exact-venue usage isolation, current
tenant budget state, private policy omission, capability enforcement, and zero persistent residue.
