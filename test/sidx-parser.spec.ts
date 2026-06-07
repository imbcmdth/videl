/**
 * Unit tests for parseSidx (src/lib/mp4/sidx-parser.ts).
 *
 * Sidx buffers are constructed programmatically using DataView writes so no
 * real media file is required.  Each helper builds a minimal valid sidx box
 * whose byte layout matches ISO 14496-12 §8.16.3 exactly.
 *
 * Wire layout (big-endian):
 *   [0-3]   uint32  box size
 *   [4-7]   uint32  fourcc 'sidx'
 *   [8]     uint8   version (0 or 1)
 *   [9-11]  uint24  flags (0)
 *   [12-15] uint32  reference_ID
 *   [16-19] uint32  timescale
 *   version 0: [20-23] uint32 earliest_presentation_time
 *              [24-27] uint32 first_offset
 *              [28-29] uint16 reserved
 *              [30-31] uint16 reference_count
 *              entries start at [32]
 *   version 1: [20-27] uint64 earliest_presentation_time
 *              [28-35] uint64 first_offset
 *              [36-37] uint16 reserved
 *              [38-39] uint16 reference_count
 *              entries start at [40]
 *
 * Each entry (12 bytes):
 *   uint32  (reference_type:1 | referenced_size:31)
 *   uint32  subsegment_duration
 *   uint32  (starts_with_SAP:1 | SAP_type:3 | SAP_delta_time:28)
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const MODULE_PATH = path.join(__dirname, '../dist/index.js');

test.beforeEach(async ({ page }) => {
  await page.route('**/dist/index.js', route =>
    route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: fs.readFileSync(MODULE_PATH, 'utf8'),
    })
  );
  await page.route('http://localhost:3000/', route =>
    route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><html><body></body></html>' })
  );
  await page.goto('http://localhost:3000/');
});

// ---------------------------------------------------------------------------
// Helpers (run inside page context)
// ---------------------------------------------------------------------------

/** Build a version-0 sidx box with `entries` media references. */
function buildSidxV0Src(opts: {
  timescale:  number;
  earliestPTS: number;
  firstOffset: number;
  entries: Array<{ size: number; duration: number; nestedSidx?: boolean }>;
}): string {
  // Header: 32 bytes + entries * 12 bytes
  const byteLength = 32 + opts.entries.length * 12;
  return `
    (function() {
      const buf  = new ArrayBuffer(${byteLength});
      const view = new DataView(buf);
      let p = 0;
      // size
      view.setUint32(p, ${byteLength}, false); p += 4;
      // fourcc 'sidx' = 0x73696478
      view.setUint32(p, 0x73696478, false); p += 4;
      // version=0, flags=0
      view.setUint32(p, 0, false); p += 4;
      // reference_ID
      view.setUint32(p, 1, false); p += 4;
      // timescale
      view.setUint32(p, ${opts.timescale}, false); p += 4;
      // earliest_presentation_time (v0 = uint32)
      view.setUint32(p, ${opts.earliestPTS}, false); p += 4;
      // first_offset (v0 = uint32)
      view.setUint32(p, ${opts.firstOffset}, false); p += 4;
      // reserved
      view.setUint16(p, 0, false); p += 2;
      // reference_count
      view.setUint16(p, ${opts.entries.length}, false); p += 2;
      // entries
      ${opts.entries.map(e => `
        view.setUint32(p, ${e.nestedSidx ? 0x80000000 : 0} | ${e.size}, false); p += 4;
        view.setUint32(p, ${e.duration}, false); p += 4;
        view.setUint32(p, 0, false); p += 4;
      `).join('')}
      return buf;
    })()
  `;
}

/** Build a version-1 sidx box (64-bit times) with 2 entries. */
function buildSidxV1Src(opts: {
  timescale:   number;
  earliestPTS: number;
  firstOffset: number;
  entries: Array<{ size: number; duration: number }>;
}): string {
  const byteLength = 40 + opts.entries.length * 12;
  return `
    (function() {
      const buf  = new ArrayBuffer(${byteLength});
      const view = new DataView(buf);
      let p = 0;
      view.setUint32(p, ${byteLength}, false); p += 4;
      view.setUint32(p, 0x73696478, false); p += 4;
      // version=1
      view.setUint8(p, 1); p += 1;
      view.setUint8(p, 0); p += 1;
      view.setUint16(p, 0, false); p += 2;
      view.setUint32(p, 1, false); p += 4; // reference_ID
      view.setUint32(p, ${opts.timescale}, false); p += 4;
      // earliest_presentation_time (uint64, hi=0 for test values)
      view.setUint32(p, 0, false); p += 4;
      view.setUint32(p, ${opts.earliestPTS}, false); p += 4;
      // first_offset (uint64, hi=0)
      view.setUint32(p, 0, false); p += 4;
      view.setUint32(p, ${opts.firstOffset}, false); p += 4;
      view.setUint16(p, 0, false); p += 2; // reserved
      view.setUint16(p, ${opts.entries.length}, false); p += 2;
      ${opts.entries.map(e => `
        view.setUint32(p, ${e.size}, false); p += 4;
        view.setUint32(p, ${e.duration}, false); p += 4;
        view.setUint32(p, 0, false); p += 4;
      `).join('')}
      return buf;
    })()
  `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('parseSidx version 0 — 3 media entries: correct byte ranges, start times, durations', async ({ page }) => {
  // sidx box at bytes 100-131 (32 bytes) → sidxEndByte = 132
  // firstOffset = 0 → subsegment 0 starts at byte 132
  // timescale = 1000, earliestPTS = 0
  // entries: size=500 dur=3000, size=600 dur=3000, size=400 dur=2000
  const sidxSrc = buildSidxV0Src({
    timescale:   1000,
    earliestPTS: 0,
    firstOffset: 0,
    entries: [
      { size: 500,  duration: 3000 },
      { size: 600,  duration: 3000 },
      { size: 400,  duration: 2000 },
    ],
  });

  const result = await page.evaluate(async (sidxSrc: string) => {
    const { parseSidx } = await import('/dist/index.js');
    // eslint-disable-next-line no-eval
    const buf     = eval(sidxSrc) as ArrayBuffer;
    const entries = parseSidx(buf, 132);
    return entries.map(e => ({ byteRange: e.byteRange, startTime: e.startTime, duration: e.duration }));
  }, sidxSrc);

  expect(result).toHaveLength(3);

  // Entry 0: bytes 132–631, startTime=0, duration=3
  expect(result[0]!.byteRange).toBe('132-631');
  expect(result[0]!.startTime).toBeCloseTo(0, 6);
  expect(result[0]!.duration).toBeCloseTo(3, 6);

  // Entry 1: bytes 632–1231, startTime=3, duration=3
  expect(result[1]!.byteRange).toBe('632-1231');
  expect(result[1]!.startTime).toBeCloseTo(3, 6);
  expect(result[1]!.duration).toBeCloseTo(3, 6);

  // Entry 2: bytes 1232–1631, startTime=6, duration=2
  expect(result[2]!.byteRange).toBe('1232-1631');
  expect(result[2]!.startTime).toBeCloseTo(6, 6);
  expect(result[2]!.duration).toBeCloseTo(2, 6);
});

test('parseSidx — non-zero earliestPTS shifts all startTime values', async ({ page }) => {
  // earliestPTS=90000 at timescale=90000 → 1.0 s offset
  const sidxSrc = buildSidxV0Src({
    timescale:   90000,
    earliestPTS: 90000,
    firstOffset: 0,
    entries: [
      { size: 1000, duration: 270000 }, // 3 s
      { size: 1000, duration: 270000 }, // 3 s
    ],
  });

  const result = await page.evaluate(async (sidxSrc: string) => {
    const { parseSidx } = await import('/dist/index.js');
    const buf     = eval(sidxSrc) as ArrayBuffer;
    const entries = parseSidx(buf, 200);
    return entries.map(e => e.startTime);
  }, sidxSrc);

  expect(result[0]).toBeCloseTo(1.0, 6);
  expect(result[1]).toBeCloseTo(4.0, 6);
});

test('parseSidx — non-zero firstOffset shifts byte addresses', async ({ page }) => {
  // sidxEndByte=1000, firstOffset=50 → first subsegment starts at 1050
  const sidxSrc = buildSidxV0Src({
    timescale:   1000,
    earliestPTS: 0,
    firstOffset: 50,
    entries: [
      { size: 300, duration: 2000 },
    ],
  });

  const result = await page.evaluate(async (sidxSrc: string) => {
    const { parseSidx } = await import('/dist/index.js');
    const buf   = eval(sidxSrc) as ArrayBuffer;
    const [e]   = parseSidx(buf, 1000);
    return e?.byteRange;
  }, sidxSrc);

  expect(result).toBe('1050-1349');
});

test('parseSidx version 1 — 2 entries parsed correctly with 64-bit time fields', async ({ page }) => {
  const sidxSrc = buildSidxV1Src({
    timescale:   44100,
    earliestPTS: 0,
    firstOffset: 0,
    entries: [
      { size: 800, duration: 44100 },  // 1 s
      { size: 900, duration: 88200 },  // 2 s
    ],
  });

  const result = await page.evaluate(async (sidxSrc: string) => {
    const { parseSidx } = await import('/dist/index.js');
    const buf     = eval(sidxSrc) as ArrayBuffer;
    const entries = parseSidx(buf, 500);
    return entries.map(e => ({ byteRange: e.byteRange, startTime: e.startTime, duration: e.duration }));
  }, sidxSrc);

  expect(result).toHaveLength(2);
  expect(result[0]!.byteRange).toBe('500-1299');
  expect(result[0]!.startTime).toBeCloseTo(0, 6);
  expect(result[0]!.duration).toBeCloseTo(1, 6);
  expect(result[1]!.byteRange).toBe('1300-2199');
  expect(result[1]!.startTime).toBeCloseTo(1, 6);
  expect(result[1]!.duration).toBeCloseTo(2, 6);
});

test('parseSidx — nested sidx entries (reference_type=1) are skipped', async ({ page }) => {
  // Entry 0: nested sidx (reference_type=1), Entry 1 and 2: media
  const sidxSrc = buildSidxV0Src({
    timescale:   1000,
    earliestPTS: 0,
    firstOffset: 0,
    entries: [
      { size: 200, duration: 1000, nestedSidx: true }, // skipped
      { size: 500, duration: 3000 },                    // returned
      { size: 400, duration: 2000 },                    // returned
    ],
  });

  const result = await page.evaluate(async (sidxSrc: string) => {
    const { parseSidx } = await import('/dist/index.js');
    const buf     = eval(sidxSrc) as ArrayBuffer;
    const entries = parseSidx(buf, 100);
    return entries.map(e => ({ byteRange: e.byteRange, startTime: e.startTime }));
  }, sidxSrc);

  // Nested entry skipped — 2 media entries returned
  expect(result).toHaveLength(2);
  // Byte accounting continues past the nested entry's size (200),
  // so media entry 0 starts at 100 + 200 = 300
  expect(result[0]!.byteRange).toBe('300-799');
  expect(result[0]!.startTime).toBeCloseTo(1, 6); // nested contributed 1 s to time
  expect(result[1]!.byteRange).toBe('800-1199');
  expect(result[1]!.startTime).toBeCloseTo(4, 6);
});

test('parseSidx — empty buffer returns []', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { parseSidx } = await import('/dist/index.js');
    return parseSidx(new ArrayBuffer(0), 0);
  });
  expect(result).toEqual([]);
});

test('parseSidx — buffer with no sidx fourcc returns []', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { parseSidx } = await import('/dist/index.js');
    // 40-byte buffer with fourcc 'moof' (not sidx)
    const buf  = new ArrayBuffer(40);
    const view = new DataView(buf);
    view.setUint32(0, 40, false);
    view.setUint32(4, 0x6d6f6f66, false); // 'moof'
    return parseSidx(buf, 100);
  });
  expect(result).toEqual([]);
});

test('parseSidx — zero reference_count returns []', async ({ page }) => {
  const sidxSrc = buildSidxV0Src({
    timescale:   1000,
    earliestPTS: 0,
    firstOffset: 0,
    entries: [],
  });
  const result = await page.evaluate(async (sidxSrc: string) => {
    const { parseSidx } = await import('/dist/index.js');
    const buf = eval(sidxSrc) as ArrayBuffer;
    return parseSidx(buf, 0);
  }, sidxSrc);
  expect(result).toEqual([]);
});
