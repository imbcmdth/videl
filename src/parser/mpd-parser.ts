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

  if (dur)    {
    el.setAttribute('media-presentation-duration', String(parseDuration(dur)));
  }
  if (minBuf) {
    el.setAttribute('min-buffer-time',             String(parseDuration(minBuf)));
  }
  el.setAttribute('type', type);

  const mpdBase = resolveBaseUrl(mpd, baseUrl);
  const mpdDur  = dur ? parseDuration(dur) : undefined;

  // Track the running presentation-time cursor so periods without an explicit
  // @start inherit the cumulative offset of all preceding periods.
  let runningStart = 0;
  for (const period of children(mpd, 'Period')) {
    const { el: periodEl, nextStart } = buildPeriod(period, mpdBase, mpdDur, runningStart);
    el.appendChild(periodEl);
    runningStart = nextStart;
  }

  return el;
}

// ---------------------------------------------------------------------------
// Period → <videl-period>
// ---------------------------------------------------------------------------

function buildPeriod(
  period: Element,
  parentBase: string,
  mpdDuration: number | undefined,
  precedingStart: number
): { el: HTMLElement; nextStart: number } {
  const el = document.createElement('videl-period');

  const id       = period.getAttribute('id') ?? '';
  const startStr = period.getAttribute('start');
  const durStr   = period.getAttribute('duration');

  el.setAttribute('period-id', id);

  // Period@start is optional; when absent the period begins where the previous
  // one ended (cumulative). Only the first period without @start begins at 0.
  const start = startStr ? parseDuration(startStr) : precedingStart;
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
    el.appendChild(buildAdaptationSet(ads, {
      base, parentST: periodST, parentSL: periodSL ?? undefined,
      periodStart: start, periodDuration
    }));
  }

  // If this period has any text adaptation sets, inject a synthetic "None" ADS
  // as the first text candidate so that subtitles are off by default.
  const firstTextAds = el.querySelector('videl-adaptation-set[content-type="text"]');
  if (firstTextAds) {
    el.insertBefore(buildNoneTextAds(), firstTextAds);
  }

  // Advance the cursor: next period starts where this one ends (if known).
  const nextStart = periodDuration !== undefined ? start + periodDuration : start;
  return { el, nextStart };
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
    periodStart:     number;
    periodDuration?: number;
  }
): HTMLElement {
  const el = document.createElement('videl-adaptation-set');

  const lang       = ads.getAttribute('lang')        ?? '';
  // mimeType/codecs are frequently absent on the AdaptationSet and present only
  // on the child Representations. Fall back to the first Representation so the
  // content-type is inferred correctly (otherwise audio-only sets with no ADS
  // mimeType default to "video").
  const firstRep   = child(ads, 'Representation');
  const mimeType   = ads.getAttribute('mimeType') || firstRep?.getAttribute('mimeType') || '';
  const codecs     = ads.getAttribute('codecs')   || firstRep?.getAttribute('codecs')   || '';
  const contentType = ads.getAttribute('contentType') ??
    inferContentType(mimeType, codecs);

  el.setAttribute('content-type', contentType);
  if (mimeType)  {
    el.setAttribute('mime-type', mimeType);
  }
  if (codecs)    {
    el.setAttribute('codecs',    codecs);
  }
  if (lang)      {
    el.setAttribute('lang',      lang);
  }

  // Compute display label following priority: Label child element, label attribute, lang attribute, contentType, 'track'
  const displayLabel = computeAdaptationSetLabel(ads, lang, contentType);
  el.setAttribute('label', displayLabel);

  const base    = resolveBaseUrl(ads, ctx.base);
  const adsST   = readSegTemplate(ads);
  const merged  = mergeSegTemplate(ctx.parentST, adsST);
  // SegmentList / SegmentBase can appear at the AdaptationSet level and are
  // inherited by Representations that don't define their own.
  const adsSL   = child(ads, 'SegmentList') ?? ctx.parentSL;

  // Build all representation elements
  const repElements = children(ads, 'Representation').map(rep =>
    buildRepresentation(rep, {
      base,
      parentST: merged,
      parentSL: adsSL,
      periodStart: ctx.periodStart,
      periodDuration: ctx.periodDuration,
      parentMimeType: mimeType,
      parentCodecs: codecs
    }));

  // For video adaptation sets, sort representations by increasing bandwidth
  if (contentType === 'video') {
    repElements.sort((a, b) => {
      const aBandwidth = Number(a.getAttribute('bandwidth') ?? 0);
      const bBandwidth = Number(b.getAttribute('bandwidth') ?? 0);
      return aBandwidth - bBandwidth;
    });
  }

  // Append representations (sorted for video, original order for audio/text)
  for (const repEl of repElements) {
    el.appendChild(repEl);
  }

  return el;
}

/**
 * Build the synthetic "None" adaptation set injected as the first text ADS
 * in each period that contains text adaptation sets.
 *
 * The "None" ADS:
 *   - has content-type="text" so PickNMixin keys it correctly
 *   - has videl-text-none="" so VidelAdaptationSet hides the TextTrack on activation
 *   - has label="None" for the subtitle menu row
 *   - has NO representations — it is intentionally inert as a data source
 *   - is activated first by default (candidates[0] in selectAdaptationSet)
 */
function buildNoneTextAds(): HTMLElement {
  const el = document.createElement('videl-adaptation-set');
  el.setAttribute('content-type',   'text');
  el.setAttribute('videl-text-none', '');
  el.setAttribute('label',          'None');
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
    periodStart:     number;
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
  if (width)    {
    el.setAttribute('width',    width);
  }
  if (height)   {
    el.setAttribute('height',   height);
  }
  if (mimeType) {
    el.setAttribute('mime-type', mimeType);
  }
  if (codecs)   {
    el.setAttribute('codecs',    codecs);
  }

  const base   = resolveBaseUrl(rep, ctx.base);
  const repST  = readSegTemplate(rep);
  const st     = mergeSegTemplate(ctx.parentST, repST);

  buildSegments(rep, el, {
    base, st, parentSL: ctx.parentSL,
    periodStart: ctx.periodStart, periodDuration: ctx.periodDuration,
    id, bandwidth
  });

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
    periodStart:     number;
    periodDuration?: number;
    id:              string;
    bandwidth:       number;
  }
): void {
  const { base, st, parentSL, periodStart, periodDuration, id, bandwidth } = ctx;

  // Stamp timestamp-offset = periodStart - pto/timescale on the representation
  // element so videl-representation can set SourceBuffer.timestampOffset after
  // the init segment is appended. This corrects presentation-time alignment for
  // any stream with a non-zero @presentationTimeOffset, for all content types.
  if (st) {
    const tsOffset = periodStart - (st.pto ?? 0) / (st.timescale ?? 1);
    if (tsOffset !== 0) {
      repEl.setAttribute('timestamp-offset', String(tsOffset));
    }
  }

  // Priority: SegmentBase > SegmentList > SegmentTemplate (inherited or local)
  const sb = child(rep, 'SegmentBase');
  if (sb) {
    buildSegmentBase(rep, repEl, base); return;
  }

  // SegmentList: check Representation first, then inherited from AdaptationSet.
  const sl = child(rep, 'SegmentList') ?? parentSL;
  if (sl) {
    buildSegmentList(sl, repEl, base); return;
  }

  if (!st?.media) {
    // No SegmentBase / SegmentList / SegmentTemplate: this is the ISO on-demand
    // profile where a Representation carries only a <BaseURL> pointing at a
    // single self-contained file (moov + media). Treat the whole file as one
    // self-initializing segment (no separate init URL).
    if (child(rep, 'BaseURL')) {
      const fileUrl = resolveBaseUrl(rep, base);
      appendSegment(repEl, fileUrl, periodStart, periodDuration ?? 0);
    }
    return;
  }

  // Stamp initialization-url on the representation element.
  if (st.initialization) {
    repEl.setAttribute(
      'initialization-url',
      resolveUrl(expandTemplate(st.initialization, { id, bandwidth }), base)
    );
  }

  if (st.timeline) {
    buildFromTimeline(repEl, st as SegTemplate, periodStart, periodDuration, { id, bandwidth }, base);
  } else if (st.segDuration) {
    buildFromNumber(repEl, st as SegTemplate, periodStart, periodDuration, { id, bandwidth }, base);
  }
}

// SegmentTemplate + SegmentTimeline ($Number$ or $Time$)
function buildFromTimeline(
  repEl:   HTMLElement,
  st:      SegTemplate,
  periodStart: number,
  periodDuration: number | undefined,
  vars:    { id: string; bandwidth: number },
  base:    string
): void {
  const { media, timescale, startNumber, pto, timeline } = st;
  if (!media || !timeline) {
    return;
  }

  let segNumber = startNumber;
  let t = 0; // running time cursor in timescale units

  for (const s of timeline) {
    const sT = s.hasAttribute('t') ? Number(s.getAttribute('t')) : t;
    const d  = Number(s.getAttribute('d') ?? 0);
    if (d === 0) {
      continue;
    }
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
      // Absolute presentation time: period start + period-relative time. Keeps
      // the pump's segment selection aligned with the continuous MSE buffer
      // across multi-period streams.
      const startTime = periodStart + (t - pto) / timescale;
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
  periodStart: number,
  periodDuration: number | undefined,
  vars:    { id: string; bandwidth: number },
  base:    string
): void {
  const { media, timescale, startNumber, segDuration } = st;
  if (!media || !segDuration) {
    return;
  }

  const segDurSec = segDuration / timescale;
  if (periodDuration === undefined || segDurSec <= 0) {
    return;
  }

  const count = Math.ceil(periodDuration / segDurSec);

  for (let i = 0; i < count; i++) {
    const segNumber = startNumber + i;
    const url       = resolveUrl(expandTemplate(media, { ...vars, number: segNumber }), base);
    // Absolute presentation time so multi-period segments don't collide at 0.
    const startTime = periodStart + i * segDurSec;

    appendSegment(repEl, url, startTime, segDurSec);
  }
}

// SegmentBase → single segment + init
function buildSegmentBase(rep: Element, repEl: HTMLElement, base: string): void {
  const sb  = child(rep, 'SegmentBase');
  if (!sb) {
    return;
  }

  const segUrl    = resolveBaseUrl(rep, base);
  const indexRange = sb.getAttribute('indexRange');

  const init = child(sb, 'Initialization');
  if (init) {
    const initRange = init.getAttribute('range');
    const initUrl   = init.getAttribute('sourceURL');
    repEl.setAttribute('initialization-url', initUrl ? resolveUrl(initUrl, segUrl) : segUrl);
    if (initRange) {
      repEl.setAttribute('initialization-byte-range', initRange);
    }
  }

  const segEl = document.createElement('videl-segment');
  segEl.setAttribute('url', segUrl);
  if (indexRange) {
    segEl.setAttribute('byte-range', indexRange);
  }
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
      if (range) {
        repEl.setAttribute('initialization-byte-range', range);
      }
    }
  }

  let idx = 0;
  for (const su of children(sl, 'SegmentURL')) {
    const media      = su.getAttribute('media') ?? '';
    const mediaRange = su.getAttribute('mediaRange');

    const segEl = document.createElement('videl-segment');
    segEl.setAttribute('url', resolveUrl(media, base));
    if (mediaRange) {
      segEl.setAttribute('byte-range', mediaRange);
    }
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
  if (!st) {
    return undefined;
  }

  // S elements live inside a <SegmentTimeline> child, not directly under
  // <SegmentTemplate>.
  const timelineEl  = child(st, 'SegmentTimeline');
  const timelineEls = timelineEl ? children(timelineEl, 'S') : [];

  return {
    media: st.getAttribute('media')          ?? undefined,
    initialization: st.getAttribute('initialization') ?? undefined,
    timescale: Number(st.getAttribute('timescale')              ?? 1),
    startNumber: Number(st.getAttribute('startNumber')            ?? 1),
    pto: Number(st.getAttribute('presentationTimeOffset') ?? 0),
    segDuration: st.hasAttribute('duration') ?
      Number(st.getAttribute('duration')) :
      undefined,
    timeline: timelineEls.length > 0 ? timelineEls : undefined
  };
}

/** Merge two partial SegTemplate objects; child wins per field. */
function mergeSegTemplate(
  parent?: Partial<SegTemplate>,
  child2?: Partial<SegTemplate>
): SegTemplate | undefined {
  if (!parent && !child2) {
    return undefined;
  }
  return {
    media: child2?.media          ?? parent?.media,
    initialization: child2?.initialization ?? parent?.initialization,
    timescale: child2?.timescale      ?? parent?.timescale      ?? 1,
    startNumber: child2?.startNumber    ?? parent?.startNumber    ?? 1,
    pto: child2?.pto            ?? parent?.pto            ?? 0,
    segDuration: child2?.segDuration    ?? parent?.segDuration,
    timeline: child2?.timeline       ?? parent?.timeline
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
  if (!baseUrlEl) {
    return parentBase;
  }
  let text = baseUrlEl.textContent?.trim() ?? '';
  if (!text) {
    return parentBase;
  }
  // DASH BaseURL acts as a directory prefix for relative-URL resolution.
  // Add a trailing slash when the last path segment has no file extension
  // (e.g. '/streams' → '/streams/') so that `new URL(rel, base)` appends
  // rather than replaces the last segment.
  // Do NOT add a slash when the BaseURL itself points to a file
  // (e.g. 'video.mp4' — used in SegmentBase single-file addressing).
  if (!text.endsWith('/') && !text.includes('?')) {
    const lastSeg = text.split('/').pop() ?? '';
    if (!/\.[a-z0-9]+$/i.test(lastSeg)) {
      text += '/';
    }
  }
  return resolveUrl(text, parentBase);
}

function resolveUrl(url: string, base: string): string {
  if (!url) {
    return base;
  }
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Content-type inference
// ---------------------------------------------------------------------------

function inferContentType(mimeType: string, codecs = ''): string {
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType.startsWith('text/')  ||
      mimeType.includes('ttml')     ||
      mimeType.includes('vtt')      ||
      mimeType.includes('cea'))      {
    return 'text';
  }

  // Fall back to codec sniffing when the MIME type is generic/absent.
  const c = codecs.toLowerCase();
  if (/^(mp4a|ac-[34]|ec-3|opus|vorbis|flac|dts|alac)/.test(c)) {
    return 'audio';
  }
  if (/^(avc|hvc|hev|dvh|vp0?[89]|av01|mp4v)/.test(c))          {
    return 'video';
  }
  if (/^(wvtt|stpp|ttml)/.test(c))                              {
    return 'text';
  }
  return 'video'; // safe default
}

// ---------------------------------------------------------------------------
// AdaptationSet display label computation
// ---------------------------------------------------------------------------

function computeAdaptationSetLabel(ads: Element, lang: string, contentType: string): string {
  // Priority order: Label child element, label attribute, lang attribute, contentType, 'track'

  // 1. Check for Label child element
  const labelEl = child(ads, 'Label');
  if (labelEl) {
    const text = labelEl.textContent?.trim();
    if (text) {
      return text;
    }
  }

  // 2. Check label attribute
  const label = ads.getAttribute('label');
  if (label) {
    return label;
  }

  // 3. Check lang attribute
  if (lang) {
    return lang;
  }

  // 4. Fall back to contentType or 'track'
  return contentType || 'track';
}

// ---------------------------------------------------------------------------
// ISO 8601 duration parser  (PT1H30M45.5S, P1DT2H, PT30S, …)
// ---------------------------------------------------------------------------

export function parseDuration(s: string): number {
  const m = s.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!m) {
    return 0;
  }
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
    if (c.localName === localName) {
      return c;
    }
  }
  return null;
}

function children(el: Element, localName: string): Element[] {
  const result: Element[] = [];
  for (const c of el.children) {
    if (c.localName === localName) {
      result.push(c);
    }
  }
  return result;
}
