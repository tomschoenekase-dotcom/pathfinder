# PathFinder Marketing Site — Full Context Brief

> This file is for the Claude Code session building the standalone marketing website.
> It contains everything you need to know about the product, the audience, the brand, and what this site must accomplish.
> Do NOT modify the existing PathFinder platform codebase. This is a completely separate project.

---

## What PathFinder Is

PathFinder is an **AI-powered visitor guidance platform** for real-world places — museums, parks, historic sites, nature centers, aquariums, zoos, community organizations, and similar venues.

The core product: a venue deploys PathFinder, and visitors scan a **QR code** on their phone. They are taken to a chat interface where they can ask any question about the venue — what to see first, how to navigate, what something means, what's happening today, where the bathrooms are, what's accessible, what the history is.

The AI is trained specifically on that venue's own content. It does not give generic answers. It knows the specific place.

**This is not a generic chatbot. It is a venue-trained guest guidance system.**

---

## The Core Problem PathFinder Solves

Large physical venues are overwhelming. Visitors:

- Don't know where to start
- Miss the most interesting things
- Can't find staff to ask questions
- Leave without feeling like they got the most out of their visit

Venues have:

- Outdated paper maps
- Kiosks nobody uses
- Staff stretched thin
- No data on what guests actually want

PathFinder addresses all of these at once with a simple QR code — no app download, no account, no friction.

---

## Why Venues Would Choose This Over Free Tools (Critical Differentiator)

The product has to win on these points against "just use ChatGPT":

- **Venue-specific knowledge** — trained on the venue's actual content, not the internet
- **Operator control** — venues decide what is highlighted, what is suppressed, how the AI represents them
- **Business analytics** — operators see what guests ask, what creates confusion, what gets engagement
- **Curated, trusted answers** — no hallucinations about their specific place
- **Multilingual support** — many venues have English-only signage; PathFinder can respond in the visitor's language
- **No app download** — works in a browser via QR code on any phone
- **Reduced staff burden** — fewer basic questions to frontline staff

---

## The Free Local Pilot Program (Primary CTA)

PathFinder is currently offering **free pilot programs** to local venues and organizations. This is the primary call-to-action for the marketing site.

The pilot offer:

- No cost to the venue
- PathFinder handles the setup and training
- The venue gets a working AI assistant for their visitors
- PathFinder gets a real-world case study and feedback

This is the main conversion goal of the site. Every section should funnel toward "Contact About a Free Pilot."

---

## Target Customers (Who the Site Is For)

The audience reading this site is **venue operators and administrators**, not visitors. Specifically:

- Museum directors and education coordinators
- Park rangers and park district administrators
- Historic site managers and preservation societies
- Nature center and wildlife sanctuary staff
- Community organization leaders (food pantries, social services, government service locations)
- Any venue where visitors have questions, need navigation help, or struggle to get the most out of their visit

**Buyer persona:** A museum director or parks department manager. They are not technical. They care about visitor experience, staff burden, operational costs, and their institution's reputation. They are cautious about new technology. A free pilot lowers their risk to zero.

**Tone needed:** Professional, warm, trustworthy. Institutional-credibility feel. NOT startup-hype, NOT overly technical, NOT AI-buzzword-heavy. Think: a vendor presenting at a museum directors' conference, not a tech demo.

---

## Brand Identity

PathFinder has an established visual identity. Match it as closely as possible for credibility:

**Brand palette:**

- `#0F2A4A` — deep navy (primary dark, used for headers, sidebars)
- `#1F4E8C` — brand blue (primary buttons, main brand color)
- `#3A7BD5` — accent blue (interactive highlights, CTAs)
- `#C9D4E3` — light steel (borders, subtle backgrounds)
- `#F2F5F9` — off-white / cool surface (page backgrounds)
- `#FFFFFF` — white (cards, clean sections)

**Typography:** Plus Jakarta Sans (available free from Google Fonts). Use this font if possible.

**Visual feel:** Clean, professional, outdoorsy/institutional. REI or national parks aesthetic — not a dark tech SaaS aesthetic. Light backgrounds, navy and blue accents, trustworthy.

**Logo:** The site should reference PathFinder as the brand. If you need a placeholder logo, use text in Plus Jakarta Sans bold: "PathFinder" with the primary blue color.

---

## Required Site Sections

Build these sections in order:

### 1. Hero Section

- Headline conveying what PathFinder is in plain language
- Subheadline explaining the QR code concept simply
- Two CTAs: primary = "Contact About a Free Pilot" (prominent), secondary = "See How It Works" (scroll anchor)
- Visual placeholder for a phone mockup or venue photo

### 2. How It Works

Three-step process:

1. **Venue sets up PathFinder** — uploads their content, configures their AI assistant
2. **QR codes are placed at the venue** — entrances, exhibits, kiosks, printed materials
3. **Visitors scan and ask** — instant answers about what to see, where to go, what things mean

### 3. Use Cases

Show the range of venues this works for. Include:

- Natural parks and trail systems
- Museums and science centers
- Historic homes and heritage sites
- Nature centers and wildlife sanctuaries
- Community service organizations (food pantries, government services)
- Zoos and aquariums
- Botanical gardens

For each, briefly describe what visitors ask and how PathFinder helps.

### 4. Free Local Pilot Program

Dedicated section explaining the offer:

- Free to the venue — no cost, no contract
- PathFinder handles setup and AI training
- Venue gets a working visitor assistant
- Both sides benefit: venue gets a tool, PathFinder gets a real-world case study

Make this feel like a genuine partnership offer, not a sales gimmick.

### 5. Why Venues Like It

Benefit-focused section. Key points:

- Reduces repetitive questions to staff
- Visitors leave more satisfied
- No app download required — works on any phone
- Works in any language automatically
- Venue controls what the AI says
- Insights into what visitors care about
- Simple setup — PathFinder does the heavy lifting

### 6. Demo / Screenshot Section (Placeholder)

- A section that says something like "See PathFinder in action"
- Include a placeholder for a phone screenshot or demo embed
- CTA: "Request a live demo" linking to the contact section
- Note: Real screenshots will be added later. Use a clean placeholder card or wireframe-style visual.

### 7. Contact Section

- Clean contact form or mailto link (no backend needed — mailto is fine)
- Contact email: tomschoenekase@gmail.com
- Primary message: "Interested in a free pilot for your venue? Get in touch."
- Fields: Name, Organization, Role/Title, Message
- CTA button: "Send Message" (can just be a mailto: link)

---

## Technical Constraints

**This is a static site. No backend. No database. No login. No CMS.**

- Deploy target: Cloudflare Pages or GitHub Pages (both support static sites)
- Framework: Astro + Tailwind is preferred
- No server-side rendering required — pure static HTML/CSS/JS
- Contact form: use a mailto: link or a free form service like Formspree — do not build a backend
- No cookies, no tracking scripts (keep it clean)
- Mobile-first: the product is QR-code activated so a significant portion of visitors will be on phones
- Performance matters: keep it fast and lightweight

---

## What Not to Build

- No login or account creation
- No backend or API calls
- No database or CMS
- No analytics dashboards
- No pricing calculator
- No chatbot on the marketing site itself (ironic but out of scope)
- No complex animations or heavy JavaScript
- No blog or content management
- Do not modify or reference the existing PathFinder platform codebase

---

## Tone and Copy Guidelines

- Write for a non-technical audience (museum directors, parks managers)
- Lead with visitor experience and outcomes, not technology
- Avoid AI buzzwords: no "cutting-edge," "revolutionary," "state-of-the-art," "leveraging AI"
- Do say: "trained on your venue's content," "answers specific to your place," "works on any phone"
- The word "PathFinder" is always one word, capital P and F
- Emphasize the pilot program as risk-free for the venue
- Keep copy concise — institutional buyers are busy

---

## Known Sales Targets (for inspiration, not to name-drop)

The founder has specific targets in mind for outreach:

- St. Louis Aquarium
- Union Station (St. Louis)
- Navy Pier (Chicago)
- St. Louis City SC (soccer venue)
- World Bird Sanctuary
- Forest Park (St. Louis)
- Gateway Arch National Park
- Local museums, historic houses, community organizations

Write copy and use cases that speak to organizations at this scale — real institutions, not hypothetical startups.

---

## Summary of Site Goals

1. Explain clearly what PathFinder is to someone who has never heard of it
2. Make the free pilot offer feel credible and low-risk
3. Get venue operators to submit a contact form or email
4. Look polished enough to send as a cold outreach link to a museum director

That's it. Don't overbuild. One great section is better than ten mediocre ones.
