

# Path Finder MVP Brief

## 1. Product summary

**Path Finder** is a location-aware chatbot for outdoor consumer destinations with multiple activities, such as sculpture parks, zoos, botanical gardens, bird sanctuaries, and similar places.

The purpose of the MVP is to help **first-time visitors** feel less overwhelmed, understand what the place offers, and make better moment-to-moment decisions during their visit.

**Core promise:**
**Path Finder helps people make the most of every moment of their day.**

---

## 2. First target customer and first target user

### First target customer

Outdoor destinations with many activities and physical points of interest:

* sculpture parks
* bird sanctuaries
* botanical gardens
* zoos
* similar walkable venues

### First target end user

**First-time visitors** who do not know the layout well and want help deciding:

* what they are near
* what is worth doing next
* where practical amenities are

---

## 3. Problem being solved

These places can feel overwhelming. Guests often:

* do not know what is nearby
* do not know what is worth prioritizing
* miss experiences they would have enjoyed
* waste time figuring out logistics like bathrooms, food, or activity locations

Path Finder reduces friction by acting like a **context-aware on-site guide**.

---

## 4. Tight MVP definition

The MVP is a **mobile-first, location-aware chatbot** that answers questions based on:

* the visitor’s current location
* the venue’s static structured data
* the venue’s defined points of interest and amenities

### Assumption for v1 platform

Since the user will walk around a real place and test location services, **v1 should be a mobile web app / PWA**, not desktop-first.

---

## 5. Core user jobs in v1

The user must be able to:

1. **Ask Path Finder for information about where they currently are**

   * “What am I near?”
   * “What is this area?”
   * “What can I do here?”

2. **Ask Path Finder where they should go next**

   * “What should I do next?”
   * “What nearby thing is most worth seeing?”
   * “I like animals / views / quiet spots / food — what should I go to next?”

3. **Ask Path Finder for practical nearby information**

   * “Where is the nearest bathroom?”
   * “Where can I get ice cream?”
   * “Where is the closest place to sit?”
   * “What is near me right now?”

---

## 6. What v1 must feel like

This cannot feel like a generic chatbot with venue text pasted into it.

It must feel like:

* it knows where the user is
* it understands the land and the venue layout
* it can prioritize based on physical proximity
* it can answer venue-specific questions better than a normal LLM
* it can guide the user through a place in a grounded way

The differentiator is **location-aware venue intelligence**, not general conversation.

---

## 7. In scope for v1

### Visitor-facing

* mobile-first chatbot UI
* anonymous use, no account required
* browser geolocation with permission flow
* precise user location shown internally to the app logic
* structured venue data ingestion from static files or admin-entered data
* location-aware answers based on nearest relevant POIs
* recommendations for what to do next based on:

  * user query
  * current location
  * venue metadata
  * distance / proximity
* answers for amenities like bathrooms, food, seating, exits, etc.
* ability to support a fake demo venue such as **“Activities at My House”**

### Business/admin framework

* business entity model exists
* venue/project configuration exists
* data can be loaded per business/venue
* minimal admin/business scaffolding exists for future expansion
* architecture supports future data adapters/integrations

### Architecture

* static-data-first
* clean framework for future connectors
* clear separation between:

  * venue data
  * location logic
  * chat orchestration
  * future business dashboard / accounts

---

## 8. Explicitly out of scope for v1

These are intentionally **not** part of the MVP:

* interactive map as a major feature
* rich map exploration UI
* analytics dashboard
* business reporting
* proactive nudges or push notifications
* behavior tracking for business optimization
* personalization or user profiles
* saved preferences
* recommendations driven by company goals
* live third-party integrations
* payments or ticketing
* audio mode
* staff tools
* loyalty / gamification
* multi-venue enterprise control panel beyond simple framework scaffolding

---

## 9. Key product principles

1. **Chat-first, not map-first**
   The chatbot is the product. Anything that distracts from getting the chatbot excellent should be deferred.

2. **Location is the moat**
   The system must use real user position in a meaningful way.

3. **Framework over one-off hack**
   Even though data is static in v1, the system should be built so each new venue can be plugged in cleanly.

4. **Anonymous and low-friction**
   A user should be able to land on the app, allow location, and start asking questions.

5. **Useful in the real world, not just impressive in a demo**
   The product should help someone while physically moving through a place.

---

## 10. Core user flows

## Flow 1: First-time visitor starts using Path Finder

1. User opens the mobile web app
2. User selects or lands in a configured venue experience
3. App requests location permission
4. App detects current location
5. User sees chat interface with suggested starter prompts like:

   * What am I near?
   * What should I do next?
   * Where is the nearest bathroom?
6. User asks a question
7. System responds with venue-aware, location-aware guidance

## Flow 2: User asks “What am I near?”

1. User sends message
2. System reads current coordinates
3. System determines nearest POIs / zones / amenities
4. System returns:

   * nearby items
   * what each one is
   * what is most worth doing depending on context

## Flow 3: User asks “What should I do next?”

1. User asks recommendation question
2. System checks:

   * current location
   * nearest candidate places
   * category metadata
   * venue-defined importance / tags
3. System recommends one or a few next options with reasons

## Flow 4: User asks for practical amenity help

1. User asks for bathroom, food, seating, etc.
2. System finds nearest relevant amenity
3. System gives clear directional guidance in plain language

## Flow 5: Venue setup

1. Admin/developer creates a venue/business record
2. Admin uploads or defines static venue data
3. Venue data is normalized into standard schema
4. Venue becomes available to chat layer without rewriting the product

---

## 11. Functional requirements

## A. Chat experience

* clean mobile chat UI
* quick-start prompt chips
* answer streaming preferred but not required
* system prompt and retrieval should be grounded in venue data
* responses should be concise, useful, and on-site oriented

## B. Geolocation

* browser/mobile location permission flow
* location refresh during walking session
* app stores current position temporarily during session
* system can compute nearest POIs and amenities from coordinates

## C. Venue intelligence

* venue has zones / points of interest / amenities
* each item includes name, type, description, coordinates, tags, and optional priority
* recommendation logic uses proximity plus semantic fit
* chatbot answers should cite venue-specific facts internally, even if not displayed as citations

## D. Multi-tenant framework

* support multiple venues/businesses
* each venue has separate data
* each venue can be configured without code rewrites
* architecture supports future data adapters

## E. Business scaffolding

* business account / venue model exists in database
* basic admin access structure exists
* no heavy dashboard UI required yet

---

## 12. Non-functional requirements

* mobile-first responsive UI
* clean and simple UX
* low-friction setup
* clear code organization
* easy venue onboarding
* low-cost architecture where possible
* easy to test with fake venue data
* privacy-conscious handling of user location
* no user account required

---

## 13. Suggested MVP data model

## Business

* id
* name
* type
* slug
* status

## Venue

* id
* business_id
* name
* description
* category
* geo_boundary optional
* default_center_lat
* default_center_lng

## Place / Point of Interest

* id
* venue_id
* name
* type
  examples: attraction, amenity, entrance, food, seating, restroom, scenic_spot, exhibit
* short_description
* long_description optional
* lat
* lng
* tags
* importance_score optional
* area_name optional
* hours optional

## Suggested Route / Recommendation metadata

* id
* venue_id
* title
* applicable_tags
* target_place_ids
* priority rules optional

## Session

* id
* venue_id
* anonymous_user_token
* started_at
* latest_lat
* latest_lng

## Message

* id
* session_id
* role
* content
* created_at

## Data Adapter

* id
* venue_id
* adapter_type
  examples: static_json, csv_import, cms_feed, live_api_future
* config_blob

---

## 14. Recommendation logic for v1

Keep it simple and deterministic enough to feel smart.

When answering:

* prioritize nearby relevant places
* use venue tags and place types
* prefer practical answers when user intent is logistical
* prefer nearby highlights when user intent is exploratory
* explain recommendations in grounded terms:

  * “You’re close to…”
  * “A good next stop is…”
  * “Since you’re near X, Y is a strong choice…”

The system should not pretend to know live conditions unless live data exists.

---

## 15. Demo scenario requirement

The MVP must support a fake venue test case called something like:

**Activities at My House**

Example fake POIs:

* playground
* front yard
* backyard
* driveway basketball hoop
* kitchen snack area
* porch sitting area
* bathroom
* garage activity zone

The user should be able to walk around and ask:

* What am I near?
* What should I do next?
* Where is the nearest bathroom?
* What fun thing is closest to me?

This demo is critical because it proves:

* location works
* chat feels venue-aware
* venue setup framework is reusable

---

## 16. Success criteria / definition of demo-ready

The MVP is demo-ready when all three are true:

1. **Location services work and are accurate**

   * app can detect and update location while walking around the venue
   * proximity-based responses are meaningfully tied to where the user actually is

2. **The chatbot communicates well and goes beyond a generic LLM**

   * answers feel grounded in the venue
   * answers reference current nearby context
   * it helps the user decide what to do next, not just describes things

3. **It is easy to plug a new business into the framework**

   * venue data can be loaded into a standard schema
   * adding a new venue does not require product rewrites
   * fake venue and real venue can share the same architecture

---

## 17. Main risks to design around

### 1. Adoption risk

Businesses may not care enough to use it.

**Response in MVP:**
Make venue onboarding simple and demo value obvious.

### 2. Generic AI risk

The chatbot may feel like a normal LLM.

**Response in MVP:**
Make answers heavily grounded in:

* current location
* venue schema
* proximity-based reasoning
* venue-specific wording

### 3. Cost risk

LLM/API costs may become expensive at scale.

**Response in MVP:**
Keep v1 lean:

* small prompt context
* structured retrieval
* deterministic pre-processing where possible
* no unnecessary agent loops

### 4. Overbuilding risk

The interactive map could consume too much time.

**Response in MVP:**
Defer map richness. Build chat excellence first.

---

## 18. Recommended v1 tech posture

Claude should optimize for:

* simple, modular architecture
* clear separation of concerns
* ability to start with static JSON or simple DB records
* adapter-based venue data ingestion
* location utility layer
* chat orchestration layer
* future business/admin support without building a full dashboard now

---

# Claude Code Build Prompt

Use the following as your handoff prompt.

---

You are helping me build the MVP for a product called **Path Finder**.

## Product

Path Finder is a **location-aware chatbot for outdoor consumer destinations** with many activities, such as sculpture parks, zoos, botanical gardens, and bird sanctuaries.

It is meant primarily for **first-time visitors**. The goal is to make these places feel less overwhelming and help visitors make better moment-to-moment decisions during their day.

**Core promise:**
Path Finder helps people make the most of every moment of their day.

## MVP approach

This MVP is **chat-first**, not map-first.
Do not overbuild the interactive map.
The chatbot is the core product.

The MVP should be a **mobile-first web app / PWA** that:

1. gets the user’s location
2. understands what venue they are in
3. answers location-aware questions
4. recommends what to do next
5. helps with practical questions like nearest bathroom, food, seating, etc.

## Primary use cases

The user must be able to:

* ask what they are near
* ask what they should do next
* ask where the nearest bathroom / ice cream / amenity is

## What makes the product special

This cannot feel like a generic LLM wrapper.
It must feel like it understands:

* where the user is
* what is around them
* what the venue offers
* what nearby option is best next

The differentiator is **location-aware venue intelligence**.

## Data model expectations

Design the system so it works with **static structured venue data** in v1, but can later support other connectors/integrations.

At minimum, create clean support for:

* business
* venue
* place / point of interest
* amenities
* chat session
* messages
* future data adapters

Each place should have fields like:

* id
* name
* type
* description
* lat/lng
* tags
* optional importance score
* optional area name

## Business/admin expectations

Do not build a full dashboard yet.
But do build the framework so business accounts and venue setup are easy to expand later.

## Out of scope

Do not focus on:

* advanced interactive map UI
* analytics dashboards
* proactive notifications
* personalization
* saved accounts
* live integrations
* business optimization tooling
* audio mode

## Demo requirement

The MVP must support a fake venue like **“Activities at My House”** with fake POIs such as:

* playground
* front yard
* backyard
* porch
* kitchen snack area
* nearest bathroom

The app should work while physically walking around and asking:

* What am I near?
* What should I do next?
* Where is the nearest bathroom?

## Success criteria

The MVP is successful when:

1. location services work and are accurate
2. the chatbot goes beyond what a generic LLM would do
3. it is easy to plug in a new venue/business using the same framework

## What I want from you

Please produce:

1. a clean technical architecture for this MVP
2. a recommended tech stack
3. a proposed folder structure
4. a minimal but scalable data model
5. the core user flows
6. the initial implementation plan broken into small coding tasks
7. the MVP screens/components needed
8. the chat/location logic design
9. the venue data ingestion design
10. guidance on how to keep LLM/API costs under control

Optimize for:

* fast MVP delivery
* simplicity
* modularity
* future extensibility
* real-world demoability

When there is a tradeoff, prefer:

* chat quality over flashy UI
* grounded venue logic over broad AI behavior
* easy venue onboarding over complex features

---

