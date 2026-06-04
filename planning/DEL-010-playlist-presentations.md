# DEL-010: Playlist Presentations

**Depends on:** DEL-006 (`<videl-presentation>`), DEL-007 (MPD parser), DEL-008 (`<videl-player>`), ADR-0002 (attribute-based state)  
**Deliverable type:** Element behaviour changes + Playwright tests  
**Status:** Planned (to be implemented after ADR-0002 migration)

---

## Summary

Elevate `<videl-player>` from a single-stream player to a declarative playlist container. The developer places multiple `<videl-presentation>` elements as direct children of the player, each carrying its own `src` MPD URL, optional display metadata, and an optional display `duration`. The player sequences through them automatically; each presentation self-populates from its manifest exactly when needed — prefetched when `videl-state="next"`, activated when `videl-state="active"` — using the parser introduced in DEL-007.

State is communicated via the `videl-state` attribute (per ADR-0002) rather than the `slot` attribute, keeping the DOM structure stable and shadow DOM composition fully independent of playback state.

---

## Motivation

The current model requires the player to own MPD fetching: `<videl-player src="stream.mpd">` kicks off the entire load. This is fine for a single stream but it means:

- There is no way to declare a playlist in HTML without scripting.
- The next stream cannot be prefetched until the first one ends.
- There is no place to attach display metadata (titles, thumbnails) to individual presentations.
- The DOM is reorganised by slot assignment, making in-place debugging and DOM inspection unreliable.

By moving MPD ownership to `<videl-presentation>`, making the player a sequential container, and using `videl-state` for state communication, all four problems go away.

---

## Revised Public Interface

### `<videl-presentation>` — new and changed attributes

| Attribute | Type | Change | Description |
|-----------|------|--------|-------------|
| `src` | string | **existing** — now primary driver | MPD URL. When `videl-state` becomes `next` or `active` the element fetches + parses this URL and self-populates. |
| `duration` | number (seconds) | **new** | Display duration shown in the card before the manifest has been fetched. Overridden by `media-presentation-duration` once the manifest is parsed. |
| `media-presentation-duration` | number | existing | Populated from the parsed manifest. |
| `type` | string | existing | `static` or `dynamic`. |
| `videl-state` | `"active"` \| `"next"` \| absent | **new** | Set by `<videl-player>`. Drives self-population and period activation. Does **not** affect the element's position or visual layout in the DOM. |

The `slot` attribute is **not used for state**. It remains available for visual composition — e.g. slotting a group of presentations into a wrapper component's named area.

### `<videl-presentation>` — shadow DOM

The shadow root contains a single **default (unnamed) `<slot>`** that projects all light-DOM children into the composed tree. The element itself is the playlist card — there is no wrapper slot, no named card slot, and no imposed structure. Developers place visible content (images, headings, custom elements) directly inside `<videl-presentation>` and style the element itself.

Technical children injected by self-population (`<videl-period>`) are hidden via a targeted `::slotted` rule so they do not affect the visual output by default. They remain in the composed tree and are fully inspectable in DevTools.

```
shadow root
├── <style> :host { display: block }
│           ::slotted(videl-period) { display: none }
├── <slot>                      ← all light-DOM children; user content visible,
│                                  videl-period hidden by CSS
└── (optional debug panel when debug attribute is set)
```

This structure means:
- The `<videl-presentation>` element itself is the unit of visual presentation in the playlist.
- Every `<videl-period>` child is in its natural DOM position, hidden by CSS, always inspectable.
- No named slots exist — neither state slots nor card wrapper slots.
- User content requires no `slot` attribute at all.

### `<videl-presentation>` — self-population

When `videl-state` is set to `"next"` or `"active"`, the element:

1. Checks whether `<videl-period>` children already exist (already populated — idempotent).
2. If not, fetches `src` and parses the MPD with `parseMpd(xml, src)`.
3. Removes any existing `<videl-period>` children only — **preserves** all non-period children (card content, etc.).
4. Appends the parsed `<videl-period>` children.
5. Stamps `media-presentation-duration`, `min-buffer-time`, and `type` from the manifest onto itself.

When `videl-state` is removed the fetch is aborted (if in-flight) and period children are deactivated.

### `<videl-presentation>` — period activation

The presentation uses `videl-state` on its `<videl-period>` children to drive the same active/next lifecycle one layer down:

- On `videl-state="active"`: set `videl-state="active"` on the first period child.
- On `videl-state="next"`: begin self-population only (no period activation needed at prefetch time).
- On `videl-state` removed: remove `videl-state` from all period children (cascade deactivation).

The `videlUpdate(state)` pump method guards on `getAttribute('videl-state') === 'active'` and forwards to the child period that also has `videl-state="active"`.

### `<videl-player>` — playlist management

The player no longer requires its own `src` attribute to function. Instead it watches its direct `<videl-presentation>` children:

- **On connection / first child mutation:** sets `videl-state="active"` on the first presentation; sets `videl-state="next"` on the second.
- **On `videl:done` from a direct `<videl-presentation>` child:** removes `videl-state` from the completed presentation, tears down MSE, advances to the next, sets up fresh MSE, resumes playback if was playing.
- **`src` attribute (legacy / single-stream):** still supported. Setting `src` creates a single `<videl-presentation>` child (with no metadata) and inserts it as the only child.

#### Player state management of presentations

The player sets `videl-state="active"` on the currently playing presentation and `videl-state="next"` on the immediately following one. All others have no `videl-state` attribute. Teardown is a single `removeAttribute('videl-state')` call per presentation — identical verbosity to the old `removeAttribute('slot')`.

The player never sets the `slot` attribute on presentation children.

#### MSE lifecycle on presentation switch

Full MSE rebuild on every presentation transition:

1. Save `wasPlaying = !video.paused`.
2. `removeAttribute('videl-state')` on the completed presentation — cascades deactivation to its periods.
3. Tear down MSE (`endOfStream`, revoke object URL, clear SourceBuffer registry).
4. `setAttribute('videl-state', 'active')` on the next presentation.
5. Run `#setupMse(nextPresentation)` — triggers self-population if not already prefetched, creates SourceBuffers, distributes them to adaptation sets.
6. If `wasPlaying`, call `video.play()`.
7. Emit `videl:playlist:advance` with `{ from, to, index }`.

---

## Usage

Because `<videl-presentation>` is the card, content goes directly inside the element with no wrapping or slot attributes required:

```html
<videl-presentation src="ep1.mpd" duration="2700">
  <img src="ep1-thumb.jpg" alt="Episode 1 thumbnail" />
  <h3>Episode 1: Pilot</h3>
  <p>An intrepid journey begins.</p>
</videl-presentation>
```

CSS targets the element directly:

```css
videl-presentation                        { opacity: 0.5; cursor: pointer; }
videl-presentation[videl-state="active"]  { opacity: 1.0; outline: 2px solid #4af; }
videl-presentation[videl-state="next"]    { opacity: 0.75; }
```

---

## New Event

| Event | Bubbles | Detail | Fired by |
|-------|---------|--------|---------|
| `videl:playlist:advance` | yes | `{ from, to, index }` | `<videl-player>` when advancing to the next presentation |

---

## CSS State Hooks

Because `videl-state` is a plain attribute, consumers get free CSS hooks:

```css
/* Dim non-playing items in the playlist */
videl-presentation                        { opacity: 0.5; }
videl-presentation[videl-state="active"]  { opacity: 1.0; }

/* Indicate the prefetching item */
videl-presentation[videl-state="next"]    { outline: 2px dashed #888; }
```

---

## Functional Acceptance Criteria

### `<videl-presentation>` self-population

1. When `videl-state="next"` is set and `<videl-period>` children are absent: an HTTP request is made to `src` and `<videl-period>` children are injected.
2. When `videl-state="active"` is set without a prior `videl-state="next"`: fetch + parse happens inline; `<videl-period>` children are injected before the first period is activated.
3. Non-period children (card content, etc.) are **never** removed during self-population.
4. After self-population, `media-presentation-duration` is updated from the parsed manifest value.
5. The `duration` attribute value is shown in the card fallback before the manifest is fetched; it is replaced by the manifest value after fetch completes.
6. Self-population is idempotent — setting `videl-state` twice with the same `src` does not duplicate `<videl-period>` children.
7. If the fetch fails (network error, 4xx/5xx), `videl:segment:error` fires and the presentation remains unpopulated.

### `<videl-presentation>` — DOM stability

8. The `<videl-presentation>` element stays at its original position in the DOM regardless of `videl-state` value — it is never moved by state changes.
9. `<videl-period>` children remain at their natural position in the DOM when the presentation is active, next, or idle.
10. No `<slot name="active">` or `<slot name="next">` exist in the presentation shadow root.

### `<videl-presentation>` — shadow DOM composition

11. The shadow root contains a single default unnamed `<slot>` that projects all light-DOM children into the composed tree.
12. `<videl-period>` children projected through the default slot are hidden by `::slotted(videl-period) { display: none }`.
13. Non-period light-DOM children (user content) are visible by default — no `slot` attribute is required on them.
14. No named slots exist in the presentation shadow root.

### `<videl-player>` playlist sequencing

17. With two `<videl-presentation>` children: on connection the first gets `videl-state="active"`, the second gets `videl-state="next"`.
18. When the active presentation fires `videl:done`: the player advances — `videl-state` removed from old presentation, `videl-state="active"` set on new presentation, MSE rebuilt, playback resumes from `t=0`.
19. `videl:playlist:advance` fires with correct `{ from, to, index }` on every advance.
20. After the last presentation completes, the player stops (does not loop) and `videl:playlist:advance` does **not** fire.
21. Changing the `src` attribute while a playlist is playing: the player inserts a new sole `<videl-presentation>` child, drops all others, and loads immediately.
22. A presentation that already has `<videl-period>` children (previously prefetched) when `videl-state` becomes `"active"`: no re-fetch occurs.
23. The `wasPlaying` state is preserved across presentation transitions (if playing when one stream ends, next stream plays automatically).
24. The player does **not** set the `slot` attribute on any `<videl-presentation>` child.

---

## Design Notes

### Why `videl-state` instead of `slot` for state?

See ADR-0002. In summary: using `slot` for state forces the element to move visually in the composed tree when state changes, breaking DOM-order inspection and preventing independent visual composition. `videl-state` is a pure data attribute — it communicates state without touching layout.

### Why self-population instead of player-driven population?

Reversing MPD ownership to the presentation element enables:

- **Prefetch without player involvement.** The player just sets `videl-state="next"`; the presentation handles the fetch.
- **Declarative playlists.** The developer pre-declares all presentations in HTML; no script needed to describe the playlist.
- **Metadata co-location.** The thumbnail, title, and src live together on the same element.

### Why full MSE rebuild on presentation switch?

Presentations may have entirely different codec sets, sample rates, and adaptation structures. `changeType()` works only within the same container format and is not guaranteed across streams. A clean rebuild is the safest default. Future work could optimise same-codec transitions to avoid the rebuild.

### Why a default slot with technical children hidden by CSS?

Making all children visible in the composed shadow tree means the full element hierarchy is inspectable in DevTools without any state-driven slot reorganisation. Only `<videl-period>` children (injected by self-population) are hidden — user content is visible by default because it lives alongside periods in the same default slot. A developer enabling `debug` can override `::slotted(videl-period)` to expose the period subtree. This is the primary debugging benefit of the ADR-0002 architecture.

### Backwards compatibility

Setting `src` on `<videl-player>` continues to work exactly as in DEL-008 — the player internally creates a single anonymous `<videl-presentation>` child and manages it. The multi-presentation mode is purely additive.

---

## Test Approach

**Framework:** Playwright integration tests (real browser).

Key test scenarios:

- **Self-population on `videl-state="next"`:** route an MPD URL; set `videl-state="next"` on a bare presentation; assert `<videl-period>` children appear and `media-presentation-duration` is updated.
- **Self-population on `videl-state="active"` without prior next:** assert fetch happens inline and periods are populated before activation.
- **Metadata preservation:** set `videl-state="next"` on a presentation with user content children (e.g. `<img>`, `<h3>`); assert they are still present after population and that only `<videl-period>` children were added.
- **Idempotency:** populate a presentation twice; assert period count is unchanged.
- **DOM stability:** mount player with two presentations; assert both remain at their original `children` indices throughout activation and advance.
- **Player connection:** mount player with two pre-declared presentations; assert first gets `videl-state="active"`, second gets `videl-state="next"`.
- **No slot mutation:** assert the player never sets the `slot` attribute on any presentation child.
- **Playlist advance:** trigger `videl:done` from the first presentation; assert second becomes `videl-state="active"`, `videl:playlist:advance` fires with correct detail.
- **Last presentation:** trigger `videl:done` from the last presentation; assert no further advance and player stops.
- **Legacy `src`:** set `src` on the player; assert a single `<videl-presentation>` child is created and loaded.
- **Default slot projection:** assert that `<videl-period>` children are reachable via the shadow root's default slot `assignedElements()` and that their computed `display` is `none`.
- **CSS hooks:** assert `[videl-state="active"]` selector matches the playing presentation and no other.
- **Default slot projection:** assert that `<videl-period>` children are accessible via the shadow root's default slot assignedElements.
