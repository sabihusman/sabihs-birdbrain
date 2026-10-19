import { describe, expect, it } from 'vitest';
import { confidenceLine, windowLine, windowLines } from '../src/ui/confidence-text';

describe('sighting card confidence text', () => {
  it('states the best confidence against the user minimum', () => {
    expect(confidenceLine(0.957, 0.6)).toBe('Confidence 96% · your minimum 60%');
  });
  it('formats a 3 s window as a time range and a percentage', () => {
    expect(windowLine({ offsetSec: 2, confidence: 0.96 }, 10)).toBe('0:02–0:05 · 96%');
    expect(windowLine({ offsetSec: 1.5, confidence: 0.804 }, 10)).toBe('0:01–0:04 · 80%');
  });
  it('clips the last window to the recording length and lists windows in time order', () => {
    expect(windowLines([{ offsetSec: 3, confidence: 0.7 }, { offsetSec: 0, confidence: 0.9 }], 4.5)).toEqual(['0:00–0:03 · 90%', '0:03–0:04 · 70%']);
  });
});
