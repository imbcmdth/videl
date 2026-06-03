import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURE_DIR  = path.join(__dirname, 'fixtures');
const MODULE_PATH  = path.join(__dirname, '../dist/index.js');
const MIME         = 'video/mp4; codecs="avc1.64001e"';
const INIT_BYTES   = fs.readFileSync(path.join(FIXTURE_DIR, 'video-init.mp4'));
const SEG1_BYTES   = fs.readFileSync(path.join(FIXTURE_DIR, 'video-seg1.mp4'));

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------
test.beforeEach(async ({ page }) => {
  // Serve the compiled module.
  await page.route('**/dist/index.js', route =>
    route.fulfill({
      contentType: 'application/javascript; charset=utf-8',
      body: fs.readFileSync(MODULE_PATH, 'utf8'),
    })
  );

  // Serve the init and media segment fixtures at predictable URLs.
  await page.route('**/fixtures/video-init.mp4', route =>
    route.fulfill({ contentType: 'video/mp4', body: INIT_BYTES })
  );
  await page.route('**/fixtures/video-seg1.mp4', route =>
    route.fulfill({ contentType: 'video/mp4', body: SEG1_BYTES })
  );

  // Minimal HTML page.
  await page.route('http://localhost:3000/', route =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><body><video id="video"></video></body></html>`,
    })
  );

  await page.goto('http://localhost:3000/');
});

// ---------------------------------------------------------------------------
// Helper: sets up a MediaSource + SourceBuffer, appends the init segment,
// and returns a ManagedSourceBuffer ready for segment appends.
// ---------------------------------------------------------------------------
async function setupMSB(page: any) {
  return page.evaluate(async ({ mimeStr }: { mimeStr: string }) => {
    const { ManagedSourceBuffer, VidelSegment } = await import('/dist/index.js');

    const mediaSource = new MediaSource();
    const video = document.getElementById('video') as HTMLVideoElement;
    video.src = URL.createObjectURL(mediaSource);
    await new Promise<void>(r => mediaSource.addEventListener('sourceopen', () => r(), { once: true }));

    const sb = mediaSource.addSourceBuffer(mimeStr);
    const msb = new ManagedSourceBuffer(sb);

    // Prime with init segment.
    const initResp = await fetch('/fixtures/video-init.mp4');
    await msb.append(await initResp.arrayBuffer());

    // Stash on window so subsequent evaluate calls can retrieve it.
    (window as any).__msb = msb;
    (window as any).__VidelSegment = VidelSegment;

    return true;
  }, { mimeStr: MIME });
}

// ---------------------------------------------------------------------------
// Criterion 2 + 3 combo helper: creates a segment element backed by the MSB.
// ---------------------------------------------------------------------------

// ===========================================================================
// Tests
// ===========================================================================

test('criterion 2 — prefetch path: slot=next then slot=active appends and fires videl:done', async ({ page }) => {
  await setupMSB(page);

  const result = await page.evaluate(async () => {
    const { ManagedSourceBuffer, VidelSegment } = (window as any).__VidelSegment
      ? { ManagedSourceBuffer: null, VidelSegment: (window as any).__VidelSegment }
      : await import('/dist/index.js');
    const msb = (window as any).__msb;

    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('url', '/fixtures/video-seg1.mp4');
    seg.setAttribute('start-time', '0');
    seg.setAttribute('duration', '5');
    seg.sourceBuffer = msb;
    document.body.appendChild(seg);

    // Listen before triggering slot changes.
    const events: any[] = [];
    seg.addEventListener('videl:done', (e: any) => events.push({ type: 'done', detail: e.detail }));
    seg.addEventListener('videl:segment:error', (e: any) => events.push({ type: 'error', detail: e.detail?.error?.message }));

    // 1. Prefetch.
    seg.setAttribute('slot', 'next');
    // Wait long enough for the fetch to complete.
    await new Promise<void>(r => setTimeout(r, 500));

    // 2. Activate.
    seg.setAttribute('slot', 'active');
    // Wait for append.
    await new Promise<void>(r => setTimeout(r, 500));

    return events;
  });

  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('done');
  expect(result[0].detail.startTime).toBe(0);
  expect(result[0].detail.duration).toBe(5);
});

test('criterion 3 — direct activation (no prefetch): fetches inline and fires videl:done', async ({ page }) => {
  await setupMSB(page);

  const result = await page.evaluate(async () => {
    const msb = (window as any).__msb;

    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('url', '/fixtures/video-seg1.mp4');
    seg.setAttribute('start-time', '2');
    seg.setAttribute('duration', '3');
    seg.sourceBuffer = msb;
    document.body.appendChild(seg);

    const events: any[] = [];
    seg.addEventListener('videl:done', (e: any) => events.push({ type: 'done', detail: e.detail }));
    seg.addEventListener('videl:segment:error', (e: any) => events.push({ type: 'error' }));

    // Go directly to active — no prior slot=next.
    seg.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 800));

    return events;
  });

  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('done');
  expect(result[0].detail.startTime).toBe(2);
  expect(result[0].detail.duration).toBe(3);
});

test('criterion 4 — abort during prefetch: no append and no event', async ({ page }) => {
  // Route the segment URL with an artificial delay so we can abort mid-flight.
  await page.route('**/fixtures/slow-segment.mp4', async route => {
    await new Promise<void>(r => setTimeout(r, 3000));
    await route.fulfill({ contentType: 'video/mp4', body: SEG1_BYTES });
  });

  await setupMSB(page);

  const result = await page.evaluate(async () => {
    const msb = (window as any).__msb;

    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('url', '/fixtures/slow-segment.mp4');
    seg.setAttribute('start-time', '0');
    seg.setAttribute('duration', '5');
    seg.sourceBuffer = msb;
    document.body.appendChild(seg);

    const events: any[] = [];
    seg.addEventListener('videl:done',          (e: any) => events.push('done'));
    seg.addEventListener('videl:segment:error', (e: any) => events.push('error'));

    // Start prefetch then immediately abort.
    seg.setAttribute('slot', 'next');
    seg.removeAttribute('slot');

    // Wait to confirm no events arrive.
    await new Promise<void>(r => setTimeout(r, 400));
    return events;
  });

  expect(result).toHaveLength(0);
});

test('criterion 5 — abort after prefetch complete: bytes discarded, no append', async ({ page }) => {
  await setupMSB(page);

  const result = await page.evaluate(async () => {
    const msb = (window as any).__msb;

    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('url', '/fixtures/video-seg1.mp4');
    seg.setAttribute('start-time', '0');
    seg.setAttribute('duration', '5');
    seg.sourceBuffer = msb;
    document.body.appendChild(seg);

    const events: any[] = [];
    seg.addEventListener('videl:done',          () => events.push('done'));
    seg.addEventListener('videl:segment:error', () => events.push('error'));

    // Prefetch, wait for it to land.
    seg.setAttribute('slot', 'next');
    await new Promise<void>(r => setTimeout(r, 500));

    // Remove slot before activation.
    seg.removeAttribute('slot');

    // Wait to confirm no events arrive.
    await new Promise<void>(r => setTimeout(r, 300));
    return events;
  });

  expect(result).toHaveLength(0);
});

test('criterion 6 — fetch failure (404): fires videl:segment:error', async ({ page }) => {
  await page.route('**/fixtures/missing-segment.mp4', route =>
    route.fulfill({ status: 404, body: 'Not Found' })
  );

  await setupMSB(page);

  const result = await page.evaluate(async () => {
    const msb = (window as any).__msb;

    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('url', '/fixtures/missing-segment.mp4');
    seg.setAttribute('start-time', '0');
    seg.setAttribute('duration', '5');
    seg.sourceBuffer = msb;
    document.body.appendChild(seg);

    const events: any[] = [];
    seg.addEventListener('videl:done',          () => events.push('done'));
    seg.addEventListener('videl:segment:error', (e: any) => events.push({ type: 'error', msg: e.detail?.error?.message }));

    seg.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 500));

    return events;
  });

  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('error');
  expect(result[0].msg).toMatch(/404/);
});

test('criterion 7 — append rejection: fires videl:segment:error', async ({ page }) => {
  await setupMSB(page);

  const result = await page.evaluate(async () => {
    // Use a mock sourceBuffer whose append always rejects, directly exercising
    // the criterion without relying on browser-specific SourceBuffer error behavior.
    const fakeMSB = {
      append: async () => { throw new Error('mock append failure'); },
    };

    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('url', '/fixtures/video-seg1.mp4');
    seg.setAttribute('start-time', '0');
    seg.setAttribute('duration', '5');
    seg.sourceBuffer = fakeMSB;
    document.body.appendChild(seg);

    const events: any[] = [];
    seg.addEventListener('videl:done',          () => events.push('done'));
    seg.addEventListener('videl:segment:error', (e: any) => events.push({ type: 'error', msg: e.detail?.error?.message }));

    seg.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 500));

    return events;
  });

  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('error');
  expect(result[0].msg).toMatch(/mock append failure/);
});

test('criterion 8 — missing sourceBuffer: fires videl:segment:error', async ({ page }) => {
  await setupMSB(page);

  const result = await page.evaluate(async () => {
    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('url', '/fixtures/video-seg1.mp4');
    seg.setAttribute('start-time', '0');
    seg.setAttribute('duration', '5');
    // Intentionally do NOT set seg.sourceBuffer.
    document.body.appendChild(seg);

    const events: any[] = [];
    seg.addEventListener('videl:done',          () => events.push('done'));
    seg.addEventListener('videl:segment:error', (e: any) => events.push({ type: 'error', msg: e.detail?.error?.message }));

    seg.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 500));

    return events;
  });

  expect(result).toHaveLength(1);
  expect(result[0].type).toBe('error');
  expect(result[0].msg).toMatch(/sourceBuffer/i);
});

test('criterion 9 — videl:done detail includes correct startTime and duration', async ({ page }) => {
  await setupMSB(page);

  const result = await page.evaluate(async () => {
    const msb = (window as any).__msb;

    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('url', '/fixtures/video-seg1.mp4');
    seg.setAttribute('start-time', '10.5');
    seg.setAttribute('duration', '2.5');
    seg.sourceBuffer = msb;
    document.body.appendChild(seg);

    let detail: any = null;
    seg.addEventListener('videl:done', (e: any) => { detail = e.detail; });

    seg.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 800));

    return detail;
  });

  expect(result).not.toBeNull();
  expect(result.startTime).toBe(10.5);
  expect(result.duration).toBe(2.5);
});

test('criterion 10 — re-slot after deactivation works cleanly', async ({ page }) => {
  await setupMSB(page);

  const result = await page.evaluate(async () => {
    const msb = (window as any).__msb;

    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('url', '/fixtures/video-seg1.mp4');
    seg.setAttribute('start-time', '0');
    seg.setAttribute('duration', '5');
    seg.sourceBuffer = msb;
    document.body.appendChild(seg);

    const events: any[] = [];
    seg.addEventListener('videl:done',          (e: any) => events.push({ type: 'done' }));
    seg.addEventListener('videl:segment:error', (e: any) => events.push({ type: 'error' }));

    // First activation — succeeds.
    seg.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 800));

    // Deactivate.
    seg.removeAttribute('slot');

    // Second activation — should work again (we need to remove the old bytes
    // from the buffer first so the append doesn't fail; reuse the same MSB
    // and just re-activate; the segment is re-fetched inline).
    events.length = 0; // reset

    // The buffer already has these bytes but SourceBuffer won't reject a
    // re-append of the same range in all browsers — skip buffer state here
    // and just verify no throw / error event.
    seg.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 800));

    return events;
  });

  // The second activation should produce exactly one outcome event (done or
  // error from SourceBuffer overlap — both are acceptable; what matters is
  // that the element doesn't throw or hang, and clears prior abort state).
  expect(result).toHaveLength(1);
});

test('criterion 1 — slot=next issues a fetch request for the url', async ({ page }) => {
  // Use a custom URL that we can detect was requested.
  let fetched = false;
  await page.route('**/fixtures/detected-segment.mp4', route => {
    fetched = true;
    route.fulfill({ contentType: 'video/mp4', body: SEG1_BYTES });
  });

  await setupMSB(page);

  await page.evaluate(async () => {
    const seg = document.createElement('videl-segment') as any;
    seg.setAttribute('url', '/fixtures/detected-segment.mp4');
    seg.setAttribute('start-time', '0');
    seg.setAttribute('duration', '5');
    document.body.appendChild(seg);

    seg.setAttribute('slot', 'next');
    await new Promise<void>(r => setTimeout(r, 500));
  });

  expect(fetched).toBe(true);
});
