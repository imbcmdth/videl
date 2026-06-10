# MPD Update — Periodic Manifest Re-fetch and DOM Merge

## Overview

For `type="dynamic"` (live) presentations that carry `@minimumUpdatePeriod`,
the DASH spec (§5.4) requires the client to periodically re-fetch the MPD and
apply any changes to the presentation. The client must not re-fetch more
frequently than once per `minimumUpdatePeriod`; from the client's perspective,
the MPD is guaranteed valid for that duration after the fetch completes.

This plan describes how `<videl-presentation>` schedules periodic re-fetches and
how the resulting new XML is merged into the existing live DOM tree.

---

## Spec Notes (§5.4, §5.3.2)

- `@minimumUpdatePeriod` — if absent, the MPD does not change; no polling needed.
  Present only when `@type="dynamic"`.
- `@publishTime` — wall-clock time the MPD was generated. A newer `publishTime`
  means the fetched document is a genuine update. Identical `publishTime` → no-op.
- `Period@id` — **shall be present and shall not change** when the MPD is updated
  (§5.3.2.2, Table 4). This is the stable key used to match periods across updates.
- The live-edge period has unknown duration (`@duration` absent); its duration
  is filled in once the period ends in a later update.
- Periods that have fallen behind the timeshift-buffer window may be removed from
  the manifest in later updates.

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Who schedules re-fetch | `VidelPresentation` | It owns `src`, the parsed tree, and the `minimumUpdatePeriod` value |
| Trigger mechanism | Checked on every `videlUpdate()` tick | Avoids background timers that outlive playback; naturally gated by the pump |
| Period match key | `dash-id` attribute | Stable per spec; already stamped by parser |
| AdaptationSet match key | `dash-id` when present, else `content-type` | `@id` is optional on `AdaptationSet`; content-type is always present |
| Representation match key | `dash-id` attribute | Already stamped by parser |
| Segment match key | `url` attribute | Unambiguous; already stamped by parser for all addressing modes |
| Segment removal | Remove only unfetched (no `videl-state`) segments absent from new manifest | Avoids disturbing in-flight or already-fetched segments |
| Period removal | Defer to existing `#updateLivePeriodWindows` time-based eviction | Keeps the merge simple; the pump already evicts expired periods |
| Duplicate update guard | Skip merge if `publish-time` hasn't advanced | Avoids diffing when the server returns the same MPD |
| Concurrent fetch guard | `#refreshInFlight` boolean flag | Prevents overlapping re-fetch requests |

---

## New and Modified Files

| File | Change |
|---|---|
| `src/parser/mpd-parser.ts` | Stamp `minimum-update-period` and `publish-time` on the output `<videl-presentation>` |
| `src/parser/mpd-merger.ts` | **New.** Pure function `applyMpdUpdate()` — DOM merge logic |
| `src/elements/videl-presentation.ts` | Add refresh scheduling, new properties, call `applyMpdUpdate` |

---

## Phase 1 — Parser: Stamp Update Metadata

### 1.1 `buildPresentation` additions

In `mpd-parser.ts`, inside `buildPresentation`, after the existing attribute
stamping:

```typescript
const mup = mpd.getAttribute('minimumUpdatePeriod');
if (mup) {
  el.setAttribute('minimum-update-period', String(parseDuration(mup)));
}

const publishTime = mpd.getAttribute('publishTime');
if (publishTime) {
  el.setAttribute('publish-time', String(parseIsoDateTime(publishTime)));
}
```

`parseDuration` already exists in the file. `parseIsoDateTime` already exists.
No new utility functions are needed.

### 1.2 VidelPresentation properties

In `VidelPresentation.properties`, add:

```typescript
minimumUpdatePeriod: { type: Number, attribute: 'minimum-update-period' },
publishTime:         { type: Number, attribute: 'publish-time' },
```

Class fields:

```typescript
minimumUpdatePeriod: number | null = null;
publishTime:         number | null = null;
```

These are stamped by the parser and read by the refresh logic.

---

## Phase 2 — `src/parser/mpd-merger.ts`

Pure module; no element lifecycle, no browser globals beyond `document` (for
`createElement`).

### Public API

```typescript
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
  existing: HTMLElement,   // live <videl-presentation> DOM node
  newTree:  HTMLElement,   // freshly-parsed <videl-presentation> from parseMpd()
): boolean
```

### Algorithm

```
applyMpdUpdate(existing, newTree):
  changed = false

  // 1. Top-level MPD attribute passthrough
  for attr in ['type', 'media-presentation-duration', 'min-buffer-time',
               'minimum-update-period', 'publish-time', 'no-seek']:
    newVal = newTree.getAttribute(attr)
    if newVal !== null and existing.getAttribute(attr) !== newVal:
      existing.setAttribute(attr, newVal)
      changed = true
    else if newVal === null and existing.hasAttribute(attr):
      existing.removeAttribute(attr)
      changed = true

  // 2. Period merge
  existingPeriodMap = Map<string, Element>   // dash-id → element
  for each child of existing with tag 'videl-period':
    id = child.getAttribute('dash-id') ?? ''
    existingPeriodMap.set(id, child)

  for each newPeriod of newTree with tag 'videl-period':
    id = newPeriod.getAttribute('dash-id') ?? ''
    if existingPeriodMap.has(id):
      c = mergePeriod(existingPeriodMap.get(id), newPeriod)
      if c: changed = true
    else:
      existing.appendChild(newPeriod)
      changed = true

  return changed


mergePeriod(existing, newPeriod):
  changed = false

  // Update mutable period attributes
  for attr in ['start', 'duration']:
    update if changed

  // Match adaptation sets by dash-id when present, falling back to content-type
  existingAdsMap = buildAdsMap(existing)    // key → element
  for each newAds of newPeriod with tag 'videl-adaptation-set':
    key = adsKey(newAds)
    if existingAdsMap.has(key):
      c = mergeAdaptationSet(existingAdsMap.get(key), newAds)
      if c: changed = true
    // else: new adaptation set — append (rare in practice for live content)
    //   existing.appendChild(newAds); changed = true
    // NOTE: don't add new ads whose content-type already exists — would require
    // videl-player to create a new SourceBuffer; out of scope for this plan.

  return changed

  // AdaptationSet key: dash-id when present, else content-type
  //   adsKey(el) = el.getAttribute('dash-id') ?? el.getAttribute('content-type') ?? ''
  // Representation key: dash-id attribute


mergeAdaptationSet(existing, newAds):
  // Match representations by 'dash-id' attribute
  existingRepMap = Map<string, Element>
  for each child with tag 'videl-representation':
    existingRepMap.set(child.getAttribute('dash-id') ?? '', child)

  for each newRep of newAds with tag 'videl-representation':
    id = newRep.getAttribute('dash-id') ?? ''
    if existingRepMap.has(id):
      mergeRepresentation(existingRepMap.get(id), newRep)
    // else: new representation — out of scope; ignoring

  return changed


mergeRepresentation(existing, newRep):
  existingUrls = new Set<string>()
  for each child with tag 'videl-segment':
    existingUrls.add(child.getAttribute('url') ?? '')

  newUrls = new Set<string>()
  for each newSeg of newRep with tag 'videl-segment':
    newUrls.add(newSeg.getAttribute('url') ?? '')
    if not existingUrls.has(url):
      existing.appendChild(newSeg)      // append new segment
      changed = true

  // Remove unfetched segments that disappeared from the manifest
  for each child of existing with tag 'videl-segment':
    url = child.getAttribute('url') ?? ''
    if not newUrls.has(url) and not child.hasAttribute('videl-state'):
      existing.removeChild(child)
      changed = true

  return changed
```

### Edge cases

- **Segments with empty URL** (`url=""` or missing): treated as not-matchable;
  never removed.
- **Periods with no `dash-id`** (non-dynamic MPDs; shouldn't occur for
  `type="dynamic"`, but guard by falling through to append).
- **New adaptation sets for existing content types** (e.g., server adds a new
  audio language track): out of scope for this plan — these would require a new
  `SourceBuffer` from `videl-player`. Log a console warning and skip.
- **Event streams** (from the event-stream plan): `<videl-event-stream>` /
  `<videl-event>` children within a period follow the same key-based merge
  (match event-stream by `scheme-id-uri` + `value`; match events by `id`).
  The event-stream videlUpdate already iterates the live child list, so newly
  appended `<videl-event>` nodes are picked up automatically on the next tick.
  **This sub-case is explicitly deferred to the event-stream plan per its
  open question 2.** The merger skips `videl-event-stream` children for now.

---

## Phase 3 — `VidelPresentation` Refresh Logic

### 3.1 New private state

```typescript
#lastFetchWallTime: number = 0;    // ms; Date.now() after a successful fetch
#refreshInFlight:   boolean = false;
```

### 3.2 Stamp fetch time after initial `#populate`

In `#populate()`, after `this.setAttribute('videl-populated', '')`:

```typescript
this.#lastFetchWallTime = Date.now();
```

### 3.3 Refresh check in `videlUpdate()`

Append to the top of `videlUpdate()`, before forwarding to the active period:

```typescript
if (this.presentationType === 'dynamic' &&
    this.minimumUpdatePeriod !== null &&
    !this.#refreshInFlight &&
    this.hasAttribute('videl-populated')) {
  const elapsed = (Date.now() - this.#lastFetchWallTime) / 1000;
  if (elapsed >= this.minimumUpdatePeriod) {
    void this.#refreshMpd();
  }
}
```

### 3.4 `#refreshMpd()`

```typescript
async #refreshMpd(): Promise<void> {
  if (this.#refreshInFlight || !this.src) return;
  this.#refreshInFlight = true;
  try {
    const response = await fetch(this.src, { signal: this.#fetchController?.signal });
    if (!response.ok) return;
    const xml = await response.text();

    const self = this as unknown as HTMLElement;
    const tsbdDefault = Math.max(
      0,
      Number(self.parentElement?.getAttribute('time-shift-buffer-depth-default') ?? 0)
    );
    const newTree = parseMpd(xml, this.src, { tsbdDefault });

    // publishTime guard: skip if this is not a newer document
    const newPublishTime = Number(newTree.getAttribute('publish-time') ?? 0);
    if (newPublishTime > 0 && newPublishTime <= (this.publishTime ?? 0)) {
      return;  // same or older MPD — no-op
    }

    applyMpdUpdate(self, newTree);
    this.#lastFetchWallTime = Date.now();

  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') return;
    // Non-fatal: log but continue playback
    console.warn('[videl-presentation] MPD refresh failed:', err);
  } finally {
    this.#refreshInFlight = false;
  }
}
```

### 3.5 Abort on deactivation

In `attributeChangedCallback`, when `value === null` (deactivation):
```typescript
this.#refreshInFlight = false;  // reset flag so a re-activation can refresh
```
The `#fetchController.abort()` call that is already there covers any in-flight
fetch (both initial populate and refresh share the same AbortController).

---

## Phase 4 — `VidelPresentation.#populate` cleanup

After the merge, the initial `#populate` still replaces all `<videl-period>`
children wholesale (correct — this is the first-time build). No changes needed
to `#populate` itself other than stamping `#lastFetchWallTime`.

The new `minimum-update-period` and `publish-time` attributes are stamped onto
`this` during `#populate` via the attribute passthrough block that already
handles `type`, `media-presentation-duration`, and `min-buffer-time`:

```typescript
// existing block — extend it:
const mup     = subtree.getAttribute('minimum-update-period');
const pubTime = subtree.getAttribute('publish-time');
if (mup)     { self.setAttribute('minimum-update-period', mup); }
if (pubTime) { self.setAttribute('publish-time', pubTime); }
```

---

## Functional Acceptance Criteria

1. **Static MPDs** (`type="static"`, no `minimum-update-period`): no re-fetch is
   ever triggered.

2. **Dynamic MPD without `minimumUpdatePeriod`**: no re-fetch triggered.

3. **Dynamic MPD with `minimumUpdatePeriod=PT5S`**: `#refreshMpd` is called no
   sooner than 5 seconds after the preceding successful fetch.

4. **Same `publishTime` returned**: `applyMpdUpdate` is not called; DOM is
   unchanged.

5. **New period appended**: a new `<videl-period>` appears in the manifest →
   it is appended as the last child of the presentation; any currently active
   period is undisturbed.

6. **New segments appended to live-edge representation**: `<videl-segment>`
   elements for new segments are appended to the representation in DOM order;
   existing fetched/in-flight segments are untouched.

7. **Stale unfetched segments removed**: segments present in the DOM but absent
   from the new manifest that do not have `videl-state` are removed from the
   representation.

8. **Segments with `videl-state` are preserved**: in-flight or fetched segments
   are never removed by the merger.

9. **Period `duration` fill-in**: when the live-edge period gains a `duration`
   attribute in the new MPD, it is applied to the existing DOM period element.

10. **Concurrent re-fetch guard**: if `videlUpdate` is called multiple times
    before a refresh completes, only one in-flight request exists at a time.

11. **`applyMpdUpdate` is a pure DOM function**: it only reads/writes the two
    element trees passed to it; no global side effects.

---

## Test Approach

### Unit tests (Vitest, no browser required if using `happy-dom` or `jsdom`)

**mpd-merger.test.ts**

- **Period append**: `existing` with period `P1`; `newTree` has `P1` + `P2` →
  after merge, `existing` has two periods; `P1` is the same element reference.

- **Period attribute update**: `existing` period `P1` has `duration=null`;
  `newTree` period `P1` has `duration=10` → duration is updated.

- **Segment append**: existing representation has `seg0.m4v` and `seg1.m4v`;
  new tree has `seg0.m4v`, `seg1.m4v`, `seg2.m4v` → `seg2.m4v` is appended;
  existing segment nodes are the same references.

- **Stale segment removal**: existing has `seg_old.m4v` (no `videl-state`) and
  `seg0.m4v`; new has `seg0.m4v` only → `seg_old.m4v` is removed.

- **Active segment preserved**: existing has `seg0.m4v` with
  `videl-state="active"`; it is absent from new manifest → NOT removed.

- **Same `publishTime` guard**: calling `applyMpdUpdate` when new tree's
  `publish-time` ≤ existing's `publish-time` → returns false, no DOM change.

- **Top-level attribute passthrough**: `minimum-update-period` and `publish-time`
  are updated from the new tree.

### Component tests (Playwright)

**videl-presentation refresh** — mount a `<videl-presentation>` with
`type="dynamic"` and `minimum-update-period="1"`, mock `fetch` to return a
second MPD with an extra period and updated `publishTime`:

- After `minimumUpdatePeriod` seconds of pump ticks, `fetch` is called exactly
  once more.
- A new `<videl-period>` appears in the DOM.
- The existing active period has not been re-created (element identity preserved).

---

## Implementation Order

1. `mpd-parser.ts` — stamp `minimum-update-period` + `publish-time` (10 min)
2. `videl-presentation.ts` — add properties + attribute passthrough in `#populate` (15 min)
3. `mpd-merger.ts` — write `applyMpdUpdate` (45 min)
4. `videl-presentation.ts` — add `#refreshInFlight`, `#lastFetchWallTime`,
   `#refreshMpd`, check in `videlUpdate` (30 min)
5. Unit tests for `applyMpdUpdate` (45 min)
6. Component test for refresh scheduling (30 min)

---

## Out of Scope

- **MPD Patch (§5.15)**: incremental patch documents are a separate mechanism
  (`PatchLocation` element). Not covered here.
- **New adaptation sets during live**: adding a new audio language mid-stream
  would require a new `SourceBuffer`; deferred.
- **Event stream merge**: `<videl-event-stream>` / `<videl-event>` merge is
  deferred to the event-stream plan (see open question 2 in that plan).
- **MPD Reset (§5.4.2)**: full presentation reset on `urn:mpeg:dash:reset:2016`
  event is not covered here.
- **HTTP cache headers**: using `Cache-Control` / `ETag` to suppress unnecessary
  re-fetches is a future optimisation.
