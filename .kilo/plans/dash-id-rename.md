# Rename DASH Manifest `id` → `dash-id` on Custom Elements

## Problem

The HTML spec requires `id` attributes to be unique within a document. Our
elements use the DOM `id` attribute to store DASH manifest IDs stamped by the
parser (e.g. `Representation@id`, `Event@id`). When two `<videl-player>`
instances exist in the same DOM (or the same stream is loaded twice), elements
with the same DASH id clash, violating uniqueness and breaking `getElementById`
semantics.

```html
<!-- two players, same stream → duplicate id="video/1" in the document -->
<videl-representation id="video/1" …></videl-representation>  <!-- player 1 -->
<videl-representation id="video/1" …></videl-representation>  <!-- player 2 -->
```

## Scope

| Element | Current attribute | New attribute | DASH source |
|---|---|---|---|
| `<videl-representation>` | `id` | `dash-id` | `Representation@id` |
| `<videl-event>` | `id` | `dash-id` | `Event@id` |
| `<videl-period>` | `period-id` | `dash-id` | `Period@id` |
| `<videl-adaptation-set>` | *(not stamped)* | `dash-id` (when `@id` present) | `AdaptationSet@id` |

All four DASH element types that carry a manifest `@id` value now use the same
`dash-id` attribute name. `period-id` was a one-off name; unifying everything
under `dash-id` makes the convention consistent and keeps the MPD-update merger
logic uniform across element types.

`<videl-event>` must still emit `id="…"` in the XML it serialises for the
`EventSourceBuffer` — only the DOM attribute name changes, not the XML output.

---

## Files to Change

### `src/parser/mpd-parser.ts`

**Representation builder** (line ~455):
```diff
- el.setAttribute('id', id);
+ el.setAttribute('dash-id', id);
```

**Event builder** (line ~411):
```diff
- el.setAttribute('id', ev.getAttribute('id')!);
+ el.setAttribute('dash-id', ev.getAttribute('id')!);
```

**Period builder** (line ~180):
```diff
- el.setAttribute('period-id', id);
+ el.setAttribute('dash-id', id);
```

**AdaptationSet builder** (line ~260, inside `buildAdaptationSet`, after the existing attribute block):
```diff
+ const adsId = ads.getAttribute('id');
+ if (adsId) {
+   el.setAttribute('dash-id', adsId);
+ }
```
Only stamp `dash-id` when the manifest element actually carries `@id`; omitting
it when absent keeps the attribute absent (consistent with all other elements).

### `src/elements/videl-period.ts`

**Property declaration** (line ~29):
```diff
- periodId: { type: String, attribute: 'period-id' },
+ periodId: { type: String, attribute: 'dash-id' },
```
The `periodId` field name and its use in the `videl:done` event detail
(`detail: { periodId: this.periodId }`) are unchanged — only the HTML attribute
name backing it changes.

### `src/elements/videl-representation.ts`

**Property declaration** (line ~95):
```diff
- repId: { type: String, attribute: 'id' },
+ repId: { type: String, attribute: 'dash-id' },
```
The `repId` field name and every downstream use of `this.repId` are unchanged —
only the HTML attribute name backing it changes.

### `src/elements/videl-adaptation-set.ts`

**Add `dashId` property** alongside the existing properties:
```diff
+ dashId: { type: String, attribute: 'dash-id' },
  forcedRepId: { type: String, attribute: 'forced-rep' },
```
```diff
+ dashId = '';
  forcedRepId = '';
```
The property is read-only from the element's perspective (set by the parser);
no behavioural change is needed.

Every `rep.getAttribute('id')` call must become `rep.getAttribute('dash-id')`:

| Line | Change |
|---|---|
| `~199` | `reps.find(r => r.getAttribute('id') === this.forcedRepId)` → `getAttribute('dash-id')` |
| `~247` | `prev.repId ?? prev.getAttribute('id') ?? null` → `getAttribute('dash-id')` |
| `~248` | `target.repId ?? target.getAttribute('id') ?? null` → `getAttribute('dash-id')` |
| `~283` | `rep.getAttribute('id') === this.forcedRepId` → `getAttribute('dash-id')` |
| `~305` | `const repId = rep.getAttribute('id') ?? ''` → `getAttribute('dash-id')` |
| `~334` | `rep.getAttribute('id') === this.forcedRepId` → `getAttribute('dash-id')` |

Note: `forcedRepId` is the **value** of the `forced-rep` attribute — it stores
the DASH representation ID string. The attribute name `forced-rep` and property
name `forcedRepId` do not change; only the attribute queried on child
`<videl-representation>` nodes changes from `id` to `dash-id`.

### `src/elements/videl-event.ts`

**Property declaration** (line ~58):
```diff
- eventId: { type: Number, attribute: 'id' },
+ eventId: { type: Number, attribute: 'dash-id' },
```

**`#toXml()` method** (line ~140 — produces DASH XML, must keep `id=` in output):
```diff
- ? ` id="${this.getAttribute('id')}"`
+ ? ` id="${this.getAttribute('dash-id')}"`
```
The generated XML string itself still uses `id="…"` — that is the DASH Event
attribute name understood by `EventSourceBuffer`, not a DOM attribute.

---

## Tests to Update

### `test/videl-adaptation-set.spec.ts`

All test helpers that create `<videl-representation>` elements with `id`:

```diff
- rep.setAttribute('id', id);
+ rep.setAttribute('dash-id', id);
```

```diff
- ads.querySelector('videl-representation[videl-state="active"]')?.getAttribute('id')
+ ads.querySelector('videl-representation[videl-state="active"]')?.getAttribute('dash-id')
```

Affected lines (approximate): 73, 104, 135, 157, 164, 171, 196, 215, 237, 292,
337, 380, 456, 459, 476, 497, 514.

### `test/videl-representation.spec.ts`

```diff
- repA.setAttribute('id', 'rep-a');
- repB.setAttribute('id', 'rep-b');
+ repA.setAttribute('dash-id', 'rep-a');
+ repB.setAttribute('dash-id', 'rep-b');
```

Lines ~450, ~457.

### `test/mpd-parser.spec.ts`

Representation id lookup (line ~485):
```diff
- id: rep.getAttribute('id'),
+ id: rep.getAttribute('dash-id'),
```

Period id lookup (line ~71):
```diff
- id: p.getAttribute('period-id'),
+ id: p.getAttribute('dash-id'),
```

Line ~463 similarly:
```diff
- return periods.map(p => p.getAttribute('period-id'));
+ return periods.map(p => p.getAttribute('dash-id'));
```

The test descriptions reference `period-id` in their titles (e.g. `'criterion 2 — each videl-period has correct period-id, start, duration'`). Update those strings to say `dash-id` for accuracy.

### `test/videl-period.spec.ts`

All `period.setAttribute('period-id', …)` calls → `setAttribute('dash-id', …)`.
Affected lines (approximate): 46, 83, 117, 152, 184, 216, 248, 290, 339, 375,
413, 450.

Lines 421 and 424 set `id` on `<videl-adaptation-set>` stubs purely to make
them visually distinguishable in the test; the `id` value is never read back in
the test logic (the test checks `getAttribute('videl-state')` only). These
lines can simply be **removed** — they serve no functional purpose and happen
to put real `id` attributes onto elements unnecessarily.

```diff
  const first = document.createElement('videl-adaptation-set') as any;
  first.setAttribute('content-type', 'video');
- first.setAttribute('id', 'first');
  const second = document.createElement('videl-adaptation-set') as any;
  second.setAttribute('content-type', 'video');
- second.setAttribute('id', 'second');
```

### `test/videl-presentation.spec.ts`

All `p.setAttribute('period-id', …)` calls → `setAttribute('dash-id', …)`.
Affected lines (approximate): 45, 67, 69, 100, 144, 187, 224, 226, 266, 301.

### `test/videl-player.spec.ts`

```diff
- firstPres?.getAttribute('period-id') ||
- firstPres?.querySelector('videl-period')?.getAttribute('period-id')
+ firstPres?.getAttribute('dash-id') ||
+ firstPres?.querySelector('videl-period')?.getAttribute('dash-id')
```

Lines ~295–296.

---

## Impact on `mpd-update.md` Plan

The MPD update plan references both `period-id` and `id` as match keys.
Both must change to `dash-id`:

```diff
- existingPeriodMap.set(child.getAttribute('period-id') ?? '', child)
+ existingPeriodMap.set(child.getAttribute('dash-id') ?? '', child)
```

```diff
- existingRepMap.set(child.getAttribute('id') ?? '', child)
+ existingRepMap.set(child.getAttribute('dash-id') ?? '', child)
```

The `mpd-update.md` plan file should be updated to use `dash-id` throughout.

---

## Acceptance Criteria

1. No `<videl-representation>`, `<videl-period>`, `<videl-adaptation-set>`, or
   `<videl-event>` element in the DOM carries a native `id` attribute that came
   from the DASH manifest.
2. Every element type that carries a DASH manifest `@id` uses the single
   consistent attribute name `dash-id`. `<videl-adaptation-set>` receives
   `dash-id` only when the manifest `AdaptationSet@id` is present.
3. `periodId` on `VidelPeriod` continues to return the DASH `Period@id` value
   (now read from `dash-id`). The `videl:done` event detail
   `{ periodId }` is unchanged.
4. `repId` on `VidelRepresentation` continues to return the DASH
   `Representation@id` value (now read from `dash-id`).
5. ABR forced-representation: `forceRepresentation(rep)` stores the `dash-id`
   value in `forced-rep`; ABR lookup finds the rep by `dash-id` correctly.
6. `<videl-event>#toXml()` still emits `id="…"` in the XML string output.
7. Two `<videl-player>` instances in the same page playing the same stream
   produce no duplicate `id` values in the document.
8. All existing tests pass after the rename.

---

## Implementation Order

1. `mpd-parser.ts` — change `setAttribute('period-id', …)` + two `setAttribute('id', …)` calls + add `dash-id` stamping for adaptation sets (5 min)
2. `videl-period.ts` — change `attribute: 'period-id'` → `'dash-id'` (2 min)
3. `videl-representation.ts` — change `attribute: 'id'` → `'dash-id'` (2 min)
4. `videl-adaptation-set.ts` — add `dashId` property + update all 6 `getAttribute('id')` references (5 min)
5. `videl-event.ts` — change property attribute and `#toXml` (2 min)
6. Tests — bulk find-replace across affected files:
   - `setAttribute('period-id',` → `setAttribute('dash-id',`
   - `getAttribute('period-id')` → `getAttribute('dash-id')`
   - `setAttribute('id',` → `setAttribute('dash-id',` (representation/event usages only)
   - `getAttribute('id')` → `getAttribute('dash-id')` (same scope)
   - Remove two no-op `id` lines in `videl-period.spec.ts`
   - Update test description strings mentioning `period-id` (10 min)
7. Update `mpd-update.md` plan: replace `period-id` and `id` match keys with `dash-id` (2 min)
8. Run tests to verify
