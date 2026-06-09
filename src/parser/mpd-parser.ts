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

import { expandTemplate, resolveUrl } from './template-utils';

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

export function parseMpd(
  xml:     string,
  baseUrl: string,
  options: { tsbdDefault?: number } = {}
): HTMLElement {
  const xmlDoc = new DOMParser().parseFromString(xml, 'text/xml');

  const parseErr = xmlDoc.querySelector('parsererror');
  if (parseErr) {
    throw new ParseError(`Malformed XML: ${parseErr.textContent?.trim()}`);
  }

  const mpd = xmlDoc.documentElement;
  if (mpd.localName !== 'MPD') {
    throw new ParseError(`Root element must be MPD, got <${mpd.localName}>`);
  }

  // DASH Annex I (I.2): extract the MPD URL's query string so it can be used
  // as initialQueryString when UrlQueryInfo/@useMPDUrlQuery="true".
  let mpdQueryString = '';
  try {
    mpdQueryString = new URL(baseUrl).search.replace(/^\?/, '');
  } catch {
    // baseUrl is not a valid absolute URL — ignore
  }

  return buildPresentation(mpd, baseUrl, mpdQueryString, options.tsbdDefault ?? 0);
}

// ---------------------------------------------------------------------------
// MPD → <videl-presentation>
// ---------------------------------------------------------------------------

function buildPresentation(
  mpd:            Element,
  baseUrl:        string,
  mpdQueryString: string = '',
  tsbdDefault:    number = 0
): HTMLElement {
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

  // Live / dynamic stream metadata passed down to representations so they can
  // compute segment availability from wall clock time.
  const isDynamic = type === 'dynamic';
  // When timeShiftBufferDepth is absent, fall back to tsbdDefault (supplied by
  // the player via `time-shift-buffer-depth-default`). Per ADR-0005 the
  // product default is 0 (pure-live, no window), diverging from the ISO spec
  // default of infinite. Consumers may override by setting the player attr.
  const tsbdAttr = mpd.getAttribute('timeShiftBufferDepth');
  const tsbd = isDynamic ?
    (tsbdAttr !== null ? parseDuration(tsbdAttr) : tsbdDefault) :
    0;
  const liveCtx: LiveContext | undefined = isDynamic ? {
    availabilityStartTime: parseIsoDateTime(mpd.getAttribute('availabilityStartTime') ?? ''),
    timeShiftBufferDepth: tsbd
  } : undefined;

  // No timeShiftBufferDepth on a live stream means no DVR window — seeking
  // should be disabled and playback starts at the live edge mapped to time 0.
  if (isDynamic && tsbd === 0) {
    el.setAttribute('no-seek', '');
  }

  // Track the running presentation-time cursor so periods without an explicit
  // @start inherit the cumulative offset of all preceding periods.
  const mpdUrlQuery = computeUrlQuery(mpd, mpdQueryString);

  let runningStart = 0;
  for (const period of children(mpd, 'Period')) {
    const { el: periodEl, nextStart } = buildPeriod(period, mpdBase, mpdDur, runningStart, liveCtx, mpdQueryString, mpdUrlQuery);
    el.appendChild(periodEl);
    runningStart = nextStart;
  }

  return el;
}

/** Metadata from MPD-level live attributes, propagated to each representation. */
interface LiveContext {
  /** Unix epoch seconds from MPD@availabilityStartTime. */
  availabilityStartTime: number;
  /** Seconds from MPD@timeShiftBufferDepth (0 if absent). */
  timeShiftBufferDepth:  number;
}

/**
 * Parse an ISO 8601 datetime string to Unix epoch seconds.
 * Returns 0 for invalid or missing strings.
 */
function parseIsoDateTime(s: string): number {
  if (!s) {
    return 0;
  }
  const ms = Date.parse(s);
  return isNaN(ms) ? 0 : ms / 1000;
}

// ---------------------------------------------------------------------------
// Period → <videl-period>
// ---------------------------------------------------------------------------

function buildPeriod(
  period:          Element,
  parentBase:      string,
  mpdDuration:     number | undefined,
  precedingStart:  number,
  liveCtx?:        LiveContext,
  mpdQueryString?: string,
  parentUrlQuery?: string
): { el: HTMLElement; nextStart: number } {
  const el = document.createElement('videl-period');

  const id       = period.getAttribute('id') ?? '';
  const startStr = period.getAttribute('start');
  const durStr   = period.getAttribute('duration');

  el.setAttribute('period-id', id);

  // Period@start is optional; when absent the period begins where the previous
  // one ended (cumulative). Only the first period without @start begins at 0.
  // `start` here is the presentation-relative offset (seconds from period 0).
  const start = startStr ? parseDuration(startStr) : precedingStart;

  // For live streams, stamp wall-clock epoch seconds on the period element:
  //   wallStart = availabilityStartTime + presentationOffset
  // This is the epoch second at which this period's media begins. All downstream
  // segment arithmetic uses this value directly, eliminating coordinate-space
  // conversions in the element tree (ADR-0005 unified wall-clock model).
  //
  // For VOD, wallStart = 0 + start = start (wallAnchor = 0, identity mapping).
  const wallStart = liveCtx ?
    liveCtx.availabilityStartTime + start :
    start;
  el.setAttribute('start', String(wallStart));

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

  const periodUrlQuery = computeUrlQuery(period, mpdQueryString ?? '');
  const childUrlQuery  = joinUrlQueries(periodUrlQuery, parentUrlQuery ?? '');

  const periodSL = child(period, 'SegmentList');
  for (const ads of children(period, 'AdaptationSet')) {
    el.appendChild(buildAdaptationSet(ads, {
      base, parentST: periodST, parentSL: periodSL ?? undefined,
      // Pass wallStart so representations compute epoch-based segment times.
      periodStart: wallStart, periodDuration, liveCtx,
      mpdQueryString: mpdQueryString ?? '', parentUrlQuery: childUrlQuery
    }));
  }

  // If this period has any text adaptation sets, inject a synthetic "None" ADS
  // as the first text candidate so that subtitles are off by default.
  const firstTextAds = el.querySelector('videl-adaptation-set[content-type="text"]');
  if (firstTextAds) {
    el.insertBefore(buildNoneTextAds(), firstTextAds);
  }

  // Build EventStream children (MPD timed events — peer to AdaptationSet).
  for (const es of children(period, 'EventStream')) {
    el.appendChild(buildEventStream(es, wallStart));
  }

  // Advance the cursor in presentation-relative space (used to compute the
  // next period's presentation offset before converting to wall-clock).
  const nextStart = periodDuration !== undefined ? start + periodDuration : start;
  return { el, nextStart };
}

// ---------------------------------------------------------------------------
// AdaptationSet → <videl-adaptation-set>
// ---------------------------------------------------------------------------

function buildAdaptationSet(
  ads: Element,
  ctx: {
    base:             string;
    parentST?:        Partial<SegTemplate>;
    parentSL?:        Element;   // inherited SegmentList
    periodStart:      number;
    periodDuration?:  number;
    liveCtx?:         LiveContext;
    mpdQueryString?:  string;
    parentUrlQuery?:  string;
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

  const adsUrlQuery   = computeUrlQuery(ads, ctx.mpdQueryString ?? '');
  const childUrlQuery = joinUrlQueries(adsUrlQuery, ctx.parentUrlQuery ?? '');

  // Build all representation elements
  const repElements = children(ads, 'Representation').map(rep =>
    buildRepresentation(rep, {
      base,
      parentST: merged,
      parentSL: adsSL,
      periodStart: ctx.periodStart,
      periodDuration: ctx.periodDuration,
      parentMimeType: mimeType,
      parentCodecs: codecs,
      liveCtx: ctx.liveCtx,
      mpdQueryString: ctx.mpdQueryString ?? '',
      parentUrlQuery: childUrlQuery
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
// EventStream → <videl-event-stream> + <videl-event> children
// ---------------------------------------------------------------------------

/**
 * Build a `<videl-event-stream>` element from an MPD `<EventStream>` node.
 *
 * The EventStream is a peer of AdaptationSet inside a Period — it carries
 * DASH timed events inline in the manifest rather than in media segments.
 *
 * Attribute mapping (no `videl-` prefix — these are manifest-derived values):
 *   scheme-id-uri              ← EventStream@schemeIdUri
 *   value                      ← EventStream@value (optional)
 *   timescale                  ← EventStream@timescale (default 1)
 *   presentation-time-offset   ← EventStream@presentationTimeOffset (default 0)
 *   period-start               ← wall-clock epoch seconds of the period start
 */
function buildEventStream(es: Element, periodStart: number): HTMLElement {
  const el = document.createElement('videl-event-stream');

  el.setAttribute('scheme-id-uri', es.getAttribute('schemeIdUri') ?? '');

  const timescale = Number(es.getAttribute('timescale') ?? '1') || 1;
  const pto       = Number(es.getAttribute('presentationTimeOffset') ?? '0');
  el.setAttribute('timescale',                String(timescale));
  el.setAttribute('presentation-time-offset', String(pto));

  if (es.hasAttribute('value')) {
    el.setAttribute('value', es.getAttribute('value')!);
  }

  el.setAttribute('period-start', String(periodStart));

  for (const ev of children(es, 'Event')) {
    el.appendChild(buildEvent(ev));
  }

  return el;
}

/**
 * Build a `<videl-event>` element from an MPD `<Event>` node.
 *
 * Attribute mapping (no `videl-` prefix — manifest-derived values):
 *   presentation-time  ← Event@presentationTime (raw ticks; default 0)
 *   duration           ← Event@duration (raw ticks; omitted when absent)
 *   id                 ← Event@id (omitted when absent)
 *   message-data       ← Event@messageData (base64; omitted when absent)
 *
 * Inline text content is preserved as the element's textContent for use as
 * the event payload when @messageData is absent.
 */
function buildEvent(ev: Element): HTMLElement {
  const el = document.createElement('videl-event');

  if (ev.hasAttribute('presentationTime')) {
    el.setAttribute('presentation-time', ev.getAttribute('presentationTime')!);
  }
  if (ev.hasAttribute('duration')) {
    el.setAttribute('duration', ev.getAttribute('duration')!);
  }
  if (ev.hasAttribute('id')) {
    el.setAttribute('id', ev.getAttribute('id')!);
  }
  if (ev.hasAttribute('messageData')) {
    el.setAttribute('message-data', ev.getAttribute('messageData')!);
  }

  // Preserve inline payload as text content.
  const payload = ev.textContent?.trim() ?? '';
  if (payload) {
    el.textContent = payload;
  }

  return el;
}

// ---------------------------------------------------------------------------
// Representation → <videl-representation>
// ---------------------------------------------------------------------------

function buildRepresentation(
  rep: Element,
  ctx: {
    base:             string;
    parentST?:        Partial<SegTemplate>;
    parentSL?:        Element;
    periodStart:      number;
    periodDuration?:  number;
    parentMimeType:   string;
    parentCodecs:     string;
    liveCtx?:         LiveContext;
    mpdQueryString?:  string;
    parentUrlQuery?:  string;
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

  const repUrlQuery = computeUrlQuery(rep, ctx.mpdQueryString ?? '');
  const urlQuery    = joinUrlQueries(repUrlQuery, ctx.parentUrlQuery ?? '');

  buildSegments(rep, el, {
    base, st, parentSL: ctx.parentSL,
    periodStart: ctx.periodStart, periodDuration: ctx.periodDuration,
    id, bandwidth, liveCtx: ctx.liveCtx, urlQuery
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
    liveCtx?:        LiveContext;
    urlQuery?:       string;
  }
): void {
  const { base, st, parentSL, periodStart, periodDuration, id, bandwidth, liveCtx, urlQuery } = ctx;

  // Stamp timestamp-offset = periodStart - pto/timescale on the representation
  // element. For VOD (wallAnchor = 0, periodStart = presentation offset) this
  // is read by videl-representation #startInit to correct presentation-time
  // alignment for non-zero @presentationTimeOffset.
  //
  // For live, videl-representation #startInit ignores this attribute and instead
  // uses the `availability-start-time` attribute as the wall-clock offset, so
  // ManagedSourceBuffer can translate it correctly. The stamped value is unused
  // for live but harmless.
  if (st) {
    const tsOffset = periodStart - (st.pto ?? 0) / (st.timescale ?? 1);
    if (tsOffset !== 0) {
      repEl.setAttribute('timestamp-offset', String(tsOffset));
    }
  }

  // Priority: SegmentBase > SegmentList > SegmentTemplate (inherited or local)

  // ── SegmentBase ────────────────────────────────────────────────────────────
  // Stamp addressing attributes for VidelRepresentation to process at activation
  // time.  If indexRange is present the representation will fetch the sidx box
  // and create one <videl-segment> per entry; otherwise a single whole-file
  // segment is created.
  const sb = child(rep, 'SegmentBase');
  if (sb) {
    stampSegmentBase(rep, repEl, base);
    return;
  }

  // ── SegmentList ────────────────────────────────────────────────────────────
  // 1:1 XML-to-DOM transform — no computation required, stays in the parser.
  const sl = child(rep, 'SegmentList') ?? parentSL;
  if (sl) {
    buildSegmentList(sl, repEl, base, urlQuery);
    return;
  }

  if (!st?.media) {
    // No SegmentBase / SegmentList / SegmentTemplate: ISO on-demand profile
    // where a Representation carries only a <BaseURL> pointing at a single
    // self-contained file (moov + media).  Stamp segment-base-url so
    // VidelRepresentation creates one self-initializing segment at activation.
    if (child(rep, 'BaseURL')) {
      const fileUrl = resolveBaseUrl(rep, base);
      repEl.setAttribute('segment-base-url', fileUrl);
      // period-duration is needed by VidelRepresentation to set the segment
      // duration attribute on the single whole-file segment.
      if (periodDuration !== undefined) {
        repEl.setAttribute('period-duration', String(periodDuration));
      }
    }
    return;
  }

  // ── SegmentTemplate ────────────────────────────────────────────────────────
  // Stamp raw template data.  VidelRepresentation expands $Number$/$Time$ and
  // creates <videl-segment> children at activation time.
  stampSegmentTemplate(repEl, st as SegTemplate, { id, bandwidth }, base, liveCtx, urlQuery);
}

// ---------------------------------------------------------------------------
// Attribute-stamping helpers (no segment element creation)
// ---------------------------------------------------------------------------

/**
 * Stamp SegmentBase addressing attributes onto the representation element.
 * VidelRepresentation reads these at activation time to either:
 *   - fetch + parse the sidx box (if segment-base-index-range is present), or
 *   - create a single <videl-segment> covering the whole file.
 */
function stampSegmentBase(rep: Element, repEl: HTMLElement, base: string): void {
  const sb     = child(rep, 'SegmentBase')!;
  // `base` already has the Representation's <BaseURL> resolved into it by the
  // caller (buildRepresentation → resolveBaseUrl).  Do NOT call resolveBaseUrl
  // again here or the BaseURL path component gets appended twice.
  const segUrl = base;

  const init = child(sb, 'Initialization');
  if (init) {
    const initRange = init.getAttribute('range');
    const initUrl   = init.getAttribute('sourceURL');
    repEl.setAttribute('initialization-url', initUrl ? resolveUrl(initUrl, segUrl) : segUrl);
    if (initRange) {
      repEl.setAttribute('initialization-byte-range', initRange);
    }
  }

  repEl.setAttribute('segment-base-url', segUrl);

  const indexRange = sb.getAttribute('indexRange');
  if (indexRange) {
    repEl.setAttribute('segment-base-index-range', indexRange);
    // When there is no explicit <Initialization> element but an indexRange is
    // present, the init segment is implicitly the bytes before the index:
    // bytes 0 through (indexRange.start - 1).  Stamp synthetic init attributes
    // so VidelRepresentation fetches them instead of treating the representation
    // as self-initialising.
    if (!init) {
      const indexStart = Number(indexRange.split('-')[0]);
      if (!isNaN(indexStart) && indexStart > 0) {
        repEl.setAttribute('initialization-url', segUrl);
        repEl.setAttribute('initialization-byte-range', `0-${indexStart - 1}`);
      }
    }
  }
}

/**
 * Stamp SegmentTemplate addressing attributes onto the representation element.
 *
 * $RepresentationID$ and $Bandwidth$ are pre-expanded here (they are known
 * at parse time and constant for the representation).  $Number$ and $Time$
 * are left unexpanded — VidelRepresentation substitutes those per-segment.
 *
 * The media template is also resolved against the base URL so
 * VidelRepresentation does not need to know the base URL at activation time.
 *
 * Example after pre-expansion + resolution:
 *   input:  media="video/$RepresentationID$/seg$Number$.m4s", base="https://cdn.example.com/"
 *   output: "https://cdn.example.com/video/vid1/seg$Number$.m4s"
 */
function stampSegmentTemplate(
  repEl:    HTMLElement,
  st:       SegTemplate,
  vars:     { id: string; bandwidth: number },
  base:     string,
  liveCtx?: LiveContext,
  urlQuery?: string
): void {
  // Stamp initialization-url.
  if (st.initialization) {
    const initUrl = resolveUrl(expandTemplate(st.initialization, vars), base);
    repEl.setAttribute('initialization-url', appendUrlQuery(initUrl, urlQuery ?? ''));
  }

  // Pre-expand identity vars in the media template then resolve against base.
  // $Number$ and $Time$ tokens survive because vars does not include them,
  // and expandTemplate preserves unknown/undefined variables intact.
  // The URL query is appended to the pre-resolved template so that it is
  // present on every per-segment URL expanded later by VidelRepresentation.
  const resolvedMedia = appendUrlQuery(
    resolveUrl(expandTemplate(st.media!, vars), base),
    urlQuery ?? ''
  );
  repEl.setAttribute('segment-template-media',        resolvedMedia);
  repEl.setAttribute('segment-template-timescale',    String(st.timescale));
  repEl.setAttribute('segment-template-start-number', String(st.startNumber));
  repEl.setAttribute('segment-template-pto',          String(st.pto));

  if (st.segDuration !== undefined) {
    repEl.setAttribute('segment-template-duration', String(st.segDuration));
  }

  if (st.timeline && st.timeline.length > 0) {
    // Serialize the S-element array to JSON.  Only t/d/r are needed; t is
    // optional (the representation uses the running cursor if absent).
    const timelineJson = JSON.stringify(st.timeline.map(s => {
      const entry: { d: number; r: number; t?: number } = {
        d: Number(s.getAttribute('d') ?? 0),
        r: Number(s.getAttribute('r') ?? 0)
      };
      if (s.hasAttribute('t')) {
        entry.t = Number(s.getAttribute('t'));
      }
      return entry;
    }));
    repEl.setAttribute('segment-template-timeline', timelineJson);
  }

  // ── Live / dynamic stream metadata ─────────────────────────────────────────
  // Stamp these so VidelRepresentation can compute segment availability from
  // wall clock time without any manifest refresh.
  if (liveCtx) {
    repEl.setAttribute('live', '');
    repEl.setAttribute('availability-start-time', String(liveCtx.availabilityStartTime));
    if (liveCtx.timeShiftBufferDepth > 0) {
      repEl.setAttribute('time-shift-buffer-depth', String(liveCtx.timeShiftBufferDepth));
    }
  }
}

// SegmentList → one segment per SegmentURL
function buildSegmentList(sl: Element, repEl: HTMLElement, base: string, urlQuery?: string): void {
  const timescale  = Number(sl.getAttribute('timescale') ?? 1);
  const segDuration = sl.hasAttribute('duration') ? Number(sl.getAttribute('duration')) : undefined;

  // Initialization
  const init = child(sl, 'Initialization');
  if (init) {
    const src   = init.getAttribute('sourceURL');
    const range = init.getAttribute('range');
    if (src) {
      repEl.setAttribute('initialization-url', appendUrlQuery(resolveUrl(src, base), urlQuery ?? ''));
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
    segEl.setAttribute('url', appendUrlQuery(resolveUrl(media, base), urlQuery ?? ''));
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

// ---------------------------------------------------------------------------
// DASH Annex I — URL query parameter helpers
// ---------------------------------------------------------------------------

/**
 * Compute the finalQueryString for the first URL-parameter descriptor
 * (EssentialProperty or SupplementalProperty with
 * schemeIdUri="urn:mpeg:dash:urlparam:2014") found on `el`.
 *
 * Implements I.2.3.2 (initialQueryString) and I.2.3.3 (finalQueryString).
 * Returns '' when no applicable descriptor is found.
 */
function computeUrlQuery(el: Element, mpdQueryString: string): string {
  for (const propName of ['EssentialProperty', 'SupplementalProperty'] as const) {
    for (const ep of children(el, propName)) {
      if (ep.getAttribute('schemeIdUri') !== 'urn:mpeg:dash:urlparam:2014') {
        continue;
      }
      const uqi = child(ep, 'UrlQueryInfo');
      if (!uqi) {
        continue;
      }

      // I.2.3.2: build initialQueryString
      const useMPD    = uqi.getAttribute('useMPDUrlQuery') === 'true';
      const qsAttr    = uqi.getAttribute('queryString') ?? '';
      let initialQS   = '';
      if (useMPD && qsAttr) {
        initialQS = mpdQueryString ? `${mpdQueryString}&${qsAttr}` : qsAttr;
      } else if (useMPD) {
        initialQS = mpdQueryString;
      } else {
        initialQS = qsAttr;
      }

      if (!initialQS) {
        return '';
      }

      const queryTemplate = uqi.getAttribute('queryTemplate');
      if (!queryTemplate) {
        // No template — pass initialQueryString through as-is.
        return initialQS;
      }

      // I.2.3.3: substitute $querypart$ and $query:<param>$ identifiers.
      // Build param lookup table from initialQS.
      const params: Record<string, string> = {};
      for (const pair of initialQS.split('&')) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx > 0) {
          params[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1);
        }
      }

      let finalQS = queryTemplate;
      // Handle $$ escape first (replace with a sentinel, restore at end).
      finalQS = finalQS.replace(/\$\$/g, '\x00');
      // $querypart$ → entire initialQS
      finalQS = finalQS.replace(/\$querypart\$/g, initialQS);
      // $query:<param>$ → value of named param (empty string if absent)
      finalQS = finalQS.replace(/\$query:([^$]+)\$/g, (_, param: string) => params[param] ?? '');
      // Restore $$ → $
      finalQS = finalQS.replace(/\x00/g, '$');

      return finalQS;
    }
  }
  return '';
}

/**
 * Concatenate two finalQueryString values.
 * Per I.2.3.3 the more-specific (Rep) level's string comes before the less-
 * specific (ADS / Period / MPD) inherited string.
 */
function joinUrlQueries(specific: string, inherited: string): string {
  if (specific && inherited) {
    return `${specific}&${inherited}`;
  }
  return specific || inherited;
}

/**
 * Append a query string to a URL per I.2.3.4:
 * use '?' when the URL has no query, '&' when it already does.
 */
function appendUrlQuery(url: string, query: string): string {
  if (!query) {
    return url;
  }
  return url.includes('?') ? `${url}&${query}` : `${url}?${query}`;
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
