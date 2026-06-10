import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const MODULE_PATH = path.join(__dirname, '../dist/index.js');
const INIT_BYTES  = fs.readFileSync(path.join(__dirname, 'fixtures/video-init.mp4'));

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
  // Serve the init segment for every representation test.
  await page.route('**/fixtures/video-init.mp4', route =>
    route.fulfill({ contentType: 'video/mp4', body: INIT_BYTES })
  );
  // Default media-segment stub (no real MSE needed for selection tests).
  await page.route('**/fixtures/seg-*.mp4', route =>
    route.fulfill({ contentType: 'video/mp4', body: Buffer.alloc(0) })
  );
  await page.route('http://localhost:3000/', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><body></body></html>`,
    })
  );
  await page.goto('http://localhost:3000/');
});

// ---------------------------------------------------------------------------
// Helpers (run inside page.evaluate)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Utility shared across tests: create a representation + N segments, activate,
// wait for init, call update() once, return child slot attributes.
// ---------------------------------------------------------------------------

async function runUpdateTest(
  page: any,
  opts: {
    segTimes: number[];      // [startTime, ...] — duration always 5 s
    bufferedRanges?: [number, number][];  // defaults to [] in the evaluate
    currentTime: number;
  }
): Promise<(string | null)[]> {
  return page.evaluate(
    async ({ segTimes, bufferedRanges = [], currentTime }: typeof opts) => {
      const { VidelRepresentation } = await import('/dist/index.js');

      const mockMSB = {
        appendCalls: [] as number[],
        append: async function(bytes: ArrayBuffer) {
          (this.appendCalls as number[]).push(bytes.byteLength);
        },
        get buffered() {
          return {
            length: bufferedRanges.length,
            start: (i: number) => bufferedRanges[i][0],
            end:   (i: number) => bufferedRanges[i][1],
          };
        },
      };

      const rep = document.createElement('videl-representation') as any;
      rep.setAttribute('initialization-url', '/fixtures/video-init.mp4');
      rep.sourceBuffer = mockMSB;
      document.body.appendChild(rep);

      const segs = segTimes.map(t => {
        const s = document.createElement('videl-segment') as any;
        s.setAttribute('start-time', String(t));
        s.setAttribute('duration', '5');
        s.setAttribute('url', '/fixtures/seg-0.mp4');
        rep.appendChild(s);
        return s;
      });

      rep.setAttribute('videl-state', 'active');
      await new Promise<void>(r => setTimeout(r, 400));

      rep.videlUpdate({
        currentTime,
        currentWallTime: currentTime,
        bandwidth: 1e6,
        playbackRate: 1,
        buffered: {
          length: bufferedRanges.length,
          start: (i: number) => bufferedRanges[i][0],
          end:   (i: number) => bufferedRanges[i][1],
        },
      });

      return segs.map((s: any) => s.getAttribute('videl-state'));
    },
    opts
  );
}

// Replace the placeholder test with the real implementation.
// (Playwright executes tests in order; the placeholder above will run but
//  its assertion is trivially true — replace it with the substantive tests.)

test('criterion 1 — update(t=0): segment covering t=0 becomes active', async ({ page }) => {
  const slots = await runUpdateTest(page, {
    segTimes: [0, 5, 10],
    bufferedRanges: [],
    currentTime: 0,
  });
  expect(slots[0]).toBe('active');
});

test('criterion 3 — update(t=0): segment immediately after active gets slot=next', async ({ page }) => {
  const slots = await runUpdateTest(page, {
    segTimes: [0, 5, 10],
    bufferedRanges: [],
    currentTime: 0,
  });
  expect(slots[1]).toBe('next');
  expect(slots[2]).toBeNull();
});

test('criterion 2 — seek: update(t=30) activates the segment covering t=30', async ({ page }) => {
  // 7 segments: 0-5, 5-10, 10-15, 15-20, 20-25, 25-30, 30-35
  const segTimes = [0, 5, 10, 15, 20, 25, 30];
  const slots = await runUpdateTest(page, {
    segTimes,
    bufferedRanges: [],
    currentTime: 30,
  });
  // Only the segment starting at 30 should be active.
  expect(slots[6]).toBe('active');
  // Earlier segments untouched.
  for (let i = 0; i < 6; i++) expect(slots[i]).toBeNull();
});

test('criterion 4 — already-buffered segment is skipped; next unbuffered gets slot=next', async ({ page }) => {
  // Segments: 0-5, 5-10, 10-15
  // currentTime=0 (seg 0 is work target — not buffered).
  // Seg 1 (5-10) is already buffered.
  // Seg 2 (10-15) is unbuffered → should become slot=next.
  const slots = await runUpdateTest(page, {
    segTimes: [0, 5, 10],
    bufferedRanges: [[5, 10]],   // seg 1 is buffered
    currentTime: 0,
  });
  expect(slots[0]).toBe('active');
  expect(slots[1]).toBeNull();   // buffered — not preloaded
  expect(slots[2]).toBe('next'); // first unbuffered after active
});

test('criterion 5 — sourceBuffer is forwarded to segment before it is slotted', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { VidelRepresentation } = await import('/dist/index.js');

    const mockMSB = {
      append: async (_bytes: ArrayBuffer) => {},
      get buffered() {
        return { length: 0, start: () => 0, end: () => 0 };
      },
    };

    const rep = document.createElement('videl-representation') as any;
    rep.setAttribute('initialization-url', '/fixtures/video-init.mp4');
    rep.sourceBuffer = mockMSB;
    document.body.appendChild(rep);

    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('start-time', '0');
    seg.setAttribute('duration', '5');
    seg.setAttribute('url', '/fixtures/seg-0.mp4');
    rep.appendChild(seg);

    rep.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 400));

    // sourceBuffer not yet set on seg (slot is still unset).
    const sbBeforeUpdate = seg.sourceBuffer;

    rep.videlUpdate({
      currentTime: 0,
      currentWallTime: 0,
      bandwidth: 1e6,
      playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    // After update, seg should have been activated with sourceBuffer forwarded.
    return {
      slot: seg.getAttribute('videl-state'),
      hasSB: seg.sourceBuffer === mockMSB,
      hadSBBefore: sbBeforeUpdate === mockMSB,
    };
  });

  expect(result.slot).toBe('active');
  expect(result.hasSB).toBe(true);
  // sourceBuffer is set on the segment at activation time (it may or may not
  // have been set before — we just care it is set when slotted).
});

test('criterion 6 — slot=next triggers init segment fetch and append', async ({ page }) => {
  let initFetched = false;
  await page.route('**/fixtures/tracked-init.mp4', route => {
    initFetched = true;
    route.fulfill({ contentType: 'video/mp4', body: INIT_BYTES });
  });

  const result = await page.evaluate(async () => {
    const { VidelRepresentation } = await import('/dist/index.js');

    const appendLog: number[] = [];
    const mockMSB = {
      append: async (bytes: ArrayBuffer) => { appendLog.push(bytes.byteLength); },
      get buffered() { return { length: 0, start: () => 0, end: () => 0 }; },
    };

    const rep = document.createElement('videl-representation') as any;
    rep.setAttribute('initialization-url', '/fixtures/tracked-init.mp4');
    rep.sourceBuffer = mockMSB;
    document.body.appendChild(rep);

    rep.setAttribute('videl-state', 'next');
    await new Promise<void>(r => setTimeout(r, 400));

    return { appendCount: appendLog.length };
  });

  expect(initFetched).toBe(true);
  // The init bytes should have been appended to the mock MSB.
  expect(result.appendCount).toBe(1);
});

test('criterion 6a — initialization-byte-range sends a Range header', async ({ page }) => {
  let capturedRange: string | null = null;
  await page.route('**/fixtures/range-init.mp4', route => {
    capturedRange = route.request().headers()['range'] ?? null;
    route.fulfill({ contentType: 'video/mp4', body: INIT_BYTES });
  });

  await page.evaluate(async () => {
    const { VidelRepresentation } = await import('/dist/index.js');

    const mockMSB = {
      append: async (_bytes: ArrayBuffer) => {},
      get buffered() { return { length: 0, start: () => 0, end: () => 0 }; },
    };

    const rep = document.createElement('videl-representation') as any;
    rep.setAttribute('initialization-url', '/fixtures/range-init.mp4');
    rep.setAttribute('initialization-byte-range', '0-1234');
    rep.sourceBuffer = mockMSB;
    document.body.appendChild(rep);

    rep.setAttribute('videl-state', 'next');
    await new Promise<void>(r => setTimeout(r, 400));
  });

  expect(capturedRange).toBe('bytes=0-1234');
});

test('criterion 7 — deactivation cascades synchronously to all child segments', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { VidelRepresentation } = await import('/dist/index.js');

    const mockMSB = {
      append: async (_bytes: ArrayBuffer) => {},
      get buffered() { return { length: 0, start: () => 0, end: () => 0 }; },
    };

    const rep = document.createElement('videl-representation') as any;
    rep.setAttribute('initialization-url', '/fixtures/video-init.mp4');
    rep.sourceBuffer = mockMSB;
    document.body.appendChild(rep);

    const segs = [0, 5].map(t => {
      const s = document.createElement('videl-segment') as any;
      s.setAttribute('start-time', String(t));
      s.setAttribute('duration', '5');
      s.setAttribute('url', '/fixtures/seg-0.mp4');
      rep.appendChild(s);
      return s;
    });

    rep.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 400));

    rep.videlUpdate({
      currentTime: 0, currentWallTime: 0, bandwidth: 1e6, playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    // Verify slots set.
    const before = segs.map((s: any) => s.getAttribute('videl-state'));

    // Deactivate the representation — check synchronously.
    rep.removeAttribute('videl-state');

    const after = segs.map((s: any) => s.getAttribute('videl-state'));
    return { before, after };
  });

  expect(result.before[0]).toBe('active');
  expect(result.before[1]).toBe('next');
  expect(result.after[0]).toBeNull();
  expect(result.after[1]).toBeNull();
});

test('criterion 8 — videl:done from child does NOT advance to next segment', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { VidelRepresentation } = await import('/dist/index.js');

    const mockMSB = {
      append: async (_bytes: ArrayBuffer) => {},
      get buffered() { return { length: 0, start: () => 0, end: () => 0 }; },
    };

    const rep = document.createElement('videl-representation') as any;
    rep.setAttribute('initialization-url', '/fixtures/video-init.mp4');
    rep.sourceBuffer = mockMSB;
    document.body.appendChild(rep);

    const segs = [0, 5, 10].map(t => {
      const s = document.createElement('videl-segment') as any;
      s.setAttribute('start-time', String(t));
      s.setAttribute('duration', '5');
      s.setAttribute('url', '/fixtures/seg-0.mp4');
      rep.appendChild(s);
      return s;
    });

    rep.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 400));

    rep.videlUpdate({
      currentTime: 0, currentWallTime: 0, bandwidth: 1e6, playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    const afterUpdate = segs.map((s: any) => s.getAttribute('videl-state'));

    // Fire videl:done from the active segment — representation must not react.
    segs[0].dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true,
      detail: { startTime: 0, duration: 5 },
    }));

    // Give any microtasks time to run.
    await new Promise<void>(r => setTimeout(r, 50));

    const afterDone = segs.map((s: any) => s.getAttribute('videl-state'));
    return { afterUpdate, afterDone };
  });

  // After update: seg 0 active, seg 1 next.
  expect(result.afterUpdate[0]).toBe('active');
  expect(result.afterUpdate[1]).toBe('next');

  // After videl:done: NO change — update() drives advancement, not events.
  expect(result.afterDone[0]).toBe('active');
  expect(result.afterDone[1]).toBe('next');
});

// ===========================================================================
// Init segment re-append on rendition switch (ADR-0001)
//
// When the SourceBuffer is shared across representations in an AdaptationSet
// and a rendition switch occurs, the incoming representation MUST re-send its
// init segment before appending any media segments — even if it was previously
// active.  Skipping the re-send leaves the SourceBuffer configured for the
// intermediate representation's codec/dimensions, causing MSE errors.
// ===========================================================================

test('init segment is re-fetched after deactivation — even if it was appended before', async ({ page }) => {
  // Track how many times the init URL is requested.
  let initFetchCount = 0;
  await page.route('**/fixtures/video-init.mp4', async route => {
    initFetchCount++;
    await route.fulfill({ contentType: 'video/mp4', body: INIT_BYTES });
  });

  const result = await page.evaluate(async () => {
    const { VidelRepresentation } = await import('/dist/index.js');

    const mockMSB = {
      append: async (_bytes: ArrayBuffer) => {},
      get buffered() { return { length: 0, start: () => 0, end: () => 0 }; },
    };

    const rep = document.createElement('videl-representation') as any;
    rep.setAttribute('initialization-url', '/fixtures/video-init.mp4');
    rep.sourceBuffer = mockMSB;
    document.body.appendChild(rep);

    // First activation — init should be fetched.
    rep.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 400));
    const initAppendedAfterFirst = rep._initAppended ?? 'unknown';

    // Deactivate.
    rep.removeAttribute('videl-state');
    await new Promise<void>(r => setTimeout(r, 50));

    // Second activation — init must be re-fetched, not skipped.
    rep.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 400));

    return { initAppendedAfterFirst };
  });

  // The init segment should have been fetched TWICE — once per activation.
  expect(initFetchCount).toBe(2);
});

test('rendition A→B→A switch: each activation re-sends init to shared SourceBuffer', async ({ page }) => {
  // Two separate init URLs, one per rendition.
  let initACalls = 0;
  let initBCalls = 0;
  await page.route('**/fixtures/init-a.mp4', async route => {
    initACalls++;
    await route.fulfill({ contentType: 'video/mp4', body: INIT_BYTES });
  });
  await page.route('**/fixtures/init-b.mp4', async route => {
    initBCalls++;
    await route.fulfill({ contentType: 'video/mp4', body: INIT_BYTES });
  });

  await page.evaluate(async () => {
    const { VidelAdaptationSet } = await import('/dist/index.js');

    const mockMSB = {
      changeTypeCalls: [] as string[],
      changeType(type: string) { this.changeTypeCalls.push(type); },
      abort() { return Promise.resolve(); },
      append: async (_bytes: ArrayBuffer) => {},
      get buffered() { return { length: 0, start: () => 0, end: () => 0 }; },
    };

    const ads = document.createElement('videl-adaptation-set') as any;
    ads.setAttribute('content-type', 'video');
    ads.setAttribute('mime-type', 'video/mp4');
    ads.setAttribute('codecs', 'avc1.64001e');
    document.body.appendChild(ads);

    // Two representations at different bitrates.
    const repA = document.createElement('videl-representation') as any;
    repA.setAttribute('dash-id', 'rep-a');
    repA.setAttribute('bandwidth', '500000');
    repA.setAttribute('initialization-url', '/fixtures/init-a.mp4');
    repA.setAttribute('mime-type', 'video/mp4');
    repA.setAttribute('codecs', 'avc1.64001e');

    const repB = document.createElement('videl-representation') as any;
    repB.setAttribute('dash-id', 'rep-b');
    repB.setAttribute('bandwidth', '2000000');
    repB.setAttribute('initialization-url', '/fixtures/init-b.mp4');
    repB.setAttribute('mime-type', 'video/mp4');
    repB.setAttribute('codecs', 'avc1.64001e');

    ads.appendChild(repA);
    ads.appendChild(repB);

    ads.sourceBuffer = mockMSB;
    ads.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 50));

    // Step 1: low bandwidth → selects rep-a.
    ads.videlUpdate({
      bandwidth: 600_000, currentTime: 0, playbackRate: 1, bufferAhead: 30,
      buffered: { length: 0, start: () => 0, end: () => 0 },
      sourceBuffered: new Map(),
    });
    await new Promise<void>(r => setTimeout(r, 500)); // wait for rep-a init

    // Step 2: high bandwidth → switches to rep-b.
    ads.videlUpdate({
      bandwidth: 5_000_000, currentTime: 0, playbackRate: 1, bufferAhead: 30,
      buffered: { length: 0, start: () => 0, end: () => 0 },
      sourceBuffered: new Map(),
    });
    await new Promise<void>(r => setTimeout(r, 500)); // wait for rep-b init

    // Step 3: bandwidth drops → switches back to rep-a.
    ads.videlUpdate({
      bandwidth: 600_000, currentTime: 0, playbackRate: 1, bufferAhead: 30,
      buffered: { length: 0, start: () => 0, end: () => 0 },
      sourceBuffered: new Map(),
    });
    await new Promise<void>(r => setTimeout(r, 500)); // wait for rep-a init again
  });

  // Each time a representation becomes active its init must be fetched.
  // rep-a is activated twice (step 1 and step 3).
  expect(initACalls).toBe(2);
  // rep-b is activated once (step 2).
  expect(initBCalls).toBe(1);
});
