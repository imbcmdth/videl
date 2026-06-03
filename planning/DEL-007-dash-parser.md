# DEL-007: DASH Manifest Parser

**Depends on:** DEL-002–DEL-006 (all element definitions must be registered before parser creates them)  
**Deliverable type:** TypeScript module + unit tests  
**Status:** Implemented

---

## Summary

A standalone module that takes a DASH MPD XML string and a base URL, and produces a fully-populated `<videl-presentation>` DOM subtree ready to be inserted into `<videl-player>`. All DASH attribute inheritance is resolved at parse time; every `<videl-segment>` receives stamped, absolute URLs and byte ranges. The parser never modifies the DOM after initial construction.

---

## Public Interface

```ts
function parseMpd(xml: string, baseUrl: string): HTMLElement;
// Returns a <videl-presentation> element with the full subtree attached.
// Throws ParseError for unsupported profiles or malformed XML.
```

### Output element tree

```
<videl-presentation mediaPresentationDuration="..." minBufferTime="..." type="static|dynamic">
  <videl-period period-id="..." start="..." duration="...">
    <videl-adaptation-set content-type="video" mime-type="..." codecs="..." lang="...">
      <videl-representation id="..." bandwidth="..." width="..." height="..." codecs="..." mime-type="...">
        <videl-segment url="..." byte-range="..." start-time="..." duration="..."></videl-segment>
        ...
      </videl-representation>
      ...
    </videl-adaptation-set>
    <videl-adaptation-set content-type="audio" ...>
      ...
    </videl-adaptation-set>
  </videl-period>
  ...
</videl-presentation>
```

### DASH Parsing Gotchas

These are the most common sources of bugs in DASH parsers. Read this section before implementing.

**`timescale`:** `SegmentTemplate` and `SegmentTimeline` time values (`t`, `d`, `r`, `presentationTimeOffset`) are in `timescale` units, **not seconds**. To convert to seconds: `value / timescale`. Default `timescale` is `1` but real streams almost always set it — video typically uses `90000`, audio `48000` or `44100`. Getting this wrong produces `start-time` and `duration` values that are off by 4–5 orders of magnitude. Always resolve `timescale` before doing any time arithmetic.

**`startNumber`:** `SegmentTemplate` `$Number$` expansion starts at `startNumber` (attribute on `SegmentTemplate`, default `1`). Many streams set it to `0` or a large value. Missing this produces wrong segment URLs.

**Template variables:** All of `$RepresentationID$`, `$Bandwidth$`, `$Number$`, `$Time$`, and `$Number%0Nd$` (zero-padded) must be expanded. `$RepresentationID$` and `$Bandwidth$` are very common in real streams and are taken from the Representation's `id` and `bandwidth` attributes respectively.

**`r` repeat attribute:** In `SegmentTimeline`, `<S r="N">` means the segment repeats `N` additional times (total `N+1` segments). `r="-1"` means repeat to the end of the period — compute the repeat count from the period duration and segment duration.

**Initialization segment URL:** Each `SegmentTemplate` has an `initialization` attribute (separate from `media`). This resolves to the init segment URL for the representation and must be stamped as `initialization-url` on each `<videl-representation>` element. `SegmentBase` uses `Initialization/@range` as the byte range and the `BaseURL` as the URL — stamp these as `initialization-url` + `initialization-byte-range`.

**`presentationTimeOffset`:** `SegmentTemplate` may include `presentationTimeOffset` (in timescale units). Subtract this from `t` values when computing `start-time` in seconds: `(t - presentationTimeOffset) / timescale`.

---

### Segment addressing modes supported

| Mode | Handling |
|------|----------|
| `SegmentTemplate` with `$Number$` or `$Time$` | Expand into individual `<videl-segment>` elements with resolved URLs |
| `SegmentTemplate` with `SegmentTimeline` | Expand per `<S>` entry |
| `SegmentBase` with `indexRange` | Single `<videl-segment>` with byte-range from index |
| `SegmentList` | One `<videl-segment>` per `<SegmentURL>` entry |

### Inheritance resolution

The following attributes are resolved at parse time (child value overrides parent):
- `mimeType` / `codecs`: AdaptationSet → Representation → stamped on all segments
- `SegmentTemplate` (including `timescale`, `startNumber`, `initialization`, `media`, `presentationTimeOffset`): inherited from Period → AdaptationSet → Representation (most specific wins)
- `BaseURL`: resolved and prepended to all segment URLs
- `initialization-url` and `initialization-byte-range`: stamped on every `<videl-representation>` element (see DASH Parsing Gotchas above)

---

## Functional Acceptance Criteria

1. Parsing a valid VOD MPD produces a `<videl-presentation>` with correct `mediaPresentationDuration` and `type=static`.
2. Each `<videl-period>` has correct `period-id`, `start`, and `duration`.
3. Each `<videl-adaptation-set>` has resolved `content-type`, `mime-type`, `codecs`, and `lang`.
4. Each `<videl-representation>` has `bandwidth`, `width`/`height` (if video), and fully resolved `codecs` + `mime-type` (inherited from parent if not explicit).
5. `SegmentTemplate` with `$Number$`: produces correct segment URLs using `startNumber` as the first index; `$Number%0Nd$` zero-padding is applied correctly.
6. `SegmentTemplate` with `$Time$`: segment URLs use the `t` value from `SegmentTimeline` in timescale units (not converted to seconds).
7. `SegmentTemplate` with `SegmentTimeline`: one `<videl-segment>` per `<S>` entry (accounting for `r` repeat attribute, including `r="-1"`); `start-time` and `duration` on each are in **seconds** (divided by `timescale`).
8. `SegmentBase`: produces a single `<videl-segment>` with correct `byte-range`.
9. `SegmentList`: produces one `<videl-segment>` per `<SegmentURL>` with correct absolute URLs.
10. Relative URLs are resolved against `baseUrl`.
11. `BaseURL` elements in the manifest are respected and prepended correctly.
12. Unsupported DASH profiles throw a `ParseError` with a descriptive message rather than silently producing a broken tree.
13. Codec inheritance: a `<videl-representation>` with no explicit `codecs` attribute inherits from its parent `<videl-adaptation-set>`.
14. Multi-period MPDs produce multiple `<videl-period>` children in DOM order matching manifest order.
15. `$RepresentationID$` and `$Bandwidth$` template variables are expanded correctly from the Representation's `id` and `bandwidth` attributes.
16. `initialization-url` is stamped on every `<videl-representation>` element; `initialization-byte-range` is stamped when applicable.
17. `timescale` values other than `1` produce correct `start-time` and `duration` values in seconds (e.g. `t=90000, timescale=90000` → `start-time=1.0`).
18. `presentationTimeOffset` is subtracted before converting `t` values to seconds when present.

---

## Test Approach

**Framework:** Vitest or Playwright (parser is a pure module — no browser APIs needed; Node-based unit tests are sufficient).

Use a set of fixture MPD files (`.mpd` XML files committed to the test suite) covering:
- Single-period VOD with `SegmentTemplate + $Number$` (non-default `startNumber`)
- `SegmentTemplate + SegmentTimeline` with repeat (`r`) attributes including `r="-1"`
- `SegmentTemplate + SegmentTimeline` with non-1 `timescale` (e.g. `timescale=90000`)
- `SegmentBase` with `indexRange` and `Initialization/@range`
- `SegmentList`
- Multi-period VOD
- Codec inheritance (codecs on AdaptationSet only, not Representation)
- Relative and absolute `BaseURL`
- `$RepresentationID$` and `$Bandwidth$` in template URLs
- `presentationTimeOffset` in `SegmentTemplate`

For each fixture: parse and assert the produced DOM tree matches expected element counts, attributes, URL values, and that all times are in seconds.

Additionally: feed a known real-world DASH stream (e.g. the Akamai Big Buck Bunny test stream) and assert basic structural validity (at least one video + one audio adaptation set with segments, `initialization-url` set on all representations).
