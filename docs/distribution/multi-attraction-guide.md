# One guide for a multi-attraction pass

A city pass, a destination bundle or a resort sells access to many attractions. Torchiko can give that
partner one AI guide that knows every attraction, lives inside the partner's own app, and sends
visitors back to the partner's native screens. This page is the operator setup and the partner
story. The app mechanics are in [Add Torchiko to your app](add-to-your-app.md).

## How it fits today's model

Set the pass up as **one Torchiko venue per city or bundle** (for example "Pass — Chicago"). Each
attraction is a **place** in that venue:

- name, type (use `ATTRACTION`), short and long description, area, hours and coordinates;
- visibility `PUBLIC` and active, so the guide may recommend it and partners may reference it;
- knowledge entries for what the pass includes there, reservation rules, best times, accessibility
  and family tips.

The guide answers across the whole bundle ("we have one afternoon and two kids"), recommends places
as cards, and can plan the order of a day. Nothing about this needs new data structures: it is a
normal venue whose places happen to be whole attractions. Use the location-aware guide mode when the
places have coordinates, so cards can show distance and directions.

A visitor who opens the guide from one attraction's screen (`place=ID`) gets that attraction as the
context of the first answer. The rest of the conversation still covers the whole pass.

## The loop inside the partner's app

1. **Ask tab.** The partner loads `/app/<slug>?header=none&placeAction=1` in one WebView that stays
   mounted.
2. **From an attraction screen into the guide.** An "Ask the guide" button either loads the URL with
   `place=` and an unsent `ask=`, or injects the same as a `prefill` into the already-open guide so
   the conversation continues.
3. **From the guide back into the app.** Every recommended place shows the partner's button (default
   "Open in app"). A tap posts `place-action` with the public place ID and name. The app opens its own
   screen for that attraction: its ticket, its map pin, its booking page.

Both directions use the same place IDs. Operators copy them from platform admin **Visitor access →
Place IDs for app and website hosts** as a CSV and send them to the partner's developers once.

## Show it without a phone build

Run the web app in development and open `/dev-fixtures/app-host`. It is a phone-sized partner app
around the real guide fixture: a pass screen with three invented attractions, an Ask tab that keeps
the guide mounted, the guide's **See in app** buttons opening a native-style attraction screen, and
**Ask the guide about this** injecting an unsent question into the same conversation. It uses the
exact messages a real app receives, so it doubles as a reference for partner developers. It is
development-only and never served by a production build.

## What the partner can measure

- Sessions that entered through the app door (entry surface **App**), the website, QR and direct.
- Place card views and detail opens per attraction.
- Taps that handed a visitor back to the app: `visitor.action.clicked` events with analytics key
  `host.open-in-app` and the place ID. A tap is counted only after the app's message channel accepted
  it.

## Operator checklist

1. Create the venue and import its attractions as public places; review names, hours and coordinates.
2. Add knowledge entries per attraction and run a few test conversations on the public chat URL.
3. Set the guide's name, character and appearance for the partner's brand in Look & feel.
4. Confirm the `app-webview` entitlement, enable app access for the venue with a reason, and check the
   effective readback (see the [operator runbook](operator-runbook.md)).
5. Send the partner the app URL with `&placeAction=1` (or their label), the app background color, the
   place ID CSV and [Add Torchiko to your app](add-to-your-app.md).
6. Ask for an emulator or device check of: close, place-action into a native screen, an injected
   "ask about this" prefill, and returning to the same conversation.

## Limits to state plainly

- One venue holds the whole bundle, so all attractions share one knowledge base, one guide persona and
  one usage allowance. A multi-city pass uses one venue per city.
- Attraction operators do not get their own logins or per-attraction permissions in this setup; the
  pass partner or Torchiko maintains the content.
- The place ID list is copied by an operator. A self-serve partner API for places is separate work
  and stays off until it is approved.
- Website embeds support `place` and `ask`, but do not emit `place-action` yet.
