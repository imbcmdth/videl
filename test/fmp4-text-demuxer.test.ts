/**
 * Fmp4TextDemuxer — unit tests.
 *
 * Synthetic fMP4 init and media segments are constructed in the browser via
 * a shared box-building utility. No external fixture files are required.
 *
 * The page.evaluate calls use the string overload so TypeScript does not
 * attempt to resolve identifiers that only exist inside the eval'd helper
 * string at runtime.
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
    route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' })
  );
  await page.goto('http://localhost:3000/');
});

// ---------------------------------------------------------------------------
// Shared ISOBMFF box-building helpers — injected as a string into every
// page.evaluate call so they are available in the browser context.
// ---------------------------------------------------------------------------
const BOX_UTILS = `
  function u32be(v) {
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  }
  function concat(...arrs) {
    const total = arrs.reduce((s, a) => s + a.length, 0);
    const r = new Uint8Array(total);
    let off = 0;
    for (const a of arrs) { r.set(a, off); off += a.length; }
    return r;
  }
  function box(fourcc, data) {
    const size = 8 + data.length;
    return concat(new Uint8Array(u32be(size)), new Uint8Array([...fourcc].map(c => c.charCodeAt(0))), data);
  }
  function fullbox(fourcc, version, flags, data) {
    const fb = new Uint8Array(4);
    fb[0] = version;
    fb[1] = (flags >>> 16) & 0xff;
    fb[2] = (flags >>> 8)  & 0xff;
    fb[3] =  flags         & 0xff;
    return box(fourcc, concat(fb, data));
  }

  // mdhd: v0, timescale, duration=0, language=0
  function makeMdhd(timescale) {
    const d = new Uint8Array(20);
    const v = new DataView(d.buffer);
    v.setUint32(8, timescale, false);
    return fullbox('mdhd', 0, 0, d);
  }

  // stsd with a single sample entry of the given fourcc (wvtt or stpp)
  function makeStsd(codec) {
    const entryData = new Uint8Array(8); // reserved(6) + dri(2)
    const entry = box(codec, entryData);
    const count = new Uint8Array(u32be(1));
    return fullbox('stsd', 0, 0, concat(count, entry));
  }

  function makeInitSegment(codec, timescale, opts) {
    const withFtyp = opts && opts.withFtyp;
    const mdhd = makeMdhd(timescale);
    const stsd = makeStsd(codec);
    const stbl = box('stbl', stsd);
    const minf = box('minf', stbl);
    const mdia = box('mdia', concat(mdhd, minf));
    const trak = box('trak', mdia);
    const moov = box('moov', trak);
    if (withFtyp) {
      const ftypData = new Uint8Array(12);
      ftypData.set([0x69,0x73,0x6f,0x6d], 0); // 'isom'
      const ftyp = box('ftyp', ftypData);
      return concat(ftyp, moov).buffer;
    }
    return moov.buffer;
  }

  function makeTfhd(trackId) {
    return fullbox('tfhd', 0, 0, new Uint8Array(u32be(trackId)));
  }
  function makeTfdt(baseDecodeTime) {
    return fullbox('tfdt', 0, 0, new Uint8Array(u32be(baseDecodeTime)));
  }
  function makeTrun(dataOffset, samples) {
    const cnt  = new Uint8Array(u32be(samples.length));
    const doff = new Uint8Array(u32be(dataOffset));
    const per  = concat(...samples.map(s =>
      concat(new Uint8Array(u32be(s.duration)), new Uint8Array(u32be(s.size)))
    ));
    return fullbox('trun', 0, 0x000301, concat(cnt, doff, per));
  }
  function makeMediaSegment(baseDecodeTime, samples) {
    const tfhd = makeTfhd(1);
    const tfdt = makeTfdt(baseDecodeTime);
    const trunPlaceholder = makeTrun(0, samples);
    const trafP = box('traf', concat(tfhd, tfdt, trunPlaceholder));
    const mfhd  = fullbox('mfhd', 0, 0, new Uint8Array(u32be(1)));
    const moofP = box('moof', concat(mfhd, trafP));
    const moofSize = moofP.length;
    const trun  = makeTrun(moofSize + 8, samples);
    const traf  = box('traf', concat(tfhd, tfdt, trun));
    const moof  = box('moof', concat(mfhd, traf));
    const mdatData = concat(...samples.map(s => s.data));
    return concat(moof, box('mdat', mdatData)).buffer;
  }
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Fmp4TextDemuxer', () => {

  test('parseInit() reads timescale from mdhd for wvtt', async ({ page }) => {
    const timescale = await page.evaluate(`(async () => {
      ${BOX_UTILS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const initBuf = makeInitSegment('wvtt', 90000);
      const d = new Fmp4TextDemuxer();
      d.parseInit(initBuf);
      return d.timescale;
    })()`);
    expect(timescale).toBe(90000);
  });

  test('parseInit() detects wvtt container codec', async ({ page }) => {
    const codec = await page.evaluate(`(async () => {
      ${BOX_UTILS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const initBuf = makeInitSegment('wvtt', 44100);
      const d = new Fmp4TextDemuxer();
      d.parseInit(initBuf);
      return d.containerCodec;
    })()`);
    expect(codec).toBe('wvtt');
  });

  test('parseInit() detects stpp container codec', async ({ page }) => {
    const codec = await page.evaluate(`(async () => {
      ${BOX_UTILS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const initBuf = makeInitSegment('stpp', 1000);
      const d = new Fmp4TextDemuxer();
      d.parseInit(initBuf);
      return d.containerCodec;
    })()`);
    expect(codec).toBe('stpp');
  });

  test('parseInit() with non-text codec → containerCodec=unknown', async ({ page }) => {
    const codec = await page.evaluate(`(async () => {
      ${BOX_UTILS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const initBuf = makeInitSegment('mp4a', 48000);
      const d = new Fmp4TextDemuxer();
      d.parseInit(initBuf);
      return d.containerCodec;
    })()`);
    expect(codec).toBe('unknown');
  });

  test('parseInit() reads timescale when ftyp precedes moov', async ({ page }) => {
    const timescale = await page.evaluate(`(async () => {
      ${BOX_UTILS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const initBuf = makeInitSegment('wvtt', 48000, { withFtyp: true });
      const d = new Fmp4TextDemuxer();
      d.parseInit(initBuf);
      return d.timescale;
    })()`);
    expect(timescale).toBe(48000);
  });

  test('parseMedia() returns correct pts from tfdt', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${BOX_UTILS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const timescale      = 90000;
      const baseDecodeTime = 90000; // 1.0 second
      const sampleDuration = 45000; // 0.5 seconds
      const sampleData     = new Uint8Array([0x68, 0x69]); // 'hi'
      const initBuf   = makeInitSegment('wvtt', timescale);
      const mediaBuf  = makeMediaSegment(baseDecodeTime, [{ duration: sampleDuration, size: sampleData.length, data: sampleData }]);
      const d = new Fmp4TextDemuxer();
      d.parseInit(initBuf);
      const samples = d.parseMedia(mediaBuf);
      return { count: samples.length, pts: samples[0]?.pts, duration: samples[0]?.duration };
    })()`);
    expect((result as any).count).toBe(1);
    expect((result as any).pts).toBeCloseTo(1.0, 5);
    expect((result as any).duration).toBeCloseTo(0.5, 5);
  });

  test('parseMedia() returns correct sample data bytes', async ({ page }) => {
    const data = await page.evaluate(`(async () => {
      ${BOX_UTILS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const payload  = new Uint8Array([0x41, 0x42, 0x43]); // 'ABC'
      const initBuf  = makeInitSegment('wvtt', 1000);
      const mediaBuf = makeMediaSegment(0, [{ duration: 1000, size: payload.length, data: payload }]);
      const d = new Fmp4TextDemuxer();
      d.parseInit(initBuf);
      const samples = d.parseMedia(mediaBuf);
      return Array.from(samples[0]?.data ?? []);
    })()`);
    expect(data).toEqual([0x41, 0x42, 0x43]);
  });

  test('parseMedia() handles multiple samples in one segment', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${BOX_UTILS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const initBuf = makeInitSegment('wvtt', 1000);
      const s1 = { duration: 1000, size: 2, data: new Uint8Array([0x41, 0x42]) };
      const s2 = { duration: 2000, size: 2, data: new Uint8Array([0x43, 0x44]) };
      const mediaBuf = makeMediaSegment(5000, [s1, s2]);
      const d = new Fmp4TextDemuxer();
      d.parseInit(initBuf);
      const samples = d.parseMedia(mediaBuf);
      return samples.map(s => ({ pts: s.pts, duration: s.duration }));
    })()`);
    expect(result as any[]).toHaveLength(2);
    expect((result as any[])[0].pts).toBeCloseTo(5.0, 5);
    expect((result as any[])[0].duration).toBeCloseTo(1.0, 5);
    expect((result as any[])[1].pts).toBeCloseTo(6.0, 5);
    expect((result as any[])[1].duration).toBeCloseTo(2.0, 5);
  });

  test('reset() clears timescale and containerCodec', async ({ page }) => {
    const result = await page.evaluate(`(async () => {
      ${BOX_UTILS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const d = new Fmp4TextDemuxer();
      d.parseInit(makeInitSegment('wvtt', 90000));
      d.reset();
      return { timescale: d.timescale, codec: d.containerCodec };
    })()`);
    expect((result as any).timescale).toBe(1);
    expect((result as any).codec).toBe('unknown');
  });

  test('parseMedia() before parseInit uses default timescale of 1', async ({ page }) => {
    const count = await page.evaluate(`(async () => {
      ${BOX_UTILS}
      const { Fmp4TextDemuxer } = await import('/dist/index.js');
      const mediaBuf = makeMediaSegment(0, [{ duration: 1000, size: 2, data: new Uint8Array([0x41, 0x42]) }]);
      const d = new Fmp4TextDemuxer();
      const samples = d.parseMedia(mediaBuf);
      return samples.length;
    })()`);
    expect(count).toBe(1);
  });
});
