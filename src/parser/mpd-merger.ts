/**
 * MPD DOM merger — applies a freshly-parsed MPD tree onto an existing live
 * <videl-presentation> element tree without disturbing active/fetched segments.
 *
 * Public API:
 *   applyMpdUpdate(existing, newTree): boolean
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Merge a freshly-parsed MPD tree into an existing <videl-presentation>.
 *
 * Rules:
 * - Top-level manifest attributes are always updated.
 * - Periods are matched by `dash-id`; new ones are appended.
 * - Segments are matched by `url`; new ones are appended to their
 *   representation; unfetched stale ones are removed.
 * - Active/fetched segments and active periods are never disturbed.
 *
 * Returns true if any structural change was applied (useful for tests / tracing).
 */
export function applyMpdUpdate(
  existing: HTMLElement,  // live <videl-presentation> DOM node
  newTree:  HTMLElement,  // freshly-parsed <videl-presentation> from parseMpd()
): boolean {
  let changed = false;

  // 1. Top-level MPD attribute passthrough
  const topLevelAttrs = [
    'type',
    'media-presentation-duration',
    'min-buffer-time',
    'minimum-update-period',
    'publish-time',
    'no-seek',
  ];
  for (const attr of topLevelAttrs) {
    const newVal = newTree.getAttribute(attr);
    if (newVal !== null) {
      if (existing.getAttribute(attr) !== newVal) {
        existing.setAttribute(attr, newVal);
        changed = true;
      }
    } else if (existing.hasAttribute(attr)) {
      existing.removeAttribute(attr);
      changed = true;
    }
  }

  // 2. Period merge
  const existingPeriodMap = new Map<string, Element>();
  for (const child of existing.children) {
    if (child.tagName.toLowerCase() === 'videl-period') {
      const id = child.getAttribute('dash-id') ?? '';
      existingPeriodMap.set(id, child);
    }
  }

  for (const newPeriod of newTree.children) {
    if (newPeriod.tagName.toLowerCase() !== 'videl-period') {
      continue;
    }
    const id = newPeriod.getAttribute('dash-id') ?? '';
    if (existingPeriodMap.has(id)) {
      const c = mergePeriod(existingPeriodMap.get(id)!, newPeriod);
      if (c) {
        changed = true;
      }
    } else {
      existing.appendChild(newPeriod);
      changed = true;
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Internal merge helpers
// ---------------------------------------------------------------------------

function mergePeriod(existing: Element, newPeriod: Element): boolean {
  let changed = false;

  // Update mutable period attributes
  for (const attr of ['start', 'duration']) {
    const newVal = newPeriod.getAttribute(attr);
    if (newVal !== null) {
      if (existing.getAttribute(attr) !== newVal) {
        existing.setAttribute(attr, newVal);
        changed = true;
      }
    } else if (existing.hasAttribute(attr)) {
      existing.removeAttribute(attr);
      changed = true;
    }
  }

  // Match adaptation sets by dash-id when present, falling back to content-type
  const existingAdsMap = buildAdsMap(existing);
  for (const newAds of newPeriod.children) {
    if (newAds.tagName.toLowerCase() !== 'videl-adaptation-set') {
      continue;
    }
    const key = adsKey(newAds);
    if (existingAdsMap.has(key)) {
      const c = mergeAdaptationSet(existingAdsMap.get(key)!, newAds);
      if (c) {
        changed = true;
      }
    }
    // New adaptation sets (e.g. new audio language track mid-stream) are out
    // of scope — they would require a new SourceBuffer. Log and skip.
    // Note: we only warn if the key is new AND the content-type already exists
    // (which is the problematic case). Truly new content types are also skipped.
  }

  // Match event streams by scheme-id-uri + value; merge their events by dash-id.
  const existingEsMap = buildEventStreamMap(existing);
  for (const newEs of newPeriod.children) {
    if (newEs.tagName.toLowerCase() !== 'videl-event-stream') {
      continue;
    }
    const key = eventStreamKey(newEs);
    if (existingEsMap.has(key)) {
      const c = mergeEventStream(existingEsMap.get(key)!, newEs);
      if (c) {
        changed = true;
      }
    } else {
      // New event stream — append. The event-stream videlUpdate iterates live
      // child list so newly appended <videl-event-stream> nodes are picked up
      // automatically on the next tick.
      existing.appendChild(newEs);
      changed = true;
    }
  }

  return changed;
}

/**
 * Build a key → element map for adaptation sets within a period.
 * Key: dash-id when present, else content-type.
 */
function buildAdsMap(period: Element): Map<string, Element> {
  const map = new Map<string, Element>();
  for (const child of period.children) {
    if (child.tagName.toLowerCase() === 'videl-adaptation-set') {
      const key = adsKey(child);
      if (key && !map.has(key)) {
        map.set(key, child);
      }
    }
  }
  return map;
}

/** Compute the match key for an adaptation set element. */
function adsKey(el: Element): string {
  return el.getAttribute('dash-id') ?? el.getAttribute('content-type') ?? '';
}

function mergeAdaptationSet(existing: Element, newAds: Element): boolean {
  let changed = false;

  // Match representations by dash-id attribute
  const existingRepMap = new Map<string, Element>();
  for (const child of existing.children) {
    if (child.tagName.toLowerCase() === 'videl-representation') {
      existingRepMap.set(child.getAttribute('dash-id') ?? '', child);
    }
  }

  for (const newRep of newAds.children) {
    if (newRep.tagName.toLowerCase() !== 'videl-representation') {
      continue;
    }
    const id = newRep.getAttribute('dash-id') ?? '';
    if (existingRepMap.has(id)) {
      const c = mergeRepresentation(existingRepMap.get(id)!, newRep);
      if (c) {
        changed = true;
      }
    }
    // New representations: out of scope — ignore.
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Event stream merge helpers
// ---------------------------------------------------------------------------

/**
 * Build a key → element map for event streams within a period.
 * Key: scheme-id-uri + '|' + value (empty string when @value absent).
 */
function buildEventStreamMap(period: Element): Map<string, Element> {
  const map = new Map<string, Element>();
  for (const child of period.children) {
    if (child.tagName.toLowerCase() === 'videl-event-stream') {
      const key = eventStreamKey(child);
      if (!map.has(key)) {
        map.set(key, child);
      }
    }
  }
  return map;
}

/** Compute the match key for a <videl-event-stream> element. */
function eventStreamKey(el: Element): string {
  const scheme = el.getAttribute('scheme-id-uri') ?? '';
  const value  = el.getAttribute('value') ?? '';
  return `${scheme}|${value}`;
}

/**
 * Merge events within a matched event stream.
 *
 * - New events (by dash-id) are appended.
 * - Events absent from the new stream that do not have `videl-state` are removed.
 * - Events with `videl-state` (already dispatched / in-flight) are preserved.
 * - Events without a dash-id are not matchable and are never removed.
 */
function mergeEventStream(existing: Element, newEs: Element): boolean {
  let changed = false;

  // Collect existing event ids
  const existingIds = new Set<string>();
  for (const child of existing.children) {
    if (child.tagName.toLowerCase() === 'videl-event') {
      const id = child.getAttribute('dash-id') ?? '';
      if (id) {
        existingIds.add(id);
      }
    }
  }

  // Collect new event ids and append new events
  const newIds = new Set<string>();
  for (const newEv of newEs.children) {
    if (newEv.tagName.toLowerCase() !== 'videl-event') {
      continue;
    }
    const id = newEv.getAttribute('dash-id') ?? '';
    if (id) {
      newIds.add(id);
    }
    if (id && !existingIds.has(id)) {
      existing.appendChild(newEv);
      changed = true;
    }
  }

  // Remove events absent from the new stream that have not been dispatched.
  // Events without a dash-id are not matchable and are never removed.
  for (const child of [...existing.children]) {
    if (child.tagName.toLowerCase() !== 'videl-event') {
      continue;
    }
    const id = child.getAttribute('dash-id') ?? '';
    if (!id) {
      // No id — not matchable; never remove.
      continue;
    }
    if (!newIds.has(id) && !child.hasAttribute('videl-state')) {
      existing.removeChild(child);
      changed = true;
    }
  }

  return changed;
}

// ---------------------------------------------------------------------------
// Representation segment merge
// ---------------------------------------------------------------------------

function mergeRepresentation(existing: Element, newRep: Element): boolean {
  let changed = false;

  // Collect existing segment URLs
  const existingUrls = new Set<string>();
  for (const child of existing.children) {
    if (child.tagName.toLowerCase() === 'videl-segment') {
      const url = child.getAttribute('url') ?? '';
      if (url) {
        existingUrls.add(url);
      }
    }
  }

  // Collect new segment URLs and append new segments
  const newUrls = new Set<string>();
  for (const newSeg of newRep.children) {
    if (newSeg.tagName.toLowerCase() !== 'videl-segment') {
      continue;
    }
    const url = newSeg.getAttribute('url') ?? '';
    if (url) {
      newUrls.add(url);
    }
    if (url && !existingUrls.has(url)) {
      existing.appendChild(newSeg);
      changed = true;
    }
  }

  // Remove unfetched segments that disappeared from the manifest.
  // Segments with empty/missing url are not matchable and are never removed.
  for (const child of [...existing.children]) {
    if (child.tagName.toLowerCase() !== 'videl-segment') {
      continue;
    }
    const url = child.getAttribute('url') ?? '';
    if (!url) {
      // Empty URL — not matchable; never remove.
      continue;
    }
    if (!newUrls.has(url) && !child.hasAttribute('videl-state')) {
      existing.removeChild(child);
      changed = true;
    }
  }

  return changed;
}
