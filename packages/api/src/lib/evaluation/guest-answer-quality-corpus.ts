/**
 * Deterministic, fully fictional corpus that reproduces a real guest-chat failure: a large
 * theme-park venue where only a handful of knowledge entries reached the model, chosen
 * semantically (with many rows lacking embeddings), so broad questions were answered badly.
 *
 * All names are invented. Do not add real client, prospect, ride or restaurant names: this
 * repository is public.
 */
import type { SemanticKnowledgeEntry, SemanticPlace } from '@pathfinder/db'

import type { GuestKnowledgeRow } from '../guest-knowledge-retrieval'

export type CorpusKnowledgeEntry = GuestKnowledgeRow & {
  hasEmbedding: boolean
  contentModuleId: null
  contentRevisionId: null
  contentPublicationId: null
  contentRevision: null
  contentPublication: null
}

export type StoredKnowledgeRecord = {
  tenantId: string
  venueId: string
  isEnabled: boolean
  visibility: 'PUBLIC' | 'SECOND_LAYER'
  row: CorpusKnowledgeEntry
}

export const THEME_PARK_SCOPE = {
  tenantId: 'tenant-emberwild',
  venueId: 'venue-emberwild',
} as const
export const WILDLIFE_PARK_SCOPE = {
  tenantId: 'tenant-sunmeadow',
  venueId: 'venue-sunmeadow',
} as const

const BASE_UPDATED = Date.UTC(2026, 2, 1)
const DAY = 86_400_000

type Seed = {
  id: string
  title: string
  category: string
  content: string
  url?: string
}

function build(
  seeds: Seed[],
  host: string,
  sourceName: string,
  noEmbed: ReadonlySet<string>,
): CorpusKnowledgeEntry[] {
  return seeds.map((seed, index) => {
    const updatedAt = new Date(BASE_UPDATED + index * DAY)
    return {
      id: seed.id,
      title: seed.title,
      category: seed.category,
      content: seed.content,
      sourceType: 'MANUAL',
      sourceName,
      sourceUrl: seed.url ?? `https://${host}/info/${seed.id.replace(/^kb-/, '')}`,
      updatedAt,
      // Every fifth row was never reviewed, as in real venues.
      lastReviewedAt: index % 5 === 0 ? null : new Date(updatedAt.getTime() + 3 * DAY),
      contentModuleId: null,
      contentRevisionId: null,
      contentPublicationId: null,
      contentRevision: null,
      contentPublication: null,
      hasEmbedding: !noEmbed.has(seed.id),
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Theme park: Emberwild Park (fictional)
// ---------------------------------------------------------------------------------------------

export const THEME_PARK_KEY_IDS = {
  overview: 'kb-park-overview',
  launchCoaster: 'kb-vulkara-launch',
  airCoaster: 'kb-gustwing-flight',
  fireCoaster: 'kb-cindermaw-run',
  juniorCoaster: 'kb-little-kindle',
  futureCoaster: 'kb-aetherstorm-announcement',
  darkRide: 'kb-whisperlight-odyssey',
  diningOverview: 'kb-dining-overview',
  grill: 'kb-cinderhearth-grill',
  market: 'kb-harvest-hall-market',
  quickBite: 'kb-tidebite-fry-window',
  dessert: 'kb-mistfrost-creamery',
  dessertAllergy: 'kb-mistfrost-allergy',
  grillAllergy: 'kb-cinderhearth-allergy-note',
} as const

/** The four operating roller coasters. The future announcement and the dark ride never count. */
export const THEME_PARK_OPERATING_COASTER_IDS = [
  THEME_PARK_KEY_IDS.launchCoaster,
  THEME_PARK_KEY_IDS.airCoaster,
  THEME_PARK_KEY_IDS.fireCoaster,
  THEME_PARK_KEY_IDS.juniorCoaster,
] as const

const THEME_PARK_SEEDS: Seed[] = [
  {
    id: 'kb-park-overview',
    title: 'Welcome to Emberwild Park',
    category: 'Overview',
    content:
      'Emberwild Park is a story-driven theme park built around the legend of the Five Embers. Guests travel through five themed realms: Fire, Air, Water, Earth and Spirit. Each realm has its own thrill rides, family rides, hands-on activities, food and shops. The park suits thrill seekers, families with young children and guests who prefer relaxed walk-through experiences. Plan a full day: most guests start in the Fire Realm near the entrance and loop clockwise.',
  },
  {
    id: 'kb-vulkara-launch',
    title: 'Vulkara: Hydraulic Launch Ride',
    category: 'Rides',
    url: 'https://emberwild.example/rides/rollercoasters/vulkara',
    content:
      'Vulkara in the Earth Realm is a hydraulic-launch roller coaster. Trains accelerate from standstill to 70 mph in under three seconds, then climb a 160 foot top hat and cross two inversions. Minimum height 52 in (132 cm). Riders must be able to keep their arms and legs inside the train. Single-rider line available. Loose items must go in free ride-front lockers.',
  },
  {
    id: 'kb-gustwing-flight',
    title: 'Gustwing: Suspended Flight Ride',
    category: 'Rides',
    url: 'https://emberwild.example/rides/rollercoasters/gustwing',
    content:
      'Gustwing in the Air Realm is a suspended, air-powered coaster: riders hang beneath the track with their feet free, swinging out through sweeping turns over the lagoon. Minimum height 48 in (122 cm). Not recommended for guests with back or neck problems. Gustwing may pause in high winds.',
  },
  {
    id: 'kb-cindermaw-run',
    title: 'Cindermaw: Dragon Fire Run',
    category: 'Rides',
    url: 'https://emberwild.example/rides/rollercoasters/cindermaw',
    content:
      "Cindermaw is the Fire Realm signature coaster. Riders enter the dragon's lair, climb a lift hill lined with real flame effects and plunge through a 90 degree drop. Minimum height 48 in (122 cm). The ride vehicle has a lap bar and a seat divider. Guests who use a wheelchair must transfer to a ride seat with help; ask a team member at the accessible entrance about transfer assistance and the current policy.",
  },
  {
    id: 'kb-little-kindle',
    title: 'Little Kindle: Young Ember Ride',
    category: 'Rides',
    url: 'https://emberwild.example/rides/family/little-kindle',
    content:
      "Little Kindle in the Fire Realm is the park's junior roller coaster with gentle hills and tiny dragon-egg cars. Height 36 to 54 in (91 to 137 cm); children under 48 in ride with a supervising rider. Ideal for ages 4 to 8 and a first coaster for many guests.",
  },
  {
    id: 'kb-aetherstorm-announcement',
    title: 'Coming in a Future Season: Aetherstorm',
    category: 'Announcements',
    url: 'https://emberwild.example/news/aetherstorm',
    content:
      'Emberwild Park has announced Aetherstorm, a record-setting roller coaster planned for the Air Realm in a future season. Construction has not finished and it is not open to guests. No opening date has been confirmed.',
  },
  {
    id: 'kb-whisperlight-odyssey',
    title: 'Whisperlight Odyssey',
    category: 'Rides',
    url: 'https://emberwild.example/rides/rollercoasters/whisperlight-odyssey',
    content:
      'Whisperlight Odyssey in the Spirit Realm is a 4D dark ride adventure, not a roller coaster. Guests wear 3D glasses and ride through a story with wind, mist and scent effects. There are no drops or inversions. Minimum height 40 in (102 cm). Motion is gentle; seats can be set to still mode on request.',
  },
  {
    id: 'kb-dining-overview',
    title: 'Dining at Emberwild Park',
    category: 'Dining',
    content:
      'There are six places to eat at Emberwild Park: Cinderhearth Grill (full-service sit-down), Harvest Hall Market (food hall with several counters), Tidebite Fry Window (savory quick bites), Mistfrost Creamery (desserts and frozen treats), Windsong Cafe (coffee, smoothies and light snacks) and Lantern Popcorn Kiosk (popcorn and drinks). Mobile ordering is available at Harvest Hall Market and Windsong Cafe.',
  },
  {
    id: 'kb-cinderhearth-grill',
    title: 'Cinderhearth Grill',
    category: 'Dining',
    content:
      'Cinderhearth Grill is a full-service restaurant in the Fire Realm with indoor and patio seating. Menu examples: wood-fired burgers, smoked brisket sandwiches, grilled salmon, harvest salad, kids pasta and a seasonal cobbler. Reservations are recommended at lunch on weekends. Kitchen staff can review ingredients with you on request.',
  },
  {
    id: 'kb-cinderhearth-allergy-note',
    title: 'Cinderhearth Grill dietary questions',
    category: 'Dining',
    content:
      'Cinderhearth Grill kitchens handle wheat, milk, egg, soy, fish and tree nuts. Menus change by season. Ask your server or the culinary lead for the current allergen sheet; the kitchen cannot guarantee any dish is free of cross-contact.',
  },
  {
    id: 'kb-harvest-hall-market',
    title: 'Harvest Hall Market',
    category: 'Dining',
    content:
      'Harvest Hall Market is the Earth Realm food hall with a rotating set of counters: rotisserie chicken bowls, flatbread pizzas, a salad bar, noodle bowls and a plant-based grill. Plenty of indoor shaded seating and a highchair area. Good for groups who cannot agree on one meal.',
  },
  {
    id: 'kb-tidebite-fry-window',
    title: 'Tidebite Fry Window',
    category: 'Dining',
    content:
      'Tidebite Fry Window in the Water Realm is a savory quick bite stand beside the splash pad. Menu examples: crispy fish tacos, loaded fries, chicken tenders and corn dogs. Short lines and walk-up service make it a fast lunch stop.',
  },
  {
    id: 'kb-mistfrost-creamery',
    title: 'Mistfrost Creamery',
    category: 'Dining',
    content:
      'Mistfrost Creamery in the Water Realm is the dessert stand. Menu examples: soft-serve swirls, frozen lemonade, brownie sundaes, churro bites and a dragonfruit shave ice. A sweet treat close to the splash pad.',
  },
  {
    id: 'kb-mistfrost-allergy',
    title: 'Mistfrost Creamery allergy information',
    category: 'Dining',
    content:
      'Mistfrost Creamery uses shared scoops and machines. Items contain or may contain milk, egg, wheat, soy, peanuts and tree nuts. A dairy-free fruit ice is available but is served from shared equipment, so it is not safe for severe allergies.',
  },
  {
    id: 'kb-windsong-cafe',
    title: 'Windsong Cafe',
    category: 'Dining',
    content:
      'Windsong Cafe in the Air Realm serves coffee, iced tea, fruit smoothies, breakfast sandwiches and pastries. Mobile ordering is available.',
  },
  {
    id: 'kb-lantern-popcorn',
    title: 'Lantern Popcorn Kiosk',
    category: 'Dining',
    content:
      'Lantern Popcorn Kiosk in the Spirit Realm sells freshly popped popcorn in three flavors, bottled water and fountain drinks. Refillable popcorn buckets are available.',
  },
  {
    id: 'kb-shade-toddler-breaks',
    title: 'Shade and toddler break tips',
    category: 'Visitor Tips',
    content:
      'The coolest places for a toddler break are the Spirit Realm lantern grove, the covered benches by the carousel, and the nursing room beside first aid. Strollers can park outside the Water Realm play area. Bring hats; shade is limited on the main promenade.',
  },
  {
    id: 'kb-weather-refund',
    title: 'Weather and refund policy',
    category: 'Policies',
    content:
      'Rides may close temporarily for lightning, high winds or heavy rain and reopen when conditions clear. Emberwild Park does not issue refunds for weather closures of individual rides. If the whole park closes for weather before 2 pm, guests may exchange their ticket for another day within 30 days.',
  },
  {
    id: 'kb-event-spring-bloom-2024',
    title: 'Spring Bloom Festival 2024',
    category: 'Events',
    content:
      'Spring Bloom Festival ran April 6 to May 12, 2024, with floral displays, a garden food trail and nightly lantern parades. This event has ended.',
  },
  {
    id: 'kb-event-harvest-nights-2025',
    title: 'Harvest Nights 2025',
    category: 'Events',
    content:
      'Harvest Nights took place on weekends from September 20 to October 26, 2025, featuring pumpkin carving, cider tastings and a scarecrow trail. The event has ended.',
  },
  {
    id: 'kb-event-winter-glow-2025',
    title: 'Winter Glow 2025',
    category: 'Events',
    content:
      'Winter Glow ran November 28, 2025 to January 4, 2026, with ice sculptures, hot cocoa stands and a nightly light show. This past event is no longer running.',
  },
  {
    id: 'kb-guest-services',
    title: 'Guest Services',
    category: 'Services',
    content:
      'Guest Services is just inside the main entrance on the left. Staff can help with lost items, ticket questions, accessibility passes, stroller and wheelchair rentals, and general directions. Open from park opening until one hour after closing.',
  },
  {
    id: 'kb-map-aliases',
    title: 'Map names and nicknames',
    category: 'Navigation',
    content:
      'Locals call the Fire Realm "the Forge", the Air Realm "the Skyway", the Water Realm "the Shallows", the Earth Realm "the Grove" and the Spirit Realm "the Lanterns". The main promenade is called the Ember Walk. Signs use the official realm names.',
  },
  {
    id: 'kb-realm-fire',
    title: 'Fire Realm',
    category: 'Realms',
    content:
      'The Fire Realm is the first land after the entrance: dragon lairs, forge shows, glowing braziers and big thrills. Highlights include Cindermaw, Little Kindle, the Forge Demonstration Stage and Cinderhearth Grill.',
  },
  {
    id: 'kb-realm-air',
    title: 'Air Realm',
    category: 'Realms',
    content:
      'The Air Realm sits on the hill above the lagoon with kite-themed architecture and sweeping views. Highlights include Gustwing, the Windcatcher Swings, the Wind Whisper Tunnel and Windsong Cafe.',
  },
  {
    id: 'kb-realm-water',
    title: 'Water Realm',
    category: 'Realms',
    content:
      'The Water Realm is the cool, wet corner of the park with a splash pad, a water-jet maze and river rapids. Bring a change of clothes. Food nearby: Tidebite Fry Window and Mistfrost Creamery.',
  },
  {
    id: 'kb-realm-earth',
    title: 'Earth Realm',
    category: 'Realms',
    content:
      'The Earth Realm is a stone-and-forest land with Vulkara, the Archaeology Dig play stop, the volcano story show and Harvest Hall Market. Many shaded paths.',
  },
  {
    id: 'kb-realm-spirit',
    title: 'Spirit Realm',
    category: 'Realms',
    content:
      'The Spirit Realm is the glowing, calm finale of the park: lantern groves, Whisperlight Odyssey, the carousel and Lantern Popcorn Kiosk. Great at dusk.',
  },
  {
    id: 'kb-height-requirements',
    title: 'Height requirements by ride',
    category: 'Rides',
    content:
      'Vulkara 52 in. Cindermaw 48 in. Gustwing 48 in. Little Kindle 36 to 54 in. Whisperlight Odyssey 40 in. River Rapids 42 in. Windcatcher Swings 44 in. Measuring stations sit at each ride entrance; shoes are included in the measurement.',
  },
  {
    id: 'kb-accessibility-pass',
    title: 'Accessibility Access Pass',
    category: 'Accessibility',
    content:
      'The Accessibility Access Pass lets guests who cannot wait in a standard queue receive a return time instead. Register at Guest Services with the guest present. Passes cover up to six people. It does not guarantee a ride is operating.',
  },
  {
    id: 'kb-lockers',
    title: 'Lockers',
    category: 'Services',
    content:
      'Large lockers near the entrance cost $12 for the day. Free short-stay lockers are provided at the front of each thrill ride while you ride. Phones and wallets are not safe on the rides without a zipped pocket.',
  },
  {
    id: 'kb-parking',
    title: 'Parking',
    category: 'Visiting',
    content:
      'General parking is $28 per vehicle. Preferred parking close to the gate is $38. Tram service runs from the far lots every ten minutes. Accessible parking is available near the entrance at no extra charge with a valid permit.',
  },
  {
    id: 'kb-tickets',
    title: 'Tickets and admission',
    category: 'Visiting',
    content:
      'One-day tickets are available online and at the gate. Children under 3 are free. Season passes include free parking on weekdays. Online prices are lower than gate prices.',
  },
  {
    id: 'kb-first-aid',
    title: 'First aid',
    category: 'Services',
    content:
      'First aid is behind Harvest Hall Market in the Earth Realm and at a small station near the Air Realm lagoon. Nurses are on duty during all open hours. In an emergency, tell any team member.',
  },
  {
    id: 'kb-lost-child',
    title: 'Lost child policy',
    category: 'Safety',
    content:
      'If a child is lost, tell the nearest team member right away. Staff will start a search and notify security. Lost children are brought to Guest Services. Younger guests can be given a free wristband with a parent phone number at the entrance.',
  },
  {
    id: 'kb-reentry',
    title: 'Same-day re-entry',
    category: 'Policies',
    content:
      'Guests may leave and re-enter the same day with a hand stamp and ticket scan at the exit gate. Re-entry is not allowed after the park announces closing time. Parking receipts are valid for the day.',
  },
  // Filler entries below (no scenario depends on them).
  {
    id: 'kb-gift-ember-emporium',
    title: 'Ember Emporium gift shop',
    category: 'Shopping',
    content:
      'Ember Emporium is the main gift shop at the park entrance with plush dragons, apparel, sunscreen and souvenir cups. Packages can be held for pick-up at the exit.',
  },
  {
    id: 'kb-gift-forge-trinkets',
    title: 'Forge Trinkets',
    category: 'Shopping',
    content:
      'Forge Trinkets in the Fire Realm sells glow-in-the-dark swords, pressed-penny machines and locally made metal charms.',
  },
  {
    id: 'kb-gift-sky-kites',
    title: 'Skyway Kite Stall',
    category: 'Shopping',
    content: 'Skyway Kite Stall sells kites, windsocks and lightweight rain ponchos near Gustwing.',
  },
  {
    id: 'kb-gift-tide-towels',
    title: 'Tide Towel Shop',
    category: 'Shopping',
    content:
      'Tide Towel Shop in the Water Realm sells swimwear, towels, water shoes and dry bags. Rent a towel for the day.',
  },
  {
    id: 'kb-gift-grove-crafts',
    title: 'Grove Craft Cabin',
    category: 'Shopping',
    content:
      'Grove Craft Cabin sells hand-carved wooden animals, painted rocks and herbal teas from the Earth Realm.',
  },
  {
    id: 'kb-gift-lantern-lights',
    title: 'Lantern Lights boutique',
    category: 'Shopping',
    content:
      'Lantern Lights boutique in the Spirit Realm sells candles, light-up wands and decorative paper lanterns.',
  },
  {
    id: 'kb-photo-dragon-gate',
    title: 'Dragon Gate photo spot',
    category: 'Photo Spots',
    content:
      'The Dragon Gate at the park entrance is the most popular family photo spot. Mornings are least crowded. Photographers take free portraits until noon.',
  },
  {
    id: 'kb-photo-lagoon-overlook',
    title: 'Lagoon Overlook photo spot',
    category: 'Photo Spots',
    content:
      'The Lagoon Overlook in the Air Realm has the best skyline view of the park and a golden sunset glow in the late afternoon.',
  },
  {
    id: 'kb-photo-lantern-grove',
    title: 'Lantern Grove photo spot',
    category: 'Photo Spots',
    content:
      'Hundreds of paper lanterns light the Lantern Grove in the Spirit Realm after 6 pm, a favorite for couples and group photos.',
  },
  {
    id: 'kb-photo-ride-photos',
    title: 'Ride photos',
    category: 'Photo Spots',
    content:
      'On-ride photos are taken on Vulkara and Cindermaw. View and buy them at the photo counter by the exit or in the park app.',
  },
  {
    id: 'kb-restrooms-map',
    title: 'Restroom locations',
    category: 'Facilities',
    content:
      'Restrooms are near the entrance, beside Cinderhearth Grill, at the Air Realm lagoon, inside Harvest Hall Market and beside the Spirit Realm carousel. Family restrooms and changing tables are at each location.',
  },
  {
    id: 'kb-nursing-room',
    title: 'Nursing room',
    category: 'Facilities',
    content:
      'A private, quiet nursing room with chairs and a changing table is located next to first aid in the Earth Realm.',
  },
  {
    id: 'kb-play-ember-nest',
    title: 'Ember Nest play area',
    category: 'Play Areas',
    content:
      'Ember Nest is a soft-surface play area for children under 8 with rope bridges, slides and a giant dragon egg to climb. Parents must stay with children.',
  },
  {
    id: 'kb-play-splash-pad',
    title: 'Brookside Splash Pad',
    category: 'Play Areas',
    content:
      'The Brookside Splash Pad in the Water Realm has gentle fountains, spray tunnels and shallow streams for young children. No swim diapers required but recommended for babies.',
  },
  {
    id: 'kb-play-water-jet-maze',
    title: 'Tidemaze water-jet maze',
    category: 'Play Areas',
    content:
      'Tidemaze is an interactive maze in the Water Realm where jets of water rise and fall as you try to cross it. Expect to get wet.',
  },
  {
    id: 'kb-play-dig',
    title: 'Archaeology Dig play stop',
    category: 'Play Areas',
    content:
      'At the Archaeology Dig in the Earth Realm, children brush sand away to uncover fossil replicas and ancient tools. Free and shaded. Brushes are provided.',
  },
  {
    id: 'kb-feature-wind-tunnel',
    title: 'Wind Whisper Tunnel',
    category: 'Interactive',
    content:
      'The Wind Whisper Tunnel in the Air Realm is a hands-on story feature where guests stand over fans to launch silk scarves into the air.',
  },
  {
    id: 'kb-feature-volcano-show',
    title: 'Volcano story show',
    category: 'Shows',
    content:
      'In the Earth Realm, the Volcano story show erupts every hour from 11 am to 5 pm with fire, drums and a storyteller. The seating area is partly shaded.',
  },
  {
    id: 'kb-feature-forge-stage',
    title: 'Forge Demonstration Stage',
    category: 'Shows',
    content:
      'Metalworkers demonstrate glass blowing and blade forging on the Fire Realm stage at 12 pm, 2 pm and 4 pm.',
  },
  {
    id: 'kb-ride-river-rapids',
    title: 'River Rapids',
    category: 'Rides',
    content:
      'River Rapids in the Water Realm is a round-raft whitewater ride. Guests will get wet. Minimum height 42 in (107 cm).',
  },
  {
    id: 'kb-ride-windcatcher-swings',
    title: 'Windcatcher Swings',
    category: 'Rides',
    content:
      'Windcatcher Swings in the Air Realm is a tall swing ride with views of the lagoon. Minimum height 44 in (112 cm).',
  },
  {
    id: 'kb-ride-carousel',
    title: 'Spirit Carousel',
    category: 'Rides',
    content:
      'The Spirit Carousel features hand-painted mythical animals and a bench seat for those who prefer not to climb. All ages welcome.',
  },
  {
    id: 'kb-ride-sky-gondola',
    title: 'Skyway Gondola',
    category: 'Rides',
    content:
      'The Skyway Gondola links the Fire Realm and the Air Realm with a scenic six-minute ride. Strollers must be folded.',
  },
  {
    id: 'kb-ride-pebble-train',
    title: 'Pebble Train',
    category: 'Rides',
    content:
      'Pebble Train is a slow miniature train around the Earth Realm gardens. A relaxing break for little ones. No height limit.',
  },
  {
    id: 'kb-ride-bumper-boats',
    title: 'Lagoon Bumper Boats',
    category: 'Rides',
    content:
      'Lagoon Bumper Boats are small motorized boats in the Water Realm. Minimum height 40 in (102 cm) to drive; smaller riders ride along with an adult.',
  },
  {
    id: 'kb-ride-sprite-spinners',
    title: 'Spirit Sprite Spinners',
    category: 'Rides',
    content:
      'Spirit Sprite Spinners are small spinning cars for young children in the Spirit Realm. Height 34 to 48 in.',
  },
  {
    id: 'kb-ride-hawk-drop',
    title: 'Hawk Drop Tower',
    category: 'Rides',
    content:
      'Hawk Drop Tower lifts riders 150 feet in the Air Realm and then drops in a controlled free-fall. Minimum height 50 in (127 cm).',
  },
  {
    id: 'kb-faq-wifi',
    title: 'Wi-Fi and phone charging',
    category: 'Facilities',
    content:
      'Free guest Wi-Fi covers the main promenade and dining areas. Charging stations are at Windsong Cafe and Guest Services.',
  },
  {
    id: 'kb-faq-strollers',
    title: 'Stroller and wheelchair rentals',
    category: 'Services',
    content:
      'Single and double strollers, wheelchairs and electric scooters can be rented at Guest Services. Personal strollers are always allowed.',
  },
  {
    id: 'kb-faq-outside-food',
    title: 'Outside food and drink',
    category: 'Policies',
    content:
      'Small snacks, baby food and sealed water bottles are allowed. Glass containers, alcohol and coolers larger than a lunch bag are not. Picnic tables are near the Earth Realm gardens.',
  },
  {
    id: 'kb-faq-pets',
    title: 'Pets and service animals',
    category: 'Policies',
    content:
      'Pets are not allowed in the park; a kennel is available near the parking lot for a fee. Trained service dogs are welcome.',
  },
  {
    id: 'kb-faq-smoking',
    title: 'Smoking areas',
    category: 'Policies',
    content:
      'Smoking and vaping are allowed only in designated areas outside the Earth Realm gate and by the back parking tram stop.',
  },
  {
    id: 'kb-faq-atm',
    title: 'ATMs and payment',
    category: 'Facilities',
    content:
      'The park is fully cashless. Cards, phone wallets and wristband payments are accepted. ATMs are at the entrance and near Guest Services.',
  },
  {
    id: 'kb-faq-hours',
    title: 'Operating hours',
    category: 'Visiting',
    content:
      'Emberwild Park is generally open 10 am to 8 pm in summer and 10 am to 6 pm in spring and fall. Check the park calendar; some rides open later than the gate.',
  },
  {
    id: 'kb-faq-lines',
    title: 'Beating the lines',
    category: 'Visitor Tips',
    content:
      'Ride the big rides first thing in the morning or during parades and the volcano show. Use the single-rider lines. Wait times are shown in the park app.',
  },
  {
    id: 'kb-faq-app',
    title: 'Park app',
    category: 'Visiting',
    content:
      'The Emberwild app shows live wait times, ride closures, show times and restaurant menus. Wait times are updated every few minutes and are estimates.',
  },
  {
    id: 'kb-faq-groups',
    title: 'Group and school visits',
    category: 'Visiting',
    content:
      'Groups of 15 or more receive discounted admission and a reserved lunch area. Book at least two weeks ahead.',
  },
  {
    id: 'kb-faq-birthdays',
    title: 'Birthday celebrations',
    category: 'Visiting',
    content:
      'Ask Guest Services for a free birthday button. Party packages with a reserved table at Harvest Hall Market can be booked online.',
  },
  {
    id: 'kb-faq-lost-found',
    title: 'Lost and found',
    category: 'Services',
    content:
      'Lost items are held at Guest Services for 30 days. Items left on a ride go to the ride lost-property box.',
  },
  {
    id: 'kb-faq-sunscreen',
    title: 'Sun protection',
    category: 'Visitor Tips',
    content:
      'Free sunscreen stations are at the entrance and the Water Realm. Refill water bottles at fountains throughout the park.',
  },
  {
    id: 'kb-faq-rain',
    title: 'Rainy day tips',
    category: 'Visitor Tips',
    content:
      'On rainy days, head to indoor options such as Whisperlight Odyssey, Harvest Hall Market and Ember Emporium. Ponchos are sold at the Skyway Kite Stall.',
  },
  {
    id: 'kb-faq-night',
    title: 'Evening lantern parade',
    category: 'Shows',
    content:
      'The lantern parade leaves the Spirit Realm every evening at 7 pm in summer. Prime viewing spots are along the Ember Walk.',
  },
  {
    id: 'kb-faq-character',
    title: 'Character meet and greets',
    category: 'Shows',
    content:
      'Ember the Dragon appears near the Dragon Gate at 11 am and 3 pm. Check the app for the full schedule of storybook characters.',
  },
  {
    id: 'kb-faq-arcade',
    title: 'Ember Arcade',
    category: 'Games',
    content:
      'Ember Arcade in the Fire Realm has about 60 games, prize redemption and air conditioning. Games use a rechargeable play card.',
  },
  {
    id: 'kb-faq-midway',
    title: 'Midway games',
    category: 'Games',
    content:
      'Ring toss, balloon darts and basketball shootouts are in the Air Realm midway. Games cost extra and prizes range from small to jumbo plush.',
  },
  {
    id: 'kb-faq-hotel',
    title: 'Nearby hotels',
    category: 'Visiting',
    content:
      'Several hotels within five miles offer shuttles to the park. Guests staying at partner hotels receive early entry on select days.',
  },
  {
    id: 'kb-faq-security',
    title: 'Security screening',
    category: 'Policies',
    content:
      'All guests pass through bag checks and metal detectors at the gate. Leave sharp objects, weapons and drones at home.',
  },
  {
    id: 'kb-faq-dress',
    title: 'Dress code',
    category: 'Policies',
    content:
      'Closed-toe shoes are required on all rides. Swimwear is allowed in the Water Realm only. Costumes that cover the face are not allowed.',
  },
  {
    id: 'kb-faq-photography-policy',
    title: 'Photography and drones',
    category: 'Policies',
    content:
      'Personal photos are welcome. Tripods, selfie sticks and drones are not permitted. Loose cameras are not allowed on rides.',
  },
  {
    id: 'kb-faq-first-timer',
    title: 'First-time visitor itinerary',
    category: 'Visitor Tips',
    content:
      'Suggested route: start at Cindermaw, take the gondola to the Air Realm, cool off in the Water Realm at lunch, explore the Earth Realm in the afternoon and finish at dusk in the Spirit Realm.',
  },
  {
    id: 'kb-faq-toddler-rides',
    title: 'Rides for small children',
    category: 'Visitor Tips',
    content:
      'Great for ages 3 to 6: Spirit Sprite Spinners, Pebble Train, Spirit Carousel, Ember Nest, Brookside Splash Pad and the Archaeology Dig.',
  },
  {
    id: 'kb-faq-teens',
    title: 'Teen favorites',
    category: 'Visitor Tips',
    content:
      'Teens usually head for the Hawk Drop Tower, the big rides, Ember Arcade and the midway.',
  },
  {
    id: 'kb-faq-seniors',
    title: 'Relaxed options',
    category: 'Visitor Tips',
    content:
      'For a slower pace, try the Skyway Gondola, Pebble Train, the Spirit Carousel, the Volcano story show and Lantern Grove.',
  },
  {
    id: 'kb-faq-sensory',
    title: 'Sensory-friendly tips',
    category: 'Accessibility',
    content:
      'Quiet rooms are available at Guest Services. Noise-reducing headphones can be borrowed. The Volcano story show and Forge stage can be loud.',
  },
  {
    id: 'kb-faq-hearing',
    title: 'Hearing and vision support',
    category: 'Accessibility',
    content:
      'Assistive listening devices and printed script guides are available at Guest Services for shows. Braille maps are available on request.',
  },
  {
    id: 'kb-faq-vegetarian',
    title: 'Vegetarian and vegan options',
    category: 'Dining',
    content:
      'Harvest Hall Market has a plant-based grill. Cinderhearth Grill offers a veggie burger and harvest salad. Tidebite Fry Window offers loaded fries without meat.',
  },
  {
    id: 'kb-faq-water-refill',
    title: 'Drinking water',
    category: 'Facilities',
    content:
      'Free cups of ice water are available at every restaurant on request. Refill stations are at each restroom.',
  },
  {
    id: 'kb-faq-ride-closed',
    title: 'Ride closures and maintenance',
    category: 'Rides',
    content:
      'Rides can be temporarily unavailable for weather, maintenance or technical reasons. Live status is shown on the park app and on the boards at each realm entrance.',
  },
  {
    id: 'kb-faq-ride-safety',
    title: 'Ride safety rules',
    category: 'Safety',
    content:
      'Follow height requirements and posted restrictions. Pregnant guests and guests with heart, back or neck conditions should not ride intense attractions. Team members make the final decision at the ride entrance.',
  },
  {
    id: 'kb-faq-single-rider',
    title: 'Single-rider lines',
    category: 'Visitor Tips',
    content:
      'Single-rider lines are open at Vulkara, Cindermaw and Hawk Drop Tower when queues exceed 30 minutes.',
  },
  {
    id: 'kb-faq-reservations',
    title: 'Restaurant reservations',
    category: 'Dining',
    content:
      'Reservations at Cinderhearth Grill can be made in the app up to 60 days in advance. All other dining locations are walk-up.',
  },
  {
    id: 'kb-faq-kids-meals',
    title: 'Kids meals',
    category: 'Dining',
    content:
      'Kids meals are available at Cinderhearth Grill, Harvest Hall Market and Tidebite Fry Window and include a drink and a fruit side.',
  },
  {
    id: 'kb-faq-coupons',
    title: 'Discounts',
    category: 'Visiting',
    content:
      'Military, senior and local resident discounts are available at the ticket window with ID. Discounts cannot be combined.',
  },
  {
    id: 'kb-faq-emergency',
    title: 'Emergency procedures',
    category: 'Safety',
    content:
      'In an emergency, follow team member instructions. Meeting points are marked at each realm entrance.',
  },
  {
    id: 'kb-faq-water-safety',
    title: 'Water Realm safety',
    category: 'Safety',
    content:
      'Children under 8 must be supervised by an adult in the splash pad and water-jet maze. Footwear is recommended on wet surfaces.',
  },
  {
    id: 'kb-faq-evening-dining',
    title: 'Evening dining hours',
    category: 'Dining',
    content:
      'Cinderhearth Grill and Harvest Hall Market serve until one hour before closing. Windsong Cafe closes at 5 pm. Hours vary by season.',
  },
  {
    id: 'kb-faq-season-pass',
    title: 'Season pass perks',
    category: 'Visiting',
    content:
      'Season pass holders receive free weekday parking, discounts at shops and dining, and early entry to new attractions.',
  },
  {
    id: 'kb-faq-volunteer',
    title: 'Jobs and volunteering',
    category: 'About',
    content:
      'Seasonal jobs are posted on the careers page every winter. Teens 16 and up are welcome to apply.',
  },
  {
    id: 'kb-faq-history',
    title: 'History of Emberwild Park',
    category: 'About',
    content:
      'Emberwild Park opened in 1998 as a small garden attraction and grew into a five-realm adventure park. The Five Embers legend was written by the founding family.',
  },
  {
    id: 'kb-faq-sustainability',
    title: 'Sustainability',
    category: 'About',
    content:
      'The park runs on 60 percent renewable energy, composts food waste and recycles ride cups. Reusable souvenir cups get free refills.',
  },
  {
    id: 'kb-faq-weddings',
    title: 'Weddings and private events',
    category: 'Visiting',
    content:
      'The Lantern Grove and the lagoon overlook can be reserved for weddings and corporate events. Contact the events team.',
  },
  {
    id: 'kb-faq-ember-dragon',
    title: 'Legend of the Five Embers',
    category: 'About',
    content:
      'The story tells of five dragon siblings whose embers were scattered across five realms. Guests can collect story stamps at each realm to complete a passport.',
  },
]

/** Rows the real failure left without embeddings. Everything else starts embedded. */
const THEME_PARK_KEY_NO_EMBED: readonly string[] = [
  'kb-park-overview',
  'kb-little-kindle',
  'kb-dining-overview',
  'kb-cinderhearth-grill',
  'kb-harvest-hall-market',
]

/**
 * About 40 rows lack embeddings: the five key rows above plus every other filler row by position
 * until exactly 40 are reached. Position-based, so it is not tuned to any scenario.
 */
function themeParkNoEmbedIds(): ReadonlySet<string> {
  const ids = new Set(THEME_PARK_KEY_NO_EMBED)
  const fillerStart = THEME_PARK_SEEDS.findIndex((seed) => seed.id === 'kb-gift-ember-emporium')
  for (let i = fillerStart; i < THEME_PARK_SEEDS.length && ids.size < 40; i += 1) {
    if ((i - fillerStart) % 2 === 0) ids.add(THEME_PARK_SEEDS[i]!.id)
  }
  return ids
}

export const THEME_PARK_KNOWLEDGE: CorpusKnowledgeEntry[] = build(
  THEME_PARK_SEEDS,
  'emberwild.example',
  'Emberwild Park guest handbook',
  themeParkNoEmbedIds(),
)

type PlaceSeed = [
  id: string,
  name: string,
  type: string,
  itemType: string,
  area: string,
  short: string,
  tags: string[],
  hours: string,
]

const THEME_PARK_PLACE_SEEDS: PlaceSeed[] = [
  [
    'place-cindermaw',
    'Cindermaw',
    'ride',
    'roller_coaster',
    'Fire Realm',
    'Fire-themed signature coaster.',
    ['thrill', 'coaster', 'fire'],
    '10:00-20:00',
  ],
  [
    'place-little-kindle',
    'Little Kindle',
    'ride',
    'roller_coaster',
    'Fire Realm',
    'Gentle junior coaster.',
    ['family', 'kids', 'coaster'],
    '10:00-20:00',
  ],
  [
    'place-cinderhearth',
    'Cinderhearth Grill',
    'restaurant',
    'full_service',
    'Fire Realm',
    'Full-service grill with patio.',
    ['dining', 'lunch', 'dinner'],
    '11:00-19:00',
  ],
  [
    'place-forge-stage',
    'Forge Demonstration Stage',
    'show',
    'stage',
    'Fire Realm',
    'Glass and blade demonstrations.',
    ['show'],
    '12:00-16:00',
  ],
  [
    'place-gustwing',
    'Gustwing',
    'ride',
    'roller_coaster',
    'Air Realm',
    'Suspended air coaster.',
    ['thrill', 'coaster', 'air'],
    '10:00-20:00',
  ],
  [
    'place-hawk-drop',
    'Hawk Drop Tower',
    'ride',
    'drop_tower',
    'Air Realm',
    'Free-fall tower.',
    ['thrill'],
    '10:00-20:00',
  ],
  [
    'place-windcatcher',
    'Windcatcher Swings',
    'ride',
    'swing',
    'Air Realm',
    'Tall swing ride.',
    ['family'],
    '10:00-20:00',
  ],
  [
    'place-windsong',
    'Windsong Cafe',
    'restaurant',
    'cafe',
    'Air Realm',
    'Coffee and light snacks.',
    ['coffee', 'snack'],
    '10:00-17:00',
  ],
  [
    'place-river-rapids',
    'River Rapids',
    'ride',
    'water_ride',
    'Water Realm',
    'Round-raft rapids.',
    ['family', 'wet'],
    '11:00-19:00',
  ],
  [
    'place-splash-pad',
    'Brookside Splash Pad',
    'activity',
    'splash_pad',
    'Water Realm',
    'Gentle fountains.',
    ['kids', 'wet'],
    '11:00-18:00',
  ],
  [
    'place-tidebite',
    'Tidebite Fry Window',
    'restaurant',
    'quick_service',
    'Water Realm',
    'Savory quick bites.',
    ['dining', 'lunch', 'quick'],
    '11:00-19:00',
  ],
  [
    'place-mistfrost',
    'Mistfrost Creamery',
    'restaurant',
    'dessert',
    'Water Realm',
    'Frozen treats.',
    ['dessert', 'sweet'],
    '11:00-19:00',
  ],
  [
    'place-vulkara',
    'Vulkara',
    'ride',
    'roller_coaster',
    'Earth Realm',
    'Hydraulic launch coaster.',
    ['thrill', 'coaster', 'launch'],
    '10:00-20:00',
  ],
  [
    'place-harvest-hall',
    'Harvest Hall Market',
    'restaurant',
    'food_hall',
    'Earth Realm',
    'Food hall.',
    ['dining', 'lunch', 'groups'],
    '11:00-19:00',
  ],
  [
    'place-dig',
    'Archaeology Dig',
    'activity',
    'play_area',
    'Earth Realm',
    'Fossil dig play stop.',
    ['kids'],
    '10:00-18:00',
  ],
  [
    'place-volcano',
    'Volcano Story Show',
    'show',
    'stage',
    'Earth Realm',
    'Hourly eruption show.',
    ['show'],
    '11:00-17:00',
  ],
  [
    'place-whisperlight',
    'Whisperlight Odyssey',
    'ride',
    'dark_ride',
    'Spirit Realm',
    '4D dark ride.',
    ['family', 'indoor', 'dark-ride'],
    '10:00-20:00',
  ],
  [
    'place-carousel',
    'Spirit Carousel',
    'ride',
    'carousel',
    'Spirit Realm',
    'Hand-painted carousel.',
    ['kids', 'gentle'],
    '10:00-20:00',
  ],
  [
    'place-popcorn',
    'Lantern Popcorn Kiosk',
    'restaurant',
    'kiosk',
    'Spirit Realm',
    'Popcorn and drinks.',
    ['snack'],
    '11:00-20:00',
  ],
  [
    'place-guest-services',
    'Guest Services',
    'service',
    'service',
    'Entrance',
    'Help desk.',
    ['services'],
    '09:30-21:00',
  ],
]

export const THEME_PARK_PLACES: SemanticPlace[] = THEME_PARK_PLACE_SEEDS.map(
  ([id, name, type, itemType, area, short, tags, hours], index) => ({
    id,
    name,
    type,
    itemType,
    shortDescription: short,
    longDescription: `${short} Located in the ${area} of Emberwild Park.`,
    lat: 40 + index * 0.0004,
    lng: -80 + index * 0.0005,
    tags,
    areaName: area,
    hours,
    photoUrl: null,
    sourceType: 'MANUAL',
    sourceName: 'Emberwild Park guest handbook',
    sourceUrl: `https://emberwild.example/places/${id.replace(/^place-/, '')}`,
  }),
)

// ---------------------------------------------------------------------------------------------
// Wildlife park regression: Sunmeadow Wildlife Park (fictional)
// ---------------------------------------------------------------------------------------------

export const WILDLIFE_PARK_KEY_IDS = {
  repeatPolicy: 'kb-wp-tram-reboarding',
  animalStory: 'kb-wp-juniper-giraffe',
  viewingArea: 'kb-wp-savanna-overlook',
} as const

const WILDLIFE_PARK_SEEDS: Seed[] = [
  {
    id: 'kb-wp-tram-reboarding',
    title: 'Safari tram boarding rules',
    category: 'Policies',
    content:
      'The safari tram loop circles the savanna paddocks every fifteen minutes. A ticket scan is required each time you board. Guests may board again on the same day at no extra charge, up to three loops per ticket. Seats are not reserved, and the last loop departs thirty minutes before closing.',
  },
  {
    id: 'kb-wp-juniper-giraffe',
    title: 'Juniper the reticulated giraffe',
    category: 'Animals',
    content:
      'Juniper was born at Sunmeadow in 2014 and was hand-raised for her first months after her mother could not nurse. Keepers taught her to eat acacia leaves from a pole, and she now leads the herd to the feeding platform each morning. Juniper is recognizable by her unusually dark ears and a star-shaped patch on her left shoulder.',
  },
  {
    id: 'kb-wp-savanna-overlook',
    title: 'Savanna Overlook viewing area',
    category: 'Visitor Areas',
    content:
      'The Savanna Overlook is a covered viewing platform above the giraffe paddock with benches, binoculars and a shaded rail. It is open during park hours and is step-free from the main path. Early morning is the quietest time.',
  },
  {
    id: 'kb-wp-hours',
    title: 'Park hours',
    category: 'Visiting',
    content:
      'Sunmeadow Wildlife Park opens at 9 am and closes at 5 pm daily, with last entry at 4 pm.',
  },
  {
    id: 'kb-wp-feeding',
    title: 'Keeper talks and feeding times',
    category: 'Programs',
    content:
      'Keeper talks run at 10 am, 12 pm and 2 pm at the feeding platform. Guests may buy a cup of leaf browse to feed the giraffes.',
  },
  {
    id: 'kb-wp-rhino',
    title: 'Rhino Ridge',
    category: 'Animals',
    content:
      'Rhino Ridge is home to two southern white rhinos, Bramble and Tuft, who enjoy mud wallows on warm afternoons.',
  },
  {
    id: 'kb-wp-lemur',
    title: 'Lemur Walk',
    category: 'Animals',
    content:
      'On the Lemur Walk guests can step through a free-roaming ring-tailed lemur habitat. Keep a meter away and no touching.',
  },
  {
    id: 'kb-wp-cafe',
    title: 'Watering Hole Cafe',
    category: 'Dining',
    content:
      'The Watering Hole Cafe serves sandwiches, soups and ice cream near the entrance. Picnic areas are beside the lemur habitat.',
  },
  {
    id: 'kb-wp-parking',
    title: 'Parking and tickets',
    category: 'Visiting',
    content: 'Parking is free. Adult admission is $24 and children under 3 are free.',
  },
  {
    id: 'kb-wp-access',
    title: 'Accessibility at Sunmeadow',
    category: 'Accessibility',
    content:
      'Paved paths are wheelchair friendly. Free loaner wheelchairs are available at the entrance. Service dogs are welcome.',
  },
  {
    id: 'kb-wp-weather',
    title: 'Weather policy',
    category: 'Policies',
    content:
      'The park stays open in light rain. The tram may stop in lightning. No refunds are provided for weather.',
  },
  {
    id: 'kb-wp-gift',
    title: 'Safari Gift Hut',
    category: 'Shopping',
    content:
      'The Safari Gift Hut sells plush animals, field guides and adoptions for the herd. Proceeds support conservation.',
  },
]

export const WILDLIFE_PARK_KNOWLEDGE: CorpusKnowledgeEntry[] = build(
  WILDLIFE_PARK_SEEDS,
  'sunmeadow.example',
  'Sunmeadow visitor guide',
  new Set(['kb-wp-tram-reboarding', 'kb-wp-weather', 'kb-wp-parking']),
)

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

export type GuestAnswerQualityScenario = {
  id: string
  venue: 'theme-park' | 'wildlife-park'
  /** Guest turns in order. mustRetrieveIds apply to the final turn. */
  turns: string[]
  visitContext?: unknown
  /** Entries that must reach model context for the final turn. */
  mustRetrieveIds: string[]
  /** Entries that must not be counted as satisfying the question (for example in a count). */
  mustNotCountIds?: string[]
  notes: string
}

const K = THEME_PARK_KEY_IDS
const COASTERS: string[] = [...THEME_PARK_OPERATING_COASTER_IDS]
const NOT_COASTERS: string[] = [K.futureCoaster, K.darkRide]
const DINING_ALL: string[] = [K.diningOverview, K.grill, K.market, K.quickBite, K.dessert]

export const GUEST_ANSWER_QUALITY_SCENARIOS: GuestAnswerQualityScenario[] = [
  {
    id: 'coaster-count-after-explain',
    venue: 'theme-park',
    turns: ['Explain this place to me.', 'How many coasters are there'],
    mustRetrieveIds: COASTERS,
    mustNotCountIds: NOT_COASTERS,
    notes:
      'Original failure. Four operating coasters; the future announcement and the 4D dark ride (URL says rollercoasters) must not inflate the count. Answer must say four or list them.',
  },
  {
    id: 'explain-place-overview',
    venue: 'theme-park',
    turns: ['Explain this place to me.'],
    mustRetrieveIds: [K.overview],
    notes: 'Broad orientation question. The overview entry has no embedding and must still arrive.',
  },
  {
    id: 'where-to-eat-isolated',
    venue: 'theme-park',
    turns: ['Where to eat'],
    mustRetrieveIds: DINING_ALL,
    notes:
      'Original failure. Answer must cover all six dining options, not one; overview, grill and market have no embedding.',
  },
  {
    id: 'paraphrase-park-about',
    venue: 'theme-park',
    turns: ["what's this park about?"],
    mustRetrieveIds: [K.overview],
    notes: 'Unseen paraphrase of the overview question.',
  },
  {
    id: 'paraphrase-rundown',
    venue: 'theme-park',
    turns: ['give me the rundown on this place'],
    mustRetrieveIds: [K.overview],
    notes: 'Unseen paraphrase with no keyword shared with the overview title.',
  },
  {
    id: 'paraphrase-roller-coasters',
    venue: 'theme-park',
    turns: ['how many roller coasters do you have'],
    mustRetrieveIds: COASTERS,
    mustNotCountIds: NOT_COASTERS,
    notes: 'Phrased as "roller coasters". The count must be four.',
  },
  {
    id: 'paraphrase-coasters-open',
    venue: 'theme-park',
    turns: ['which coasters are open'],
    mustRetrieveIds: COASTERS,
    mustNotCountIds: NOT_COASTERS,
    notes:
      'Live status is unknown. Expected uncertainty: list the four coasters, say live status is not available and point to the app or a team member. Must not claim any is open or closed.',
  },
  {
    id: 'paraphrase-hungry',
    venue: 'theme-park',
    turns: ["I'm hungry"],
    mustRetrieveIds: DINING_ALL,
    notes: 'No dining keywords at all.',
  },
  {
    id: 'paraphrase-lunch',
    venue: 'theme-park',
    turns: ['anywhere good for lunch?'],
    mustRetrieveIds: [K.diningOverview, K.grill, K.market, K.quickBite],
    notes: 'Lunch wording; sit-down and quick options should both be offered.',
  },
  {
    id: 'paraphrase-something-sweet',
    venue: 'theme-park',
    turns: ['something sweet?'],
    mustRetrieveIds: [K.dessert],
    notes: 'Dessert stand. The allergy entry is useful but not required.',
  },
  {
    id: 'water-realm-quick-bite',
    venue: 'theme-park',
    turns: ['quick bite near the water realm'],
    mustRetrieveIds: [K.quickBite],
    notes: 'Realm-scoped savory quick bite. The dessert stand is nearby but is not savory.',
  },
  {
    id: 'follow-up-scariest',
    venue: 'theme-park',
    turns: ['How many coasters are there', 'which one is the scariest?'],
    mustRetrieveIds: COASTERS,
    mustNotCountIds: NOT_COASTERS,
    notes:
      'Follow-up needs the coaster entries again from conversation context. Scariness is subjective: compare facts (height, launch, inversions, drop) and do not invent ratings.',
  },
  {
    id: 'follow-up-five-year-old',
    venue: 'theme-park',
    turns: ['How many coasters are there', 'what about for my 5 year old?'],
    mustRetrieveIds: [K.juniorCoaster, K.launchCoaster, K.fireCoaster],
    notes:
      'Needs the junior coaster (36 in minimum) and the other height rules. The child must be measured at the ride; no guarantee.',
  },
  {
    id: 'safety-grill-nut-free',
    venue: 'theme-park',
    turns: ['is the grill nut free?'],
    mustRetrieveIds: [K.grill, K.grillAllergy],
    notes:
      'Allergen safety. Expected uncertainty: must NOT claim nut free; report that tree nuts are handled in the kitchen and direct to staff and the allergen sheet.',
  },
  {
    id: 'safety-dessert-allergy',
    venue: 'theme-park',
    turns: ['can my kid with a peanut allergy have ice cream?'],
    mustRetrieveIds: [K.dessert, K.dessertAllergy],
    notes:
      'Allergen safety. Must mention shared equipment and possible peanuts and must not call anything safe.',
  },
  {
    id: 'live-launch-coaster-open',
    venue: 'theme-park',
    turns: ['is the launch coaster open right now?'],
    mustRetrieveIds: [K.launchCoaster],
    notes:
      'No live status data. Expected uncertainty: say live ride status is not visible and refer to the app or a team member; may mention weather closures happen.',
  },
  {
    id: 'accessibility-wheelchair-fire-coaster',
    venue: 'theme-park',
    turns: ['can I bring a wheelchair on the fire coaster?'],
    mustRetrieveIds: [K.fireCoaster],
    notes:
      'Source says a guest must transfer with help and to ask a team member. Expected uncertainty: do not promise access; point to the accessible entrance and Guest Services.',
  },
  {
    id: 'wildlife-repeat-loop',
    venue: 'wildlife-park',
    turns: ['can I ride the loop again later today if I do it once now?'],
    mustRetrieveIds: [WILDLIFE_PARK_KEY_IDS.repeatPolicy],
    notes:
      'The policy never uses the guest words (ride, again, later). Answer: yes, up to three loops per ticket with a scan each time.',
  },
  {
    id: 'wildlife-giraffe-with-viewing-area',
    venue: 'wildlife-park',
    turns: ["what's the story with Juniper the giraffe, and where can I watch from?"],
    mustRetrieveIds: [WILDLIFE_PARK_KEY_IDS.animalStory, WILDLIFE_PARK_KEY_IDS.viewingArea],
    notes: 'Adding viewing-area context must not lose the animal story. Both entries are needed.',
  },
  {
    id: 'wildlife-giraffe-story-only',
    venue: 'wildlife-park',
    turns: ["what's the story with Juniper the giraffe?"],
    mustRetrieveIds: [WILDLIFE_PARK_KEY_IDS.animalStory],
    notes: 'Baseline for the previous scenario; the story entry alone must be found.',
  },
]

// ---------------------------------------------------------------------------------------------
// Fake reader and fake semantic search
// ---------------------------------------------------------------------------------------------

export function toStoredRecords(
  entries: CorpusKnowledgeEntry[],
  scope: { tenantId: string; venueId: string },
  overrides: Partial<Pick<StoredKnowledgeRecord, 'isEnabled' | 'visibility'>> = {},
): StoredKnowledgeRecord[] {
  return entries.map((row) => ({
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    isEnabled: overrides.isEnabled ?? true,
    visibility: overrides.visibility ?? 'PUBLIC',
    row,
  }))
}

export const THEME_PARK_RECORDS = toStoredRecords(THEME_PARK_KNOWLEDGE, THEME_PARK_SCOPE)
export const WILDLIFE_PARK_RECORDS = toStoredRecords(WILDLIFE_PARK_KNOWLEDGE, WILDLIFE_PARK_SCOPE)

type Where = Record<string, unknown>

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordField(record: StoredKnowledgeRecord, key: string): unknown {
  if (key === 'tenantId' || key === 'venueId' || key === 'isEnabled' || key === 'visibility') {
    return record[key]
  }
  return (record.row as Record<string, unknown>)[key]
}

function matchesField(record: StoredKnowledgeRecord, key: string, condition: unknown): boolean {
  // Relations: corpus rows are legacy rows with no module, revision, publication or adoption.
  if (
    key === 'contentPublication' ||
    key === 'contentRevision' ||
    key === 'universalContentAdoption'
  ) {
    if (condition === null) return true
    return isObject(condition) && condition.is === null
  }
  const value = recordField(record, key)
  if (condition === null) return value === null || value === undefined
  if (!isObject(condition)) return value === condition
  if ('not' in condition) {
    const negated = condition.not
    return negated === null
      ? value !== null && value !== undefined
      : !matchesField(record, key, negated)
  }
  if ('in' in condition) return (condition.in as unknown[]).includes(value)
  if ('contains' in condition) {
    if (typeof value !== 'string') return false
    const needle = String(condition.contains)
    return condition.mode === 'insensitive'
      ? value.toLowerCase().includes(needle.toLowerCase())
      : value.includes(needle)
  }
  throw new Error(`Fake reader does not support condition on ${key}: ${JSON.stringify(condition)}`)
}

export function matchesWhere(record: StoredKnowledgeRecord, where: Where): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (condition as Where[]).every((item) => matchesWhere(record, item))
    if (key === 'OR') return (condition as Where[]).some((item) => matchesWhere(record, item))
    if (key === 'NOT') return !matchesWhere(record, condition as Where)
    return matchesField(record, key, condition)
  })
}

type OrderBy = Record<string, 'asc' | 'desc'>

/** Ascending comparison with NULL last, like PostgreSQL. Descending order inverts it. */
function compareValues(a: unknown, b: unknown): number {
  const aNull = a === null || a === undefined
  const bNull = b === null || b === undefined
  if (aNull) return bNull ? 0 : 1
  if (bNull) return -1
  const left = a instanceof Date ? a.getTime() : (a as string | number)
  const right = b instanceof Date ? b.getTime() : (b as string | number)
  return left < right ? -1 : left > right ? 1 : 0
}

export type FakeKnowledgeReader = {
  venueKnowledgeEntry: {
    findMany(args: Record<string, unknown>): Promise<GuestKnowledgeRow[]>
  }
  /** Every query the reader has evaluated, for assertions. */
  calls: Array<{ where: unknown; take: unknown }>
}

export function createFakeKnowledgeReader(records: StoredKnowledgeRecord[]): FakeKnowledgeReader {
  const calls: FakeKnowledgeReader['calls'] = []
  return {
    calls,
    venueKnowledgeEntry: {
      async findMany(args) {
        const where = (args.where ?? {}) as Where
        calls.push({ where, take: args.take })
        let matched = records.filter((record) => matchesWhere(record, where))
        const orderBy = (args.orderBy ?? []) as OrderBy[]
        if (orderBy.length > 0) {
          matched = [...matched].sort((x, y) => {
            for (const order of orderBy) {
              const [field, direction] = Object.entries(order)[0]!
              const raw = compareValues(recordField(x, field), recordField(y, field))
              if (raw !== 0) return direction === 'desc' ? -raw : raw
            }
            return 0
          })
        }
        if (typeof args.take === 'number') matched = matched.slice(0, args.take)
        return matched.map((record) => {
          const { hasEmbedding, ...row } = record.row
          void hasEmbedding
          return { ...row }
        })
      },
    },
  }
}

function bagOfWords(text: string): Map<string, number> {
  const bag = new Map<string, number>()
  for (const token of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    bag.set(token, (bag.get(token) ?? 0) + 1)
  }
  return bag
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  for (const [token, count] of a) dot += count * (b.get(token) ?? 0)
  const norm = (bag: Map<string, number>) =>
    Math.sqrt([...bag.values()].reduce((sum, count) => sum + count * count, 0))
  const denominator = norm(a) * norm(b)
  return denominator === 0 ? 0 : dot / denominator
}

/**
 * Imitates embedding search: only rows with hasEmbedding true are candidates. Plain term-frequency
 * cosine over title plus content, no stop words and no tuning. Distance is 1 minus similarity.
 * Zero-similarity rows are still returned, as a nearest-neighbour search would.
 */
export function fakeSemanticSearch(params: {
  records: StoredKnowledgeRecord[]
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  query: string
  limit?: number
}): SemanticKnowledgeEntry[] {
  const queryBag = bagOfWords(params.query)
  return params.records
    .filter(
      (record) =>
        record.tenantId === params.tenantId &&
        record.venueId === params.venueId &&
        record.isEnabled &&
        record.row.sourceType !== 'SOURCE_CONNECTION' &&
        record.row.hasEmbedding &&
        (params.includeSecondLayer || record.visibility === 'PUBLIC'),
    )
    .map((record) => ({
      record,
      similarity: cosine(queryBag, bagOfWords(`${record.row.title} ${record.row.content}`)),
    }))
    .sort((a, b) => b.similarity - a.similarity || a.record.row.id.localeCompare(b.record.row.id))
    .slice(0, params.limit ?? 5)
    .map(({ record, similarity }) => ({
      id: record.row.id,
      title: record.row.title,
      category: record.row.category,
      content: record.row.content,
      sourceType: record.row.sourceType,
      sourceName: record.row.sourceName,
      sourceUrl: record.row.sourceUrl,
      distance: 1 - similarity,
      contentModuleId: null,
      contentRevisionId: null,
      contentPublicationId: null,
    }))
}

/** Adapter matching the `semanticSearch` option of retrieveGuestKnowledge. */
export function createFakeSemanticSearch(
  records: StoredKnowledgeRecord[],
  query: string,
  limit = 20,
) {
  return async (scope: { tenantId: string; venueId: string; includeSecondLayer: boolean }) =>
    fakeSemanticSearch({ records, query, limit, ...scope })
}
