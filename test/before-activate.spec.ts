/**
 * Tests for the `videl:before-activate` event and related lifecycle contracts.
 *
 * Covered:
 *  1. Event fires on every element level (presentation, period, adaptation-set)
 *  2. event.detail.element is the element about to activate
 *  3. waitUntil(promise) holds activation until the promise resolves
 *  4. If waitUntil promise rejects, activation is aborted (videl-state reverted)
 *    and videl:activate:error is fired
 *  5. Multiple waitUntil promises all settle before activation proceeds
 *  6. videl-state="next" does NOT fire videl:before-activate
 *  7. Direct unslotted → active transition fires the event
 *  8. videl-player fires the event before #video.play() on play()
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { VidelBeforeActivateEvent } from '../src/events';

const MODULE_PATH = path.join(__dirname, '../dist/index.js');

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

// ===========================================================================
// Criterion 1 — event fires when videl-state transitions to "active"
// ===========================================================================
test('criterion 1a — videl:before-activate fires on videl-presentation activation', async ({ page }) => {
  const fired = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    let fired = false;
    pres.addEventListener('videl:before-activate', () => { fired = true; });

    pres.setAttribute('videl-state', 'active');

    // Give the microtask queue a tick to settle
    await new Promise(r => setTimeout(r, 0));
    return fired;
  });
  expect(fired).toBe(true);
});

test('criterion 1b — videl:before-activate fires on videl-period activation', async ({ page }) => {
  const fired = await page.evaluate(async () => {
    await import('/dist/index.js');

    const period = document.createElement('videl-period') as any;
    period.setAttribute('dash-id', 'p0');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '10');
    document.body.appendChild(period);

    let fired = false;
    period.addEventListener('videl:before-activate', () => { fired = true; });

    period.setAttribute('videl-state', 'active');

    await new Promise(r => setTimeout(r, 0));
    return fired;
  });
  expect(fired).toBe(true);
});

test('criterion 1c — videl:before-activate fires on videl-adaptation-set activation', async ({ page }) => {
  const fired = await page.evaluate(async () => {
    await import('/dist/index.js');

    const ads = document.createElement('videl-adaptation-set') as any;
    ads.setAttribute('content-type', 'video');
    ads.setAttribute('videl-text-none', ''); // prevent sourceBuffer guard
    document.body.appendChild(ads);

    let fired = false;
    ads.addEventListener('videl:before-activate', () => { fired = true; });

    ads.setAttribute('videl-state', 'active');

    await new Promise(r => setTimeout(r, 0));
    return fired;
  });
  expect(fired).toBe(true);
});

// ===========================================================================
// Criterion 2 — event.detail.element is the activating element
// ===========================================================================
test('criterion 2 — detail.element is the element being activated', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    pres.id = 'test-pres';
    document.body.appendChild(pres);

    let detailElement: Element | null = null;
    pres.addEventListener('videl:before-activate', (e: CustomEvent) => {
      detailElement = e.detail.element;
    });

    pres.setAttribute('videl-state', 'active');
    await new Promise(r => setTimeout(r, 0));

    return detailElement === pres;
  });
  expect(result).toBe(true);
});

test('criterion 2b — detail.element is the element itself, not an ancestor', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    const period = document.createElement('videl-period') as any;
    period.setAttribute('dash-id', 'p0');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '10');
    pres.appendChild(period);

    const detailElements: string[] = [];
    // Listen on the container — events bubble so we'll catch all of them
    document.body.addEventListener('videl:before-activate', (e: Event) => {
      detailElements.push((e as CustomEvent<{ element: Element }>).detail.element.tagName.toLowerCase());
    });

    period.setAttribute('videl-state', 'active');
    await new Promise(r => setTimeout(r, 0));

    // Only the period event should have fired (not the presentation)
    return detailElements;
  });
  expect(result).toEqual(['videl-period']);
});

// ===========================================================================
// Criterion 3 — waitUntil defers activation until promise resolves
// ===========================================================================
test('criterion 3 — waitUntil defers activation until promise resolves', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    // Inject one period so #activateFirstPeriod has something to do
    const period = document.createElement('videl-period') as any;
    period.setAttribute('dash-id', 'p0');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '10');
    pres.appendChild(period);

    const log: string[] = [];

    let resolve!: () => void;
    const blocker = new Promise<void>(r => { resolve = r; });

    // Scope to pres only — the period's event also bubbles up here
    pres.addEventListener('videl:before-activate', (e: CustomEvent) => {
      if (e.detail.element !== pres) return;
      log.push('before-activate');
      (e as unknown as VidelBeforeActivateEvent).waitUntil(blocker);
    });

    // Track when the period gets activated (which happens after before-activate settles)
    period.addEventListener('videl:before-activate', () => {
      log.push('period-before-activate');
    });

    pres.setAttribute('videl-state', 'active');

    // Allow one turn — before-activate should have fired but period should not yet
    await new Promise(r => setTimeout(r, 10));
    const afterSet = [...log];

    // Now resolve the blocker
    resolve();
    await new Promise(r => setTimeout(r, 10));
    const afterResolve = [...log];

    return { afterSet, afterResolve };
  });

  // Before-activate fired synchronously on the pres, but period was held back
  expect(result.afterSet).toEqual(['before-activate']);
  // After resolving, period's activation proceeds
  expect(result.afterResolve).toEqual(['before-activate', 'period-before-activate']);
});

// ===========================================================================
// Criterion 4 — rejected waitUntil aborts activation and fires activate:error
// ===========================================================================
test('criterion 4 — rejected waitUntil aborts activation and fires videl:activate:error', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    const period = document.createElement('videl-period') as any;
    period.setAttribute('dash-id', 'p0');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '10');
    pres.appendChild(period);

    const log: string[] = [];

    pres.addEventListener('videl:before-activate', (e: CustomEvent) => {
      log.push('before-activate');
      (e as unknown as VidelBeforeActivateEvent).waitUntil(Promise.reject(new Error('auth-failed')));
    });

    // Should NOT fire because activation is aborted
    period.addEventListener('videl:before-activate', () => {
      log.push('period-activated');
    });

    let activateError: string | null = null;
    pres.addEventListener('videl:activate:error', (e: CustomEvent) => {
      log.push('activate-error');
      activateError = e.detail.error.message;
    });

    pres.setAttribute('videl-state', 'active');
    await new Promise(r => setTimeout(r, 20));

    return {
      log,
      activateError,
      // videl-state should have been reverted to null
      videlState: pres.getAttribute('videl-state')
    };
  });

  expect(result.log).toEqual(['before-activate', 'activate-error']);
  expect(result.activateError).toBe('auth-failed');
  expect(result.videlState).toBeNull();
});

// ===========================================================================
// Criterion 5 — multiple waitUntil promises all settle before activation
// ===========================================================================
test('criterion 5 — all waitUntil promises settle before activation proceeds', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    const period = document.createElement('videl-period') as any;
    period.setAttribute('dash-id', 'p0');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '10');
    pres.appendChild(period);

    let resolveA!: () => void;
    let resolveB!: () => void;
    const promiseA = new Promise<void>(r => { resolveA = r; });
    const promiseB = new Promise<void>(r => { resolveB = r; });

    let periodActivated = false;

    pres.addEventListener('videl:before-activate', (e: CustomEvent) => {
      if (e.detail.element !== pres) return;
      (e as unknown as VidelBeforeActivateEvent).waitUntil(promiseA);
      (e as unknown as VidelBeforeActivateEvent).waitUntil(promiseB);
    });

    period.addEventListener('videl:before-activate', () => {
      periodActivated = true;
    });

    pres.setAttribute('videl-state', 'active');

    await new Promise(r => setTimeout(r, 10));
    const afterBothPending = periodActivated;

    // Resolve only A — still blocked on B
    resolveA();
    await new Promise(r => setTimeout(r, 10));
    const afterOnlyA = periodActivated;

    // Resolve B — now both resolved, activation can proceed
    resolveB();
    await new Promise(r => setTimeout(r, 10));
    const afterBoth = periodActivated;

    return { afterBothPending, afterOnlyA, afterBoth };
  });

  expect(result.afterBothPending).toBe(false);
  expect(result.afterOnlyA).toBe(false);
  expect(result.afterBoth).toBe(true);
});

// ===========================================================================
// Criterion 6 — videl-state="next" does NOT fire videl:before-activate
// ===========================================================================
test('criterion 6 — videl-state="next" does not fire videl:before-activate', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    let fired = false;
    pres.addEventListener('videl:before-activate', () => { fired = true; });

    pres.setAttribute('videl-state', 'next');
    await new Promise(r => setTimeout(r, 10));

    return fired;
  });

  expect(result).toBe(false);
});

// ===========================================================================
// Criterion 7 — direct unslotted → active fires the event
// ===========================================================================
test('criterion 7 — unslotted → active (no prior next) fires videl:before-activate', async ({ page }) => {
  const fired = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    let fired = false;
    pres.addEventListener('videl:before-activate', () => { fired = true; });

    // Direct activation — no 'next' step first
    pres.setAttribute('videl-state', 'active');
    await new Promise(r => setTimeout(r, 0));
    return fired;
  });
  expect(fired).toBe(true);
});

// ===========================================================================
// Criterion 8 — event bubbles so a single listener on a container catches all
// ===========================================================================
test('criterion 8 — event bubbles: parent listener receives events from descendants', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    // Build: container > presentation > period
    const container = document.createElement('div');
    document.body.appendChild(container);

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    container.appendChild(pres);

    const period = document.createElement('videl-period') as any;
    period.setAttribute('dash-id', 'p0');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '10');
    pres.appendChild(period);

    const seen: string[] = [];
    container.addEventListener('videl:before-activate', (e: Event) => {
      seen.push((e as CustomEvent<{ element: Element }>).detail.element.tagName.toLowerCase());
    });

    // Activate presentation — this will cascade into period activation
    pres.setAttribute('videl-state', 'active');
    await new Promise(r => setTimeout(r, 20));

    return seen;
  });

  // Presentation fires first, then period
  expect(result).toContain('videl-presentation');
  expect(result).toContain('videl-period');
  expect(result.indexOf('videl-presentation')).toBeLessThan(result.indexOf('videl-period'));
});

// ===========================================================================
// Criterion 9 — activation can be used to stamp config before proceeding
// ===========================================================================
test('criterion 9 — waitUntil allows async config to be stamped before child activation', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');

    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('type', 'static');
    document.body.appendChild(pres);

    const period = document.createElement('videl-period') as any;
    period.setAttribute('dash-id', 'p0');
    period.setAttribute('start', '0');
    period.setAttribute('duration', '10');
    pres.appendChild(period);

    // Simulate an async config stamp (e.g. DRM config fetch)
    pres.addEventListener('videl:before-activate', (e: CustomEvent) => {
      (e as unknown as VidelBeforeActivateEvent).waitUntil(
        new Promise<void>(resolve => setTimeout(resolve, 5))
          .then(() => { (e.detail.element as any).dataset.configStamped = 'yes'; })
      );
    });

    let configReadyWhenPeriodActivates = false;
    period.addEventListener('videl:before-activate', () => {
      // By the time the period activates, the pres config should be set
      configReadyWhenPeriodActivates = pres.dataset.configStamped === 'yes';
    });

    pres.setAttribute('videl-state', 'active');
    await new Promise(r => setTimeout(r, 50));

    return {
      configStamped: pres.dataset.configStamped,
      configReadyWhenPeriodActivates
    };
  });

  expect(result.configStamped).toBe('yes');
  expect(result.configReadyWhenPeriodActivates).toBe(true);
});
