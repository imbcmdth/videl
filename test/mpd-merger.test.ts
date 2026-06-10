/**
 * applyMpdUpdate() — unit tests.
 *
 * Tests the pure DOM merger function that applies a freshly-parsed MPD tree
 * onto an existing live <videl-presentation> element tree. All assertions run
 * in the browser context against real DOM elements.
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

test.describe('applyMpdUpdate', () => {

  // ── Top-level attribute passthrough ───────────────────────────────────────

  test('updates top-level attributes from the new tree', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      existing.setAttribute('type', 'dynamic');
      existing.setAttribute('minimum-update-period', '5');
      existing.setAttribute('publish-time', '1000');

      const newTree = document.createElement('videl-presentation');
      newTree.setAttribute('type', 'dynamic');
      newTree.setAttribute('minimum-update-period', '10');
      newTree.setAttribute('publish-time', '2000');

      const changed = applyMpdUpdate(existing, newTree);
      return {
        changed,
        mup: existing.getAttribute('minimum-update-period'),
        pt:  existing.getAttribute('publish-time'),
      };
    })()`);

    expect((result as any).changed).toBe(true);
    expect((result as any).mup).toBe('10');
    expect((result as any).pt).toBe('2000');
  });

  test('removes top-level attribute when absent from new tree', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      existing.setAttribute('type', 'dynamic');
      existing.setAttribute('no-seek', '');

      const newTree = document.createElement('videl-presentation');
      newTree.setAttribute('type', 'dynamic');

      const changed = applyMpdUpdate(existing, newTree);
      return { changed, hasNoSeek: existing.hasAttribute('no-seek') };
    })()`);

    expect((result as any).changed).toBe(true);
    expect((result as any).hasNoSeek).toBe(false);
  });

  test('returns false when nothing changed', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      existing.setAttribute('type', 'dynamic');
      existing.setAttribute('publish-time', '1000');

      const newTree = document.createElement('videl-presentation');
      newTree.setAttribute('type', 'dynamic');
      newTree.setAttribute('publish-time', '1000');

      const changed = applyMpdUpdate(existing, newTree);
      return { changed };
    })()`);

    expect((result as any).changed).toBe(false);
  });

  // ── Period append ──────────────────────────────────────────────────────────

  test('appends new period from new tree, preserving existing period reference', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      const p1 = document.createElement('videl-period');
      p1.setAttribute('dash-id', 'P1');
      existing.appendChild(p1);

      const newTree = document.createElement('videl-presentation');
      const np1 = document.createElement('videl-period');
      np1.setAttribute('dash-id', 'P1');
      const np2 = document.createElement('videl-period');
      np2.setAttribute('dash-id', 'P2');
      newTree.appendChild(np1);
      newTree.appendChild(np2);

      const changed = applyMpdUpdate(existing, newTree);
      const periods = Array.from(existing.children)
        .filter(c => c.tagName.toLowerCase() === 'videl-period')
        .map(c => c.getAttribute('dash-id'));

      const p1IsSame = existing.children[0] === p1;
      return { changed, periods, p1IsSame };
    })()`);

    expect((result as any).changed).toBe(true);
    expect((result as any).periods).toEqual(['P1', 'P2']);
    expect((result as any).p1IsSame).toBe(true);
  });

  // ── Period attribute update ────────────────────────────────────────────────

  test('updates duration on existing period (live-edge fill-in)', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      const p1 = document.createElement('videl-period');
      p1.setAttribute('dash-id', 'P1');
      existing.appendChild(p1);

      const newTree = document.createElement('videl-presentation');
      const np1 = document.createElement('videl-period');
      np1.setAttribute('dash-id', 'P1');
      np1.setAttribute('duration', '10');
      newTree.appendChild(np1);

      const changed = applyMpdUpdate(existing, newTree);
      const dur = existing.querySelector('videl-period').getAttribute('duration');
      return { changed, dur };
    })()`);

    expect((result as any).changed).toBe(true);
    expect((result as any).dur).toBe('10');
  });

  // ── Segment append ─────────────────────────────────────────────────────────

  test('appends new segment to existing representation', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      const p1 = document.createElement('videl-period');
      p1.setAttribute('dash-id', 'P1');
      const ads = document.createElement('videl-adaptation-set');
      ads.setAttribute('content-type', 'video');
      const rep = document.createElement('videl-representation');
      rep.setAttribute('dash-id', 'R1');
      const seg0 = document.createElement('videl-segment');
      seg0.setAttribute('url', 'seg0.m4v');
      const seg1 = document.createElement('videl-segment');
      seg1.setAttribute('url', 'seg1.m4v');
      rep.appendChild(seg0);
      rep.appendChild(seg1);
      ads.appendChild(rep);
      p1.appendChild(ads);
      existing.appendChild(p1);

      const newTree = document.createElement('videl-presentation');
      const np1 = document.createElement('videl-period');
      np1.setAttribute('dash-id', 'P1');
      const nads = document.createElement('videl-adaptation-set');
      nads.setAttribute('content-type', 'video');
      const nrep = document.createElement('videl-representation');
      nrep.setAttribute('dash-id', 'R1');
      ['seg0.m4v', 'seg1.m4v', 'seg2.m4v'].forEach(function(u) {
        const s = document.createElement('videl-segment');
        s.setAttribute('url', u);
        nrep.appendChild(s);
      });
      nads.appendChild(nrep);
      np1.appendChild(nads);
      newTree.appendChild(np1);

      const changed = applyMpdUpdate(existing, newTree);
      const repEl = existing.querySelector('videl-representation');
      const urls = Array.from(repEl.querySelectorAll('videl-segment')).map(function(s) {
        return s.getAttribute('url');
      });
      const seg0Same = repEl.children[0] === seg0;
      const seg1Same = repEl.children[1] === seg1;
      return { changed, urls, seg0Same, seg1Same };
    })()`);

    expect((result as any).changed).toBe(true);
    expect((result as any).urls).toEqual(['seg0.m4v', 'seg1.m4v', 'seg2.m4v']);
    expect((result as any).seg0Same).toBe(true);
    expect((result as any).seg1Same).toBe(true);
  });

  // ── Stale segment removal ──────────────────────────────────────────────────

  test('removes unfetched stale segments absent from new manifest', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      const p1 = document.createElement('videl-period');
      p1.setAttribute('dash-id', 'P1');
      const ads = document.createElement('videl-adaptation-set');
      ads.setAttribute('content-type', 'video');
      const rep = document.createElement('videl-representation');
      rep.setAttribute('dash-id', 'R1');
      const segOld = document.createElement('videl-segment');
      segOld.setAttribute('url', 'seg_old.m4v');
      const seg0 = document.createElement('videl-segment');
      seg0.setAttribute('url', 'seg0.m4v');
      rep.appendChild(segOld);
      rep.appendChild(seg0);
      ads.appendChild(rep);
      p1.appendChild(ads);
      existing.appendChild(p1);

      const newTree = document.createElement('videl-presentation');
      const np1 = document.createElement('videl-period');
      np1.setAttribute('dash-id', 'P1');
      const nads = document.createElement('videl-adaptation-set');
      nads.setAttribute('content-type', 'video');
      const nrep = document.createElement('videl-representation');
      nrep.setAttribute('dash-id', 'R1');
      const ns0 = document.createElement('videl-segment');
      ns0.setAttribute('url', 'seg0.m4v');
      nrep.appendChild(ns0);
      nads.appendChild(nrep);
      np1.appendChild(nads);
      newTree.appendChild(np1);

      const changed = applyMpdUpdate(existing, newTree);
      const repEl = existing.querySelector('videl-representation');
      const urls = Array.from(repEl.querySelectorAll('videl-segment')).map(function(s) {
        return s.getAttribute('url');
      });
      return { changed, urls };
    })()`);

    expect((result as any).changed).toBe(true);
    expect((result as any).urls).toEqual(['seg0.m4v']);
  });

  // ── Active segment preserved ───────────────────────────────────────────────

  test('preserves segments with videl-state even if absent from new manifest', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      const p1 = document.createElement('videl-period');
      p1.setAttribute('dash-id', 'P1');
      const ads = document.createElement('videl-adaptation-set');
      ads.setAttribute('content-type', 'video');
      const rep = document.createElement('videl-representation');
      rep.setAttribute('dash-id', 'R1');
      const seg0 = document.createElement('videl-segment');
      seg0.setAttribute('url', 'seg0.m4v');
      seg0.setAttribute('videl-state', 'active');
      rep.appendChild(seg0);
      ads.appendChild(rep);
      p1.appendChild(ads);
      existing.appendChild(p1);

      const newTree = document.createElement('videl-presentation');
      const np1 = document.createElement('videl-period');
      np1.setAttribute('dash-id', 'P1');
      const nads = document.createElement('videl-adaptation-set');
      nads.setAttribute('content-type', 'video');
      const nrep = document.createElement('videl-representation');
      nrep.setAttribute('dash-id', 'R1');
      nads.appendChild(nrep);
      np1.appendChild(nads);
      newTree.appendChild(np1);

      applyMpdUpdate(existing, newTree);
      const repEl = existing.querySelector('videl-representation');
      const urls = Array.from(repEl.querySelectorAll('videl-segment')).map(function(s) {
        return s.getAttribute('url');
      });
      return { urls };
    })()`);

    expect((result as any).urls).toEqual(['seg0.m4v']);
  });

  // ── Event stream merge ────────────────────────────────────────────────────

  test('appends new event to existing event stream', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      const p1 = document.createElement('videl-period');
      p1.setAttribute('dash-id', 'P1');
      const es = document.createElement('videl-event-stream');
      es.setAttribute('scheme-id-uri', 'urn:example:events');
      const ev1 = document.createElement('videl-event');
      ev1.setAttribute('dash-id', 'E1');
      es.appendChild(ev1);
      p1.appendChild(es);
      existing.appendChild(p1);

      const newTree = document.createElement('videl-presentation');
      const np1 = document.createElement('videl-period');
      np1.setAttribute('dash-id', 'P1');
      const nes = document.createElement('videl-event-stream');
      nes.setAttribute('scheme-id-uri', 'urn:example:events');
      ['E1', 'E2'].forEach(function(id) {
        const ev = document.createElement('videl-event');
        ev.setAttribute('dash-id', id);
        nes.appendChild(ev);
      });
      np1.appendChild(nes);
      newTree.appendChild(np1);

      const changed = applyMpdUpdate(existing, newTree);
      const esEl = existing.querySelector('videl-event-stream');
      const ids = Array.from(esEl.querySelectorAll('videl-event')).map(function(e) {
        return e.getAttribute('dash-id');
      });
      const ev1Same = esEl.children[0] === ev1;
      return { changed, ids, ev1Same };
    })()`);

    expect((result as any).changed).toBe(true);
    expect((result as any).ids).toEqual(['E1', 'E2']);
    expect((result as any).ev1Same).toBe(true);
  });

  test('removes stale event absent from new stream', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      const p1 = document.createElement('videl-period');
      p1.setAttribute('dash-id', 'P1');
      const es = document.createElement('videl-event-stream');
      es.setAttribute('scheme-id-uri', 'urn:example:events');
      const evOld = document.createElement('videl-event');
      evOld.setAttribute('dash-id', 'E_old');
      const evKeep = document.createElement('videl-event');
      evKeep.setAttribute('dash-id', 'E_keep');
      es.appendChild(evOld);
      es.appendChild(evKeep);
      p1.appendChild(es);
      existing.appendChild(p1);

      const newTree = document.createElement('videl-presentation');
      const np1 = document.createElement('videl-period');
      np1.setAttribute('dash-id', 'P1');
      const nes = document.createElement('videl-event-stream');
      nes.setAttribute('scheme-id-uri', 'urn:example:events');
      const nev = document.createElement('videl-event');
      nev.setAttribute('dash-id', 'E_keep');
      nes.appendChild(nev);
      np1.appendChild(nes);
      newTree.appendChild(np1);

      const changed = applyMpdUpdate(existing, newTree);
      const esEl = existing.querySelector('videl-event-stream');
      const ids = Array.from(esEl.querySelectorAll('videl-event')).map(function(e) {
        return e.getAttribute('dash-id');
      });
      return { changed, ids };
    })()`);

    expect((result as any).changed).toBe(true);
    expect((result as any).ids).toEqual(['E_keep']);
  });

  test('preserves dispatched event (videl-state) absent from new stream', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      const p1 = document.createElement('videl-period');
      p1.setAttribute('dash-id', 'P1');
      const es = document.createElement('videl-event-stream');
      es.setAttribute('scheme-id-uri', 'urn:example:events');
      const evDispatched = document.createElement('videl-event');
      evDispatched.setAttribute('dash-id', 'E1');
      evDispatched.setAttribute('videl-state', 'active');
      es.appendChild(evDispatched);
      p1.appendChild(es);
      existing.appendChild(p1);

      const newTree = document.createElement('videl-presentation');
      const np1 = document.createElement('videl-period');
      np1.setAttribute('dash-id', 'P1');
      const nes = document.createElement('videl-event-stream');
      nes.setAttribute('scheme-id-uri', 'urn:example:events');
      np1.appendChild(nes);
      newTree.appendChild(np1);

      applyMpdUpdate(existing, newTree);
      const esEl = existing.querySelector('videl-event-stream');
      const ids = Array.from(esEl.querySelectorAll('videl-event')).map(function(e) {
        return e.getAttribute('dash-id');
      });
      return { ids };
    })()`);

    expect((result as any).ids).toEqual(['E1']);
  });

  test('appends entirely new event stream to an existing period', async ({ page }) => {
    const result = await page.evaluate(String.raw`(async () => {
      const { applyMpdUpdate } = await import('/dist/index.js');

      const existing = document.createElement('videl-presentation');
      const p1 = document.createElement('videl-period');
      p1.setAttribute('dash-id', 'P1');
      existing.appendChild(p1);

      const newTree = document.createElement('videl-presentation');
      const np1 = document.createElement('videl-period');
      np1.setAttribute('dash-id', 'P1');
      const nes = document.createElement('videl-event-stream');
      nes.setAttribute('scheme-id-uri', 'urn:example:events');
      const nev = document.createElement('videl-event');
      nev.setAttribute('dash-id', 'E1');
      nes.appendChild(nev);
      np1.appendChild(nes);
      newTree.appendChild(np1);

      const changed = applyMpdUpdate(existing, newTree);
      const p1El = existing.querySelector('videl-period');
      const esEl = p1El ? p1El.querySelector('videl-event-stream') : null;
      return {
        changed,
        hasEs: esEl !== null,
        scheme: esEl ? esEl.getAttribute('scheme-id-uri') : null,
      };
    })()`);

    expect((result as any).changed).toBe(true);
    expect((result as any).hasEs).toBe(true);
    expect((result as any).scheme).toBe('urn:example:events');
  });

});
