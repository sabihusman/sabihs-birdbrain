import { describe, expect, it } from 'vitest';
import { BIRDNET_CREDIT, creditsFor, creditText, EBIRD_CREDIT, NATURESERVE_CREDIT } from '../src/ui/credits';

// The names the server sends (server/src/ask.ts SOURCE_NAMES).
const wiki = { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Lesser_redpoll' };
const ebird = { name: 'eBird', url: 'https://ebird.org/region/US-IA' };
const ns = { name: 'NatureServe Explorer', url: 'https://explorer.natureserve.org/Taxon/ELEMENT_GLOBAL.2.100000' };

describe('creditsFor (DECISIONS.md #70)', () => {
  it('credits eBird only when eBird was used', () => {
    expect(creditsFor([wiki, ebird])).toEqual([EBIRD_CREDIT]);
    expect(creditText(creditsFor([wiki, ebird]))).toBe('Local sightings in answers: eBird.org');
    expect(EBIRD_CREDIT.url).toBe('https://ebird.org');
  });
  it('credits NatureServe Explorer only when it was used', () => {
    expect(creditsFor([wiki, ns])).toEqual([NATURESERVE_CREDIT]);
    expect(creditText(creditsFor([wiki, ns]))).toBe('Conservation status: NatureServe Explorer');
    expect(NATURESERVE_CREDIT.url).toBe('https://explorer.natureserve.org');
  });
  it('credits both, eBird first, whatever the order the server listed them', () => {
    expect(creditsFor([wiki, ns, ebird])).toEqual([EBIRD_CREDIT, NATURESERVE_CREDIT]);
    expect(creditText(creditsFor([wiki, ns, ebird]))).toBe('Local sightings in answers: eBird.org · Conservation status: NatureServe Explorer');
  });
  it('credits nothing for a Wikipedia-only answer, an empty list or no list', () => {
    expect(creditsFor([wiki])).toEqual([]);
    expect(creditsFor([])).toEqual([]);
    expect(creditsFor(undefined)).toEqual([]);
    expect(creditsFor(null)).toEqual([]);
  });
  it('recognises a source by its link host when the label changes, and never by a look-alike host', () => {
    expect(creditsFor([{ name: 'Recent sightings', url: 'https://ebird.org/region/US-IA' }])).toEqual([EBIRD_CREDIT]);
    expect(creditsFor([{ name: 'Status', url: 'https://explorer.natureserve.org/Taxon/1' }])).toEqual([NATURESERVE_CREDIT]);
    expect(creditsFor([{ name: 'Wikipedia', url: 'https://notebird.org/x' }, { name: 'Wikipedia', url: 'https://ebird.org.evil.example/' }])).toEqual([]);
  });
  it('the BirdNET line names the model, both institutions and the licence, with the two links', () => {
    expect(`${BIRDNET_CREDIT.label}${BIRDNET_CREDIT.linkText}${BIRDNET_CREDIT.rest}${BIRDNET_CREDIT.licenceText}`).toBe('Bird ID: BirdNET, Cornell Lab of Ornithology and Chemnitz University of Technology · CC BY-NC-SA 4.0');
    expect(BIRDNET_CREDIT.url).toBe('https://birdnet.cornell.edu');
    expect(BIRDNET_CREDIT.licenceUrl).toBe('https://creativecommons.org/licenses/by-nc-sa/4.0/');
  });
});
