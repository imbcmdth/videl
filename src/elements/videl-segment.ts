import { LitElement, html, nothing } from 'lit';
import type { ManagedSourceBuffer } from '../managed-source-buffer';

/**
 * `<videl-segment>` — execution leaf of the manifest tree.
 *
 * Given a `url` and optional `byte-range`, fetches bytes and appends them to a
 * `ManagedSourceBuffer` when activated. Manages its own fetch lifecycle,
 * including abort on deactivation.
 *
 * Attribute contract (set by parent / parser):
 *   url          — absolute segment URL
 *   byte-range   — optional "start-end" byte range (inclusive)
 *   start-time   — presentation start time in seconds
 *   duration     — segment duration in seconds
 *   slot         — set by parent: "next" | "active" | (absent)
 *
 * Property contract (set by parent before activation):
 *   sourceBuffer — ManagedSourceBuffer instance
 *
 * Events fired (bubble):
 *   videl:done          — { startTime, duration } — bytes appended
 *   videl:segment:error — { error: Error }        — fetch or append failed
 */
export class VidelSegment extends LitElement {
  static properties = {
    url:       { type: String },
    byteRange: { type: String, attribute: 'byte-range' },
    startTime: { type: Number, attribute: 'start-time' },
    duration:  { type: Number },
    // Reflect slot so attributeChangedCallback fires when it changes.
    slot:      { type: String, reflect: true },
    // Debug flag for visual render.
    debug:     { type: Boolean },
  };

  url       = '';
  byteRange: string | null = null;
  startTime = 0;
  duration  = 0;
  slot: string | undefined = undefined;
  debug     = false;

  /** Set by the parent adaptation-set before the element is activated. */
  sourceBuffer: ManagedSourceBuffer | null = null;

  // ── Internal fetch state ──────────────────────────────────────────────────

  #controller: AbortController | null = null;
  /** Resolves with the fetched bytes; rejects on abort or network error. */
  #fetchPromise: Promise<ArrayBuffer> | null = null;
  /** Non-null once prefetch completes and bytes are held in memory. */
  #fetchedBytes: ArrayBuffer | null = null;

  // ── Slot lifecycle ────────────────────────────────────────────────────────

  /**
   * Override attributeChangedCallback so slot transitions drive behavior
   * synchronously — abort on deactivation must happen before any microtask.
   */
  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    super.attributeChangedCallback(name, old, value);

    if (name !== 'slot') return;

    if (value === null) {
      // Any → unslotted: abort immediately and discard held bytes.
      this.#abort();
    } else if (value === 'next') {
      // Unslotted → next: start prefetch.
      this.#startFetch();
    } else if (value === 'active') {
      // * → active: append (uses prefetched bytes if available).
      this.#activate();
    }
  }

  // ── Private implementation ────────────────────────────────────────────────

  /** Begin an async fetch and hold the result in memory when complete. */
  #startFetch(): void {
    this.#controller = new AbortController();
    this.#fetchPromise = this.#doFetch(this.#controller.signal);

    this.#fetchPromise
      .then(bytes => {
        this.#fetchedBytes = bytes;
        this.#fetchPromise = null;
      })
      .catch(() => {
        // Abort or network error. If we later hit active, the null fetchPromise
        // + null fetchedBytes path will restart the fetch and surface the error.
      });
  }

  /**
   * Drive the fetch → append pipeline. Called synchronously from
   * attributeChangedCallback when slot becomes 'active', so the actual work
   * happens in the async tail.
   */
  async #activate(): Promise<void> {
    let bytes: ArrayBuffer;

    if (this.#fetchedBytes) {
      // Happy path: prefetch already complete.
      bytes = this.#fetchedBytes;
    } else if (this.#fetchPromise) {
      // Prefetch in-flight: wait for it.
      const inflight = this.#fetchPromise;
      try {
        bytes = await inflight;
      } catch (err) {
        // Deactivation during wait is signaled by abort — just bail.
        if (this.getAttribute('slot') !== 'active') return;
        this.#fireError(err as Error);
        return;
      }
    } else {
      // No prefetch at all: fetch inline now.
      this.#controller = new AbortController();
      try {
        bytes = await this.#doFetch(this.#controller.signal);
      } catch (err) {
        if (this.getAttribute('slot') !== 'active') return;
        this.#fireError(err as Error);
        return;
      }
    }

    // Guard: we may have been deactivated while awaiting.
    if (this.getAttribute('slot') !== 'active') return;

    if (!this.sourceBuffer) {
      this.#fireError(new Error('videl-segment: sourceBuffer property not set before activation'));
      return;
    }

    try {
      await this.sourceBuffer.append(bytes);
    } catch (err) {
      if (this.getAttribute('slot') !== 'active') return;
      this.#fireError(err as Error);
      return;
    }

    if (this.getAttribute('slot') !== 'active') return;

    this.dispatchEvent(
      new CustomEvent('videl:done', {
        bubbles: true,
        composed: true,
        detail: { startTime: this.startTime, duration: this.duration },
      })
    );
  }

  /** Abort any in-flight fetch and discard held bytes. */
  #abort(): void {
    this.#controller?.abort();
    this.#controller  = null;
    this.#fetchPromise = null;
    this.#fetchedBytes = null;
  }

  #fireError(error: Error): void {
    this.dispatchEvent(
      new CustomEvent('videl:segment:error', {
        bubbles: true,
        composed: true,
        detail: { error },
      })
    );
  }

  async #doFetch(signal: AbortSignal): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {};
    if (this.byteRange) {
      headers['Range'] = `bytes=${this.byteRange}`;
    }
    const response = await fetch(this.url, { signal, headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${response.url}`);
    }
    return response.arrayBuffer();
  }

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    if (!this.debug) return nothing;
    return html`
      <style>
        :host { display: block; font-family: monospace; font-size: 11px;
                border: 1px solid #aaa; padding: 4px; margin: 2px; }
      </style>
      <strong>videl-segment</strong>
      slot=<em>${this.slot ?? 'unslotted'}</em>
      url=<em>${this.url}</em>
      t=<em>${this.startTime}</em>+<em>${this.duration}</em>s
    `;
  }
}

customElements.define('videl-segment', VidelSegment);
