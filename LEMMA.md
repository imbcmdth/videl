# LEMMA.md

Shared technical reference for videl development.

## Answers

- **Primary user:** Professional video engineers; open-source project prioritizes docs and governance.
- **V1 goal:** Play common DASH formats.
- **Success metric:** Minimal "special sauce" for complex tasks (ad insertion, splicing).

## Stack

- **Language:** TypeScript
- **Components:** Lit/LitElement (~5KB, no lock-in)
- **Build:** esbuild (ESM + types)
- **Testing:** Playwright (real MSE, no mocks)
- **Commits:** Conventional Commits
- **License:** MIT
- **UI:** `<videl-presentation>` control bar; `<videl-player>` HTMLMediaElement proxy surface.
- **DASH:** Custom minimal parser (DOM tree, no DASH.js)
- **3rd Party Libraries:** Avoid adding dependencies unless instructed specifically by human.

## Decisions

- **Core:** DOM-mirror of DASH manifest. XML → custom elements tree. Attributes resolved/denormalized at parse.
- **Data model:** DOM is source of truth. `<videl-segment>` is execution leaf (fetch + append).
- **Customization:** Attribute + CustomEvent contracts per element. No subclassing.
- **URLs:** Parser resolves SegmentTemplate/SegmentBase/SegmentList → absolute URLs + byte ranges on `<videl-segment>`. No element URL math.
- **Mixins:** `PickOneMixin` (1 active), `PickNMixin` (1 per content-type), `SequentialMixin` (DOM order).
- **Videl-state:** Three only — unset, `next`, `active`. Events signal completion/error; parent removes `videl-state`. `unset → active` must work (prefetch optional).
- **Cascade:** Parent deactivation strips `videl-state` from children. Invariant: one active path root→leaf. (PickNMixin is the exception to this rule)
- **Abort:** `<videl-segment>` `AbortController` aborts on `videl-state` removal.
- **Pump:** `videlUpdate(PlayerState)` down active path on tick (250ms default). Events bubble up immediately.
- **Private fields:** Use `#field` (native ES), not `_field`.
- **Public naming:** Prefix public methods/properties with `videl` to avoid HTMLElement/LitElement collisions (e.g., `videlUpdate` not `update`). Attribute-reflected properties exempt.
- **Element-as-card:** Default `<slot>`, no named slots. Technical children hidden via `::slotted { display: none }`. Card styled via `:host`.
- **TextSourceBuffer:** `ISourceBuffer` impl for fMP4 text (wvtt/stpp). Demuxes → `VTTCue` on `TextTrack`. One per presentation. `remove(s, Infinity)` for track switch. Exclude from `endOfStream`. Discard image TTML. See ADR-0004.
- **"None" text ADS:** Parser injects synthetic text ADS first (subtitles off by default). Calls `TextSourceBuffer.hide/show()` on activation.
- **ISourceBuffer interface:** `append`, `remove`, `abort`, `changeType`, `updating`, `buffered`, `timestampOffset`, optional `show?`/`hide?`.
- **PresentationTimeOffset:** Parser stamps `timestamp-offset = periodStart - pto/timescale` on `<videl-representation>`. Set on `sourceBuffer.timestampOffset` after init append.
- **Data-as-UI menus:** No menu DOM. `<videl-adaptation-set>` and `<videl-representation>` render own rows. Control buttons toggle `menu-open` on active period. Period shadow reveals via CSS `::slotted([content-type=X])`.
- **Presentation-as-player-UI:** Three roles: manifest owner, card (inactive), overlay UI (active). `position: absolute; inset: 0; z-index: 2; background: transparent`. Events dispatched as `videl:ui:*`. UI state stamped as reactive props on pump tick.
- **Segment duration mismatch:** MPD durations differ from actual encoder output. Use actual append feedback, not manifest timeline. (1) `isBuffered` tolerance = `max(0.5s, 15% duration)`; (2) `#fetchedSegments` tracks confirmed appends; (3) `#timelineDrift` tracks drift; (4) Both cleared on seek/sourceBuffer change. Critical: `#fetchedSegments` populated only in `#onSegmentDone`.
- **MSE seekable range:** VOD: set `duration` to manifest. Live: set `duration = Infinity` + call `setLiveSeekableRange(start, end)` each tick.
- **DOM-first:** Attributes = external state. Fields = transient tracking. Test: reconstructible from attributes? → attribute, else field.
- **Lazy segments:** `SegmentList` only at parse. Others: stamp addressing attrs, create `<videl-segment>` at activation. SegmentBase: fetch/parse sidx. Live: `#extendLiveSegments()` on tick.
- **Attribute prefixes:** (1) DASH/manifest — no prefix. (2) User config — no prefix. (3) Internal state — `videl-` prefix.
- **Live-DVR eviction:** Call `remove(wallAnchor, dvrStart)` on all `ISourceBuffer`s each tick after `setLiveSeekableRange`. Throttle: fire when evictable ≥ 0.5s.
- **ergo-mse API:** Wall-clock-native. Takes wall-clock for all time params. Subtracts `wallAnchor` internally. Only `videl-player` handles player-time. All other components should use wall-clock time.

## Workflow

- **Always run lint and verify no test regressions after finishing work.** `npm run lint` runs ESLint and TypeScript type-checking in parallel. `npm run test` rules tests. No PR or commit should have failures.
