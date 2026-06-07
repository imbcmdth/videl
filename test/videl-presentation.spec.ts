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
// Helpers
// ---------------------------------------------------------------------------

/** Build a presentation with N stub periods already attached. */
async function buildPresentation(page: any, opts: {
  src?: string;
  periodCount: number;
}) {
  return page.evaluate(async ({ src, periodCount }: typeof opts) => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    if (src) pres.setAttribute('src', src);
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    for (let i = 0; i < periodCount; i++) {
      const p = document.createElement('videl-period') as any;
      p.setAttribute('period-id', `period-${i}`);
      p.setAttribute('start', String(i * 10));
      p.setAttribute('duration', '10');
      pres.appendChild(p);
    }

    return true;
  }, opts);
}

// ===========================================================================
// Criterion 1 — first period gets slot=active on activation
// ===========================================================================
test('criterion 1 — first period receives slot=active when presentation is activated', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    const p0 = document.createElement('videl-period') as any;
    p0.setAttribute('period-id', 'p0');
    const p1 = document.createElement('videl-period') as any;
    p1.setAttribute('period-id', 'p1');
    pres.appendChild(p0);
    pres.appendChild(p1);

    pres.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    return {
      p0Slot: p0.getAttribute('videl-state'),
      p1Slot: p1.getAttribute('videl-state'),
    };
  });

  expect(result.p0Slot).toBe('active');
  expect(result.p1Slot).toBeNull();
});

// ===========================================================================
// Criterion 3 — videl:done from active period advances to the next period
// ===========================================================================
test('criterion 3 — videl:done from period 0 activates period 1', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    pres.setAttribute('src', 'test.mpd');
    document.body.appendChild(pres);

    const periods = [0, 1].map(i => {
      const p = document.createElement('videl-period') as any;
      p.setAttribute('period-id', `p${i}`);
      pres.appendChild(p);
      return p;
    });

    pres.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    // Period 0 signals completion.
    periods[0].dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true,
      detail: { periodId: 'p0' },
    }));

    await new Promise<void>(r => setTimeout(r, 10));

    return {
      p0Slot: periods[0].getAttribute('videl-state'),
      p1Slot: periods[1].getAttribute('videl-state'),
    };
  });

  expect(result.p0Slot).toBeNull();   // deactivated by SequentialMixin
  expect(result.p1Slot).toBe('active');
});

// ===========================================================================
// Criterion 4 — videl:done fires with { src } when last period completes
// ===========================================================================
// Criterion 4a — period videl:done does NOT fire a presentation-level videl:done.
// Period completion is an internal signal used only for period advancement.
// The presentation-level videl:done is fired by the player in response to the
// video element's 'ended' event — i.e. after endOfStream() and the playhead
// reaching the buffer end — not at "last segment fetched" time.
test('criterion 4 — period videl:done does NOT immediately fire presentation-level videl:done', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    pres.setAttribute('src', 'https://example.com/stream.mpd');
    document.body.appendChild(pres);

    const p0 = document.createElement('videl-period') as any;
    p0.setAttribute('period-id', 'p0');
    pres.appendChild(p0);

    const events: any[] = [];
    pres.addEventListener('videl:done', (e: any) => {
      if (e.target === pres) {
        events.push({ ...e.detail });
      }
    });

    pres.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    // Period signals completion — this is now an internal signal only.
    p0.dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true,
      detail:  { periodId: 'p0' },
    }));

    await new Promise<void>(r => setTimeout(r, 10));

    return events;
  });

  // The presentation must NOT fire videl:done when a period completes.
  // Presentation-level done is only fired by the player on video 'ended'.
  expect(result).toHaveLength(0);
});

// ===========================================================================
// Criterion 4 (no early fire) — videl:done does NOT fire while more periods remain
// ===========================================================================
test('criterion 4 (no early) — presentation videl:done does not fire while more periods remain', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    pres.setAttribute('src', 'test.mpd');
    document.body.appendChild(pres);

    const periods = [0, 1].map(i => {
      const p = document.createElement('videl-period') as any;
      p.setAttribute('period-id', `p${i}`);
      pres.appendChild(p);
      return p;
    });

    const presentationDoneEvents: any[] = [];
    pres.addEventListener('videl:done', (e: any) => {
      if (e.target === pres) presentationDoneEvents.push(e.detail);
    });

    pres.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    // Period 0 done — period 1 still exists.
    periods[0].dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true, detail: { periodId: 'p0' },
    }));
    await new Promise<void>(r => setTimeout(r, 10));

    return presentationDoneEvents;
  });

  expect(result).toHaveLength(0);
});

// ===========================================================================
// Criterion (descendant filtering) — videl:done from grandchild is ignored
// ===========================================================================
test('criterion — videl:done from a grandchild does not trigger period advancement', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    const p0 = document.createElement('videl-period') as any;
    p0.setAttribute('period-id', 'p0');
    const p1 = document.createElement('videl-period') as any;
    p1.setAttribute('period-id', 'p1');
    pres.appendChild(p0);
    pres.appendChild(p1);

    const grandchild = document.createElement('div');
    p0.appendChild(grandchild);

    pres.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    // Fire videl:done from a grandchild — must NOT trigger advancement.
    grandchild.dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true,
      detail: { startTime: 0, duration: 5 },
    }));
    await new Promise<void>(r => setTimeout(r, 10));

    return {
      p0Slot: p0.getAttribute('videl-state'),
      p1Slot: p1.getAttribute('videl-state'),
    };
  });

  // p0 should still be active; p1 untouched.
  expect(result.p0Slot).toBe('active');
  expect(result.p1Slot).toBeNull();
});

// ===========================================================================
// Criterion 5 — videlUpdate is forwarded to the active period
// ===========================================================================
test('criterion 5 — videlUpdate() is forwarded to the active period', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    const p0 = document.createElement('videl-period') as any;
    p0.setAttribute('period-id', 'p0');
    p0.setAttribute('start', '0');
    p0.setAttribute('duration', '30');
    pres.appendChild(p0);

    pres.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 50));

    // Patch videlUpdate AFTER Lit's update cycle.
    let capturedTime: number | null = null;
    p0.videlUpdate = (s: any) => { capturedTime = s.currentTime; };

    pres.videlUpdate({
      currentTime: 7, bandwidth: 1e6, playbackRate: 1,
      buffered: { length: 0, start: () => 0, end: () => 0 },
    });

    return { capturedTime };
  });

  expect(result.capturedTime).toBe(7);
});

// ===========================================================================
// Criterion 8 — deactivation cascades to the active period
// ===========================================================================
test('criterion 8 — removing slot deactivates the active period synchronously', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    const p0 = document.createElement('videl-period') as any;
    p0.setAttribute('period-id', 'p0');
    pres.appendChild(p0);

    pres.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 30));

    const slotBefore = p0.getAttribute('videl-state');

    // Deactivate synchronously.
    pres.removeAttribute('videl-state');
    const slotAfter = p0.getAttribute('videl-state');

    return { slotBefore, slotAfter };
  });

  expect(result.slotBefore).toBe('active');
  expect(result.slotAfter).toBeNull();
});

// ===========================================================================
// Criterion 6 — slot=next triggers an HTTP request to src (fetch hook present)
// Full population verification deferred to DEL-007 (parser integration).
// ===========================================================================
test('criterion 6 — slot=next with src triggers an HTTP fetch of the MPD URL', async ({ page }) => {
  let fetched = false;
  await page.route('**/test-stream.mpd', route => {
    fetched = true;
    route.fulfill({ contentType: 'text/xml', body: '<MPD/>' });
  });

  await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('src', '/test-stream.mpd');
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    pres.setAttribute('videl-state', 'next');
    await new Promise<void>(r => setTimeout(r, 300));
  });

  expect(fetched).toBe(true);
});

// ===========================================================================
// Criterion 7 — slot=active with src (and no children) triggers fetch inline
// ===========================================================================
test('criterion 7 — slot=active with src and no children triggers an HTTP fetch', async ({ page }) => {
  let fetched = false;
  await page.route('**/inline-stream.mpd', route => {
    fetched = true;
    route.fulfill({ contentType: 'text/xml', body: '<MPD/>' });
  });

  await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('src', '/inline-stream.mpd');
    pres.setAttribute('type', 'static');
    // No children — triggers inline fetch.
    document.body.appendChild(pres);

    pres.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 300));
  });

  expect(fetched).toBe(true);
});
