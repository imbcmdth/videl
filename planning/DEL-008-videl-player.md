# DEL-008: `<videl-player>`

**Depends on:** DEL-000–DEL-007 (all prior deliverables)  
**Deliverable type:** Custom element + integration tests  
**Status:** Implemented

---

## Summary

The root orchestrator. Extends `CustomVideoElement` from the `media-chrome` package (`import { CustomVideoElement } from 'media-chrome/dist/custom-video-element.js'`) to expose an `HTMLMediaElement`-compatible interface for `media-chrome` UI controls. Owns the `MediaSource`, drives the pump, manages seeks, and reacts to developer DOM mutations. This is the most complex element and the final integration point for all prior deliverables.

---

## Public Interface

### Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `src` | string | MPD URL. Changing this tears down the current presentation and starts a new one. |
| `tick-ms` | number | Pump throttle interval in ms. Default: `250`. |
| `debug` | boolean | When present, all child elements render their debug view. |

### `HTMLMediaElement` interface (via `CustomVideoElement`)

Exposes the following subset sufficient for `media-chrome`:

| Member | Type | Notes |
|--------|------|-------|
| `play()` | method | Resumes playback |
| `pause()` | method | Pauses playback |
| `currentTime` | get/set | Getting reads from internal `<video>`; setting triggers seek |
| `duration` | get | From active presentation's `mediaPresentationDuration` |
| `paused` | get | Proxied from internal `<video>` |
| `buffered` | get | Proxied from internal `<video>` |
| `volume` | get/set | Proxied from internal `<video>` |
| `muted` | get/set | Proxied from internal `<video>` |
| `readyState` | get | Proxied from internal `<video>` |

Events re-fired from internal `<video>`: `play`, `pause`, `timeupdate`, `seeking`, `seeked`, `ended`, `waiting`, `canplay`, `canplaythrough`, `durationchange`, `volumechange`.

### Properties (none — this is the root)

### `videlUpdate(state: PlayerState)` — internal only

`videl-player` is the *source* of the pump; it does not receive `update()` from a parent.

---

## Responsibilities

1. **`src` handling:** on attribute change, execute the full MSE rebuild procedure (see below), then fetch + parse new MPD and insert `<videl-presentation>` as a child.

2. **`MediaSource` lifecycle:** sole owner of `MediaSource` and the object URL. Creates both; revokes the object URL only after the MediaSource is closed. On `sourceopen`: inspect the active presentation's manifest for required content types and codec strings, call `addSourceBuffer` for each, distribute the resulting SourceBuffers to the corresponding `<videl-adaptation-set>` elements via property, then activate the presentation.

3. **SourceBuffer registry:** maintains a `Map<contentType, SourceBuffer>` for the lifetime of the current MSE instance. Used during rebuild to know what needs to be recreated.

4. **MSE rebuild procedure:** triggered by `src` change, `videl:mse:error`, `videl:mse:incompatible`, or unexpected MediaSource close. Steps:
   1. Save `video.currentTime`.
   2. Synchronously deactivate the presentation cascade (all slots cleared top-down).
   3. If MediaSource is still open, call `MediaSource.endOfStream()`.
   4. Revoke the object URL.
   5. Clear the SourceBuffer registry.
   6. Create new `MediaSource`; create new object URL; set `video.src`.
   7. Wait for `sourceopen`.
   8. Recreate SourceBuffers from the manifest; redistribute to adaptation sets.
   9. Set `video.currentTime` to the saved position.
   10. Reactivate the presentation from the current position.

5. **Pump:** use a `setTimeout`-based loop (not `requestAnimationFrame` — RAF pauses in background tabs, which breaks live streams; `timeupdate` alone fires at most every 250ms and is not reliable for throttle control). On each tick: build `PlayerState` from `video.currentTime`, `video.buffered`, `video.playbackRate`, and the running bandwidth estimate; call `videlUpdate(state)` on the active `<videl-presentation>`; schedule the next tick at `tick-ms`. On seek (`seeking` event): cancel the pending tick, call `videlUpdate(state)` immediately, then reschedule.

6. **Bandwidth estimation:** maintain a rolling bandwidth estimate (bytes received / time elapsed) from `videl:done` events where `event.target` is a `<videl-segment>`. Include in each `PlayerState`.

7. **Seek handling:** on `currentTime` set, immediately call `videlUpdate(state)` (don't wait for next tick) so `<videl-representation>` resolves the correct segment without delay.

8. **MutationObserver:** watch for developer insertions/removals of `<videl-period>` elements (ad insertion, splice). On relevant mutation, call `videlUpdate(state)` to re-evaluate the active path.

9. **SourceBuffer serialization:** listen for `videl:done` events where `event.target` is a `<videl-segment>`; if multiple SourceBuffers have pending appends, serialize them (MSE does not allow concurrent `appendBuffer` on the same SourceBuffer).

10. **Error escalation handler:** listen for `videl:mse:error` and `videl:mse:incompatible` (both bubble). On receipt, execute the MSE rebuild procedure. For `videl:mse:incompatible`, attempt `sourceBuffer.changeType()` first; only rebuild if that fails.

---

## Functional Acceptance Criteria

1. Setting `src` fetches the MPD, builds the DOM subtree, creates a `MediaSource`, and begins playback.
2. Changing `src` while playing: previous `MediaSource` is closed, object URL revoked, previous DOM subtree removed, new load begins cleanly.
3. `play()` and `pause()` correctly start and stop playback.
4. Setting `currentTime` seeks to the correct position; the correct `<videl-segment>` for the new time is activated without waiting for the next tick.
5. `duration` returns the correct value from the manifest.
6. `buffered` reflects the actual MSE buffer state.
7. Bandwidth estimate is updated after each `videl:done` from a `<videl-segment>` and included in `PlayerState`.
8. DOM mutation (inserting a new `<videl-period>`): `update()` is called and the new period is considered for activation.
9. `media-chrome` controls work end-to-end: play/pause button, time range scrubber, and volume control all function correctly.
10. `tick-ms` attribute is respected: changing it adjusts the pump interval.
11. Concurrent `appendBuffer` calls on the same `SourceBuffer` are serialized; no `InvalidStateError` is thrown.
12. `debug` attribute propagates to all descendant elements (they render their debug views).
13. On `videl:mse:error`: MSE rebuild executes; playback resumes from the saved `currentTime` without the caller needing to intervene.
14. On MSE rebuild: `<videl-adaptation-set>` elements receive fresh `sourceBuffer` properties and resume appending without error.
15. On content type set change between presentations (e.g. video+audio → audio-only): MSE is rebuilt with only the required SourceBuffers; no stale SourceBuffers remain.
16. `addSourceBuffer` is called by `<videl-player>` only — never by any child element.

---

## Test Approach

**Framework:** Playwright integration tests (real browser, real network or local test server).

Use a local HTTP server serving:
- A simple 2-period VOD DASH stream (real fMP4 segments, ~30 seconds total)
- A second stream for `src` change testing

Key test scenarios:
- **Basic playback:** set `src`, wait for `canplay`, call `play()`, assert video plays for 5 seconds (verify `currentTime` advances).
- **Pause/resume:** play, pause, assert `paused=true`, resume, assert `currentTime` advances again.
- **Seek:** play to t=5, set `currentTime=20`, assert `seeked` fires and playback continues from t=20.
- **`src` change:** change `src` mid-playback; assert old MediaSource is closed, object URL revoked, new stream starts cleanly.
- **Multi-period:** play through period boundary; assert both periods play and `videl:done` fires at end.
- **Ad insertion:** after parsing, insert a new `<videl-period>` into the DOM before the last period; assert the ad plays in sequence.
- **ABR:** throttle simulated bandwidth mid-play; assert `videl:representation:switched` fires.
- **media-chrome:** mount inside `<media-controller>`; assert play button and seek bar work via user interaction.
- **Buffer serialization:** assert no MSE `InvalidStateError` during normal playback.
- **MSE rebuild on error:** dispatch `videl:mse:error` from a child adaptation set; assert MSE is torn down and rebuilt, adaptation sets receive fresh SourceBuffers, and `currentTime` is preserved.
- **Content type set change:** switch `src` to an audio-only stream mid-playback; assert MSE is rebuilt with only an audio SourceBuffer (no stale video SourceBuffer remains).
- **SourceBuffer ownership:** spy on `addSourceBuffer`; assert it is only ever called from castro, never from a child element.
