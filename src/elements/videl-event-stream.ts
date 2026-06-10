import { LitElement, nothing, css, unsafeCSS } from 'lit';
import eventStreamCss from '../styles/videl-event-stream.css';
import type { ISourceBuffer } from 'ergo-mse';
import type { PlayerState } from '../player-state';
import { VidelEvent } from './videl-event';

/**
 * `<videl-event-stream>` — owns a set of `<videl-event>` children for one
 * DASH `EventStream` (as declared in the MPD `Period`).
 *
 * Analogous to `<videl-representation>` but for timed events rather than
 * media segments.  All event data is already present in the DOM at parse time
 * (stamped by the MPD parser); there is no network I/O in this element.
 *
 * ### Lifecycle
 *
 * - `videl-state="next"` or `"active"` → send the EventStream context (init-
 *   segment equivalent) to the shared `EventSourceBuffer`.  Idempotent:
 *   `videl-context-sent` guards repeated sends.
 *
 * - `videlUpdate(state)` (called each pump tick while active) → dispatch any
 *   `<videl-event>` children whose resolved wall-clock `presentationTime`
 *   falls within the current lookahead window
 *   `[currentWallTime − 1, currentWallTime + bufferAhead]`.
 *
 *   The live child list is iterated on every tick, so new `<videl-event>`
 *   children appended by a future MPD-refresh path are picked up automatically.
 *
 * - `videl-state` removed → reset context + child state for re-activation
 *   (e.g. after a period transition when the same EventStream is re-used).
 *
 * ### Attribute contract (manifest-derived, set by MPD parser)
 *
 * | Attribute                  | From MPD                         |
 * |----------------------------|----------------------------------|
 * | `scheme-id-uri`            | `EventStream@schemeIdUri`        |
 * | `value`                    | `EventStream@value` (optional)   |
 * | `timescale`                | `EventStream@timescale`          |
 * | `presentation-time-offset` | `EventStream@presentationTimeOffset` |
 * | `period-start`             | wall-clock epoch seconds of period start |
 *
 * ### Internal-state attributes (written by this element)
 *
 * | Attribute             | Meaning                                    |
 * |-----------------------|--------------------------------------------|
 * | `videl-state`         | `"next"` / `"active"` / absent             |
 * | `videl-context-sent`  | Present once the context append has been made |
 *
 * ### Property contract
 *
 * | Property       | Set by         | Description                       |
 * |----------------|----------------|-----------------------------------|
 * | `sourceBuffer` | `videl-player` | Shared `EventSourceBuffer` instance |
 */
export class VidelEventStream extends LitElement {
  static styles = css`${unsafeCSS(eventStreamCss)}`;

  /**
   * Extend LitElement's observed attribute list with `videl-state`.
   * Uses the same getter pattern as VidelSegment / VidelEvent to avoid esbuild
   * `__publicField` shadowing.
   */
  static get observedAttributes(): string[] {
    let proto: Function | null = Object.getPrototypeOf(this) as Function;
    while (proto) {
      const desc = Object.getOwnPropertyDescriptor(proto, 'observedAttributes');
      if (desc?.get) {
        const parentAttrs: string[] = desc.get.call(this) ?? [];
        return parentAttrs.includes('videl-state') ?
          parentAttrs :
          [...parentAttrs, 'videl-state'];
      }
      proto = Object.getPrototypeOf(proto);
    }
    return ['videl-state'];
  }

  static properties = {
    schemeIdUri: { type: String, attribute: 'scheme-id-uri' },
    value: { type: String },
    timescale: { type: Number },
    presentationTimeOffset: { type: Number, attribute: 'presentation-time-offset' },
    periodStart: { type: Number, attribute: 'period-start' },
    slot: { type: String, reflect: true }
  };

  schemeIdUri            = '';
  value:                 string | null = null;
  timescale              = 1;
  presentationTimeOffset = 0;
  periodStart            = 0;
  slot                   = '';

  /** Shared EventSourceBuffer — set by videl-player before activation. */
  sourceBuffer: ISourceBuffer | null = null;

  // ── State lifecycle ───────────────────────────────────────────────────────

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    super.attributeChangedCallback(name, old, value);

    if (name !== 'videl-state') {
      return;
    }

    if (value === 'active' || value === 'next') {
      // Send the EventStream context as soon as we know we'll be needed.
      this.#ensureContextSent();
    } else if (value === null) {
      // Deactivation: reset so a re-activation re-sends context and re-delivers
      // all events (e.g. after a period transition).
      this.removeAttribute('videl-context-sent');
      for (const ev of this.#childEvents) {
        ev.removeAttribute('videl-done');
        ev.removeAttribute('videl-state');
      }
    }
  }

  // ── Pump method ───────────────────────────────────────────────────────────

  /**
   * Called by `videl-period` on each pump tick while this stream is active.
   * Dispatches pending `<videl-event>` children within the lookahead window.
   */
  videlUpdate(state: PlayerState): void {
    if (this.getAttribute('videl-state') !== 'active') {
      return;
    }
    this.#dispatchPendingEvents(state.currentWallTime, state.bufferAhead);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  get #childEvents(): VidelEvent[] {
    return Array.from(this.children).filter(el => el.tagName.toLowerCase() === 'videl-event') as VidelEvent[];
  }

  /**
   * Send the `<EventStream …/>` context XML to the EventSourceBuffer (no
   * child events — sets the buffer's schemeIdUri / timescale / PTO context,
   * exactly like an init segment sets the decoder context).
   *
   * Idempotent: guarded by `videl-context-sent`.
   */
  #ensureContextSent(): void {
    if (this.hasAttribute('videl-context-sent') || !this.sourceBuffer) {
      return;
    }

    const xml   = this.#contextXml();
    const bytes = new TextEncoder().encode(xml);

    // Set timestampOffset so the EventSourceBuffer resolves period-relative
    // ticks to wall-clock seconds correctly (mirrors how VidelRepresentation
    // sets timestampOffset after appending the init segment).
    this.sourceBuffer.timestampOffset = this.periodStart;

    this.sourceBuffer.append(bytes).catch(err => {
      console.warn('[videl-event-stream] context append failed:', err); // eslint-disable-line no-console
    });

    this.setAttribute('videl-context-sent', '');
  }

  /**
   * Walk the live child list and activate any `<videl-event>` whose resolved
   * wall-clock presentationTime falls within the current lookahead window:
   *   [currentWallTime − 1 s, currentWallTime + bufferAhead]
   *
   * The −1 s lower bound catches events that just became current on this tick.
   * The upper bound mirrors the media segment buffer-ahead window so events
   * are delivered ahead of the playhead in the same rhythm as media segments.
   *
   * New children added to the DOM after activation (live MPD refresh) are
   * picked up automatically since we iterate the live child list each tick.
   */
  #dispatchPendingEvents(currentWallTime: number, bufferAhead: number): void {
    if (!this.hasAttribute('videl-context-sent')) {
      return;
    }

    const timescale   = this.timescale   || 1;
    const pto         = this.presentationTimeOffset;
    const periodStart = this.periodStart;

    for (const ev of this.#childEvents) {
      if (ev.hasAttribute('videl-done') || ev.getAttribute('videl-state') === 'active') {
        continue;
      }

      // Resolve raw tick value to wall-clock seconds.
      // Formula matches ergo-mse EventSourceBuffer:
      //   wallClock = (presentationTime − pto) / timescale + periodStart
      const rawPt    = Number(ev.getAttribute('presentation-time') ?? '0');
      const wallTime = (rawPt - pto) / timescale + periodStart;

      if (wallTime < currentWallTime - 1 || wallTime > currentWallTime + bufferAhead) {
        continue;
      }

      ev.sourceBuffer = this.sourceBuffer;
      ev.setAttribute('videl-state', 'active');
    }
  }

  /**
   * Produce the `<EventStream …/>` wrapper XML (no child events) that
   * establishes the EventSourceBuffer's context.
   */
  #contextXml(): string {
    const scheme = this.schemeIdUri;
    const ts     = this.timescale;
    const pto    = this.presentationTimeOffset;
    const val    = this.value !== null ? ` value="${this.value}"` : '';
    return `<EventStream schemeIdUri="${scheme}" timescale="${ts}" presentationTimeOffset="${pto}"${val}/>`;
  }

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    return nothing;
  }
}

customElements.define('videl-event-stream', VidelEventStream);
