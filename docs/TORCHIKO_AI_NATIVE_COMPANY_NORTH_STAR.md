# Torchiko AI-Native Company

## Master Implementation, Review, and Long-Term Architecture Packet

**Status:** Long-term north star + current-state review + incremental implementation guidance
**Audience:** Codex and other engineering/planning agents working on Torchiko
**Former project/product name:** Pathfinder
**Current company/product name:** **Torchiko**

---

# 0. Read This First

This packet is an updated description of the long-term operating model Torchiko should move toward.

It is intentionally ambitious.

It does **not** mean the current Torchiko implementation is bad, obsolete, or should be rebuilt.

Significant portions of this vision may already exist, may be partially implemented, or may already be heading in the correct direction.

Therefore:

> **DO NOT begin by rewriting systems. Begin by reviewing them.**

For each major area described in this packet:

1. inspect the existing implementation;
2. determine what already satisfies the target;
3. determine what partially satisfies it;
4. determine what is missing;
5. identify whether existing primitives can be extended;
6. preserve good working systems;
7. only implement changes where they create a clear improvement.

The desired outcome of this work is not:

> Replace Torchiko with a new architecture.

The desired outcome is:

> **Understand the updated long-term vision, evaluate how well the existing system supports it, and incrementally strengthen Torchiko so future development naturally converges toward that vision.**

---

# 1. The Central Vision

Torchiko should become an **AI-native company and AI-native operating platform**.

The eventual goal is for AI agents to perform the overwhelming majority of routine company work while Tom concentrates his human involvement on things where human participation actually adds significant value.

Long-term, Tom's normal Torchiko work should ideally consist primarily of:

- important customer calls;
- high-value sales conversations;
- major relationships;
- strategic decisions;
- product direction;
- unusual judgment calls;
- important approvals;
- answering questions raised by agents;
- discussing complicated issues with his primary AI;
- rare in-person venue visits when physical presence genuinely matters.

Tom should **not** need to personally perform the majority of routine:

- CRM work;
- research;
- follow-up;
- email administration;
- onboarding processing;
- data entry;
- testing;
- quality assurance;
- reporting;
- support review;
- customer monitoring;
- content maintenance;
- agent assignment;
- operational task management.

The fundamental long-term objective is:

> **Torchiko should operate Torchiko. Tom should direct the company.**

Over time, even significant portions of company direction and management may be prepared, researched, monitored, and executed by AI.

Tom remains the human authority, source of vision, strategic judgment, relationship-building ability, and final decision-making where appropriate.

---

# 2. Very Important Architectural Separation

Three systems must not be conceptually merged.

They cooperate closely, but they have different jobs.

## Hermes

Hermes is the **agent runtime and AI workforce environment**.

Persistent AI identities/bots fundamentally live in Hermes.

Hermes is responsible for things such as:

- persistent bots/profiles;
- bot-specific memory;
- agent sessions;
- tools;
- skills;
- model configuration;
- bot-to-bot communication;
- delegation;
- routines;
- Kanban/work orchestration where appropriate;
- execution of agent work.

Think:

> **Hermes is where the AI employees live.**

---

## Torchiko

Torchiko is the **business platform, company operating environment, operational system, and human control plane**.

Torchiko is responsible for things such as:

- clients;
- venues;
- prospects;
- CRM;
- email workflows;
- onboarding;
- analytics;
- support;
- reports;
- operational data;
- permissions;
- AI Operations UI;
- questions;
- approvals;
- agent run visibility;
- audit logs;
- operational triggers;
- machine interfaces agents use to work inside the company.

Think:

> **Torchiko is the company they work in.**

---

## Obsidian

Obsidian is the **shared durable organizational knowledge system**.

It should contain important knowledge that should outlive individual tasks or individual agent memories.

Think:

> **Obsidian is the organization's shared brain/library.**

---

# 3. Simple Mental Model

The long-term architecture should conceptually look like:

```text
                               TOM
                                |
                                |
              talks primarily to one trusted general AI
                                |
                                v
                    PRIMARY HERMES AI
                   / CHIEF OF STAFF
                                |
           +--------------------+--------------------+
           |                    |                    |
           v                    v                    v
      Research Bot        Operations Bot       Specialist Bots
           |                    |                    |
           +--------------------+--------------------+
                                |
                  ALL LIVE FUNDAMENTALLY
                         IN HERMES
                                |
                 tools / MCP / APIs / events
                                |
                                v
                         TORCHIKO
                company operating environment
                                |
        +-----------------------+-----------------------+
        |                       |                       |
        v                       v                       v
       CRM                  Onboarding              Support
      Email                  Analytics              Clients
      Sales                  Reports                Content
        |
        +--------------------- operational state
                                |
                                v
                    Torchiko operational DB


       HERMES BOTS <---------> OBSIDIAN
                     shared durable knowledge
```

Torchiko does not replace Hermes.

Hermes does not replace Torchiko.

They should become deeply integrated.

---

# 4. The Primary Hermes AI

Tom should maintain one **primary AI identity** that functions much like the broad Hermes assistant Tom already uses.

This AI should not be restricted to Torchiko.

That distinction is important.

The Primary Hermes AI may help Tom with:

- Torchiko;
- school;
- research;
- personal projects;
- technical work;
- planning;
- Japanese learning;
- general questions;
- other systems.

It is Tom's broad AI chief of staff.

Torchiko is one major environment this AI can operate within, but **Torchiko is not the totality of its existence or purpose.**

---

# 5. The Primary AI Inside Torchiko

Although the Primary Hermes AI is broader than Torchiko, it should have excellent Torchiko capabilities.

Inside Torchiko it should be able to:

- understand company status;
- inspect operational data;
- review AI work;
- create work;
- delegate work;
- dispatch specialist bots;
- understand current tasks;
- inspect blockers;
- discuss company issues with Tom;
- answer questions about Torchiko;
- summarize company activity;
- surface important changes;
- request decisions;
- help manage agent performance.

Tom should be able to talk to this same trusted AI from Torchiko.

This should ideally feel like:

> The same person I normally talk to is now sitting inside the company operating system with full awareness of what the organization is doing.

---

# 6. Tom Should Not Have to Pick Bots Constantly

The desired workflow is **not**:

> Tom opens a bot directory and chooses Research Bot.

Then:

> Tom chooses Finance Bot.

Then:

> Tom chooses Engineering Bot.

That creates additional management work for Tom.

Instead:

> Tom talks to the Primary Hermes AI.

Example:

Tom:

> Look into whether we need to rethink Torchiko pricing for small museums.

Primary AI decides:

> This needs research.

It delegates to a research specialist.

Research completes its portion.

The Primary AI may ask another specialist to assess economics.

The Primary AI synthesizes the results.

Tom receives:

- conclusion;
- important evidence;
- recommendation;
- decisions requiring him.

Tom should manage **the organization**, not manually route every task.

---

# 7. Where Specialist Bots Live

Specialist bots should fundamentally live in **Hermes**.

Examples may eventually include:

- Research;
- Sales;
- Outreach;
- Client Success;
- Onboarding;
- Analytics;
- Operations;
- QA;
- Product;
- Finance;
- Marketing;
- Engineering-related assistants;
- Security;
- Knowledge Management.

Do not create all of these merely because the names sound useful.

Persistent bots should be created when there is evidence that persistent specialization provides value.

---

# 8. Why Specialist Bots Can Feel Like They "Live in Torchiko"

Although technically hosted/run by Hermes, many specialist agents may spend most of their productive life operating Torchiko.

Example:

A Client Success bot may:

- monitor Torchiko clients;
- review usage;
- inspect conversations;
- prepare responses;
- create follow-up work;
- contact customers;
- update operational state.

So from Tom's perspective it may feel like:

> Client Success lives in Torchiko.

Architecturally, however:

> **Client Success is a Hermes agent using Torchiko as its work environment.**

Preserve this distinction.

It prevents Torchiko from unnecessarily rebuilding an entire agent runtime.

---

# 9. Hermes Should Remain Replaceable Enough

Torchiko should integrate deeply with Hermes without becoming so tightly coupled that the entire product would become impossible to evolve if Hermes changes.

Where practical, introduce clean boundaries for:

- agent run submission;
- run status;
- cancellation;
- task assignment;
- tool execution;
- events;
- question/blocking states;
- agent identity;
- agent metadata.

Do not unnecessarily recreate Hermes internals.

But also avoid scattering Hermes-specific assumptions throughout unrelated business logic.

Think:

> Hermes is currently the preferred AI workforce runtime.

Torchiko is the business operating system around that workforce.

---

# 10. The Four Layers of Knowledge and State

There should be a strong separation between four concepts.

---

## Layer A — Hermes Private Bot Memory

Represents:

> **What this particular AI worker has learned.**

Examples:

Research Bot learns:

- good research methods;
- recurring source issues;
- useful query techniques;
- things it personally tends to miss.

Engineering-related bot learns:

- repository-specific pitfalls;
- useful debugging habits;
- recurring technical patterns.

Primary AI learns:

- which specialists are reliable;
- Tom's preferences;
- common delegation patterns;
- what requires escalation.

This memory can be individualized.

Individual bots do **not** need identical memories.

---

## Layer B — Obsidian Shared Organizational Knowledge

Represents:

> **What Torchiko as an organization should know.**

Examples:

- company strategy;
- major decisions;
- product philosophy;
- market research;
- architecture documentation;
- sales lessons;
- onboarding lessons;
- customer patterns;
- operating procedures;
- recurring failure modes;
- policies;
- project context;
- long-term plans.

Relevant bots should be able to access this shared knowledge.

---

## Layer C — Torchiko Operational Data

Represents:

> **What is currently true in the company.**

Examples:

- customer account;
- venue;
- prospect;
- deal stage;
- email;
- current onboarding state;
- usage;
- analytics;
- support case;
- billing state;
- permissions;
- active agent run;
- approval;
- live content.

Torchiko's database should remain authoritative for live operational facts.

---

## Layer D — Active Work / Kanban

Represents:

> **What needs to happen and what is being done.**

Examples:

- tasks;
- assignments;
- dependencies;
- blockers;
- review;
- handoffs;
- retries;
- completion state.

Use durable task primitives rather than relying exclusively on conversational context.

---

# 11. Agents Must Become Better Over Time

This is a core requirement.

Torchiko's AI workforce should **not remain static**.

As agents:

- perform work;
- receive feedback;
- talk to Tom;
- see outcomes;
- make mistakes;
- get corrected;
- collaborate;
- operate Torchiko;

they should gradually become more effective.

This must be designed intentionally.

---

# 12. Types of Agent Learning

An agent may improve in several ways.

## Personal Memory Improvement

Example:

Research Bot learns:

> Tom cares much more about evidence quality than number of sources.

That may become part of Research Bot's private memory.

---

## Organizational Learning

Example:

Multiple small museums respond better when outreach emphasizes easy setup.

That should be promoted to Obsidian because Sales, Marketing, Research, and the Primary AI may all benefit.

---

## Skill Improvement

If an agent repeatedly develops a reliable workflow, it may be appropriate to turn that workflow into:

- a reusable Hermes skill;
- a deterministic tool;
- an SOP;
- a tested workflow.

Example:

Research Bot repeatedly performs competitor teardowns successfully.

Eventually create a formal competitor-research skill.

---

## System Improvement

If agents repeatedly encounter the same limitation, engineering should improve Torchiko.

Example:

Onboarding agents repeatedly fail because accessibility information is missing.

Solution should not merely be:

> Agents remember to be careful.

Better solution:

> Torchiko's onboarding process explicitly collects accessibility information.

---

# 13. Feedback From Tom Is Valuable Training Signal

When Tom corrects an agent, that correction should not simply disappear into a chat transcript.

The system should consider:

> Is this useful feedback for future behavior?

Example:

Agent recommends emailing a particular prospect.

Tom says:

> Don't pursue companies this large unless we're ready to offer enterprise implementation.

Potential learning:

- private agent memory;
- Primary AI decision preference;
- sales strategy note in Obsidian;
- future qualification rule.

The correct destination depends on scope.

---

# 14. Human Feedback Should Not Cause Reckless Self-Modification

Agents becoming better does **not** mean agents should arbitrarily rewrite their own operating instructions after every comment.

Learning should be controlled.

Possible destinations:

1. ephemeral conversation context;
2. persistent private memory;
3. shared knowledge proposal;
4. updated skill;
5. workflow change;
6. product feature;
7. formal policy.

Changes with large consequences should receive stronger review.

---

# 15. Capture Outcome Feedback

Agent quality cannot be determined only from whether Tom liked an answer.

Torchiko should increasingly connect work with outcomes.

Examples:

Sales outreach:

- sent;
- opened;
- replied;
- ignored;
- meeting booked;
- deal won.

Support:

- customer satisfied;
- follow-up needed;
- escalated;
- refund requested.

Onboarding:

- QA score;
- client edits;
- guest failure rate;
- Tom corrections.

Research:

- recommendation adopted;
- information later shown wrong;
- result reused.

These outcomes can help determine:

> Which agents, models, prompts, skills, and workflows actually work?

---

# 16. Agent Reputation / Performance Layer

Torchiko should eventually maintain useful operational information about agents.

Possible metrics:

- task type;
- model;
- completion rate;
- review acceptance rate;
- correction rate;
- failure rate;
- cost;
- latency;
- escalation rate;
- outcome quality;
- historical strengths;
- known weaknesses.

Example:

### James — Research

Strong:

- competitive research;
- venue investigation;
- source triangulation.

Weak:

- cost forecasting.

Recent:

- 18/20 research outputs accepted without major revision.

This information can help the Primary AI delegate intelligently.

---

# 17. Agents Should Learn From Each Other Without Sharing Everything

An Engineering Bot does not need every fact a Research Bot has ever encountered.

But if Research discovers something organizationally important, it should be promoted to shared knowledge.

Think:

```text
Research private discovery
        |
        v
Does this matter beyond Research?
       / \
     no   yes
     |     |
private   shared knowledge
memory    / Obsidian
```

This avoids:

- memory contamination;
- unnecessary context;
- contradictory agent histories.

while preserving:

- organizational learning;
- cross-specialist knowledge.

---

# 18. Knowledge Promotion Protocol

Every relevant agent should follow a conceptual rule:

### Keep Private

If:

> This primarily helps me perform my own role.

### Promote to Obsidian

If:

> This could meaningfully help another agent or future company decision.

### Write to Torchiko

If:

> This is a live business fact.

### Create Work

If:

> Someone needs to take action.

---

# 19. Do Not Let Obsidian Become Garbage

Agents should not continuously dump raw text into Obsidian.

Avoid storing:

- chain-of-thought style scratch work;
- every search result;
- duplicated findings;
- low-confidence speculation;
- raw tool traces;
- temporary task details;
- constantly changing operational state.

Prefer a controlled flow.

---

# 20. AI Knowledge Inbox

If there is uncertainty about whether knowledge belongs in canonical Obsidian notes, use an **AI Knowledge Inbox**.

Each candidate may include:

- finding;
- source;
- source timestamp;
- contributing agent;
- project;
- confidence;
- why it matters;
- proposed destination.

A Knowledge/Operations bot can periodically:

- merge duplicates;
- resolve stale information;
- promote useful items;
- archive noise;
- update canonical notes.

This creates organization-wide learning without destroying the vault.

---

# 21. Kanban Is a Major Primitive

Hermes Kanban or another durable task system should become a major component of agent work.

Review the existing Hermes Kanban capabilities carefully.

Use them where appropriate instead of building redundant orchestration.

Desired behavior includes:

- durable tasks;
- ownership;
- dependencies;
- assignment;
- blockers;
- handoffs;
- review;
- retries;
- comments;
- resumability;
- human intervention;
- audit history.

---

# 22. The Primary AI Should Delegate Naturally

Tom says:

> Improve our museum onboarding.

The Primary AI may create work like:

```text
Research existing onboarding patterns
      -> Research

Audit current Torchiko onboarding
      -> Product/Operations

Analyze known onboarding failures
      -> Analytics

Propose improvements
      -> Product

Assess implementation
      -> Engineering

Implement safe changes
      -> Engineering

QA changes
      -> QA

Summarize
      -> Primary AI
```

Tom should not have to manually coordinate every step.

---

# 23. Agents Should Create New Work

Agents should be able to recognize that one task implies another.

Example:

Research finds that a competitor has released a major feature.

It may create:

> Evaluate competitive impact.

Example:

Analytics detects repeated visitor confusion.

It may create:

> Investigate whether venue knowledge is missing.

Guard against infinite task creation.

Agents should have:

- priority;
- budgets;
- work limits;
- deduplication;
- escalation rules.

---

# 24. Bidirectional Torchiko ↔ Hermes Integration

This is fundamental.

---

# 25. Hermes → Torchiko

Hermes agents should be able to **operate Torchiko**.

Agents should use machine interfaces such as:

- MCP;
- internal APIs;
- structured service endpoints;
- controlled actions.

They should not rely primarily on browser clicking.

Potential capabilities:

```text
search_clients
get_client
update_client
get_venue
update_venue
search_prospects
create_prospect
update_pipeline
get_conversations
search_conversations
get_support_case
create_insight
get_analytics
draft_email
queue_email
send_permitted_email
get_onboarding_state
update_onboarding
create_question
request_approval
create_task
complete_task
get_agent_status
```

Permission boundaries must apply.

---

# 26. Torchiko → Hermes

Torchiko should also be able to **initiate and supervise Hermes work**.

Examples:

Torchiko detects:

- new lead;
- onboarding completed;
- content changed;
- support case;
- visitor anomaly;
- unanswered question;
- stale content;
- customer reply;
- weekly report;
- approval granted.

Torchiko may then:

- create agent work;
- target a specialist;
- ask the Primary AI to route it;
- monitor status;
- receive events;
- record completion;
- surface blockers.

---

# 27. Torchiko Should Be an AI Control Plane

Torchiko should increasingly become an **external control plane for the AI organization**.

It should understand:

- agent identities;
- active work;
- status;
- blockers;
- questions;
- approvals;
- outputs;
- failures;
- costs;
- performance.

But the agent runtime itself remains Hermes.

---

# 28. MCP Is the Hands

MCP should expose capabilities.

Examples:

> Read this client.

> Search these chats.

> Update this record.

> Draft an email.

> Create a question.

It should not be confused with orchestration.

The AI runtime decides:

> Who should do this?

The task system decides:

> What needs to happen?

Obsidian provides:

> What do we know?

Torchiko provides:

> What is operationally true and what actions are available?

---

# 29. AI Operations / Command Center

The AI Operations area should become one of the most important surfaces in Torchiko.

This is **not merely a question inbox**.

It is Tom's human interface into the autonomous company.

If this vision succeeds, Tom may spend more time here than in any other Torchiko admin screen.

Therefore:

> **AI Operations UI quality is a first-class product requirement.**

---

# 30. AI Operations Must Look and Feel Excellent

Do not treat this section like an internal engineering dashboard.

It should feel like a polished flagship product experience.

Requirements should include:

- modern frontend design;
- excellent information hierarchy;
- fast perceived performance;
- fast actual loading;
- skeleton/loading states where appropriate;
- responsive interactions;
- good empty states;
- useful grouping;
- clear visual importance;
- readable typography;
- sensible density;
- intuitive navigation;
- smooth transitions where beneficial;
- strong keyboard/mouse usability;
- mobile responsiveness where practical;
- accessibility;
- minimal unnecessary reloads;
- live updates where useful.

Tom will potentially use this screen constantly.

A poor UI would directly reduce the productivity benefit of the agent system.

---

# 31. Optimize AI Operations for Fast Human Judgment

The purpose of the UI is not to display everything agents do.

The purpose is to help Tom understand:

> What matters?

> What requires me?

> What changed?

> What should I decide?

The UI should optimize for rapid comprehension and action.

---

# 32. AI Operations Information Architecture

Potential major areas:

1. **Needs You**
2. **Working Now**
3. **Completed**
4. **Blocked / Problems**
5. **Agent Team**
6. **Activity / Audit**
7. possibly **AI Conversations**
8. possibly **Budgets / Model Usage**

Do not force this exact navigation if an existing implementation is better.

Review what already exists.

---

# 33. Needs You

This should be the most important queue.

Possible item types:

- approve;
- reject;
- yes/no;
- multiple choice;
- short answer;
- long answer;
- number;
- date/time;
- select one;
- select many;
- schedule;
- discuss;
- review artifact;
- high-risk warning.

---

# 34. Each Question Should Contain Useful Context

A question should ideally include:

- requesting agent;
- associated task;
- why Tom is being asked;
- relevant evidence;
- recommendation;
- alternatives;
- urgency;
- consequences.

Bad:

> Should we do this?

Good:

> The museum requested a custom analytics export. Estimated implementation effort is moderate and projected account value is high. Engineering believes it can be isolated safely. Sales recommends agreeing to explore it without committing to a ship date.

Then choices.

---

# 35. Inline Discussion

Some questions need conversation.

Tom should be able to discuss an item directly with the relevant agent or Primary AI.

Example:

> Why do you prefer option B?

Agent responds.

Tom asks:

> Would this complicate multi-venue support?

Agent responds.

Tom makes choice.

The complete discussion should remain associated with:

- task;
- decision;
- affected work.

---

# 36. Answering Must Resume Work Automatically

Critical behavior:

```text
Agent working
      |
      v
Needs human decision
      |
      v
BLOCKED
      |
      v
Needs You
      |
      v
Tom answers
      |
      v
context delivered to agent
      |
      v
task automatically resumes
```

Tom should not have to:

1. answer;
2. open another page;
3. find task;
4. manually restart it.

---

# 37. Working Now

Show meaningful active work.

Examples:

- Researching Chicago museum prospects;
- Processing venue media;
- Running QA;
- Drafting follow-up campaign;
- Investigating support anomaly.

Do not display thousands of microscopic tool calls as the primary view.

Detailed execution data belongs in drill-down.

---

# 38. Completed Work

Show outcomes.

Examples:

- 47 prospects researched;
- 19 follow-ups sent;
- 4 onboarding gaps repaired;
- report generated;
- client content updated;
- 31 AI failures classified;
- 2 issues escalated to clients.

The question should be:

> What did the AI organization accomplish?

not:

> How many LLM calls occurred?

---

# 39. Blocked / Problems

Examples:

- agent failed;
- customer has not replied;
- tool unavailable;
- missing permission;
- repeated QA failure;
- contradictory data;
- confidence too low;
- model/provider unavailable.

Provide clear next actions.

---

# 40. Agent Team

Eventually show:

- name;
- role;
- model;
- status;
- current tasks;
- skills;
- permissions;
- cost;
- quality;
- recent outcomes;
- strengths;
- weaknesses.

This should feel like viewing a workforce, not debugging processes.

---

# 41. Audit / Activity

High autonomy demands strong observability.

Detailed views should support inspection of:

- initiating trigger;
- responsible agent;
- model;
- tool calls;
- data changes;
- timestamps;
- approvals;
- output;
- errors;
- retries;
- source data.

Do not clutter the main dashboard with all of this.

Make it available when needed.

---

# 42. AI Operations Performance Requirements

Because this may become Tom's primary admin interface:

- avoid expensive full-page reloads;
- paginate/virtualize large streams;
- avoid loading giant trace payloads by default;
- cache stable information appropriately;
- stream or incrementally update current status;
- lazy-load deep audit data;
- keep interactive elements responsive;
- minimize layout shifts;
- avoid giant client bundles where unnecessary;
- use good frontend architecture.

The page should feel immediate even when thousands of agent activities exist underneath it.

---

# 43. The Human Attention Principle

Tom's attention is expensive.

Before asking Tom, an agent should evaluate:

```text
Can I solve this?
        |
Can Torchiko data answer it?
        |
Can Obsidian answer it?
        |
Can another specialist answer it?
        |
Can Primary AI decide within authority?
        |
Should the CLIENT answer this?
        |
Does Tom actually need to decide?
```

Only then:

> Needs You.

---

# 44. Tom Is Not the Universal Human-in-the-Loop

Many issues should go to customers.

Example:

> Which entrance is wheelchair accessible?

The venue manager probably knows.

Tom probably does not.

The system should ask the venue.

---

# 45. Customer Question System

Torchiko should increasingly support AI-created client questions.

Example:

> We detected that your uploaded map labels Gallery C but no description for Gallery C was provided. Is Gallery C visitor-facing?

Customer answers.

Agent resumes work.

---

# 46. Customers Should Experience AI-Native Operations Too

Clients should not have to become expert Torchiko operators.

Long-term client experience may include:

> Torchiko noticed your holiday hours appear to have changed on your website.

[Update] [Keep Existing]

or:

> 17 visitors asked whether strollers are permitted upstairs. We do not currently have enough information.

[Answer]

Customer answers.

System updates itself.

---

# 47. Remote Onboarding

Remote onboarding is expected to become an important part of this architecture.

However:

> **DO NOT attempt to fully design or implement the remote onboarding system solely from this packet.**

A separate dedicated Codex implementation prompt will cover remote onboarding in much greater detail.

For this packet, preserve the architectural expectation that remote onboarding should eventually support:

- client uploads;
- structured intake;
- photos;
- videos;
- maps;
- documents;
- websites;
- AI extraction;
- missing-information detection;
- customer questions;
- knowledge construction;
- QA;
- confidence scoring;
- escalation.

When implementing adjacent systems, avoid decisions that would make a strong remote onboarding workflow unnecessarily difficult later.

---

# 48. Current Onboarding Reality

At present Tom may still need to:

- physically visit some venues;
- examine client material;
- verify generated venue data;
- inspect whether the AI was configured properly;
- test the finished assistant.

This is expected.

These are currently valuable learning activities.

Do not prematurely remove human inspection until the automated systems are demonstrably trustworthy.

---

# 49. Manual Onboarding Review Should Generate Learning

Every Tom correction is useful.

Capture:

- what was wrong;
- why;
- how Tom recognized it;
- what data was missing;
- whether a validator could detect it;
- whether future clients should be asked something;
- whether QA could identify it.

Then improve the system.

Core rule:

> **Tom should rarely need to manually solve the exact same category of routine onboarding failure twice.**

---

# 50. In-Person Visits

Long-term, physical visits should occur because they create real value.

Examples:

- complex venue layout;
- insufficient remote material;
- important enterprise customer;
- relationship building;
- unique physical requirements.

They should not happen simply because Torchiko lacks a good digital process.

---

# 51. Testing / QA Must Become Automated

Tom currently performs some AI testing.

Long-term this should move toward automated QA.

Possible categories:

- basic factual questions;
- exhibit content;
- navigation;
- accessibility;
- policies;
- ambiguous questions;
- multi-turn context;
- multilingual questions;
- adversarial requests;
- unanswerable questions;
- hallucination traps;
- location-specific scenarios.

---

# 52. QA Pipeline

Potential future pattern:

```text
Venue build/change
      |
      v
Test generator
      |
      v
Synthetic visitor agents
      |
      v
Evaluation
      |
      v
Failure classification
      |
      v
Safe repair
      |
      v
Retest
      |
      v
Confidence score
      |
   +--+--+
   |     |
 launch  human review
```

Again: build incrementally.

---

# 53. Real Conversations Become QA

After launch, guest interactions should produce continuous signals.

Detect:

- repeated questions;
- unanswered questions;
- repeated rephrasing;
- contradictory answers;
- likely hallucinations;
- low-confidence answers;
- navigation confusion;
- missing knowledge;
- stale data.

Agents should investigate and repair safe cases.

---

# 54. AI Workforce Model Flexibility Is a Core Requirement

Torchiko/Hermes should not become locked to one model provider.

Model availability, pricing, quality, rate limits, and promotional deals change rapidly.

The architecture should make model changes **easy, controlled, observable, and reversible**.

---

# 55. Central Model Configuration

Avoid burying model names throughout code or agent prompts.

Prefer centralized configuration defining things such as:

- provider;
- model;
- agent;
- task class;
- fallback;
- maximum cost;
- context needs;
- tool requirements;
- reasoning requirements;
- quality tier.

An agent's logical identity should not depend on one specific model.

Example:

> James = Research Agent.

Today James may use Model A.

Tomorrow James may use Model B.

James should remain James.

---

# 56. Model Router / Model Economy Layer

Long-term, create a system that continuously evaluates available models and economics.

This may involve a specialist agent such as:

> **Model Economy Bot**

or:

> **Model Router / Procurement Agent**

Its job would be to monitor things such as:

- current API pricing;
- available usage credits;
- subscription allowances;
- promotional offers;
- temporary discounts;
- provider reliability;
- rate limits;
- benchmarks;
- observed Torchiko performance;
- latency;
- tool-use quality;
- context size;
- local model availability.

---

# 57. Hourly Model-Economics Review

Tom specifically wants the possibility of something like:

> Every hour, inspect where good usage capacity, credits, deals, or unusually inexpensive strong models are available.

This is a valid long-term goal.

The agent may identify:

> Provider X currently offers a model comparable to our Research model at 20% of the current effective cost.

Then it can evaluate whether routing some workloads there is advantageous.

---

# 58. Do Not Blindly Chase Cheap Models

Cheap does not automatically mean better economics.

The system should evaluate:

```text
effective cost
      +
quality
      +
failure rate
      +
retry rate
      +
latency
      +
tool success
      +
context requirements
      +
reliability
```

A model costing 50% less but causing three times as many failed tasks is not cheaper.

---

# 59. Automatic Model Switching Should Be Policy-Based

Long-term, some model switching may become automatic.

Example policy:

### Low-Risk Work

Model Economy Bot can automatically switch when:

- candidate passes evaluation;
- cost improvement exceeds threshold;
- quality remains above threshold;
- required tools work;
- fallback remains available.

### Medium-Risk Work

Run canary test first.

Then automatically switch if metrics remain strong.

### High-Risk Work

Recommend switch to Tom or Primary AI for approval.

---

# 60. Canary Model Migration

Do not globally replace a model immediately.

Preferred process:

```text
candidate model discovered
        |
        v
benchmark existing tasks
        |
        v
tool compatibility test
        |
        v
small traffic canary
        |
        v
compare quality/cost
        |
     +--+--+
     |     |
    good   bad
     |     |
expand    revert
```

---

# 61. Task-Based Model Routing

Different workloads should use different models.

Examples:

### Premium reasoning model

Use for:

- major strategy;
- sensitive client issues;
- complicated architecture;
- high-value contracts;
- difficult reasoning.

### Strong inexpensive cloud model

Use for:

- routine research;
- summarization;
- classification;
- normal operations.

### Local model

Use for:

- high-volume extraction;
- simple classification;
- deterministic-ish language processing;
- repetitive tasks where quality is validated.

---

# 62. Provider Redundancy

Where practical, avoid single-provider dependency.

The system should support:

- primary;
- fallback;
- alternative provider;
- local fallback where appropriate.

If a provider goes offline, routine company operations should not necessarily stop.

---

# 63. Model Performance Should Be Measured on Torchiko Work

Generic benchmarks are useful but insufficient.

Torchiko should eventually develop internal evaluations.

Examples:

- outreach quality;
- research accuracy;
- venue QA;
- MCP tool reliability;
- question classification;
- onboarding extraction;
- support quality.

A model may rank highly publicly but perform poorly on Torchiko's actual workflows.

---

# 64. Agent Identity Must Survive Model Changes

This is essential.

Do not conceptually treat:

> Research Bot = DeepSeek Model X.

Instead:

> Research Bot = role + memory + skills + permissions + history + purpose.

Model is one configurable component.

That enables aggressive economic optimization without destroying organizational continuity.

---

# 65. Cost Visibility

AI Operations should eventually provide usable cost information.

Possible:

- cost today;
- cost this week;
- cost per agent;
- cost per client;
- cost per workflow;
- cost per successful outcome;
- local vs cloud usage;
- provider usage.

Do not optimize solely around token counts.

Optimize around useful work.

---

# 66. Model Economy Agent Should Learn Too

The model optimization agent itself should track:

- which switches worked;
- which benchmarks predicted reality;
- provider reliability;
- hidden failure costs;
- model strengths;
- deal expiration.

It should become increasingly good at procurement/routing.

---

# 67. Human Approval Boundaries for Model Switching

Tom should not receive alerts for every tiny model price change.

Set authority.

Example:

Model Economy Bot may:

- automatically route low-risk extraction;
- automatically use free credits;
- automatically move test workloads.

It may need approval to:

- change Primary AI model;
- change high-risk customer-facing reasoning;
- change critical QA evaluator;
- adopt unknown provider handling sensitive data.

---

# 68. AI Operations Could Include Model/Cost Intelligence

Potential section:

### AI Economy

> Estimated AI spend this month: $42
> Savings vs baseline routing: $18
> Local work share: 21%
> Active providers: 4
> Potential optimization identified: $7/month

Example:

> Nous promotion makes Model X economical for research until September 1.

[Use for Research] [Test First] [Ignore]

This can eventually become mostly automatic.

---

# 69. Learning + Routing Combined

Agent performance should be tracked by:

- agent identity;
- model;
- task type;
- skill version.

This allows conclusions such as:

> James using Model A has a 94% acceptance rate.

> James using Model B costs 60% less and has a 93% acceptance rate.

That is useful.

A vague global model benchmark is less useful.

---

# 70. Emails

Routine email should increasingly be agent-operated.

Agents may:

- classify messages;
- draft replies;
- send permitted replies;
- update CRM;
- follow up;
- extract commitments;
- schedule with appropriate approval.

Escalate major categories such as:

- angry customers;
- refunds;
- enterprise prospects;
- major custom functionality;
- unusual contractual commitments;
- press/media;
- legal concerns.

---

# 71. Sales

Long-term:

```text
market research
      |
prospect discovery
      |
qualification
      |
personalization
      |
outreach
      |
reply classification
      |
follow-up
      |
meeting
      |
proposal
      |
CRM
```

AI should handle routine process.

Tom should become involved in high-value human interactions.

---

# 72. Client Success

Agents should proactively detect:

- declining usage;
- unanswered questions;
- stale information;
- client inactivity;
- support issues;
- seasonal changes;
- unusual engagement.

They should investigate before escalating.

---

# 73. Product Intelligence

Customer activity should feed product development.

Example:

Several clients request employee-only knowledge.

System detects pattern.

Product work is created.

Research investigates.

Primary AI summarizes.

Tom decides priority.

---

# 74. Development Agents

Codex, Claude Code, and future engineering agents may not live inside Hermes in the same way as Hermes Bots.

Do not force every AI system into one runtime.

Torchiko's long-term control plane may interact with multiple agent systems.

Hermes remains particularly useful for:

- persistent workers;
- routines;
- specialized business agents;
- delegation.

Codex/Claude may remain particularly useful for:

- substantial code work;
- architecture;
- implementation;
- repository operations.

---

# 75. Future Cross-Agent Workspace

Buzz or another cross-runtime collaboration layer may eventually connect:

- Tom;
- Hermes Bots;
- Codex;
- Claude Code;
- other agents.

This is complementary to Bot Mode.

Do not make Torchiko dependent on Buzz unless there is a clear reason.

Bot Mode can support the Hermes organization now.

Buzz may later become a cross-runtime office.

---

# 76. Deterministic Software vs Agents

Do not use AI merely because AI is interesting.

If deterministic code can solve something reliably, prefer deterministic code.

Examples:

- validation;
- exact calculations;
- schema enforcement;
- permission checks;
- state transitions;
- retries;
- notifications;
- basic scheduling;
- simple transformations.

Use agents for:

- ambiguity;
- judgment;
- research;
- natural language;
- planning;
- interpretation;
- synthesis.

---

# 77. The Best System Is Hybrid

Example onboarding:

AI:

> Understand uploaded materials.

Code:

> Validate required fields.

AI:

> Identify missing semantic information.

Code:

> Track completion state.

AI:

> Ask precise customer question.

Code:

> Resume job after response.

Do not make an LLM responsible for deterministic orchestration if normal software can do it better.

---

# 78. Event-Driven Work

Where appropriate, Torchiko should emit structured events.

Examples:

```text
lead.created
lead.replied
client.created
onboarding.submitted
onboarding.processing_completed
onboarding.qa_failed
venue.ready_for_review
client.question.answered
visitor.issue.detected
content.stale
support.escalated
approval.granted
report.ready
```

Events can launch AI workflows.

Avoid forcing agents to constantly poll everything.

---

# 79. Autonomy Ladder

Move workflows gradually.

### Level 1

Human performs.

### Level 2

AI assists.

### Level 3

AI performs, human reviews.

### Level 4

AI performs, exceptions reviewed.

### Level 5

Autonomous routine.

Different workflows may remain at different levels indefinitely.

---

# 80. Trust Must Be Earned

Autonomy should depend on:

- task risk;
- agent reliability;
- model quality;
- reversibility;
- financial impact;
- customer impact;
- historical outcomes;
- confidence.

---

# 81. Permission Architecture

Agents need explicit permission boundaries.

Read operations are different from:

- deleting data;
- issuing refunds;
- changing billing;
- promising custom work;
- deploying production;
- changing security;
- contacting press.

Use role-based capabilities.

---

# 82. Human Override

Tom must always be able to:

- inspect;
- pause;
- cancel;
- override;
- edit;
- approve;
- reject;
- disable;
- change permissions;
- review logs.

Low required intervention does not mean low control.

---

# 83. Safe Failure

If an agent cannot confidently proceed:

Do not guess.

Prefer:

- retry;
- delegate;
- retrieve;
- ask customer;
- block;
- escalate.

Uncertainty should be represented explicitly.

---

# 84. Operational Resilience

Guest-serving and client-critical Torchiko systems should not become completely dependent on internal AI orchestration being online.

Separate:

- customer-facing critical systems;
- internal AI operations.

If internal agents fail temporarily, Torchiko should degrade gracefully.

---

# 85. Outcome-Oriented Agent Reporting

Tom does not need:

> I made 43 API calls.

Tom needs:

> I researched 31 prospects, qualified 9, and found 3 strong opportunities. One requires your input.

Detailed traces remain available.

---

# 86. Example Future Torchiko Dashboard

```text
TORCHIKO AI OPERATIONS

Good morning, Tom.

AI WORKFORCE
14 active
4 idle
0 critical failures

NEEDS YOU — 5
──────────────────────────────

Enterprise prospect requested custom reporting
Recommendation: pursue
[Approve] [Decline] [Discuss]

Onboarding confidence: 86%
One unresolved spatial issue
[Review]

Client requests partial refund
Recommendation: offer one month credit
[Approve] [Reject] [Discuss]

Research proposes pricing experiment
[Review]

Museum offered in-person meeting
Recommendation: accept
[Yes] [No] [Discuss]


WORKING NOW
──────────────────────────────

James — Research
Chicago museum qualification
17/24 complete

Onboarding
New venue ingestion
QA phase

Client Success
Analyzing unanswered questions

Outreach
Follow-up campaign
28/41 complete


COMPLETED
──────────────────────────────

✓ 43 prospects researched
✓ 19 emails sent
✓ 3 client knowledge gaps resolved
✓ 2 stale-content changes handled
✓ 1 onboarding automatically repaired


AGENT ECONOMY
──────────────────────────────

Estimated AI spend today: $1.84
Saved through routing: $0.71

Model Economy Bot:
New candidate found for research workloads.
Estimated 48% lower cost.
Canary evaluation running.
```

This is illustrative, not a mandatory layout.

Frontend should improve on it.

---

# 87. Example Tom Workflow

## Morning

Tom opens Torchiko.

He answers:

- two approvals;
- one scheduling choice;
- one product decision.

Ten minutes.

Agents resume.

---

## Later

Primary Hermes AI messages:

> One enterprise prospect appears unusually promising. I've prepared a briefing for your 2 PM call.

Tom does call.

Transcript enters Torchiko.

Agents:

- summarize;
- update CRM;
- create follow-up;
- update sales knowledge;
- draft proposal;
- create product question if needed.

Tom does not perform administration.

---

## Afternoon

Tom talks to Primary Hermes AI:

> Anything important?

AI:

> No urgent problems. Sales found two promising prospects, onboarding cleared one venue, QA caught an accessibility issue and asked the client, and Engineering is blocked on one choice from you.

Tom answers.

Done.

---

# 88. Human Touch Rate

Eventually measure:

> How often does Tom need to intervene?

Examples:

### Onboarding

Today: perhaps high.

Goal: steadily lower.

### Support

Goal: exceptions.

### Email

Goal: major/sensitive cases.

### QA

Goal: novel failures and low-confidence cases.

Do not optimize blindly for zero.

Optimize for:

> human participation where it adds value.

---

# 89. Repeated Intervention Rate

Track recurring manual corrections.

If Tom solves the same problem repeatedly, ask:

> Why is this still reaching Tom?

Repeated intervention should trigger automation/product improvement.

---

# 90. AI Learning Dashboard — Possible Future

Potentially expose:

### What the Organization Learned

- 8 new knowledge items promoted;
- 2 operating rules updated;
- 1 Research skill improved;
- 3 recurring onboarding failures identified;
- 1 new QA validator proposed.

This could help Tom understand that the AI organization is becoming more capable rather than simply performing tasks.

---

# 91. Model Routing Dashboard — Possible Future

Potentially expose:

### Model Fleet

Primary AI — Model X
Research — Model Y
Extraction — Local Model
QA — Model Z
Fallback — Model Q

### Changes

Research moved from Model A → Model Y.

Reason:

- 42% lower effective cost;
- equivalent evaluation score;
- faster latency.

Automatic rollback available.

---

# 92. Do Not Overbuild Dashboards Before Data Exists

The preceding ideas describe long-term possibilities.

Do not implement empty UI merely to match this document.

Build infrastructure first when necessary.

Only expose metrics that can be measured meaningfully.

---

# 93. Review Before Implementing

Before changing Torchiko, perform a systematic audit.

For each area classify:

### COMPLETE / STRONG

Already meets vision.

No meaningful change required.

### PARTIAL

Good foundation exists but should be extended.

### MISSING

Important capability absent.

### DUPLICATIVE RISK

Hermes already provides this and Torchiko should probably integrate rather than rebuild.

### DEFER

Useful later but premature now.

---

# 94. Required Review Areas

Audit at minimum:

1. AI Operations current implementation;
2. questions/approvals;
3. agent run model;
4. agent identity representation;
5. Hermes integration;
6. MCP architecture;
7. Kanban integration;
8. Obsidian integration;
9. operational audit trail;
10. email agent architecture;
11. client portal question workflows;
12. onboarding architecture;
13. QA/testing infrastructure;
14. event architecture;
15. model/provider configuration;
16. cost tracking;
17. agent permissions;
18. frontend performance;
19. AI Operations UX;
20. task resumption after human input.

---

# 95. Review Existing Progress Respectfully

Do not assume:

> Previous Codex work failed to anticipate this vision.

Much of Torchiko may already strongly support it.

The purpose of the audit is to recognize existing progress.

Example output:

> Existing AI questions architecture already supports structured response types and conversation threads. Preserve it.

> Existing agent lineage infrastructure provides strong auditability. Extend it rather than replacing it.

> Existing MCP work already supports bidirectional operation. Fill gaps only.

This is preferable to unnecessary rewrites.

---

# 96. Produce a Gap Map

After review, create something like:

```text
AREA                     STATUS       NEXT ACTION

AI Operations            Partial      Expand status views
Questions                Strong       Preserve
Human resume flow        Partial      Add automatic resume
Hermes dispatch          Partial      Harden
Kanban                    Unknown      Audit
Obsidian read             Strong       Preserve
Obsidian write protocol   Missing      Add promotion flow
Agent reputation          Missing      Design later
Model abstraction         Partial      Centralize
Model economy agent       Missing      Defer/plan
QA automation             Early        Incremental build
Remote onboarding         Separate     Do not implement here
```

Exact format may differ.

---

# 97. Then Create an Incremental Implementation Plan

Separate changes into:

### Now

High leverage and foundational.

### Soon

Useful once foundations are stable.

### Later

Requires scale/data.

### Experimental

Interesting but not yet proven.

---

# 98. Likely Near-Term Foundations

Potentially high-value areas include:

- clean Hermes/Torchiko interface;
- reliable agent identity;
- robust task status;
- human question → automatic resume;
- Kanban review;
- Obsidian knowledge-promotion rules;
- centralized model configuration;
- AI Operations frontend quality;
- audit trail;
- permission boundaries.

But verify existing implementation before deciding these are missing.

---

# 99. Remote Onboarding Is Separate Work

Do **not** expand this implementation packet into a full remote onboarding rewrite.

Tom intends to provide a dedicated prompt for that project.

This packet should ensure:

- architecture supports it;
- agent system can use it;
- questions can flow to clients;
- QA can connect later;
- events and state transitions can support it.

---

# 100. Codex Should Keep a Distinction Between Vision and Implementation

Some ideas in this packet may be:

- immediate;
- months away;
- dependent on scale;
- dependent on Hermes evolution;
- dependent on better model availability.

Do not implement every futuristic feature today.

Use this document to guide architecture.

---

# 101. Core Design Questions for Every Future Feature

When modifying Torchiko, ask:

### Human Work

Does this create recurring work for Tom?

Could AI eventually do it?

---

### Agent Access

Can a Hermes agent use this capability safely without the human UI?

---

### Machine Interface

Is there an MCP/API/event interface where appropriate?

---

### Human Interface

If Tom must use it, is the UI excellent?

---

### Knowledge

Does this produce reusable organizational knowledge?

---

### Learning

If Tom corrects the system, does anything improve?

---

### Delegation

Can the Primary AI route this to the right specialist?

---

### Models

Can this workload change models without rewriting the feature?

---

### Cost

Can cheaper models perform this safely?

---

### Feedback

Can outcomes be measured?

---

### Audit

Can we determine why something happened?

---

### Failure

Can it fail safely?

---

### Scale

Would this architecture still make sense with 1,000 clients?

---

# 102. Important Anti-Patterns

## One Giant Shared Hermes Memory

Avoid.

Use:

- private agent memory;
- shared Obsidian;
- Torchiko operational state.

---

## One Model Everywhere

Avoid.

Use configurable models and routing.

---

## Hardcoded Model Names

Avoid when practical.

---

## Blind Automated Model Switching

Avoid.

Use evaluations, canaries, and policies.

---

## Every Question Goes to Tom

Avoid.

Use escalation hierarchy.

---

## Every Bot Dumps Into Obsidian

Avoid.

Use knowledge promotion.

---

## Torchiko Rebuilds Hermes

Avoid.

Integrate.

---

## Hermes Becomes Torchiko's Database

Avoid.

Torchiko owns operational state.

---

## Agents Operate Only Through UI

Avoid.

Provide machine interfaces.

---

## Ugly Internal AI Dashboard

Avoid.

AI Operations is a flagship interface.

---

## Slow AI Operations Screen

Avoid.

Tom may use it constantly.

---

## Human Answers But Task Does Not Resume

Avoid.

---

## Agents Never Learn

Avoid.

Feedback should improve behavior/system.

---

## Agents Self-Modify Recklessly

Avoid.

Learning should be controlled and auditable.

---

## Automating Unknown Workflows Too Soon

Avoid.

Observe first.

---

## Agent Theater

Avoid agents talking endlessly without producing useful outcomes.

---

# 103. Long-Term Evolution of Tom's Role

Today Tom may still:

- onboard venues;
- test AI;
- inspect generated data;
- monitor client setups;
- manually conduct outreach;
- coordinate development;
- handle operational edge cases.

That is okay.

The trajectory should gradually become:

```text
DOES WORK
   |
SUPERVISES AI DOING WORK
   |
REVIEWS RESULTS
   |
HANDLES EXCEPTIONS
   |
SETS PRIORITIES / MAKES DECISIONS
```

---

# 104. Human Work That May Remain Valuable

Even in an extremely autonomous Torchiko:

### Important calls

Human trust matters.

### Major relationships

Human relationships matter.

### Rare site visits

Physical context sometimes matters.

### Strategic judgment

Tom remains company owner/founder.

### Product taste

Not every decision should be delegated.

### Major risk decisions

Some authority should remain human.

---

# 105. Human Work That Should Shrink Aggressively

- routine email;
- CRM maintenance;
- research;
- follow-up;
- simple support;
- repetitive onboarding processing;
- routine AI testing;
- data transfer;
- report generation;
- repeated manual correction;
- assigning every small task;
- manually checking whether work resumed.

---

# 106. The Compounding Advantage

The most important economic property of this architecture is:

> **More clients should not require proportionally more Tom.**

If Torchiko grows from:

10 clients → 100 → 1,000 → 10,000,

Tom's direct operating workload should grow much more slowly.

That is the operating leverage this architecture is trying to produce.

---

# 107. Agents Becoming Better Creates a Second Compounding Advantage

Not only should automation reduce labor.

The workers themselves should improve.

Over time:

- Research knows the market better.
- Sales knows what converts.
- Onboarding knows recurring data gaps.
- QA knows common hallucination patterns.
- Client Success knows warning signals.
- Primary AI knows which agents to trust.
- Model Economy knows which providers/models provide actual value.

Therefore:

> Torchiko should become more operationally capable as it accumulates experience.

---

# 108. Model Economics Creates a Third Compounding Advantage

As model markets improve:

- better models appear;
- local models improve;
- prices drop;
- discounts emerge;
- free usage appears;
- providers compete.

Torchiko should capture these improvements automatically where safe.

The long-term company should ideally become:

> **more capable and/or cheaper to operate over time because its AI infrastructure can continuously adopt better economics.**

---

# 109. The Three Compounding Loops

The ultimate architecture should create three reinforcing loops.

## Automation Loop

```text
Tom performs task
      |
system learns pattern
      |
AI performs task
      |
Tom reviews
      |
AI handles exceptions
      |
human workload falls
```

## Knowledge Loop

```text
Agent works
      |
discovers something
      |
feedback/outcome arrives
      |
useful learning retained
      |
future agent performance improves
```

## Model Economy Loop

```text
model market changes
      |
router discovers opportunity
      |
candidate evaluated
      |
cheaper/better model adopted
      |
operating efficiency improves
```

Together these are strategically powerful.

---

# 110. Final Target Architecture

Conceptually:

```text
                              TOM
                               |
                vision / judgment / relationships
                               |
                               v
                     PRIMARY HERMES AI
                      Chief of Staff
                               |
            +------------------+------------------+
            |                  |                  |
            v                  v                  v
        Research           Operations          Specialists
            |                  |                  |
            +------------------+------------------+
                               |
                          HERMES RUNTIME
                               |
                 +-------------+-------------+
                 |                           |
                 v                           v
             KANBAN                       SKILLS
                 |
                 |
        APIs / MCP / events
                 |
                 v
                         TORCHIKO
              AI-native company operating system
                 |
      +----------+----------+----------+----------+
      |          |          |          |          |
     CRM       Email    Onboarding   Support   Analytics
      |          |          |          |          |
      +----------+----------+----------+----------+
                 |
                 v
          OPERATIONAL DATABASE

HERMES AGENTS <------------------------> OBSIDIAN
                  shared company brain


MODEL ECONOMY / ROUTING LAYER
                 |
     continuously evaluates providers,
     models, cost, usage, credits,
     reliability, quality and local options
                 |
                 v
        configurable Hermes workforce
```

---

# 111. North-Star User Experience

The ideal long-term interaction is:

Tom opens Torchiko.

Torchiko says:

> Here's what your AI organization accomplished.

> Here's what it's doing now.

> Here are the three things only you can answer.

Tom answers.

The agents continue.

Later Tom talks to his Primary Hermes AI about:

- Torchiko;
- another project;
- school;
- personal work;
- anything else.

That same AI knows his Torchiko organization and can dispatch work there when relevant.

Tom does not need to constantly manage the distinction.

The architecture does.

---

# 112. The One-Sentence Architecture

> **Hermes hosts the AI workforce, Obsidian stores shared organizational knowledge, Torchiko is the company operating environment and control plane, and Tom primarily interacts with a trusted Primary Hermes AI plus Torchiko's polished AI Operations interface.**

---

# 113. The One-Sentence Business Goal

> **Build Torchiko so that customer count and company capability can increase dramatically without requiring a proportional increase in Tom's routine human labor.**

---

# 114. The One-Sentence Learning Goal

> **Every meaningful interaction, correction, task outcome, and operational failure should have the potential to make the relevant agent, shared knowledge, skill, workflow, or product system better next time.**

---

# 115. The One-Sentence Model Goal

> **Agent identities and workflows must remain portable across models so Torchiko can continuously adopt the best available combination of quality, cost, reliability, and available usage without constantly rebuilding the organization.**

---

# 116. Directive to Codex

Treat this packet as an updated north-star architecture and review mandate for Torchiko.

Do not assume current implementation is missing everything described here.

Do not perform a wholesale rewrite.

Instead:

1. **Review the existing Torchiko implementation against this packet.**
2. **Identify what is already complete or strongly aligned.**
3. **Preserve those systems.**
4. **Identify partial implementations that can be extended.**
5. **Identify genuine gaps.**
6. **Identify places where Hermes already provides the correct primitive.**
7. **Avoid duplicating Hermes unnecessarily.**
8. **Keep persistent specialist bots fundamentally in Hermes.**
9. **Keep Torchiko as their operational environment/control plane.**
10. **Keep Obsidian as shared durable organizational knowledge.**
11. **Ensure agents can improve over time from work, outcomes, and Tom's feedback.**
12. **Ensure model choice is abstracted enough to change easily.**
13. **Plan for cost/quality-aware model routing and eventual model-economy automation.**
14. **Treat AI Operations as a flagship frontend experience, not an internal afterthought.**
15. **Keep AI Operations performant and pleasant even as agent activity scales.**
16. **Preserve safe human override and strong auditability.**
17. **Prefer agent-accessible machine interfaces alongside human UI.**
18. **Use deterministic systems where they are more reliable than agents.**
19. **Do not implement the full remote onboarding vision from this packet; a separate dedicated prompt will cover that system.**
20. **Incrementally move routine work away from Tom while preserving human involvement where it creates real value.**

After reviewing the existing system, produce a concise but thorough **current-state alignment report** containing:

- what already exists;
- what is strong;
- what is partially implemented;
- what is missing;
- what should be preserved;
- what should be extended;
- what should be deferred;
- where Hermes should be used rather than Torchiko rebuilding functionality;
- major architectural risks;
- recommended implementation phases.

Then implement the highest-confidence foundational improvements that are appropriate under the current authorized scope.

When uncertain between:

> adding flashy autonomous behavior

and

> strengthening the durable infrastructure required for trustworthy autonomy,

prefer the durable infrastructure.

The ultimate objective is not to produce more bots.

The ultimate objective is to produce an organization that **gets useful work done correctly, learns from experience, continuously improves its economics, asks Tom only when necessary, and can scale dramatically without scaling Tom's routine workload with it.**

---

# 117. Final North Star

Torchiko should eventually feel less like software Tom personally operates and more like a company that is already working when he arrives.

The AI workforce should:

- notice;
- research;
- plan;
- execute;
- collaborate;
- verify;
- learn;
- improve;
- optimize its model usage;
- ask clients;
- ask Tom when necessary;
- resume automatically;
- record what matters;
- continuously make the organization better.

Tom should arrive primarily to provide:

- vision;
- judgment;
- relationships;
- creativity;
- authority;
- taste.

The desired future is not:

> Tom becomes extremely efficient at clicking through Torchiko.

The desired future is:

> **Tom rarely needs to click through Torchiko at all because the AI organization is already operating it competently on his behalf.**
