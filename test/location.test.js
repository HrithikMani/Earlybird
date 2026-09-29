import { describe, expect, it } from 'vitest';
import { locationMatches, inWantedLocation } from '../src/roles/match.js';

describe('locationMatches: United States', () => {
  const us = [
    'Seattle, Washington, USA',
    'Columbus, OH, United States',
    'Austin, TX',
    'New York, NY',
    'Remote, US',
    'Indianapolis, IN',
    'US, WA, Seattle',
    'Sunnyvale, CA ⋅ Bellevue, WA ⋅ +4 more',
    'Atlanta, GA, Indianapolis, IN', // Accenture: many "City, ST" pairs
    'Chicago, IL, Albany, NY, Arlington, VA, Atlanta, GA',
  ];
  const notUs = ['IN, TS, Hyderabad', 'Bangalore, KA, IN', 'Pune, MH, IN', 'London, UK', 'Toronto, ON, Canada', 'Pune, Maharashtra, India'];

  for (const l of us) it(`matches ${l}`, () => expect(locationMatches(l, 'United States')).toBe(true));
  for (const l of notUs) it(`rejects ${l}`, () => expect(locationMatches(l, 'USA')).toBe(false));
});

describe('locationMatches: other countries and cities', () => {
  it('India via ISO code first', () => expect(locationMatches('IN, TS, Hyderabad', 'India')).toBe(true));
  it('Indianapolis is not India', () => expect(locationMatches('Indianapolis, IN', 'India')).toBe(false));
  it('a city name matches as words', () => expect(locationMatches('London, UK', 'London')).toBe(true));
});

describe('inWantedLocation', () => {
  it('keeps jobs without a country ("Remote")', () => expect(inWantedLocation({ location: 'Remote' }, ['United States'])).toBe(true));
  it('keeps jobs without a location', () => expect(inWantedLocation({}, ['United States'])).toBe(true));
  it('keeps everything without a preference', () => expect(inWantedLocation({ location: 'London, UK' }, [])).toBe(true));
});
