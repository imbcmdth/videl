import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const MODULE_PATH = path.join(__dirname, '../dist/index.js');

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
    route.fulfill({
      contentType: 'text/html',
      body: `<!DOCTYPE html><html><body></body></html>`,
    })
  );
  await page.goto('http://localhost:3000/');
});

// ---------------------------------------------------------------------------
// Helpers used inside page.evaluate
// ---------------------------------------------------------------------------

/** Build a stub adaptation-set element (tracks slot and update() calls). */
const STUB_ADS = `
  function makeAds(contentType) {
    const el = document.createElement('videl-adaptation-set');
    el.setAttribute('content-type', contentType);
    el.setAttribute('mime-type', 'video/mp4');
    el.updateLog = [];
    el.videlUpdate = function(s) { this.updateLog.push({ currentTime: s.currentTime }); };
    return el;
  }
`;

/** Build a period element with the given attributes. */
const MAKE_PERIOD = `
  function makePeriod(periodId, start, duration) {
    const p = document.createElement('videl-period');
    p.setAttribute('period-id', periodId);
    p.setAttribute('start', String(start));
    if (duration !== undefined && duration !== null) {
      p.setAttribute('duration', String(duration));
    }
    document.body.appendChild(p);
    return p;
  }
`;

/** Build a default no-buffered PlayerState. */
const MAKE_STATE = `
  function makeState(currentTime, bandwidth) {
    return {
      currentTime: currentTime ?? 0,
      bandwidth:   bandwidth   ?? 1e6,
      playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    };
  }
`;

// ===========================================================================
// Criterion 1 — video + audio both activated simultaneously
// ===========================================================================
test('criterion 1 — video and audio adaptation sets are both activated on slot=active', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');
    eval(`${`
      function makeAds(contentType) {
        const el = document.createElement('videl-adaptation-set');
        el.setAttribute('content-type', contentType);
        return el;
      }
    `}`);

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'p0');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '30');
    document.body.appendChild(period);

    const video = document.createElement('videl-adaptation-set') as any;
    video.setAttribute('content-type', 'video');
    const audio = document.createElement('videl-adaptation-set') as any;
    audio.setAttribute('content-type', 'audio');

    period.appendChild(video);
    period.appendChild(audio);

    period.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    return {
      videoSlot: video.getAttribute('slot'),
      audioSlot: audio.getAttribute('slot'),
    };
  });

  expect(result.videoSlot).toBe('video-active');
  expect(result.audioSlot).toBe('audio-active');
});

// ===========================================================================
// Criterion 2 — text track also activated when present
// ===========================================================================
test('criterion 2 — video, audio, and text are all activated simultaneously', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'p0');
    period.setAttribute('start', '0');
    document.body.appendChild(period);

    const children: any[] = ['video', 'audio', 'text'].map(type => {
      const el = document.createElement('videl-adaptation-set') as any;
      el.setAttribute('content-type', type);
      period.appendChild(el);
      return el;
    });

    period.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    return children.map((c: any) => c.getAttribute('slot'));
  });

  expect(result[0]).toBe('video-active');
  expect(result[1]).toBe('audio-active');
  expect(result[2]).toBe('text-active');
});

// ===========================================================================
// Criterion 3 — only one adaptation set per content-type is active
// ===========================================================================
test('criterion 3 — only first video child is activated when two video children exist', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'p0');
    period.setAttribute('start', '0');
    document.body.appendChild(period);

    const v1 = document.createElement('videl-adaptation-set') as any;
    v1.setAttribute('content-type', 'video');
    const v2 = document.createElement('videl-adaptation-set') as any;
    v2.setAttribute('content-type', 'video');
    period.appendChild(v1);
    period.appendChild(v2);

    period.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    return {
      v1Slot: v1.getAttribute('slot'),
      v2Slot: v2.getAttribute('slot'),
    };
  });

  expect(result.v1Slot).toBe('video-active'); // first in DOM order
  expect(result.v2Slot).toBeNull();            // second stays unslotted
});

// ===========================================================================
// Criterion 3a — slot=next: one per content-type receives slot=*-next
// ===========================================================================
test('criterion 3a — slot=next preloads one adaptation set per content-type', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'p0');
    period.setAttribute('start', '0');
    document.body.appendChild(period);

    const video = document.createElement('videl-adaptation-set') as any;
    video.setAttribute('content-type', 'video');
    const audio = document.createElement('videl-adaptation-set') as any;
    audio.setAttribute('content-type', 'audio');
    period.appendChild(video);
    period.appendChild(audio);

    period.setAttribute('slot', 'next');
    await new Promise<void>(r => setTimeout(r, 30));

    return {
      videoSlot: video.getAttribute('slot'),
      audioSlot: audio.getAttribute('slot'),
    };
  });

  expect(result.videoSlot).toBe('video-next');
  expect(result.audioSlot).toBe('audio-next');
});

// ===========================================================================
// Criterion 3b — only one slot=next per content-type
// ===========================================================================
test('criterion 3b — second video child does not receive slot=next when first is already next', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'p0');
    period.setAttribute('start', '0');
    document.body.appendChild(period);

    const v1 = document.createElement('videl-adaptation-set') as any;
    v1.setAttribute('content-type', 'video');
    const v2 = document.createElement('videl-adaptation-set') as any;
    v2.setAttribute('content-type', 'video');
    period.appendChild(v1);
    period.appendChild(v2);

    period.setAttribute('slot', 'next');
    await new Promise<void>(r => setTimeout(r, 30));

    return {
      v1Slot: v1.getAttribute('slot'),
      v2Slot: v2.getAttribute('slot'),
    };
  });

  expect(result.v1Slot).toBe('video-next');
  expect(result.v2Slot).toBeNull();
});

// ===========================================================================
// Criterion 5 — update() fan-out to all active adaptation sets
// ===========================================================================
test('criterion 5 — update() is forwarded to all active adaptation sets', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'p0');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '60');
    document.body.appendChild(period);

    const children: any[] = ['video', 'audio'].map(type => {
      const el = document.createElement('videl-adaptation-set') as any;
      el.setAttribute('content-type', type);
      period.appendChild(el);
      return el;
    });

    period.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    // Patch videlUpdate on each child to record calls.
    children.forEach((el: any) => {
      el.updateLog = [];
      el.videlUpdate = (s: any) => { el.updateLog.push(s.currentTime); };
    });

    period.videlUpdate({
      currentTime: 5, bandwidth: 1e6, playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    return children.map((a: any) => a.updateLog);
  });

  // Both adaptation sets should have received the update with currentTime=5.
  expect(result[0]).toEqual([5]);
  expect(result[1]).toEqual([5]);
});

// ===========================================================================
// Criterion 6 — videl:done fires when currentTime >= start + duration
// ===========================================================================
test('criterion 6 — videl:done fires with periodId when period ends', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'my-period');
    period.setAttribute('start', '10');
    period.setAttribute('duration', '20'); // ends at t=30
    document.body.appendChild(period);

    const ads = document.createElement('videl-adaptation-set') as any;
    ads.setAttribute('content-type', 'video');
    ads.videlUpdate = () => {};
    period.appendChild(ads);

    period.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    const events: any[] = [];
    period.addEventListener('videl:done', (e: any) => events.push({ ...e.detail }));

    // Tick before end — no event.
    period.videlUpdate({
      currentTime: 29.9, bandwidth: 1e6, playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    // Tick at/past end — event fires.
    period.videlUpdate({
      currentTime: 30.1, bandwidth: 1e6, playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    // Additional tick — must NOT fire a second time.
    period.videlUpdate({
      currentTime: 35, bandwidth: 1e6, playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    return events;
  });

  expect(result).toHaveLength(1);
  expect(result[0].periodId).toBe('my-period');
});

// ===========================================================================
// Criterion 8 — videl:done (period-level) does NOT fire without duration
// ===========================================================================
test('criterion 8 — no videl:done when duration attribute is absent', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'open-ended');
    period.setAttribute('start', '0');
    // NO duration set
    document.body.appendChild(period);

    const ads = document.createElement('videl-adaptation-set') as any;
    ads.setAttribute('content-type', 'video');
    ads.videlUpdate = () => {};
    period.appendChild(ads);

    period.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    const events: any[] = [];
    period.addEventListener('videl:done', (e: any) => events.push(e.detail));

    // Pump far past any possible period end.
    period.videlUpdate({
      currentTime: 999_999, bandwidth: 1e6, playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    return events;
  });

  expect(result).toHaveLength(0);
});

// ===========================================================================
// Criterion 7 — deactivation cascades synchronously to all adaptation sets
// ===========================================================================
test('criterion 7 — removing slot deactivates all child adaptation sets synchronously', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'p0');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '30');
    document.body.appendChild(period);

    const ads: any[] = ['video', 'audio'].map(type => {
      const el = document.createElement('videl-adaptation-set') as any;
      el.setAttribute('content-type', type);
      period.appendChild(el);
      return el;
    });

    period.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    const before = ads.map((a: any) => a.getAttribute('slot'));

    // Deactivate synchronously.
    period.removeAttribute('slot');

    const after = ads.map((a: any) => a.getAttribute('slot'));
    return { before, after };
  });

  expect(result.before[0]).toBe('video-active');
  expect(result.before[1]).toBe('audio-active');
  expect(result.after[0]).toBeNull();
  expect(result.after[1]).toBeNull();
});

// ===========================================================================
// Criterion 9 — DOM order is playback order (no sorting by start attribute)
// ===========================================================================
test('criterion 9 — first child in DOM order is activated regardless of start attribute', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'p0');
    period.setAttribute('start', '0');
    document.body.appendChild(period);

    // Add two video adaptation-sets — second has a lower start value,
    // but the first in DOM order should always be chosen.
    const first = document.createElement('videl-adaptation-set') as any;
    first.setAttribute('content-type', 'video');
    first.setAttribute('id', 'first');
    const second = document.createElement('videl-adaptation-set') as any;
    second.setAttribute('content-type', 'video');
    second.setAttribute('id', 'second');

    period.appendChild(first);
    period.appendChild(second);

    period.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    return {
      firstSlot:  first.getAttribute('slot'),
      secondSlot: second.getAttribute('slot'),
    };
  });

  expect(result.firstSlot).toBe('video-active');
  expect(result.secondSlot).toBeNull();
});

// ===========================================================================
// Criterion 6 (once) — videl:done fires exactly once across multiple ticks
// ===========================================================================
test('criterion 6 (once) — videl:done fires exactly once even across many ticks past end', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('period-id', 'p-once');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '10');
    document.body.appendChild(period);

    const ads = document.createElement('videl-adaptation-set') as any;
    ads.setAttribute('content-type', 'video');
    ads.videlUpdate = () => {};
    period.appendChild(ads);

    period.setAttribute('slot', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    let fireCount = 0;
    period.addEventListener('videl:done', () => fireCount++);

    for (let t = 9; t <= 20; t++) {
      period.videlUpdate({
        currentTime: t, bandwidth: 1e6, playbackRate: 1,
        buffered: { length: 0, start: () => 0, end: () => 0 },
      });
    }

    return fireCount;
  });

  expect(result).toBe(1);
});
