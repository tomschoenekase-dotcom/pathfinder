# Path Finder — Product Vision & Long-Term Roadmap

> Captured from founder context handoff. Last updated: 2026-04-14.
> This document reflects strategic intent and prioritization, not implementation spec.
> For technical architecture, see `architecture.md` and `implementation-plan.md`.

---

## What the product is

Path Finder is an **AI-powered venue guidance platform** for large physical venues — zoos, aquariums, museums, malls, sports venues, botanical gardens, entertainment districts.

When a guest is inside a complex venue with lots to do and lots of ways to get overwhelmed, Path Finder helps them move through the space better and get more out of their visit.

**Core framing:** Path Finder is not just a chatbot. It is a **venue-trained guest guidance system.**

It is not meant to answer generic questions. It is meant to:

- Guide a person through a place
- Reduce confusion and friction
- Surface what matters most to that specific guest
- Help guests make the most of their time
- Generate useful business insight for the venue operator

---

## Why a venue would pay for this (the key product question)

**The single most important strategic question:** Why would a company pay for this when ChatGPT already exists?

The product has to win on:

- Venue-specific detail (trained on operator-provided data)
- Personalization and situational recommendations
- Curated, trusted, operator-controlled information
- Business analytics (what guests ask, where confusion is, what gets engagement)
- Operator influence over what is highlighted
- Reduced guest friction in a physical space
- Multilingual support — many venues have English-only signage; this is a meaningful differentiator

---

## Product layers (platform model)

| Layer                          | Who uses it      | Priority                 |
| ------------------------------ | ---------------- | ------------------------ |
| Guest-facing chatbot / web app | End visitors     | Near-term — core product |
| Company admin dashboard        | Venue staff      | Mid-term                 |
| Analytics dashboard            | Venue operators  | Mid-term                 |
| Platform super-admin           | Founder (Thomas) | Ongoing                  |

---

## Current priorities (near-term)

### 1. Credibility

The most important business issue right now. Build credibility through:

- Measurable stats and usage data
- Real-world pilots / case studies
- Polished demo experience
- Professional company-facing website

### 2. Company-facing website

A site that acts as the product homepage and outreach tool. Must communicate:

- What Path Finder is
- How it works
- Why it matters to a venue
- Why it is better than generic AI
- A short product demo video

### 3. Polished chatbot experience

Focus on one venue/use-case feeling highly polished rather than many half-finished ones.

### 4. Clear onboarding system

Open questions to resolve:

- How do companies get accounts?
- How do they create/manage their venue and places?
- Remote intake vs. in-person mapping?
- Structured intake form?
- Permissions for accessing internal venue data?
  Goal: onboarding becomes a repeatable system, not improvised each time.

---

## Mid-term priorities

- Company-specific admin dashboards
- Analytics dashboards (what guests ask, friction points, recommendation engagement)
- Platform-wide AI controls (improve all venue AIs at once)
- Structured, scalable onboarding
- Scalable place-creation workflow (venues with 100+ sub-experiences)
- Pricing model definition
- Multilingual support

---

## Longer-term / later-stage ideas

- Integration into existing customer apps and websites (embed/SDK)
- Kiosk hardware running the chatbot (on-site demos, malls, booths)
- Audio mode — always-on travel companion experience
- Heavier automation for venue data intake and place creation
- Deeper personalization as usage data accumulates

---

## Business model

- Onboarding fee + monthly recurring charge
- Pricing based on venue type and venue size
- Potential tiers based on complexity, traffic, and feature access

---

## Sales outreach targets (long-term pipeline)

- St. Louis Aquarium
- Union Station (STL)
- Navy Pier Chicago
- Malls
- Museums
- Concert venues
- Sports venues (e.g. STL City SC)
- World Bird Sanctuary
- Forest Park (STL)
- Gateway Arch National Park

---

## MVP vs. later: the guiding principle

> Rather than a bloated feature list, the goal is:
> a focused MVP + a strong website + a clear architecture + a believable demo + a realistic platform plan.

### Build now

- Polished chatbot experience (one venue done really well)
- Company-facing website
- Strong product demo
- Clear value proposition

### Build next

- Admin dashboards
- Analytics
- Onboarding system
- Pricing model

### Build later

- Embedding / SDK
- Kiosks
- Audio mode
- Heavy automation
