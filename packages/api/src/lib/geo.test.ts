import { describe, expect, it } from 'vitest'

import { findNearestPlaces, haversineDistanceMeters } from './geo'

describe('haversineDistanceMeters', () => {
  it('returns 0 for identical coordinates', () => {
    expect(haversineDistanceMeters(40.7128, -74.006, 40.7128, -74.006)).toBe(0)
  })

  it('returns approximately 111km for 1 degree of latitude at the equator', () => {
    const dist = haversineDistanceMeters(0, 0, 1, 0)
    // 1 degree of latitude ≈ 111,195 meters
    expect(dist).toBeGreaterThan(111_000)
    expect(dist).toBeLessThan(112_000)
  })

  it('calculates a known distance — NYC to London approx 5,570 km', () => {
    // New York: 40.7128°N, 74.0060°W   London: 51.5074°N, 0.1278°W
    const dist = haversineDistanceMeters(40.7128, -74.006, 51.5074, -0.1278)
    expect(dist).toBeGreaterThan(5_500_000)
    expect(dist).toBeLessThan(5_600_000)
  })

  it('is symmetric — distance A→B equals B→A', () => {
    const d1 = haversineDistanceMeters(34.0522, -118.2437, 37.7749, -122.4194)
    const d2 = haversineDistanceMeters(37.7749, -122.4194, 34.0522, -118.2437)
    expect(d1).toBeCloseTo(d2, 5)
  })
})

describe('findNearestPlaces', () => {
  const origin = { lat: 0, lng: 0 }

  const places = [
    { id: 'p1', name: 'Far North', lat: 1.0, lng: 0, type: 'attraction' },
    { id: 'p2', name: 'Close East', lat: 0, lng: 0.01, type: 'amenity' },
    { id: 'p3', name: 'Medium NE', lat: 0.5, lng: 0.5, type: 'food' },
    { id: 'p4', name: 'Very Close', lat: 0.001, lng: 0, type: 'seating' },
    { id: 'p5', name: 'Origin', lat: 0, lng: 0, type: 'restroom' },
  ]

  it('returns places sorted by ascending distance', () => {
    const result = findNearestPlaces(origin.lat, origin.lng, places, 5)
    const distances = result.map((p) => p.distanceMeters)
    expect(distances).toEqual([...distances].sort((a, b) => a - b))
  })

  it('attaches distanceMeters to each result', () => {
    const result = findNearestPlaces(origin.lat, origin.lng, places, 5)
    for (const r of result) {
      expect(typeof r.distanceMeters).toBe('number')
      expect(r.distanceMeters).toBeGreaterThanOrEqual(0)
    }
  })

  it('respects the limit parameter', () => {
    const result = findNearestPlaces(origin.lat, origin.lng, places, 3)
    expect(result).toHaveLength(3)
  })

  it('returns the Origin place with distanceMeters of 0', () => {
    const result = findNearestPlaces(origin.lat, origin.lng, places, 5)
    expect(result[0]).toMatchObject({ id: 'p5', distanceMeters: 0 })
  })

  it('returns empty array when places is empty', () => {
    expect(findNearestPlaces(0, 0, [], 5)).toEqual([])
  })

  it('handles limit larger than places array', () => {
    const result = findNearestPlaces(origin.lat, origin.lng, places, 100)
    expect(result).toHaveLength(places.length)
  })
})
