#!/usr/bin/env node

import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEMO_URL = 'http://localhost:3000/';
const SOURCES_URL =
  'https://reference.dashif.org/dash.js/nightly/samples/dash-if-reference-player/app/sources.json';

const ALLOWED_CATEGORIES = [
  'VOD (Static MPD)',
  'LIVE (Dynamic MPD)',
  'Subtitles and Captions',
  'Audio-only',
];

// ── Source loading ────────────────────────────────────────────────────────────

async function fetchSources() {
  const response = await fetch(SOURCES_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching sources.json`);
  const data = await response.json();
  const sources = [];
  for (const item of data.items ?? []) {
    if (!ALLOWED_CATEGORIES.includes(item.name)) continue;
    for (const s of item.submenu ?? []) {
      if (s.url) sources.push({ name: s.name || s.url, url: s.url });
    }
  }
  return sources;
}

// ── Per-source test ───────────────────────────────────────────────────────────

async function testSource(context, source) {
  let manifestFetchable = false;
  const page = await context.newPage();

  try {
    await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded', timeout: 8000 });

    // Manifest fetchability is the one thing we check at the Playwright level,
    // because it needs the HTTP status code which isn't visible inside the page.
    page.on('response', (response) => {
      try {
        if (response.url().toLowerCase().endsWith('.mpd') &&
            response.status() >= 200 && response.status() < 300) {
          manifestFetchable = true;
        }
      } catch { /* ignore */ }
    });

    // Everything else runs inside the page so we can use videl's own events
    // instead of guessing from HTTP Content-Type headers or URL patterns.
    const stats = await page.evaluate(async (sourceUrl) => {
      const result = {
        audioInit:    false,
        videoInit:    false,
        textInit:     false,
        audioSegments: 0,
        videoSegments: 0,
        textSegments:  0,
        playing:       false,
      };

      // ── Init detection via videl:trace (fires from videl-player during MSE setup) ──
      // 'add-source-buffer'      → a real MSE SourceBuffer was created (video or audio)
      // 'add-text-source-buffer' → a TextSourceBuffer was created (text)
      document.addEventListener('videl:trace', (e) => {
        const { category, action, data } = e.detail ?? {};
        if (category !== 'mse') return;
        if (action === 'add-source-buffer') {
          if (data?.contentType === 'video') result.videoInit = true;
          if (data?.contentType === 'audio') result.audioInit = true;
        }
        if (action === 'add-text-source-buffer') {
          result.textInit = true;
        }
      }, true);

      // ── Segment counting via videl:done (fires from videl-segment, bubbles) ──
      // Walk up from the segment element to its parent videl-adaptation-set to
      // read content-type — this is authoritative, no Content-Type header guessing.
      document.addEventListener('videl:done', (e) => {
        const target = e.target;
        if (target?.tagName?.toLowerCase() !== 'videl-segment') return;
        const ads = target.closest('videl-adaptation-set');
        const ct  = ads?.getAttribute('content-type');
        if      (ct === 'audio') result.audioSegments++;
        else if (ct === 'video') result.videoSegments++;
        else if (ct === 'text')  result.textSegments++;
      }, true);

      // ── Playing detection (the inner video is in the player's shadow root) ──
      const findVideo = () =>
        document.querySelector('videl-player')?.shadowRoot?.querySelector('video');

      // Poll briefly in case the element hasn't rendered yet.
      await new Promise((resolve) => {
        const deadline = Date.now() + 500;
        const poll = () => {
          const v = findVideo();
          if (v) { v.addEventListener('playing', () => { result.playing = true; }, { once: true }); resolve(); return; }
          if (Date.now() < deadline) setTimeout(poll, 50); else resolve();
        };
        poll();
      });

      // ── Load source ──
      document.querySelector('videl-player')?.setAttribute('src', sourceUrl);

      // ── Activate first real text adaptation set once MSE setup is done ──
      // videl-period (PickNMixin) keeps one ADS active per content-type key.
      // By default the synthetic "None" ADS is active (it calls hide() and has
      // no representations to load).  To get text segments loaded we deactivate
      // the None ADS and activate the first real one — the same state transition
      // the player's own UI would perform when a user picks a subtitle track.
      // We poll because #setupMse (which assigns sourceBuffer) runs async after
      // the MPD fetch completes.
      await new Promise((resolve) => {
        const deadline = Date.now() + 8000;
        const poll = () => {
          const noneAds = document.querySelector(
            'videl-adaptation-set[content-type="text"][videl-text-none]'
          );
          const realAds = document.querySelector(
            'videl-adaptation-set[content-type="text"]:not([videl-text-none])'
          );
          // Both must exist and the real one must have its sourceBuffer assigned
          // (set by #setupMse) before we switch.
          if (realAds?.sourceBuffer) {
            if (noneAds) noneAds.removeAttribute('videl-state');
            realAds.setAttribute('videl-state', 'active');
            resolve(true);
            return;
          }
          if (Date.now() < deadline) setTimeout(poll, 100); else resolve(false);
        };
        poll();
      });

      // ── Play ──
      document.querySelector('videl-player')?.play?.();

      // ── Wait for activity to accumulate ──
      await new Promise((r) => setTimeout(r, 12000));

      return result;
    }, source.url);

    return {
      sourceName:    source.name,
      sourceUrl:     source.url,
      manifestFetchable,
      audioInit:     stats.audioInit,
      videoInit:     stats.videoInit,
      textInit:      stats.textInit,
      audioSegments: stats.audioSegments,
      videoSegments: stats.videoSegments,
      textSegments:  stats.textSegments,
      playing:       stats.playing,
    };

  } catch (err) {
    console.error(`  ✗ error: ${err.message}`);
    return {
      sourceName: source.name, sourceUrl: source.url, manifestFetchable,
      audioInit: false, videoInit: false, textInit: false,
      audioSegments: 0, videoSegments: 0, textSegments: 0, playing: false,
    };
  } finally {
    await page.close();
  }
}

// ── CSV output ────────────────────────────────────────────────────────────────

function escapeCSV(v) {
  const s = String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCSV(results) {
  const headers = [
    'source name', 'url', 'manifest fetchable',
    'audio init', 'video init', 'text init',
    'audio segments', 'video segments', 'text segments',
    'playing',
  ];
  const rows = results.map((r) => [
    escapeCSV(r.sourceName),
    escapeCSV(r.sourceUrl),
    r.manifestFetchable ? 'yes' : 'no',
    r.audioInit     ? 'yes' : 'no',
    r.videoInit     ? 'yes' : 'no',
    r.textInit      ? 'yes' : 'no',
    r.audioSegments,
    r.videoSegments,
    r.textSegments,
    r.playing ? 'yes' : 'no',
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const out = path.join(__dirname, 'dash-if-compatibility-results.csv');
  fs.writeFileSync(out, csv, 'utf-8');
  console.log(`\nResults written to: ${out}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const CONCURRENCY = 6;

async function main() {
  const debug = process.argv.includes('--debug');

  let sources = await fetchSources();
  console.log(`Loaded ${sources.length} DASH sources from selected categories`);

  if (debug) {
    sources = sources.filter(s =>
      s.name === 'Single-period, 1080p, H.265, 5 video, 3 audio, 3 text tracks, CMAF, no encryption'
    );
    console.log(`[debug] Filtered to ${sources.length} source(s)\n`);
  } else {
    console.log();
  }

  const browser = await chromium.launch({ 
    headless: false, 
    channel: 'chrome' 
  });
  const context = await browser.newContext();

  // Results array pre-sized to preserve source order regardless of finish order.
  const results = new Array(sources.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < sources.length) {
      const i = nextIndex++;
      const source = sources[i];
      process.stdout.write(`[${i + 1}/${sources.length}] starting: ${source.name}\n`);
      const result = await testSource(context, source);
      results[i] = result;
      const { manifestFetchable: mf, playing: pl,
              audioSegments: a, videoSegments: v, textSegments: t } = result;
      console.log(
        `[${i + 1}/${sources.length}] done:     ${source.name}\n` +
        `  manifest:${mf ? '✓' : '✗'}  playing:${pl ? '✓' : '✗'}` +
        `  audio:${a}  video:${v}  text:${t}`
      );
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, sources.length) },
    () => worker()
  );
  await Promise.all(workers);

  await context.close();
  await browser.close();

  writeCSV(results);
  console.log('Done.');
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
