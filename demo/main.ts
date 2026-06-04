/**
 * videl-player demo page — main entry point.
 *
 * Registers all videl custom elements and media-chrome components, then wires
 * up the URL bar, event log, and LocalStorage persistence.
 */

// Register videl elements (side-effect imports).
import '../src/index';

// Register only the media-chrome components used in the demo — importing the
// full barrel ('media-chrome') pulls in every component and bloats the bundle.
import 'media-chrome/dist/media-controller.js';
import 'media-chrome/dist/media-control-bar.js';
import 'media-chrome/dist/media-play-button.js';
import 'media-chrome/dist/media-time-range.js';
import 'media-chrome/dist/media-time-display.js';
import 'media-chrome/dist/media-mute-button.js';
import 'media-chrome/dist/media-volume-range.js';
import 'media-chrome/dist/media-fullscreen-button.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LS_KEY     = 'videl-player-demo:urls';
const MAX_RECENT = 10;
const MAX_LOG    = 500;

const PRESET_STREAMS: { label: string; url: string }[] = [
  {
    label: 'Big Buck Bunny (DASH-IF / Akamai)',
    url:   'https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd',
  },
  {
    label: 'BBC Testcard (DASH-IF / BBC)',
    url:   'https://rdmedia.bbc.co.uk/testcard/vod/manifests/avc-full.mpd',
  },
  {
    label: 'DASH-IF SegmentBase fMP4',
    url:   'https://dash.akamaized.net/dash264/TestCases/1b/qualcomm/1/MultipleRates.mpd',
  },
  {
    label: 'DASH-IF Live Sim (2 s segments)',
    url:   'https://livesim.dashif.org/livesim/testpic_2s/Manifest.mpd',
  },
];

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const player    = document.getElementById('player')    as HTMLElement & {
  src: string;
  currentTime: number;
};
const urlInput  = document.getElementById('url-input') as HTMLInputElement;
const urlSelect = document.getElementById('url-select') as HTMLSelectElement;
const loadBtn   = document.getElementById('load-btn')  as HTMLButtonElement;
const clearBtn   = document.getElementById('clear-btn')    as HTMLButtonElement;
const pauseBtn   = document.getElementById('pause-btn')    as HTMLButtonElement;
const traceToggle = document.getElementById('trace-toggle') as HTMLInputElement;
const logEl      = document.getElementById('log')          as HTMLDivElement;

// ---------------------------------------------------------------------------
// LocalStorage helpers
// ---------------------------------------------------------------------------

function loadRecentUrls(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecentUrl(url: string): void {
  try {
    const list = loadRecentUrls().filter(u => u !== url);
    list.unshift(url);
    localStorage.setItem(LS_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    // Private browsing or storage blocked — degrade silently.
  }
}

// ---------------------------------------------------------------------------
// URL dropdown
// ---------------------------------------------------------------------------

function buildDropdown(): void {
  urlSelect.innerHTML = '';

  // Blank sentinel.
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = '— select a stream —';
  urlSelect.appendChild(blank);

  // Pre-configured group.
  const presetGroup = document.createElement('optgroup');
  presetGroup.label = 'Pre-configured';
  for (const { label, url } of PRESET_STREAMS) {
    const opt = document.createElement('option');
    opt.value = url;
    opt.textContent = label;
    presetGroup.appendChild(opt);
  }
  urlSelect.appendChild(presetGroup);

  // Recent group (from LocalStorage).
  const recent = loadRecentUrls();
  if (recent.length > 0) {
    const recentGroup = document.createElement('optgroup');
    recentGroup.label = 'Recent';
    for (const url of recent) {
      const opt = document.createElement('option');
      opt.value = url;
      try {
        opt.textContent = new URL(url).hostname;
      } catch {
        opt.textContent = url.slice(0, 40);
      }
      recentGroup.appendChild(opt);
    }
    urlSelect.appendChild(recentGroup);
  }
}

// Pre-populate text input with most recent URL (do not auto-play).
function prePopulate(): void {
  const recent = loadRecentUrls();
  if (recent.length > 0) urlInput.value = recent[0];
}

urlSelect.addEventListener('change', () => {
  if (!urlSelect.value) return;
  urlInput.value = urlSelect.value;
  loadStream(urlSelect.value);
  urlSelect.value = ''; // reset so the same entry can be re-selected
});

// ---------------------------------------------------------------------------
// Stream loading
// ---------------------------------------------------------------------------

function loadStream(url: string): void {
  if (!url) return;
  player.setAttribute('src', url);
  saveRecentUrl(url);
  buildDropdown(); // refresh dropdown to show new recent entry
}

loadBtn.addEventListener('click', () => loadStream(urlInput.value.trim()));

urlInput.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Enter') loadStream(urlInput.value.trim());
});

// ---------------------------------------------------------------------------
// Event log
// ---------------------------------------------------------------------------

let logPaused  = false;
let buffer: LogEntry[] = [];

interface LogEntry {
  ts:     string;
  event:  string;
  source: string;
  detail: string;
  cls:    string;
}

function timestamp(): string {
  const now = new Date();
  const hh  = now.getHours().toString().padStart(2, '0');
  const mm  = now.getMinutes().toString().padStart(2, '0');
  const ss  = now.getSeconds().toString().padStart(2, '0');
  const ms  = now.getMilliseconds().toString().padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function compactJson(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}:${JSON.stringify(v)}`);
  return entries.length ? `{${entries.join(', ')}}` : '';
}

function addEntry(entry: LogEntry): void {
  if (logPaused) {
    buffer.push(entry);
    return;
  }
  renderEntry(entry);
}

function renderEntry(entry: LogEntry): void {
  // Enforce cap.
  const rows = logEl.children;
  while (rows.length >= MAX_LOG) logEl.removeChild(rows[0]);

  const row = document.createElement('div');
  row.className = 'log-entry';

  const wasAtBottom =
    logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 2;

  row.innerHTML = `
    <span class="log-ts">${entry.ts}</span>
    <span class="log-body">
      <span class="log-event ${entry.cls}">${entry.event}</span>
      <span class="log-source">${entry.source}</span>
      ${entry.detail ? `<span class="log-detail">${entry.detail}</span>` : ''}
    </span>`;

  logEl.appendChild(row);

  // Auto-scroll only if we were already at the bottom.
  if (wasAtBottom) logEl.scrollTop = logEl.scrollHeight;
}

function flushBuffer(): void {
  for (const entry of buffer) renderEntry(entry);
  buffer = [];
}

// ── Trace toggle ───────────────────────────────────────────────────────────

// Trace events are hidden by default; the checkbox reveals them.
player.addEventListener('videl:trace', (e: Event) => {
  if (!traceToggle.checked) return;
  const ce = e as CustomEvent;
  const { category, action, data } = ce.detail ?? {};
  const source = e.target instanceof Element
    ? `<${e.target.tagName.toLowerCase()}>`
    : '?';
  addEntry({
    ts:     timestamp(),
    event:  `${category}:${action}`,
    source,
    detail: data && Object.keys(data).length ? compactJson(data) : '',
    cls:    'trace-event',
  });
});

// ── Pause / Resume ─────────────────────────────────────────────────────────

pauseBtn.addEventListener('click', () => {
  logPaused = !logPaused;
  pauseBtn.classList.toggle('active', logPaused);
  pauseBtn.textContent = logPaused ? 'Resume' : 'Pause';
  if (!logPaused) flushBuffer();
});

clearBtn.addEventListener('click', () => {
  logEl.innerHTML = '';
  buffer = [];
});

// ---------------------------------------------------------------------------
// Attach event listeners to the player element
// ---------------------------------------------------------------------------

// videl:* domain events
type VidelEventSpec = { event: string; cls: string; detail: (e: CustomEvent) => Record<string, unknown> };

const VIDEL_EVENTS: VidelEventSpec[] = [
  {
    event: 'videl:done',
    cls:   'videl-done',
    detail: e => {
      const d = e.detail ?? {};
      return e.target instanceof Element && e.target.tagName.toLowerCase() === 'videl-segment'
        ? { startTime: d.startTime, duration: d.duration }
        : { periodId: d.periodId, src: d.src };
    },
  },
  {
    event: 'videl:segment:error',
    cls:   'videl-seg-error',
    detail: e => ({ error: e.detail?.error?.message ?? 'unknown' }),
  },
  {
    event: 'videl:representation:switched',
    cls:   'videl-repr-switched',
    detail: e => ({ from: e.detail?.from, to: e.detail?.to, contentType: e.detail?.contentType }),
  },
  {
    event: 'videl:mse:error',
    cls:   'videl-mse-error',
    detail: e => ({ contentType: e.detail?.contentType, reason: e.detail?.reason }),
  },
  {
    event: 'videl:mse:incompatible',
    cls:   'videl-mse-incompatible',
    detail: e => ({ contentType: e.detail?.contentType, requiredCodecs: e.detail?.requiredCodecs }),
  },
];

for (const { event, cls, detail } of VIDEL_EVENTS) {
  player.addEventListener(event, (e: Event) => {
    const ce  = e as CustomEvent;
    const src = e.target instanceof Element ? `<${e.target.tagName.toLowerCase()}>` : '?';
    addEntry({
      ts:     timestamp(),
      event,
      source: src,
      detail: compactJson(detail(ce)),
      cls,
    });
  });
}

// Media lifecycle events (re-fired by <videl-player> from the inner <video>)
const MEDIA_EVENTS: { event: string; detail?: (p: typeof player) => Record<string, unknown> }[] = [
  { event: 'play' },
  { event: 'pause' },
  { event: 'seeking',  detail: p => ({ currentTime: +(p.currentTime ?? 0).toFixed(2) }) },
  { event: 'seeked',   detail: p => ({ currentTime: +(p.currentTime ?? 0).toFixed(2) }) },
  { event: 'waiting' },
  { event: 'canplay' },
  { event: 'ended' },
];

for (const { event, detail } of MEDIA_EVENTS) {
  player.addEventListener(event, () => {
    addEntry({
      ts:     timestamp(),
      event,
      source: '<video>',
      detail: detail ? compactJson(detail(player)) : '',
      cls:    'media-event',
    });
  });
}

// ---------------------------------------------------------------------------
// Initialise
// ---------------------------------------------------------------------------

buildDropdown();
prePopulate();
