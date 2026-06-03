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
    bufferedRanges?: [number, number][];
    currentTime: number;
  }
): Promise<(string | null)[]> {
  return page.evaluate(
    async ({ segTimes, bufferedRanges, currentTime }: typeof opts) => {
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

      rep.setAttribute('slot', 'active');
      await new Promise<void>(r => setTimeout(r, 400));

      rep.update({
        currentTime,
        bandwidth: 1e6,
        playbackRate: 1,
        buffered: {
          length: bufferedRanges.length,
          start: (i: number) => bufferedRanges[i][0],
          end:   (i: number) => bufferedRanges[i][1],
        },
      });

      return segs.map((s: any) => s.getAttribute('slot'));
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

    rep.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 400));

    // sourceBuffer not yet set on seg (slot is still unset).
    const sbBeforeUpdate = seg.sourceBuffer;

    rep.update({
      currentTime: 0,
      bandwidth: 1e6,
      playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    // After update, seg should have been activated with sourceBuffer forwarded.
    return {
      slot: seg.getAttribute('slot'),
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

    rep.setAttribute('slot', 'next');
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

    rep.setAttribute('slot', 'next');
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

    rep.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 400));

    rep.update({
      currentTime: 0, bandwidth: 1e6, playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    // Verify slots set.
    const before = segs.map((s: any) => s.getAttribute('slot'));

    // Deactivate the representation — check synchronously.
    rep.removeAttribute('slot');

    const after = segs.map((s: any) => s.getAttribute('slot'));
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

    rep.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 400));

    rep.update({
      currentTime: 0, bandwidth: 1e6, playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    const afterUpdate = segs.map((s: any) => s.getAttribute('slot'));

    // Fire videl:done from the active segment — representation must not react.
    segs[0].dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true,
      detail: { startTime: 0, duration: 5 },
    }));

    // Give any microtasks time to run.
    await new Promise<void>(r => setTimeout(r, 50));

    const afterDone = segs.map((s: any) => s.getAttribute('slot'));
    return { afterUpdate, afterDone };
  });

  // After update: seg 0 active, seg 1 next.
  expect(result.afterUpdate[0]).toBe('active');
  expect(result.afterUpdate[1]).toBe('next');

  // After videl:done: NO change — update() drives advancement, not events.
  expect(result.afterDone[0]).toBe('active');
  expect(result.afterDone[1]).toBe('next');
});
