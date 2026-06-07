/**
 * DEL-007: DASH MPD parser tests.
 *
 * All tests run in a real browser via Playwright because the parser uses
 * DOMParser and document.createElement — both browser-native APIs.
 *
 * Fixture files (test/fixtures/mpd/*.mpd) are downloaded from the
 * videojs/mpd-parser project or hand-crafted for specific edge cases.
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const MODULE_PATH  = path.join(__dirname, '../dist/index.js');
const FIXTURE_DIR  = path.join(__dirname, 'fixtures/mpd');

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------
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

// Helper: serve a fixture file and parse it inside the browser.
function fixtureXml(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

// ---------------------------------------------------------------------------
// Criterion 1 — MPD-level attributes → <videl-presentation>
// (uses multiperiod-segment-template.mpd: type=static, PT30S duration)
// ---------------------------------------------------------------------------
test('criterion 1 — produces videl-presentation with mediaPresentationDuration and type', async ({ page }) => {
  const xml = fixtureXml('multiperiod-segment-template.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const el = parseMpd(xml, 'https://example.com/');
    return {
      tag:      el.tagName.toLowerCase(),
      duration: el.getAttribute('media-presentation-duration'),
      type:     el.getAttribute('type'),
    };
  }, xml);

  expect(result.tag).toBe('videl-presentation');
  expect(result.duration).toBe('30');
  expect(result.type).toBe('static');
});

// ---------------------------------------------------------------------------
// Criterion 2 — Periods → <videl-period> with period-id, start, duration
// (multiperiod-segment-template.mpd: 2 periods, id="1"&"2", PT15S each)
// ---------------------------------------------------------------------------
test('criterion 2 — each videl-period has correct period-id, start, duration', async ({ page }) => {
  const xml = fixtureXml('multiperiod-segment-template.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://example.com/');
    const periods = [...pres.querySelectorAll('videl-period')];
    return periods.map(p => ({
      id:       p.getAttribute('period-id'),
      start:    p.getAttribute('start'),
      duration: p.getAttribute('duration'),
    }));
  }, xml);

  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ id: '1', start: '0', duration: '15' });
  // Period 2 has no start attr → derived (15s after period 1) — parser sets it if calculable
  expect(result[1].id).toBe('2');
  expect(result[1].duration).toBe('15');
});

// ---------------------------------------------------------------------------
// Criterion 3 — AdaptationSets: content-type, mime-type, codecs, lang
// ---------------------------------------------------------------------------
test('criterion 3 — videl-adaptation-set has resolved content-type, mime-type, codecs, lang', async ({ page }) => {
  const xml = fixtureXml('multiperiod-segment-template.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres    = parseMpd(xml, 'https://example.com/');
    const period  = pres.querySelector('videl-period')!;
    const adsSets = [...period.querySelectorAll('videl-adaptation-set')];
    return adsSets.map(a => ({
      contentType: a.getAttribute('content-type'),
      mimeType:    a.getAttribute('mime-type'),
      codecs:      a.getAttribute('codecs'),
      lang:        a.getAttribute('lang'),
    }));
  }, xml);

  // video adaptation set (no lang)
  expect(result[0].contentType).toBe('video');
  expect(result[0].mimeType).toBe('video/mp4');
  // audio adaptation set (lang="en")
  expect(result[1].contentType).toBe('audio');
  expect(result[1].mimeType).toBe('audio/mp4');
  expect(result[1].lang).toBe('en');
});

// ---------------------------------------------------------------------------
// Criterion 4 — Representation: bandwidth, width, height, codecs, mime-type
// ---------------------------------------------------------------------------
test('criterion 4 — videl-representation has bandwidth, dimensions, and resolved codecs', async ({ page }) => {
  const xml = fixtureXml('multiperiod-segment-template.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://example.com/');
    const rep  = pres.querySelector('videl-representation')!;
    return {
      bandwidth: rep.getAttribute('bandwidth'),
      width:     rep.getAttribute('width'),
      height:    rep.getAttribute('height'),
      codecs:    rep.getAttribute('codecs'),
      mimeType:  rep.getAttribute('mime-type'),
    };
  }, xml);

  expect(result.bandwidth).toBe('100000');
  expect(result.width).toBe('480');
  expect(result.height).toBe('200');
  expect(result.codecs).toBe('avc1.4d001f');
  expect(result.mimeType).toBe('video/mp4');
});

// ---------------------------------------------------------------------------
// Criterion 5 — SegmentTemplate + $Number$: parser stamps segment-template-*
// attributes; no <videl-segment> children are created at parse time.
// (multiperiod-segment-template.mpd: startNumber=0, duration=50, timescale=10)
// ---------------------------------------------------------------------------
test('criterion 5 — SegmentTemplate stamps segment-template-* attrs, no segments at parse time', async ({ page }) => {
  const xml = fixtureXml('multiperiod-segment-template.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://example.com/');
    const rep  = pres.querySelector('videl-period videl-adaptation-set videl-representation')!;
    return {
      segCount:     rep.querySelectorAll('videl-segment').length,
      media:        rep.getAttribute('segment-template-media'),
      timescale:    rep.getAttribute('segment-template-timescale'),
      startNumber:  rep.getAttribute('segment-template-start-number'),
      duration:     rep.getAttribute('segment-template-duration'),
    };
  }, xml);

  // No segments created at parse time
  expect(result.segCount).toBe(0);
  // Template attributes stamped — media pre-resolved against base URL
  expect(result.media).toContain('www.example.com/base');
  expect(result.media).toContain('segment_$Number$');
  expect(result.timescale).toBe('10');
  expect(result.startNumber).toBe('0');
  expect(result.duration).toBe('50');
});

// ---------------------------------------------------------------------------
// Criterion 5 (activation) — SegmentTemplate segments created on activation
// ---------------------------------------------------------------------------
test('criterion 5 (activation) — SegmentTemplate segments populated after videl-state="next"', async ({ page }) => {
  const xml = fixtureXml('multiperiod-segment-template.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd, VidelRepresentation } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://example.com/');
    document.body.appendChild(pres);
    const rep = pres.querySelector('videl-period videl-adaptation-set videl-representation')!;
    // Activate — no sourceBuffer needed for segment population
    rep.setAttribute('videl-state', 'next');
    const segs = [...rep.querySelectorAll('videl-segment')];
    return segs.map(s => s.getAttribute('url'));
  }, xml);

  // startNumber=0, duration=50 ticks, timescale=10 → 5 s/seg → 3 segs for 15 s period
  expect(result).toHaveLength(3);
  expect(result[0]).toContain('segment_0');
  expect(result[1]).toContain('segment_1');
  expect(result[2]).toContain('segment_2');
});

// ---------------------------------------------------------------------------
// Criterion 5 + criterion 17 — timescale: start-time and duration in seconds
// Segments are now created at activation time, so we activate first.
// (video: timescale=10, duration=50 → 5.0 s; audio: timescale=48000, duration=240000 → 5.0 s)
// ---------------------------------------------------------------------------
test('criterion 17 — non-1 timescale produces correct start-time and duration in seconds', async ({ page }) => {
  const xml = fixtureXml('multiperiod-segment-template.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres   = parseMpd(xml, 'https://example.com/');
    document.body.appendChild(pres);
    const period = pres.querySelector('videl-period')!;
    const reps   = [...period.querySelectorAll('videl-representation')];

    // Activate both representations to trigger segment population
    reps[0].setAttribute('videl-state', 'next');
    reps[1].setAttribute('videl-state', 'next');

    const videoSegs = [...reps[0].querySelectorAll('videl-segment')];
    const audioSegs = [...reps[1].querySelectorAll('videl-segment')];

    return {
      videoSeg0: {
        startTime: videoSegs[0]?.getAttribute('start-time'),
        duration:  videoSegs[0]?.getAttribute('duration'),
      },
      videoSeg1: {
        startTime: videoSegs[1]?.getAttribute('start-time'),
        duration:  videoSegs[1]?.getAttribute('duration'),
      },
      audioSeg0: {
        startTime: audioSegs[0]?.getAttribute('start-time'),
        duration:  audioSegs[0]?.getAttribute('duration'),
      },
    };
  }, xml);

  // video: timescale=10, segDuration=50 → 5.0 s/seg
  expect(result.videoSeg0.startTime).toBe('0');
  expect(result.videoSeg0.duration).toBe('5');
  expect(result.videoSeg1.startTime).toBe('5');
  // audio: timescale=48000, segDuration=240000 → 5.0 s/seg
  expect(result.audioSeg0.duration).toBe('5');
});

// ---------------------------------------------------------------------------
// Criterion 7 — SegmentTimeline: r attribute, start-time in seconds
// Segments are created at activation time.
// (multiperiod.mpd: period 0 video timescale=30000, d=60060 r=1 + d=59059)
// ---------------------------------------------------------------------------
test('criterion 7 — SegmentTimeline with r repeat produces correct segment count and times', async ({ page }) => {
  const xml = fixtureXml('multiperiod.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres   = parseMpd(xml, 'https://example.com/');
    document.body.appendChild(pres);
    // Period 0, video adaptation set, first representation
    const period  = pres.children[0];
    const videoAds = [...period.querySelectorAll('videl-adaptation-set')]
      .find(a => a.getAttribute('content-type') === 'video')!;
    const rep     = videoAds.querySelector('videl-representation')!;
    rep.setAttribute('videl-state', 'next');
    const segs    = [...rep.querySelectorAll('videl-segment')];
    return segs.map(s => ({
      url:       s.getAttribute('url'),
      startTime: Number(s.getAttribute('start-time')),
      duration:  Number(s.getAttribute('duration')),
    }));
  }, xml);

  // d=60060 r=1 → 2 segments; d=59059 → 1 segment; total 3
  expect(result).toHaveLength(3);
  // timescale=30000 → d=60060/30000 = 2.002s, d=59059/30000 ≈ 1.969s
  expect(result[0].startTime).toBeCloseTo(0, 5);
  expect(result[0].duration).toBeCloseTo(60060 / 30000, 5);
  expect(result[1].startTime).toBeCloseTo(60060 / 30000, 5);
  expect(result[2].startTime).toBeCloseTo((60060 * 2) / 30000, 5);
});

// ---------------------------------------------------------------------------
// Criterion 7 (r="-1") — repeat to end of period fills all segments
// Segments created at activation time.
// (segment-template-time.mpd: d=270000, timescale=90000, periodDuration=30 → 10 segs)
// ---------------------------------------------------------------------------
test('criterion 7 (r="-1") — repeat to end of period fills all segments', async ({ page }) => {
  const xml = fixtureXml('segment-template-time.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres  = parseMpd(xml, 'https://example.com/');
    document.body.appendChild(pres);
    const period = pres.children[0];
    const videoAds = [...period.querySelectorAll('videl-adaptation-set')]
      .find(a => a.getAttribute('content-type') === 'video')!;
    const rep   = videoAds.querySelector('videl-representation')!;
    rep.setAttribute('videl-state', 'next');
    const segs  = [...rep.querySelectorAll('videl-segment')];
    return {
      count:     segs.length,
      duration0: segs[0]?.getAttribute('duration'),
      lastStart: segs[segs.length - 1]?.getAttribute('start-time'),
    };
  }, xml);

  // 30 s period / 3 s per segment = 10 segments
  expect(result.count).toBe(10);
  expect(Number(result.duration0)).toBeCloseTo(3, 5);
});

// ---------------------------------------------------------------------------
// Criterion 6 — $Time$ variable in media URL
// Segments created at activation time.
// (segment-template-time.mpd: uses $Time$ in video media template)
// ---------------------------------------------------------------------------
test('criterion 6 — $Time$ template variable uses timescale-unit t value in URL', async ({ page }) => {
  const xml = fixtureXml('segment-template-time.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres  = parseMpd(xml, 'https://example.com/');
    document.body.appendChild(pres);
    const period = pres.children[0];
    const videoAds = [...period.querySelectorAll('videl-adaptation-set')]
      .find(a => a.getAttribute('content-type') === 'video')!;
    const rep   = videoAds.querySelector('videl-representation')!;
    rep.setAttribute('videl-state', 'next');
    const segs  = [...rep.querySelectorAll('videl-segment')];
    return segs.slice(0, 3).map(s => s.getAttribute('url'));
  }, xml);

  // t=0, 270000, 540000 (90000 ticks per second, 3 s segments)
  expect(result[0]).toContain('seg-0.m4s');
  expect(result[1]).toContain('seg-270000.m4s');
  expect(result[2]).toContain('seg-540000.m4s');
});

// ---------------------------------------------------------------------------
// Criterion 8 — SegmentBase: parser stamps segment-base-* attrs + init URL.
// No <videl-segment> children at parse time — sidx fetch happens at activation.
// ---------------------------------------------------------------------------
test('criterion 8 — SegmentBase stamps segment-base-url/index-range and initialization-url, no segments at parse time', async ({ page }) => {
  const xml = fixtureXml('segment-base.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://example.com/');
    const rep  = pres.querySelector('videl-representation')!;
    return {
      initUrl:        rep.getAttribute('initialization-url'),
      initRange:      rep.getAttribute('initialization-byte-range'),
      segCount:       rep.querySelectorAll('videl-segment').length,
      segBaseUrl:     rep.getAttribute('segment-base-url'),
      segIndexRange:  rep.getAttribute('segment-base-index-range'),
    };
  }, xml);

  // No segments at parse time — sidx fetch deferred to activation
  expect(result.segCount).toBe(0);
  expect(result.initUrl).toBe('https://cdn.example.com/video.mp4');
  expect(result.initRange).toBe('708-1000');
  expect(result.segBaseUrl).toBe('https://cdn.example.com/video.mp4');
  expect(result.segIndexRange).toBe('0-707');
});

// ---------------------------------------------------------------------------
// Criterion 9 — SegmentList: one segment per SegmentURL with resolved URLs
// ---------------------------------------------------------------------------
test('criterion 9 — SegmentList produces one segment per SegmentURL with correct URLs', async ({ page }) => {
  const xml = fixtureXml('segment-list.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://example.com/');
    // First adaptation set has a SegmentList at the AdaptationSet level
    const rep  = pres.querySelector('videl-representation')!;
    const segs = [...rep.querySelectorAll('videl-segment')];
    return {
      count: segs.length,
      urls:  segs.slice(0, 3).map(s => s.getAttribute('url')),
      dur0:  segs[0]?.getAttribute('duration'),
      start1: segs[1]?.getAttribute('start-time'),
    };
  }, xml);

  expect(result.count).toBe(10);
  // BaseURL=https://www.example.com/base, media=low/segment-1.ts
  expect(result.urls[0]).toContain('segment-1.ts');
  expect(result.urls[1]).toContain('segment-2.ts');
  // timescale=1000, duration=1000 → 1 s per segment
  expect(Number(result.dur0)).toBeCloseTo(1, 5);
  expect(Number(result.start1)).toBeCloseTo(1, 5);
});

// ---------------------------------------------------------------------------
// Criterion 10 — Relative URLs resolved against baseUrl
// ---------------------------------------------------------------------------
test('criterion 10 — relative segment URLs are resolved against the baseUrl', async ({ page }) => {
  const xml = fixtureXml('segment-list.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://mycdn.example.com/streams/');
    const seg  = pres.querySelector('videl-segment')!;
    return seg.getAttribute('url');
  }, xml);

  // BaseURL=https://www.example.com/base overrides the provided baseUrl
  expect(result).toMatch(/^https:\/\//);
  expect(result).toContain('segment-1');
});

// ---------------------------------------------------------------------------
// Criterion 11 — BaseURL at multiple levels
// The base URL is now embedded in the segment-template-media attribute.
// ---------------------------------------------------------------------------
test('criterion 11 — BaseURL elements are respected and embedded in segment-template-media', async ({ page }) => {
  const xml = fixtureXml('multiperiod-segment-template.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://fallback.example.com/');
    const rep  = pres.querySelector('videl-representation')!;
    return rep.getAttribute('segment-template-media');
  }, xml);

  // BaseURL is https://www.example.com/base; $Number$ token remains unexpanded
  expect(result).toContain('www.example.com/base');
  expect(result).toContain('$Number$');
});

// ---------------------------------------------------------------------------
// Criterion 12 — Malformed XML throws ParseError
// ---------------------------------------------------------------------------
test('criterion 12 — malformed XML throws ParseError', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { parseMpd, ParseError } = await import('/dist/index.js');
    try {
      parseMpd('<MPD><broken', 'https://example.com/');
      return { threw: false };
    } catch (e: any) {
      return { threw: true, name: e.name };
    }
  });

  expect(result.threw).toBe(true);
  expect(result.name).toBe('ParseError');
});

// ---------------------------------------------------------------------------
// Criterion 13 — Codec inheritance from AdaptationSet
// (segment-template-time.mpd: codecs on AdaptationSet only)
// ---------------------------------------------------------------------------
test('criterion 13 — Representation inherits codecs from AdaptationSet when absent', async ({ page }) => {
  const xml = fixtureXml('segment-template-time.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres  = parseMpd(xml, 'https://example.com/');
    const period = pres.children[0];
    const reps   = [...period.querySelectorAll('videl-representation')];
    return reps.filter(r => {
      const ads = r.closest('videl-adaptation-set');
      return ads?.getAttribute('content-type') === 'video';
    }).map(r => r.getAttribute('codecs'));
  }, xml);

  // Both video representations must inherit avc1.64001f from AdaptationSet
  expect(result).toHaveLength(2);
  expect(result[0]).toBe('avc1.64001f');
  expect(result[1]).toBe('avc1.64001f');
});

// ---------------------------------------------------------------------------
// Criterion 14 — Multi-period: correct period count in DOM order
// ---------------------------------------------------------------------------
test('criterion 14 — multi-period MPD produces videl-period children in manifest order', async ({ page }) => {
  const xml = fixtureXml('multiperiod.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres    = parseMpd(xml, 'https://example.com/');
    const periods = [...pres.querySelectorAll(':scope > videl-period')];
    return periods.map(p => p.getAttribute('period-id'));
  }, xml);

  expect(result).toEqual(['0', '1', '2', '3', '4']);
});

// ---------------------------------------------------------------------------
// Criterion 15 — $RepresentationID$ and $Bandwidth$ template expansion
// $RepresentationID$ and $Bandwidth$ are pre-expanded at parse time;
// $Number$/$Time$ are left for activation-time expansion.
// (multiperiod.mpd: initialization="https://example.com/$RepresentationID$/init0.m4f")
// ---------------------------------------------------------------------------
test('criterion 15 — $RepresentationID$ and $Bandwidth$ expanded in init URL and segment-template-media', async ({ page }) => {
  const xml = fixtureXml('multiperiod.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres   = parseMpd(xml, 'https://example.com/');
    const period  = pres.children[0]; // period id="0"
    const videoAds = [...period.querySelectorAll('videl-adaptation-set')]
      .find(a => a.getAttribute('content-type') === 'video')!;
    const rep     = videoAds.querySelector('videl-representation')!;
    return {
      id:                   rep.getAttribute('id'),
      initUrl:              rep.getAttribute('initialization-url'),
      segmentTemplateMedia: rep.getAttribute('segment-template-media'),
    };
  }, xml);

  const repId = result.id;
  // Init URL must have $RepresentationID$ expanded
  expect(result.initUrl).toContain(repId!);
  // segment-template-media must have $RepresentationID$ expanded but $Number$ preserved
  expect(result.segmentTemplateMedia).toContain(repId!);
  expect(result.segmentTemplateMedia).not.toContain('$RepresentationID$');
});

// ---------------------------------------------------------------------------
// Criterion 15 — zero-padded $Number%05d$
// Segments created at activation time.
// (segment-template-time.mpd audio: media uses $Number%05d$, startNumber=1)
// ---------------------------------------------------------------------------
test('criterion 15 — zero-padded $Number%05d$ expands correctly', async ({ page }) => {
  const xml = fixtureXml('segment-template-time.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres   = parseMpd(xml, 'https://example.com/');
    document.body.appendChild(pres);
    const period  = pres.children[0];
    const audioAds = [...period.querySelectorAll('videl-adaptation-set')]
      .find(a => a.getAttribute('content-type') === 'audio')!;
    const rep    = audioAds.querySelector('videl-representation')!;
    rep.setAttribute('videl-state', 'next');
    const segs   = [...rep.querySelectorAll('videl-segment')];
    return segs.slice(0, 2).map(s => s.getAttribute('url'));
  }, xml);

  // startNumber=1 → first segment is 00001
  expect(result[0]).toContain('00001');
  expect(result[1]).toContain('00002');
});

// ---------------------------------------------------------------------------
// Criterion 16 — initialization-url stamped on every videl-representation
// ---------------------------------------------------------------------------
test('criterion 16 — initialization-url is stamped on every videl-representation', async ({ page }) => {
  const xml = fixtureXml('multiperiod-segment-template.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres  = parseMpd(xml, 'https://example.com/');
    const reps  = [...pres.querySelectorAll('videl-representation')];
    return reps.map(r => r.getAttribute('initialization-url'));
  }, xml);

  // All representations should have initialization-url set
  expect(result.length).toBeGreaterThan(0);
  for (const url of result) {
    expect(url).toBeTruthy();
    expect(url).toContain('init');
  }
});

// ---------------------------------------------------------------------------
// Criterion 18 — presentationTimeOffset subtracted before converting to seconds
// (multiperiod.mpd period 3: pto=214016, timescale=44100
//   t=0 → startTime=(0-214016)/44100 ≈ -4.852... which is negative —
//   the implicit t starts at 0 in the timeline so startTime = (t-pto)/ts)
// Actually, looking at multiperiod.mpd period 3:
//   pto=214016, timescale=44100, first S: d=51200 (no t attribute → t=0)
//   startTime = (0 - 214016) / 44100 ≈ -4.852 s
// ---------------------------------------------------------------------------
test('criterion 18 — presentationTimeOffset subtracted, then offset by absolute period start', async ({ page }) => {
  const xml = fixtureXml('multiperiod.mpd');
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres    = parseMpd(xml, 'https://example.com/');
    document.body.appendChild(pres);
    // Period id="3" (index 3) has presentationTimeOffset=214016, timescale=44100
    const period3 = pres.children[3];
    const audioAds = [...period3.querySelectorAll('videl-adaptation-set')]
      .find(a => a.getAttribute('content-type') === 'audio')!;
    const rep    = audioAds.querySelector('videl-representation')!;
    rep.setAttribute('videl-state', 'next');
    const seg0   = rep.querySelector('videl-segment')!;
    return {
      startTime:   Number(seg0.getAttribute('start-time')),
      periodStart: Number(period3.getAttribute('start')),
    };
  }, xml);

  // Segment start times are absolute presentation time:
  //   periodStart + (t - pto)/timescale
  // pto=214016, timescale=44100 → relative offset = -214016/44100 ≈ -4.852 s
  expect(result.startTime).toBeCloseTo(result.periodStart - 214016 / 44100, 3);
});

// ---------------------------------------------------------------------------
// Content-type inference falls back to the Representation when the
// AdaptationSet has no mimeType/contentType (e.g. nomor multi-period).
// ---------------------------------------------------------------------------
test('content-type is inferred from Representation mimeType when AdaptationSet lacks it', async ({ page }) => {
  const xml = `<?xml version="1.0"?>
    <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT10S">
      <Period duration="PT10S">
        <AdaptationSet segmentAlignment="true">
          <Representation id="v" mimeType="video/mp4" codecs="avc1.4d401f" bandwidth="1000000">
            <SegmentTemplate timescale="1000" duration="2000" media="v_$Number$.mp4" startNumber="1" initialization="v_init.mp4"/>
          </Representation>
        </AdaptationSet>
        <AdaptationSet segmentAlignment="true">
          <Representation id="a" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="64000">
            <SegmentTemplate timescale="1000" duration="2000" media="a_$Number$.mp4" startNumber="1" initialization="a_init.mp4"/>
          </Representation>
        </AdaptationSet>
      </Period>
    </MPD>`;
  const types = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://example.com/');
    // content-type inference is a parse-time operation — no activation needed
    return [...pres.querySelectorAll('videl-adaptation-set')]
      .map(a => a.getAttribute('content-type'));
  }, xml);

  expect(types).toEqual(['video', 'audio']);
});

// ---------------------------------------------------------------------------
// Periods without @start inherit the cumulative offset of preceding periods.
// ---------------------------------------------------------------------------
test('periods without @start get cumulative start times', async ({ page }) => {
  const xml = `<?xml version="1.0"?>
    <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT30S">
      <Period id="0" duration="PT10S"></Period>
      <Period id="1" duration="PT20S"></Period>
    </MPD>`;
  const starts = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://example.com/');
    return [...pres.querySelectorAll('videl-period')]
      .map(p => Number(p.getAttribute('start')));
  }, xml);

  expect(starts).toEqual([0, 10]);
});

// ---------------------------------------------------------------------------
// ISO on-demand profile: a Representation with only a <BaseURL> (no
// SegmentBase/List/Template) becomes a single self-initializing whole-file
// segment (no separate init URL).
// ---------------------------------------------------------------------------
test('on-demand BaseURL-only Representation stamps segment-base-url, yields segment on activation', async ({ page }) => {
  const xml = `<?xml version="1.0"?>
    <MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
         mediaPresentationDuration="PT600S"
         profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
      <Period duration="PT600S" id="P1">
        <AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.4D401E">
          <Representation bandwidth="1000000" id="v1" width="854" height="480">
            <BaseURL>DASH_vodvideo_Track1.m4v</BaseURL>
          </Representation>
        </AdaptationSet>
      </Period>
    </MPD>`;
  const result = await page.evaluate(async (xml: string) => {
    const { parseMpd } = await import('/dist/index.js');
    const pres = parseMpd(xml, 'https://media.example.com/dir/manifest.mpd');
    document.body.appendChild(pres);
    const rep  = pres.querySelector('videl-representation')!;

    // At parse time: no segments, but segment-base-url is stamped
    const parsedSegCount  = rep.querySelectorAll('videl-segment').length;
    const segBaseUrl      = rep.getAttribute('segment-base-url');
    const hasInitUrl      = rep.hasAttribute('initialization-url');

    // After activation: one self-initializing segment created
    rep.setAttribute('videl-state', 'next');
    const segs = [...rep.querySelectorAll('videl-segment')];

    return {
      parsedSegCount,
      segBaseUrl,
      hasInitUrl,
      segCount:    segs.length,
      segUrl:      segs[0]?.getAttribute('url') ?? null,
      segStart:    segs[0]?.getAttribute('start-time') ?? null,
      segDuration: segs[0]?.getAttribute('duration') ?? null,
    };
  }, xml);

  expect(result.parsedSegCount).toBe(0);
  expect(result.segBaseUrl).toBe('https://media.example.com/dir/DASH_vodvideo_Track1.m4v');
  expect(result.hasInitUrl).toBe(false); // self-initializing
  expect(result.segCount).toBe(1);
  expect(result.segUrl).toBe('https://media.example.com/dir/DASH_vodvideo_Track1.m4v');
  expect(result.segStart).toBe('0');
  expect(result.segDuration).toBe('600');
});
