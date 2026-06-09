import { LitElement, nothing, css, unsafeCSS } from 'lit';
import eventCss from '../styles/videl-event.css';
import type { ISourceBuffer } from 'ergo-mse';
import { trace } from '../trace';

/**
 * `<videl-event>` — execution leaf for a single DASH MPD timed event.
 *
 * Analogous to `<videl-segment>` but without a network fetch — the event
 * payload is already present as element attributes and text content, stamped
 * by the MPD parser.  Activation serialises the event to XML and appends it
 * to the parent's `EventSourceBuffer`.
 *
 * Attribute contract (set by the MPD parser):
 *   presentation-time  — raw tick value from Event@presentationTime (default 0)
 *   duration           — raw tick value from Event@duration (omitted = 0)
 *   id                 — numeric event ID from Event@id (omitted when absent)
 *   message-data       — base64 payload from Event@messageData (omitted when absent)
 *   textContent        — inline payload when @messageData is absent
 *
 * Internal-state attributes (written by this element):
 *   videl-state        — "active" while appending; absent otherwise
 *   videl-done         — present after successful append in this activation session
 *
 * Property contract (set by parent VidelEventStream before activation):
 *   sourceBuffer       — EventSourceBuffer instance
 *
 * Events fired (bubble):
 *   videl:done               — { presentationTime } — append succeeded
 *   videl:segment:error      — { error: Error }     — append failed
 */
export class VidelEvent extends LitElement {
  static styles = css`${unsafeCSS(eventCss)}`;

  /**
   * Extend LitElement's observed attribute list with `videl-state`.
   * Uses the same getter pattern as VidelSegment to avoid esbuild
   * `__publicField` shadowing issues.
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
    presentationTime: { type: Number, attribute: 'presentation-time' },
    duration:         { type: Number },
    eventId:          { type: Number, attribute: 'id' },
    messageData:      { type: String, attribute: 'message-data' },
    slot:             { type: String, reflect: true },
  };

  presentationTime = 0;
  duration:    number | null = null;
  eventId:     number | null = null;
  messageData: string | null = null;
  slot = '';

  /** Set by the parent VidelEventStream before activating this event. */
  sourceBuffer: ISourceBuffer | null = null;

  // ── State lifecycle ───────────────────────────────────────────────────────

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    super.attributeChangedCallback(name, old, value);

    if (name !== 'videl-state') {
      return;
    }

    if (value === 'active') {
      this.#activate();
    }
    // 'next' is a no-op (nothing to prefetch for an inline event).
    // Removal is a no-op (no abort controller to cancel).
  }

  // ── Private implementation ────────────────────────────────────────────────

  async #activate(): Promise<void> {
    if (!this.sourceBuffer) {
      this.#fireError(new Error('videl-event: sourceBuffer not set before activation'));
      return;
    }

    const xml   = this.#toXml();
    const bytes = new TextEncoder().encode(xml);

    trace(this, 'buffer', 'append-start', { presentationTime: this.presentationTime });

    try {
      await this.sourceBuffer.append(bytes);
    } catch (err) {
      if (this.getAttribute('videl-state') !== 'active') {
        return;
      }
      trace(this, 'buffer', 'append-error', {
        presentationTime: this.presentationTime,
        error: String(err)
      });
      this.#fireError(err as Error);
      return;
    }

    if (this.getAttribute('videl-state') !== 'active') {
      return;
    }

    trace(this, 'buffer', 'append-complete', { presentationTime: this.presentationTime });
    this.setAttribute('videl-done', '');

    this.dispatchEvent(new CustomEvent('videl:done', {
      bubbles:  true,
      composed: true,
      detail:   { presentationTime: this.presentationTime },
    }));
  }

  /**
   * Serialise this event as a bare `<Event …>` XML string for appending to
   * the EventSourceBuffer.  The EventSourceBuffer parses this against the
   * previously-sent EventStream context.
   */
  #toXml(): string {
    const pt  = this.getAttribute('presentation-time') ?? '0';
    const dur = this.hasAttribute('duration')
      ? ` duration="${this.getAttribute('duration')}"`
      : '';
    const id  = this.hasAttribute('id')
      ? ` id="${this.getAttribute('id')}"`
      : '';
    const md  = this.messageData
      ? ` messageData="${this.messageData}"`
      : '';
    // Use inline payload only when there is no base64 messageData.
    const body = this.messageData ? '' : (this.textContent?.trim() ?? '');
    return `<Event presentationTime="${pt}"${dur}${id}${md}>${body}</Event>`;
  }

  #fireError(error: Error): void {
    this.dispatchEvent(new CustomEvent('videl:segment:error', {
      bubbles:  true,
      composed: true,
      detail:   { error },
    }));
  }

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    return nothing;
  }
}

customElements.define('videl-event', VidelEvent);
