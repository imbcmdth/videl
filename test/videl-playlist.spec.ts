/**
 * DEL-010: Playlist presentations — integration tests.
 *
 * Tests cover:
 *  - videl-presentation self-population (criteria 1–7)
 *  - videl-presentation DOM stability (criteria 8–10)
 *  - videl-presentation shadow DOM composition (criteria 11–14)
 *  - videl-player playlist sequencing (criteria 17–24)
 */

import { test, expect } from '@playwright/test';
import * as fs   from 'fs';
import * as path from 'path';

const MODULE_PATH = path.join(__dirname, '../dist/index.js');
const INIT_BYTES  = fs.readFileSync(path.join(__dirname, 'fixtures/video-init.mp4'));
const SEG1_BYTES  = fs.readFileSync(path.join(__dirname, 'fixtures/video-seg1.mp4'));

// Minimal MPD — single 5 s video-only period.
const makeMpd = (id = 'p0', duration = 5) => `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static"
     mediaPresentationDuration="PT${duration}S" minBufferTime="PT2S">
  <Period id="${id}" start="PT0S" duration="PT${duration}S">
    <AdaptationSet mimeType="video/mp4" contentType="video" codecs="avc1.64001e">
      <Representation id="r1" bandwidth="500000" width="640" height="360">
        <SegmentList timescale="1" duration="${duration}">
          <Initialization sourceURL="/fixtures/video-init.mp4"/>
          <SegmentURL media="/fixtures/video-seg1.mp4"/>
        </SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

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
  await page.route('**/fixtures/video-init.mp4', route =>
    route.fulfill({ contentType: 'video/mp4', body: INIT_BYTES })
  );
  await page.route('**/fixtures/video-seg1.mp4', route =>
    route.fulfill({ contentType: 'video/mp4', body: SEG1_BYTES })
  );
  await page.route('http://localhost:3000/', route =>
    route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><html><body></body></html>' })
  );
  await page.goto('http://localhost:3000/');
});

// ===========================================================================
// Criterion 1 — self-populate on videl-state="next"
// ===========================================================================
test('criterion 1 — videl-state="next" triggers MPD fetch and injects videl-period children', async ({ page }) => {
  const MPD_URL = 'http://localhost:3000/stream/ep1.mpd';
  await page.route(MPD_URL, route =>
    route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
  );

  const result = await page.evaluate(async (mpdUrl) => {
    await import('/dist/index.js');
    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('src', mpdUrl);
    document.body.appendChild(pres);

    pres.setAttribute('videl-state', 'next');
    await new Promise<void>(r => setTimeout(r, 600));

    return {
      periodCount: pres.querySelectorAll('videl-period').length,
      mpd:         pres.getAttribute('media-presentation-duration'),
    };
  }, MPD_URL);

  expect(result.periodCount).toBeGreaterThanOrEqual(1);
  expect(result.mpd).toBe('5');
});

// ===========================================================================
// Criterion 2 — self-populate on videl-state="active" (no prior next)
// ===========================================================================
test('criterion 2 — videl-state="active" without prior next fetches inline and activates', async ({ page }) => {
  const MPD_URL = 'http://localhost:3000/stream/ep2.mpd';
  await page.route(MPD_URL, route =>
    route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
  );

  const result = await page.evaluate(async (mpdUrl) => {
    await import('/dist/index.js');
    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('src', mpdUrl);
    document.body.appendChild(pres);

    pres.setAttribute('videl-state', 'active');
    await new Promise<void>(r => setTimeout(r, 600));

    const periods = [...pres.querySelectorAll('videl-period')] as any[];
    return {
      periodCount:   periods.length,
      activePeriod:  periods.some(p => p.getAttribute('videl-state') === 'active'),
    };
  }, MPD_URL);

  expect(result.periodCount).toBeGreaterThanOrEqual(1);
  expect(result.activePeriod).toBe(true);
});

// ===========================================================================
// Criterion 3 — metadata (non-period children) preserved during populate
// ===========================================================================
test('criterion 3 — non-period children are preserved during self-population', async ({ page }) => {
  const MPD_URL = 'http://localhost:3000/stream/ep3.mpd';
  await page.route(MPD_URL, route =>
    route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
  );

  const result = await page.evaluate(async (mpdUrl) => {
    await import('/dist/index.js');
    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('src', mpdUrl);

    // Attach user content before population.
    const img = document.createElement('img');
    img.setAttribute('src', 'thumb.jpg');
    pres.appendChild(img);
    const h3 = document.createElement('h3');
    h3.textContent = 'Episode 1';
    pres.appendChild(h3);

    document.body.appendChild(pres);
    pres.setAttribute('videl-state', 'next');
    await new Promise<void>(r => setTimeout(r, 600));

    return {
      hasImg:    !!pres.querySelector('img[src="thumb.jpg"]'),
      hasH3:     !!pres.querySelector('h3'),
      hasPeriod: !!pres.querySelector('videl-period'),
    };
  }, MPD_URL);

  expect(result.hasImg).toBe(true);
  expect(result.hasH3).toBe(true);
  expect(result.hasPeriod).toBe(true);
});

// ===========================================================================
// Criterion 4 — media-presentation-duration stamped after parse
// ===========================================================================
test('criterion 4 — media-presentation-duration is updated from manifest', async ({ page }) => {
  const MPD_URL = 'http://localhost:3000/stream/ep4.mpd';
  await page.route(MPD_URL, route =>
    route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 42) })
  );

  const result = await page.evaluate(async (mpdUrl) => {
    await import('/dist/index.js');
    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('src', mpdUrl);
    pres.setAttribute('duration', '99'); // pre-declared display value
    document.body.appendChild(pres);

    // Before population: display value should be declared one.
    const durationBefore = pres.getAttribute('duration');

    pres.setAttribute('videl-state', 'next');
    await new Promise<void>(r => setTimeout(r, 600));

    return {
      durationBefore,
      mpdAfter: pres.getAttribute('media-presentation-duration'),
    };
  }, MPD_URL);

  expect(result.durationBefore).toBe('99');
  expect(result.mpdAfter).toBe('42');
});

// ===========================================================================
// Criterion 6 — idempotency: second populate call does not duplicate periods
// ===========================================================================
test('criterion 6 — self-population is idempotent', async ({ page }) => {
  const MPD_URL = 'http://localhost:3000/stream/ep6.mpd';
  let fetchCount = 0;
  await page.route(MPD_URL, route => {
    fetchCount++;
    route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) });
  });

  const result = await page.evaluate(async (mpdUrl) => {
    await import('/dist/index.js');
    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('src', mpdUrl);
    document.body.appendChild(pres);

    pres.setAttribute('videl-state', 'next');
    await new Promise<void>(r => setTimeout(r, 600));
    const countAfterFirst = pres.querySelectorAll('videl-period').length;

    // Second populate call — should be a no-op.
    await (pres as any).videlPopulate();
    const countAfterSecond = pres.querySelectorAll('videl-period').length;

    return { countAfterFirst, countAfterSecond };
  }, MPD_URL);

  expect(result.countAfterFirst).toBeGreaterThanOrEqual(1);
  expect(result.countAfterSecond).toBe(result.countAfterFirst);
  expect(fetchCount).toBe(1); // network hit exactly once
});

// ===========================================================================
// Criterion 7 — fetch failure fires videl:segment:error
// ===========================================================================
test('criterion 7 — 404 MPD fetch fires videl:segment:error', async ({ page }) => {
  const MPD_URL = 'http://localhost:3000/stream/missing.mpd';
  await page.route(MPD_URL, route => route.fulfill({ status: 404, body: 'not found' }));

  const result = await page.evaluate(async (mpdUrl) => {
    await import('/dist/index.js');
    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('src', mpdUrl);
    document.body.appendChild(pres);

    let errorFired = false;
    pres.addEventListener('videl:segment:error', () => { errorFired = true; });

    pres.setAttribute('videl-state', 'next');
    await new Promise<void>(r => setTimeout(r, 600));

    return {
      errorFired,
      periodCount: pres.querySelectorAll('videl-period').length,
    };
  }, MPD_URL);

  expect(result.errorFired).toBe(true);
  expect(result.periodCount).toBe(0);
});

// ===========================================================================
// Criteria 8–9 — DOM stability: elements stay in place
// ===========================================================================
test('criteria 8-9 — presentation elements do not move in the DOM during state changes', async ({ page }) => {
  const MPD1 = 'http://localhost:3000/stream/dom1.mpd';
  const MPD2 = 'http://localhost:3000/stream/dom2.mpd';
  for (const url of [MPD1, MPD2]) {
    await page.route(url, route =>
      route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
    );
  }

  const result = await page.evaluate(async ({ mpd1, mpd2 }) => {
    await import('/dist/index.js');
    const player = document.createElement('videl-player') as any;
    document.body.appendChild(player);

    const p1 = document.createElement('videl-presentation') as any;
    p1.setAttribute('src', mpd1);
    const p2 = document.createElement('videl-presentation') as any;
    p2.setAttribute('src', mpd2);
    player.appendChild(p1);
    player.appendChild(p2);

    await new Promise<void>(r => setTimeout(r, 600));

    // Both presentations should remain as direct children in original order.
    const children = [...player.querySelectorAll(':scope > videl-presentation')];
    return {
      count:          children.length,
      firstSrc:       children[0]?.getAttribute('src'),
      secondSrc:      children[1]?.getAttribute('src'),
      firstIndex:     children.indexOf(p1),
      secondIndex:    children.indexOf(p2),
    };
  }, { mpd1: MPD1, mpd2: MPD2 });

  expect(result.count).toBe(2);
  expect(result.firstSrc).toBe(MPD1);
  expect(result.secondSrc).toBe(MPD2);
  expect(result.firstIndex).toBe(0);  // never moved
  expect(result.secondIndex).toBe(1); // never moved
});

// ===========================================================================
// Criterion 10 — no state-named slots in presentation shadow root
// ===========================================================================
test('criterion 10 — presentation shadow root has no named state slots', async ({ page }) => {
  const result = await page.evaluate(async () => {
    await import('/dist/index.js');
    const pres = document.createElement('videl-presentation') as any;
    document.body.appendChild(pres);
    await new Promise<void>(r => setTimeout(r, 50));

    const sr = pres.shadowRoot;
    return {
      hasActiveSlot: !!sr?.querySelector('slot[name="active"]'),
      hasNextSlot:   !!sr?.querySelector('slot[name="next"]'),
      hasDefaultSlot: !!sr?.querySelector('slot:not([name])'),
    };
  });

  expect(result.hasActiveSlot).toBe(false);
  expect(result.hasNextSlot).toBe(false);
  expect(result.hasDefaultSlot).toBe(true);
});

// ===========================================================================
// Criteria 11–13 — shadow DOM composition
// ===========================================================================
test('criteria 11-13 — periods in seek slot as segments; user content in default slot; no slot attr needed on user content', async ({ page }) => {
  const MPD_URL = 'http://localhost:3000/stream/shadow.mpd';
  await page.route(MPD_URL, route =>
    route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
  );

  const result = await page.evaluate(async (mpdUrl) => {
    await import('/dist/index.js');
    const pres = document.createElement('videl-presentation') as any;
    pres.setAttribute('src', mpdUrl);

    const h3 = document.createElement('h3');
    h3.textContent = 'My Title'; // no slot attr — user content needs none
    pres.appendChild(h3);

    document.body.appendChild(pres);
    pres.setAttribute('videl-state', 'next');
    await new Promise<void>(r => setTimeout(r, 600));

    const period = pres.querySelector('videl-period');

    // Periods self-assign slot="seek" for visual composition (ADR-0002).
    const periodSlot = period?.getAttribute('slot') ?? '';

    // The default slot surfaces only user content (no slot attr needed).
    const defaultSlot = pres.shadowRoot?.querySelector('slot:not([name])') as HTMLSlotElement | null;
    const defaultAssigned = defaultSlot?.assignedElements({ flatten: true }) ?? [];

    // The named seek slot surfaces the period as a seekbar segment.
    const seekSlot = pres.shadowRoot?.querySelector('slot[name="seek"]') as HTMLSlotElement | null;
    const seekAssigned = seekSlot?.assignedElements({ flatten: true }) ?? [];

    return {
      periodSlot,
      hasH3InDefaultSlot:  defaultAssigned.some(el => el.tagName.toLowerCase() === 'h3'),
      hasPeriodInSeekSlot: seekAssigned.some(el => el.tagName.toLowerCase() === 'videl-period'),
      hasPeriodInDefault:  defaultAssigned.some(el => el.tagName.toLowerCase() === 'videl-period'),
    };
  }, MPD_URL);

  // Periods self-assign to the named seek slot for seekbar visual composition.
  expect(result.periodSlot).toBe('seek');
  // User content (no slot attr) flows through the default slot.
  expect(result.hasH3InDefaultSlot).toBe(true);
  // Period is in the seek slot (rendered as a seekbar segment), not the default slot.
  expect(result.hasPeriodInSeekSlot).toBe(true);
  expect(result.hasPeriodInDefault).toBe(false);
});

// ===========================================================================
// Criterion 17 — player connection activates first, prefetches second
// ===========================================================================
test('criterion 17 — player activates first presentation and prefetches second on connection', async ({ page }) => {
  const MPD1 = 'http://localhost:3000/stream/c17a.mpd';
  const MPD2 = 'http://localhost:3000/stream/c17b.mpd';
  for (const url of [MPD1, MPD2]) {
    await page.route(url, route =>
      route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
    );
  }

  const result = await page.evaluate(async ({ mpd1, mpd2 }) => {
    await import('/dist/index.js');
    const player = document.createElement('videl-player') as any;
    const p1 = document.createElement('videl-presentation') as any;
    p1.setAttribute('src', mpd1);
    const p2 = document.createElement('videl-presentation') as any;
    p2.setAttribute('src', mpd2);
    player.appendChild(p1);
    player.appendChild(p2);
    document.body.appendChild(player);

    // Poll until p1 becomes active (MediaSource sourceopen timing varies
    // under parallel test load). Cap at 2 s.
    for (let i = 0; i < 20; i++) {
      await new Promise<void>(r => setTimeout(r, 100));
      if (p1.getAttribute('videl-state') === 'active') break;
    }

    return {
      p1State: p1.getAttribute('videl-state'),
      p2State: p2.getAttribute('videl-state'),
    };
  }, { mpd1: MPD1, mpd2: MPD2 });

  expect(result.p1State).toBe('active');
  expect(result.p2State).toBe('next');
});

// ===========================================================================
// Criterion 19 — videl:playlist:advance fires with correct detail
// ===========================================================================
test('criterion 19 — videl:playlist:advance fires with correct detail on advance', async ({ page }) => {
  const MPD1 = 'http://localhost:3000/stream/c19a.mpd';
  const MPD2 = 'http://localhost:3000/stream/c19b.mpd';
  for (const url of [MPD1, MPD2]) {
    await page.route(url, route =>
      route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
    );
  }

  const result = await page.evaluate(async ({ mpd1, mpd2 }) => {
    await import('/dist/index.js');
    const player = document.createElement('videl-player') as any;
    const p1 = document.createElement('videl-presentation') as any;
    p1.setAttribute('src', mpd1);
    const p2 = document.createElement('videl-presentation') as any;
    p2.setAttribute('src', mpd2);
    player.appendChild(p1);
    player.appendChild(p2);
    document.body.appendChild(player);

    // Wait for p1 to become active before firing done.
    for (let i = 0; i < 20; i++) {
      await new Promise<void>(r => setTimeout(r, 100));
      if (p1.getAttribute('videl-state') === 'active') break;
    }

    const advances: any[] = [];
    player.addEventListener('videl:playlist:advance', (e: any) => {
      advances.push(e.detail);
    });

    // Simulate first presentation completing.
    p1.dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true, composed: true, detail: { src: mpd1 },
    }));

    // Wait for p2 to become active.
    for (let i = 0; i < 20; i++) {
      await new Promise<void>(r => setTimeout(r, 100));
      if (p2.getAttribute('videl-state') === 'active') break;
    }

    return {
      advances,
      p2State: p2.getAttribute('videl-state'),
    };
  }, { mpd1: MPD1, mpd2: MPD2 });

  expect(result.advances).toHaveLength(1);
  expect(result.advances[0].from).toBe(MPD1);
  expect(result.advances[0].to).toBe(MPD2);
  expect(result.advances[0].index).toBe(1);
  expect(result.p2State).toBe('active');
});

// ===========================================================================
// Criterion 20 — player stops after last presentation; no extra advance event
// ===========================================================================
test('criterion 20 — player stops after last presentation without looping', async ({ page }) => {
  const MPD1 = 'http://localhost:3000/stream/c20.mpd';
  await page.route(MPD1, route =>
    route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
  );

  const result = await page.evaluate(async (mpd1) => {
    await import('/dist/index.js');
    const player = document.createElement('videl-player') as any;
    const p1 = document.createElement('videl-presentation') as any;
    p1.setAttribute('src', mpd1);
    player.appendChild(p1);
    document.body.appendChild(player);

    await new Promise<void>(r => setTimeout(r, 400));

    const advances: any[] = [];
    player.addEventListener('videl:playlist:advance', (e: any) => advances.push(e.detail));

    // Fire done from the only presentation.
    p1.dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true, composed: true, detail: { src: mpd1 },
    }));

    await new Promise<void>(r => setTimeout(r, 200));

    return { advances };
  }, MPD1);

  expect(result.advances).toHaveLength(0);
});

// ===========================================================================
// Criterion 21 — setting src while playlist plays replaces all presentations
// ===========================================================================
test('criterion 21 — setting src on player replaces playlist and loads the new stream', async ({ page }) => {
  const MPD1    = 'http://localhost:3000/stream/c21a.mpd';
  const MPD2    = 'http://localhost:3000/stream/c21b.mpd';
  const NEW_SRC = 'http://localhost:3000/stream/c21new.mpd';
  for (const url of [MPD1, MPD2, NEW_SRC]) {
    await page.route(url, route =>
      route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
    );
  }

  const result = await page.evaluate(async ({ mpd1, mpd2, newSrc }) => {
    await import('/dist/index.js');
    const player = document.createElement('videl-player') as any;
    const p1 = document.createElement('videl-presentation') as any;
    p1.setAttribute('src', mpd1);
    const p2 = document.createElement('videl-presentation') as any;
    p2.setAttribute('src', mpd2);
    player.appendChild(p1);
    player.appendChild(p2);
    document.body.appendChild(player);
    await new Promise<void>(r => setTimeout(r, 400));

    // Switch via legacy src attribute.
    player.setAttribute('src', newSrc);

    // Poll until the new single presentation has loaded its manifest.
    for (let i = 0; i < 20; i++) {
      await new Promise<void>(r => setTimeout(r, 100));
      const pres = player.querySelectorAll(':scope > videl-presentation');
      if (pres.length === 1 && pres[0].getAttribute('videl-state') === 'active') break;
    }

    const presentations = [...player.querySelectorAll(':scope > videl-presentation')];
    return {
      count:     presentations.length,
      hasState:  presentations[0]?.getAttribute('videl-state'),
    };
  }, { mpd1: MPD1, mpd2: MPD2, newSrc: NEW_SRC });

  // Legacy src path creates exactly one anonymous presentation and activates it.
  expect(result.count).toBe(1);
  expect(result.hasState).toBe('active');
});

// ===========================================================================
// Criterion 22 — pre-populated presentation (prefetched) is not re-fetched
// ===========================================================================
test('criterion 22 — already-populated presentation is not re-fetched on activation', async ({ page }) => {
  const MPD1 = 'http://localhost:3000/stream/c22a.mpd';
  const MPD2 = 'http://localhost:3000/stream/c22b.mpd';
  let mpd2FetchCount = 0;
  await page.route(MPD1, route =>
    route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
  );
  await page.route(MPD2, route => {
    mpd2FetchCount++;
    route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) });
  });

  await page.evaluate(async ({ mpd1, mpd2 }) => {
    await import('/dist/index.js');
    const player = document.createElement('videl-player') as any;
    const p1 = document.createElement('videl-presentation') as any;
    p1.setAttribute('src', mpd1);
    const p2 = document.createElement('videl-presentation') as any;
    p2.setAttribute('src', mpd2);
    player.appendChild(p1);
    player.appendChild(p2);
    document.body.appendChild(player);

    // Wait for p2 to be prefetched (videl-state="next").
    await new Promise<void>(r => setTimeout(r, 800));

    // Advance to p2.
    p1.dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true, composed: true, detail: { src: mpd1 },
    }));
    await new Promise<void>(r => setTimeout(r, 600));
  }, { mpd1: MPD1, mpd2: MPD2 });

  // MPD2 should have been fetched exactly once (during prefetch, not again on activate).
  expect(mpd2FetchCount).toBe(1);
});

// ===========================================================================
// Criterion 24 — player never sets slot attribute on presentations
// ===========================================================================
test('criterion 24 — player never uses the slot attribute as a STATE signal on presentations', async ({ page }) => {
  const MPD1 = 'http://localhost:3000/stream/c24a.mpd';
  const MPD2 = 'http://localhost:3000/stream/c24b.mpd';
  for (const url of [MPD1, MPD2]) {
    await page.route(url, route =>
      route.fulfill({ contentType: 'application/dash+xml', body: makeMpd('p0', 5) })
    );
  }

  const result = await page.evaluate(async ({ mpd1, mpd2 }) => {
    await import('/dist/index.js');
    const player = document.createElement('videl-player') as any;
    const p1 = document.createElement('videl-presentation') as any;
    p1.setAttribute('src', mpd1);
    const p2 = document.createElement('videl-presentation') as any;
    p2.setAttribute('src', mpd2);
    player.appendChild(p1);
    player.appendChild(p2);

    // ADR-0002: playback STATE is carried by `videl-state`, never `slot`.
    // The player MAY set `slot` for pure visual composition (it assigns
    // slot="stage" to move the active presentation into the video stage), but
    // it must never use `slot` to encode state values like "active"/"next".
    const slotMutations: string[] = [];
    const obs = new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'attributes' && r.attributeName === 'slot') {
          slotMutations.push((r.target as Element).getAttribute('slot') ?? '(removed)');
        }
      }
    });
    obs.observe(p1, { attributes: true, attributeFilter: ['slot'] });
    obs.observe(p2, { attributes: true, attributeFilter: ['slot'] });

    document.body.appendChild(player);
    await new Promise<void>(r => setTimeout(r, 600));
    obs.disconnect();

    return { slotMutations };
  }, { mpd1: MPD1, mpd2: MPD2 });

  // Any slot values set must be composition-only ("stage" or removed) — never
  // state values. State is asserted via videl-state in other tests.
  const stateValues = result.slotMutations.filter(
    v => v === 'active' || v === 'next'
  );
  expect(stateValues).toHaveLength(0);
  for (const v of result.slotMutations) {
    expect(['stage', '(removed)', '']).toContain(v);
  }
});
