/**
 * DASH MPD → videl element tree
 *
 * Strategy: use the browser's native DOMParser to turn the XML string into a
 * live DOM tree, then walk MPD → Period → AdaptationSet → Representation and
 * create the corresponding videl-* custom elements, stamping all resolved
 * attributes onto them.  No custom tokeniser required.
 *
 * Public API:
 *   parseMpd(xml: string, baseUrl: string): HTMLElement
 *   class ParseError extends Error
 */

// ---------------------------------------------------------------------------
// Public error type
// ---------------------------------------------------------------------------

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** All SegmentTemplate fields that can be inherited down the tree. */
interface SegTemplate {
  media?:          string;   // URL template for media segments
  initialization?: string;   // URL template for init segment
  timescale:       number;   // tick rate (default 1)
  startNumber:     number;   // first segment number (default 1)
  pto:             number;   // presentationTimeOffset in timescale units (default 0)
  /** Fixed segment duration in timescale units (SegmentTemplate/@duration). */
  segDuration?:    number;
  /** Ordered S elements from a SegmentTimeline child. */
  timeline?:       Element[];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function parseMpd(xml: string, baseUrl: string): HTMLElement {
  const xmlDoc = new DOMParser().parseFromString(xml, 'text/xml');

  const parseErr = xmlDoc.querySelector('parsererror');
  if (parseErr) {
    throw new ParseError(`Malformed XML: ${parseErr.textContent?.trim()}`);
  }

  const mpd = xmlDoc.documentElement;
  if (mpd.localName !== 'MPD') {
    throw new ParseError(`Root element must be MPD, got <${mpd.localName}>`);
  }

  return buildPresentation(mpd, baseUrl);
}

// ---------------------------------------------------------------------------
// MPD → <videl-presentation>
// ---------------------------------------------------------------------------

function buildPresentation(mpd: Element, baseUrl: string): HTMLElement {
  const el = document.createElement('videl-presentation');

  // Attributes
  const dur     = mpd.getAttribute('mediaPresentationDuration');
  const minBuf  = mpd.getAttribute('minBufferTime');
  const type    = mpd.getAttribute('type') ?? 'static';

  if (dur)    el.setAttribute('media-presentation-duration', String(parseDuration(dur)));
  if (minBuf) el.setAttribute('min-buffer-time',             String(parseDuration(minBuf)));
  el.setAttribute('type', type);

  const mpdBase = resolveBaseUrl(mpd, baseUrl);
  const mpdDur  = dur ? parseDuration(dur) : undefined;

  for (const period of children(mpd, 'Period')) {
    el.appendChild(buildPeriod(period, mpdBase, mpdDur));
  }

  return el;
}

// ---------------------------------------------------------------------------
// Period → <videl-period>
// ---------------------------------------------------------------------------

function buildPeriod(
  period: Element,
  parentBase: string,
  mpdDuration?: number
): HTMLElement {
  const el = document.createElement('videl-period');

  const id       = period.getAttribute('id') ?? '';
  const startStr = period.getAttribute('start');
  const durStr   = period.getAttribute('duration');

  el.setAttribute('period-id', id);

  const start = startStr ? parseDuration(startStr) : 0;
  el.setAttribute('start', String(start));

  let periodDuration: number | undefined;
  if (durStr) {
    periodDuration = parseDuration(durStr);
    el.setAttribute('duration', String(periodDuration));
  } else if (mpdDuration !== undefined) {
    // Single-period streams often omit Period/@duration; infer from MPD total.
    periodDuration = mpdDuration - start;
    el.setAttribute('duration', String(periodDuration));
  }

  const base     = resolveBaseUrl(period, parentBase);
  const periodST = readSegTemplate(period);

  const periodSL = child(period, 'SegmentList');
  for (const ads of children(period, 'AdaptationSet')) {
    el.appendChild(buildAdaptationSet(ads, { base, parentST: periodST, parentSL: periodSL ?? undefined, periodDuration }));
  }

  return el;
}

// ---------------------------------------------------------------------------
// AdaptationSet → <videl-adaptation-set>
// ---------------------------------------------------------------------------

function buildAdaptationSet(
  ads: Element,
  ctx: {
    base:            string;
    parentST?:       Partial<SegTemplate>;
    parentSL?:       Element;   // inherited SegmentList
    periodDuration?: number;
  }
): HTMLElement {
  const el = document.createElement('videl-adaptation-set');

  const mimeType   = ads.getAttribute('mimeType')    ?? '';
  const codecs     = ads.getAttribute('codecs')      ?? '';
  const lang       = ads.getAttribute('lang')        ?? '';
  const contentType = ads.getAttribute('contentType')
    ?? inferContentType(mimeType);

  el.setAttribute('content-type', contentType);
  if (mimeType)  el.setAttribute('mime-type', mimeType);
  if (codecs)    el.setAttribute('codecs',    codecs);
  if (lang)      el.setAttribute('lang',      lang);

  const base    = resolveBaseUrl(ads, ctx.base);
  const adsST   = readSegTemplate(ads);
  const merged  = mergeSegTemplate(ctx.parentST, adsST);
  // SegmentList / SegmentBase can appear at the AdaptationSet level and are
  // inherited by Representations that don't define their own.
  const adsSL   = child(ads, 'SegmentList') ?? ctx.parentSL;

  for (const rep of children(ads, 'Representation')) {
    el.appendChild(buildRepresentation(rep, {
      base,
      parentST:       merged,
      parentSL:       adsSL,
      periodDuration: ctx.periodDuration,
      parentMimeType: mimeType,
      parentCodecs:   codecs,
    }));
  }

  return el;
}

// ---------------------------------------------------------------------------
// Representation → <videl-representation>
// ---------------------------------------------------------------------------

function buildRepresentation(
  rep: Element,
  ctx: {
    base:            string;
    parentST?:       Partial<SegTemplate>;
    parentSL?:       Element;
    periodDuration?: number;
    parentMimeType:  string;
    parentCodecs:    string;
  }
): HTMLElement {
  const el = document.createElement('videl-representation');

  const id        = rep.getAttribute('id')        ?? '';
  const bandwidth = Number(rep.getAttribute('bandwidth') ?? 0);
  const width     = rep.getAttribute('width');
  const height    = rep.getAttribute('height');
  // Inherit MIME type and codecs from AdaptationSet if not explicit on Representation.
  const mimeType  = rep.getAttribute('mimeType')  ?? ctx.parentMimeType;
  const codecs    = rep.getAttribute('codecs')    ?? ctx.parentCodecs;

  el.setAttribute('id',        id);
  el.setAttribute('bandwidth', String(bandwidth));
  if (width)    el.setAttribute('width',    width);
  if (height)   el.setAttribute('height',   height);
  if (mimeType) el.setAttribute('mime-type', mimeType);
  if (codecs)   el.setAttribute('codecs',    codecs);

  const base   = resolveBaseUrl(rep, ctx.base);
  const repST  = readSegTemplate(rep);
  const st     = mergeSegTemplate(ctx.parentST, repST);

  buildSegments(rep, el, { base, st, parentSL: ctx.parentSL, periodDuration: ctx.periodDuration, id, bandwidth });

  return el;
}

// ---------------------------------------------------------------------------
// Segment addressing
// ---------------------------------------------------------------------------

function buildSegments(
  rep: Element,
  repEl: HTMLElement,
  ctx: {
    base:            string;
    st?:             SegTemplate;
    parentSL?:       Element;
    periodDuration?: number;
    id:              string;
    bandwidth:       number;
  }
): void {
  const { base, st, parentSL, periodDuration, id, bandwidth } = ctx;

  // Priority: SegmentBase > SegmentList > SegmentTemplate (inherited or local)
  const sb = child(rep, 'SegmentBase');
  if (sb) { buildSegmentBase(rep, repEl, base); return; }

  // SegmentList: check Representation first, then inherited from AdaptationSet.
  const sl = child(rep, 'SegmentList') ?? parentSL;
  if (sl) { buildSegmentList(sl, repEl, base); return; }

  if (!st?.media) return; // no segment addressing resolved

  // Stamp initialization-url on the representation element.
  if (st.initialization) {
    repEl.setAttribute(
      'initialization-url',
      resolveUrl(expandTemplate(st.initialization, { id, bandwidth }), base)
    );
  }

  if (st.timeline) {
    buildFromTimeline(repEl, st as SegTemplate, periodDuration, { id, bandwidth }, base);
  } else if (st.segDuration) {
    buildFromNumber(repEl, st as SegTemplate, periodDuration, { id, bandwidth }, base);
  }
}

// SegmentTemplate + SegmentTimeline ($Number$ or $Time$)
function buildFromTimeline(
  repEl:   HTMLElement,
  st:      SegTemplate,
  periodDuration: number | undefined,
  vars:    { id: string; bandwidth: number },
  base:    string
): void {
  const { media, timescale, startNumber, pto, timeline } = st;
  if (!media || !timeline) return;

  let segNumber = startNumber;
  let t = 0; // running time cursor in timescale units

  for (const s of timeline) {
    const sT = s.hasAttribute('t') ? Number(s.getAttribute('t')) : t;
    const d  = Number(s.getAttribute('d') ?? 0);
    if (d === 0) continue;
    let r = Number(s.getAttribute('r') ?? 0);

    t = sT;

    // r="-1" means repeat to end of period
    if (r === -1) {
      if (periodDuration !== undefined) {
        // How many additional repetitions fit from t to period end?
        const periodEndTicks = periodDuration * timescale + pto;
        r = Math.max(0, Math.ceil((periodEndTicks - t) / d) - 1);
      } else {
        r = 0;
      }
    }

    for (let i = 0; i <= r; i++) {
      const url       = resolveUrl(expandTemplate(media, { ...vars, number: segNumber, time: t }), base);
      const startTime = (t - pto) / timescale;
      const duration  = d / timescale;

      appendSegment(repEl, url, startTime, duration);
      t += d;
      segNumber++;
    }
  }
}

// SegmentTemplate with @duration and $Number$ (no SegmentTimeline)
function buildFromNumber(
  repEl:   HTMLElement,
  st:      SegTemplate,
  periodDuration: number | undefined,
  vars:    { id: string; bandwidth: number },
  base:    string
): void {
  const { media, timescale, startNumber, segDuration } = st;
  if (!media || !segDuration) return;

  const segDurSec = segDuration / timescale;
  if (periodDuration === undefined || segDurSec <= 0) return;

  const count = Math.ceil(periodDuration / segDurSec);

  for (let i = 0; i < count; i++) {
    const segNumber = startNumber + i;
    const url       = resolveUrl(expandTemplate(media, { ...vars, number: segNumber }), base);
    const startTime = i * segDurSec;

    appendSegment(repEl, url, startTime, segDurSec);
  }
}

// SegmentBase → single segment + init
function buildSegmentBase(rep: Element, repEl: HTMLElement, base: string): void {
  const sb  = child(rep, 'SegmentBase');
  if (!sb) return;

  const segUrl    = resolveBaseUrl(rep, base);
  const indexRange = sb.getAttribute('indexRange');

  const init = child(sb, 'Initialization');
  if (init) {
    const initRange = init.getAttribute('range');
    const initUrl   = init.getAttribute('sourceURL');
    repEl.setAttribute('initialization-url', initUrl ? resolveUrl(initUrl, segUrl) : segUrl);
    if (initRange) repEl.setAttribute('initialization-byte-range', initRange);
  }

  const segEl = document.createElement('videl-segment');
  segEl.setAttribute('url', segUrl);
  if (indexRange) segEl.setAttribute('byte-range', indexRange);
  repEl.appendChild(segEl);
}

// SegmentList → one segment per SegmentURL
function buildSegmentList(sl: Element, repEl: HTMLElement, base: string): void {
  const timescale  = Number(sl.getAttribute('timescale') ?? 1);
  const segDuration = sl.hasAttribute('duration') ? Number(sl.getAttribute('duration')) : undefined;

  // Initialization
  const init = child(sl, 'Initialization');
  if (init) {
    const src   = init.getAttribute('sourceURL');
    const range = init.getAttribute('range');
    if (src) {
      repEl.setAttribute('initialization-url', resolveUrl(src, base));
      if (range) repEl.setAttribute('initialization-byte-range', range);
    }
  }

  let idx = 0;
  for (const su of children(sl, 'SegmentURL')) {
    const media      = su.getAttribute('media') ?? '';
    const mediaRange = su.getAttribute('mediaRange');

    const segEl = document.createElement('videl-segment');
    segEl.setAttribute('url', resolveUrl(media, base));
    if (mediaRange) segEl.setAttribute('byte-range', mediaRange);
    if (segDuration !== undefined) {
      segEl.setAttribute('start-time', String(idx * segDuration / timescale));
      segEl.setAttribute('duration',   String(segDuration / timescale));
    }
    repEl.appendChild(segEl);
    idx++;
  }
}

function appendSegment(repEl: HTMLElement, url: string, startTime: number, duration: number): void {
  const seg = document.createElement('videl-segment');
  seg.setAttribute('url',        url);
  seg.setAttribute('start-time', String(startTime));
  seg.setAttribute('duration',   String(duration));
  repEl.appendChild(seg);
}

// ---------------------------------------------------------------------------
// SegmentTemplate helpers
// ---------------------------------------------------------------------------

function readSegTemplate(el: Element): Partial<SegTemplate> | undefined {
  const st = child(el, 'SegmentTemplate');
  if (!st) return undefined;

  // S elements live inside a <SegmentTimeline> child, not directly under
  // <SegmentTemplate>.
  const timelineEl  = child(st, 'SegmentTimeline');
  const timelineEls = timelineEl ? children(timelineEl, 'S') : [];

  return {
    media:          st.getAttribute('media')          ?? undefined,
    initialization: st.getAttribute('initialization') ?? undefined,
    timescale:      Number(st.getAttribute('timescale')              ?? 1),
    startNumber:    Number(st.getAttribute('startNumber')            ?? 1),
    pto:            Number(st.getAttribute('presentationTimeOffset') ?? 0),
    segDuration:    st.hasAttribute('duration')
                      ? Number(st.getAttribute('duration'))
                      : undefined,
    timeline:       timelineEls.length > 0 ? timelineEls : undefined,
  };
}

/** Merge two partial SegTemplate objects; child wins per field. */
function mergeSegTemplate(
  parent?: Partial<SegTemplate>,
  child2?: Partial<SegTemplate>
): SegTemplate | undefined {
  if (!parent && !child2) return undefined;
  return {
    media:          child2?.media          ?? parent?.media,
    initialization: child2?.initialization ?? parent?.initialization,
    timescale:      child2?.timescale      ?? parent?.timescale      ?? 1,
    startNumber:    child2?.startNumber    ?? parent?.startNumber    ?? 1,
    pto:            child2?.pto            ?? parent?.pto            ?? 0,
    segDuration:    child2?.segDuration    ?? parent?.segDuration,
    timeline:       child2?.timeline       ?? parent?.timeline,
  };
}

// ---------------------------------------------------------------------------
// Template variable expansion
// ---------------------------------------------------------------------------

function expandTemplate(
  template: string,
  vars: { id: string; bandwidth: number; number?: number; time?: number }
): string {
  return template.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (_match, name: string, padStr?: string) => {
    switch (name) {
      case 'RepresentationID': return vars.id;
      case 'Bandwidth':        return String(vars.bandwidth);
      case 'Number': {
        const val = String(vars.number ?? 0);
        return padStr ? val.padStart(Number(padStr), '0') : val;
      }
      case 'Time': return String(vars.time ?? 0);
      default:     return `$${name}$`; // unknown variable — leave intact
    }
  });
}

// ---------------------------------------------------------------------------
// URL utilities
// ---------------------------------------------------------------------------

function resolveBaseUrl(el: Element, parentBase: string): string {
  const baseUrlEl = child(el, 'BaseURL');
  if (!baseUrlEl) return parentBase;
  let text = baseUrlEl.textContent?.trim() ?? '';
  if (!text) return parentBase;
  // DASH BaseURL acts as a directory prefix for relative-URL resolution.
  // Add a trailing slash when the last path segment has no file extension
  // (e.g. '/streams' → '/streams/') so that `new URL(rel, base)` appends
  // rather than replaces the last segment.
  // Do NOT add a slash when the BaseURL itself points to a file
  // (e.g. 'video.mp4' — used in SegmentBase single-file addressing).
  if (!text.endsWith('/') && !text.includes('?')) {
    const lastSeg = text.split('/').pop() ?? '';
    if (!/\.[a-z0-9]+$/i.test(lastSeg)) text += '/';
  }
  return resolveUrl(text, parentBase);
}

function resolveUrl(url: string, base: string): string {
  if (!url) return base;
  try { return new URL(url, base).href; } catch { return url; }
}

// ---------------------------------------------------------------------------
// Content-type inference
// ---------------------------------------------------------------------------

function inferContentType(mimeType: string): string {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('text/')  ||
      mimeType.includes('ttml')     ||
      mimeType.includes('vtt'))      return 'text';
  return 'video'; // safe default
}

// ---------------------------------------------------------------------------
// ISO 8601 duration parser  (PT1H30M45.5S, P1DT2H, PT30S, …)
// ---------------------------------------------------------------------------

export function parseDuration(s: string): number {
  const m = s.match(
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 86400 +
          Number(m[2] ?? 0) * 3600  +
          Number(m[3] ?? 0) * 60    +
          Number(m[4] ?? 0));
}

// ---------------------------------------------------------------------------
// DOM query helpers (use localName to be namespace-agnostic)
// ---------------------------------------------------------------------------

function child(el: Element, localName: string): Element | null {
  for (const c of el.children) {
    if (c.localName === localName) return c;
  }
  return null;
}

function children(el: Element, localName: string): Element[] {
  const result: Element[] = [];
  for (const c of el.children) {
    if (c.localName === localName) result.push(c);
  }
  return result;
}
