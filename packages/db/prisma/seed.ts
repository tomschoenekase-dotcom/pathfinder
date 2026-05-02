import { db } from '../src'

const DEMO_TENANT_ID = 'demo-tenant'
const DEMO_VENUE_ID = 'demo-venue-riverside-aquarium'
const FEATURED_PLACE_ID = 'demo-place-penguin-cove'

const venueSeed = {
  id: DEMO_VENUE_ID,
  tenantId: DEMO_TENANT_ID,
  name: 'Riverside Aquarium',
  slug: 'riverside-aquarium',
  category: 'AQUARIUM',
  guideMode: 'location_aware',
  description: 'A world-class aquarium in the heart of the city.',
  defaultCenterLat: 38.627,
  defaultCenterLng: -90.197,
  aiTone: 'FRIENDLY',
  aiGuideNotes:
    'Always mention the Penguin Cove as a highlight. Remind guests that the 3pm shark feeding is a must-see.',
  aiFeaturedPlaceId: FEATURED_PLACE_ID,
  isActive: true,
} as const

const places = [
  {
    id: FEATURED_PLACE_ID,
    name: 'Penguin Cove',
    type: 'EXHIBIT',
    shortDescription: 'A cold-water habitat with playful penguins and daily keeper talks.',
    longDescription:
      'Watch gentoo and rockhopper penguins dive, socialize, and zip through the water from a panoramic viewing wall.',
    lat: 38.62745,
    lng: -90.19755,
    tags: ['penguins', 'family-friendly', 'keeper-talks'],
    importanceScore: 10,
    areaName: 'North Shore',
    hours: 'Open daily 9:00 AM - 6:00 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-shark-tank',
    name: 'Shark Tank',
    type: 'EXHIBIT',
    shortDescription: 'A sweeping open-water tank featuring reef sharks and rays.',
    longDescription:
      'The aquarium centerpiece, with a wraparound viewing gallery and the popular 3:00 PM shark feeding presentation.',
    lat: 38.62672,
    lng: -90.19682,
    tags: ['sharks', 'feeding-show', 'signature-exhibit'],
    importanceScore: 10,
    areaName: 'Central Blue',
    hours: 'Open daily 9:00 AM - 6:00 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-amazon-river',
    name: 'Amazon River Expedition',
    type: 'EXHIBIT',
    shortDescription: 'Freshwater giants, hidden habitats, and rainforest storytelling.',
    longDescription:
      'Explore piranhas, arapaima, and river turtles through dimly lit galleries inspired by the Amazon basin.',
    lat: 38.62648,
    lng: -90.19788,
    tags: ['freshwater', 'rainforest', 'immersive'],
    importanceScore: 8,
    areaName: 'River Passage',
    hours: 'Open daily 9:00 AM - 6:00 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-jellyfish-gallery',
    name: 'Jellyfish Gallery',
    type: 'EXHIBIT',
    shortDescription: 'A glowing room of drifting moon jellies and changing color lightscapes.',
    longDescription:
      'Slow down in a quiet gallery where translucent jellyfish pulse through softly lit cylindrical tanks.',
    lat: 38.62718,
    lng: -90.19625,
    tags: ['jellyfish', 'calming', 'photo-spot'],
    importanceScore: 8,
    areaName: 'Luminous Hall',
    hours: 'Open daily 9:00 AM - 6:00 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-ray-touch-pool',
    name: 'Ray Touch Pool',
    type: 'INTERACTIVE',
    shortDescription: 'A hands-on pool where guests can gently touch cownose rays.',
    longDescription:
      'Staff guides help guests safely interact with rays while learning how touch experiences support ocean education.',
    lat: 38.62792,
    lng: -90.19662,
    tags: ['interactive', 'rays', 'kids'],
    importanceScore: 9,
    areaName: 'Discovery Pier',
    hours: 'Open daily 10:00 AM - 5:30 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-otter-habitat',
    name: 'Otter Habitat',
    type: 'EXHIBIT',
    shortDescription: 'A lively habitat with above-and-below water views of rescued otters.',
    longDescription:
      'Catch the otters during enrichment sessions as they tumble, swim, and snack in a habitat built for close-up viewing.',
    lat: 38.62784,
    lng: -90.19794,
    tags: ['otters', 'rescue-story', 'family-favorite'],
    importanceScore: 9,
    areaName: 'Harbor Edge',
    hours: 'Open daily 9:00 AM - 6:00 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-coral-reef-tunnel',
    name: 'Coral Reef Tunnel',
    type: 'EXHIBIT',
    shortDescription: 'A walk-through tunnel surrounded by reef fish, turtles, and coral scenes.',
    longDescription:
      'The tunnel gives guests a 360-degree reef experience with colorful fish schools moving overhead.',
    lat: 38.62695,
    lng: -90.19842,
    tags: ['reef', 'tunnel', 'must-see'],
    importanceScore: 10,
    areaName: 'South Current',
    hours: 'Open daily 9:00 AM - 6:00 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-seahorse-nursery',
    name: 'Seahorse Nursery',
    type: 'EXHIBIT',
    shortDescription: 'A compact gallery focused on baby seahorses and conservation breeding.',
    longDescription:
      'See tiny juvenile seahorses up close while learning how aquariums support fragile coastal ecosystems.',
    lat: 38.62633,
    lng: -90.19694,
    tags: ['seahorses', 'conservation', 'small-kids'],
    importanceScore: 7,
    areaName: 'Tidal Lab',
    hours: 'Open daily 9:00 AM - 6:00 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-riverside-cafe',
    name: 'Riverside Cafe',
    type: 'DINING',
    shortDescription: 'Sandwiches, salads, coffee, and kids meals with riverfront seating.',
    longDescription:
      'The main dining stop for a mid-visit break, with quick service and a view toward the outdoor plaza.',
    lat: 38.62758,
    lng: -90.19598,
    tags: ['food', 'coffee', 'family-seating'],
    importanceScore: 7,
    areaName: 'Harbor Commons',
    hours: 'Open daily 10:30 AM - 4:30 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-gift-shop',
    name: 'Aquarium Gift Shop',
    type: 'GIFT_SHOP',
    shortDescription: 'Plush animals, books, apparel, and eco-friendly souvenirs.',
    longDescription:
      'Find take-home keepsakes near the exit, including penguin plush toys, STEM kits, and branded apparel.',
    lat: 38.62686,
    lng: -90.19566,
    tags: ['souvenirs', 'plush', 'retail'],
    importanceScore: 6,
    areaName: 'Main Entry',
    hours: 'Open daily 9:00 AM - 6:30 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-family-restrooms-north',
    name: 'Family Restrooms (North)',
    type: 'RESTROOM',
    shortDescription: 'Accessible family restrooms close to Penguin Cove and the touch pool.',
    longDescription:
      'A convenient restroom bank with changing stations and accessible stalls near the north exhibits.',
    lat: 38.62808,
    lng: -90.19721,
    tags: ['restrooms', 'accessible', 'changing-station'],
    importanceScore: 5,
    areaName: 'North Shore',
    hours: 'Open daily 9:00 AM - 6:00 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-family-restrooms-south',
    name: 'Family Restrooms (South)',
    type: 'RESTROOM',
    shortDescription: 'Accessible family restrooms near the Coral Reef Tunnel exit.',
    longDescription:
      'A second family restroom location positioned for guests coming from the south-side galleries.',
    lat: 38.62641,
    lng: -90.19816,
    tags: ['restrooms', 'accessible', 'family'],
    importanceScore: 5,
    areaName: 'South Current',
    hours: 'Open daily 9:00 AM - 6:00 PM',
    photoUrl: null,
  },
  {
    id: 'demo-place-first-aid',
    name: 'First Aid Station',
    type: 'FIRST_AID',
    shortDescription: 'Staffed first aid room for minor medical assistance and guest support.',
    longDescription:
      'A clearly marked support station with trained staff, basic supplies, and a quiet bench area.',
    lat: 38.6269,
    lng: -90.19714,
    tags: ['first-aid', 'guest-services', 'safety'],
    importanceScore: 6,
    areaName: 'Guest Services',
    hours: 'Open daily 9:00 AM - 6:00 PM',
    photoUrl: null,
  },
]

async function main() {
  await db.tenant.upsert({
    where: { id: DEMO_TENANT_ID },
    update: {
      name: 'PathFinder Demo',
      slug: 'pathfinder-demo',
      status: 'ACTIVE',
    },
    create: {
      id: DEMO_TENANT_ID,
      name: 'PathFinder Demo',
      slug: 'pathfinder-demo',
      status: 'ACTIVE',
    },
  })

  const venue = await db.venue.upsert({
    where: {
      tenantId_slug: {
        tenantId: DEMO_TENANT_ID,
        slug: venueSeed.slug,
      },
    },
    update: venueSeed,
    create: venueSeed,
  })

  const placeIds = places.map((place) => place.id)

  await db.place.deleteMany({
    where: {
      tenantId: DEMO_TENANT_ID,
      venueId: venue.id,
      id: {
        notIn: placeIds,
      },
    },
  })

  for (const place of places) {
    await db.place.upsert({
      where: { id: place.id },
      update: {
        ...place,
        tenantId: DEMO_TENANT_ID,
        venueId: venue.id,
      },
      create: {
        ...place,
        tenantId: DEMO_TENANT_ID,
        venueId: venue.id,
      },
    })
  }

  const historicVenue = await db.venue.upsert({
    where: {
      tenantId_slug: {
        tenantId: DEMO_TENANT_ID,
        slug: 'sappington-house',
      },
    },
    update: {
      name: 'Historic Sappington House',
      category: 'MUSEUM',
      description: 'A historic 19th-century home offering guided and self-guided tours.',
      guideMode: 'non_location',
      aiTone: 'FRIENDLY',
      aiGuideName: 'Clara',
      guideNotes:
        'A single-story historic house with rooms organized roughly front to back from public to private.',
      aiGuideNotes:
        'Focus on the Sappington family history and 1800s daily life. Always mention the kitchen hearth as a highlight.',
      isActive: true,
    },
    create: {
      id: 'demo-venue-sappington-house',
      tenantId: DEMO_TENANT_ID,
      name: 'Historic Sappington House',
      slug: 'sappington-house',
      category: 'MUSEUM',
      description: 'A historic 19th-century home offering guided and self-guided tours.',
      guideMode: 'non_location',
      aiTone: 'FRIENDLY',
      aiGuideName: 'Clara',
      guideNotes:
        'A single-story historic house with rooms organized roughly front to back from public to private.',
      aiGuideNotes:
        'Focus on the Sappington family history and 1800s daily life. Always mention the kitchen hearth as a highlight.',
      isActive: true,
    },
  })

  const sappingtonItems = [
    {
      id: 'demo-sappington-overview',
      name: 'Overview of the House',
      type: 'general_info',
      itemType: 'general_info',
      shortDescription:
        'Introduction to the house, its history, and what visitors will experience.',
    },
    {
      id: 'demo-sappington-family',
      name: 'Sappington Family History',
      type: 'exhibit',
      itemType: 'exhibit',
      shortDescription: 'The story of the Sappington family who built and lived in this home.',
    },
    {
      id: 'demo-sappington-kitchen',
      name: 'The Kitchen',
      type: 'room',
      itemType: 'room',
      shortDescription: 'The working kitchen featuring a large hearth used for all cooking.',
    },
    {
      id: 'demo-sappington-parlor',
      name: 'The Parlor',
      type: 'room',
      itemType: 'room',
      shortDescription: 'The formal parlor where guests were received.',
    },
    {
      id: 'demo-sappington-daily-life',
      name: 'Time Period and Daily Life',
      type: 'exhibit',
      itemType: 'exhibit',
      shortDescription: 'What life was like in this household in the 1800s.',
    },
    {
      id: 'demo-sappington-visitor-info',
      name: 'Tours and Visitor Info',
      type: 'faq',
      itemType: 'faq',
      shortDescription: 'Tour schedules, admission, accessibility, and visitor policies.',
    },
  ]

  for (const item of sappingtonItems) {
    await db.place.upsert({
      where: { id: item.id },
      update: {
        ...item,
        tenantId: DEMO_TENANT_ID,
        venueId: historicVenue.id,
        lat: null,
        lng: null,
        importanceScore: 5,
        isActive: true,
      },
      create: {
        ...item,
        tenantId: DEMO_TENANT_ID,
        venueId: historicVenue.id,
        importanceScore: 5,
        isActive: true,
      },
    })
  }

  const placeCount = await db.place.count({
    where: {
      tenantId: DEMO_TENANT_ID,
      venueId: venue.id,
    },
  })

  console.log(
    `Seeded ${placeCount} places for ${venue.name} (${venue.slug}) under tenant ${DEMO_TENANT_ID}.`,
  )
}

main()
  .catch((error) => {
    console.error('Seed failed.', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await db.$disconnect()
  })
