import { LitElement, nothing, css, unsafeCSS } from 'lit';
import segmentCss from '../styles/videl-segment.css';
import type { ISourceBuffer } from '../lib/ergo-mse';
import { trace } from '../trace';

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
 *   videl-state  — set by parent: "next" | "active" | (absent)
 *
 * Property contract (set by parent before activation):
 *   sourceBuffer — ManagedSourceBuffer instance
 *
 * Events fired (bubble):
 *   videl:done          — { startTime, duration } — bytes appended
 *   videl:segment:error — { error: Error }        — fetch or append failed
 */
export class VidelSegment extends LitElement {
  static styles = css`${unsafeCSS(segmentCss)}`;

  /**
   * Extend LitElement's observed attribute list with `videl-state`.
   * Declared as a getter (not a static field) so it participates in Lit's
   * class finalization. A static field would create a plain data property
   * that esbuild compiles via `__publicField`, shadowing LitElement's getter
   * without triggering finalization — causing attribute changes to be silently
   * ignored.
   */
  static get observedAttributes(): string[] {
    // Walk up from LitElement to find its observedAttributes getter, then
    // invoke it with this class as the receiver so Lit finalizes correctly.
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
    url: { type: String },
    byteRange: { type: String, attribute: 'byte-range' },
    startTime: { type: Number, attribute: 'start-time' },
    duration: { type: Number },
    slot: { type: String, reflect: true }
  };

  url       = '';
  byteRange: string | null = null;
  startTime = 0;
  duration  = 0;
  slot      = '';

  sourceBuffer: ISourceBuffer | null = null;

  // ── Internal fetch state ──────────────────────────────────────────────────

  #controller:   AbortController | null  = null;
  #fetchPromise: Promise<ArrayBuffer> | null = null;
  #fetchedBytes: ArrayBuffer | null      = null;
  #fetchStats:   { bytes: number; fetchMs: number } | null = null;

  // ── State lifecycle ───────────────────────────────────────────────────────

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    super.attributeChangedCallback(name, old, value);

    if (name !== 'videl-state') {
      return;
    }

    if (value === null) {
      this.#abort();
    } else if (value === 'next') {
      this.#startFetch();
    } else if (value === 'active') {
      this.#activate();
    }
  }

  // ── Private implementation ────────────────────────────────────────────────

  #startFetch(): void {
    trace(this, 'fetch', 'prefetch-start', { url: this.url, startTime: this.startTime });
    this.#controller  = new AbortController();
    this.#fetchPromise = this.#doFetch(this.#controller.signal);

    this.#fetchPromise
      .then(bytes => {
        this.#fetchedBytes = bytes;
        this.#fetchPromise  = null;
      })
      .catch(() => {});
  }

  async #activate(): Promise<void> {
    let bytes: ArrayBuffer;

    if (this.#fetchedBytes) {
      bytes = this.#fetchedBytes;
    } else if (this.#fetchPromise) {
      const inflight = this.#fetchPromise;
      try {
        bytes = await inflight;
      } catch (err) {
        if (this.getAttribute('videl-state') !== 'active') {
          return;
        }
        this.#fireError(err as Error);
        return;
      }
    } else {
      trace(this, 'fetch', 'fetch-start', { url: this.url, startTime: this.startTime });
      this.#controller = new AbortController();
      try {
        bytes = await this.#doFetch(this.#controller.signal);
      } catch (err) {
        if (this.getAttribute('videl-state') !== 'active') {
          return;
        }
        this.#fireError(err as Error);
        return;
      }
    }

    if (this.getAttribute('videl-state') !== 'active') {
      return;
    }

    if (this.#fetchStats) {
      const { bytes: b, fetchMs } = this.#fetchStats;
      trace(this, 'fetch', 'fetch-complete', {
        url: this.url,
        bytes: b,
        fetchMs: Math.round(fetchMs),
        bps: Math.round((b * 8) / (fetchMs / 1000))
      });
    }

    if (!this.sourceBuffer) {
      this.#fireError(new Error('videl-segment: sourceBuffer property not set before activation'));
      return;
    }

    trace(this, 'buffer', 'append-start', { startTime: this.startTime, duration: this.duration });
    try {
      await this.sourceBuffer.append(bytes);
    } catch (err) {
      if (this.getAttribute('videl-state') !== 'active') {
        return;
      }
      trace(this, 'buffer', 'append-error', { startTime: this.startTime, error: String(err) });
      this.#fireError(err as Error);
      return;
    }
    trace(this, 'buffer', 'append-complete', { startTime: this.startTime, duration: this.duration });

    if (this.getAttribute('videl-state') !== 'active') {
      return;
    }

    this.dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true,
      composed: true,
      detail: {
        startTime: this.startTime,
        duration: this.duration,
        bytes: this.#fetchStats?.bytes   ?? 0,
        fetchMs: this.#fetchStats?.fetchMs ?? 0
      }
    }));
  }

  #abort(): void {
    if (this.#controller) {
      trace(this, 'fetch', 'fetch-abort', { url: this.url, startTime: this.startTime });
      this.#controller.abort();
    }
    this.#controller   = null;
    this.#fetchPromise = null;
    this.#fetchedBytes = null;
    this.#fetchStats   = null;
  }

  #fireError(error: Error): void {
    this.dispatchEvent(new CustomEvent('videl:segment:error', {
      bubbles: true,
      composed: true,
      detail: { error }
    }));
  }

  async #doFetch(signal: AbortSignal): Promise<ArrayBuffer> {
    const headers: Record<string, string> = {};
    if (this.byteRange) {
      headers.Range = `bytes=${this.byteRange}`;
    }
    const t0       = performance.now();
    const response = await fetch(this.url, { signal, headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${response.url}`);
    }
    const bytes = await response.arrayBuffer();
    this.#fetchStats = { bytes: bytes.byteLength, fetchMs: performance.now() - t0 };
    return bytes;
  }

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    return nothing;
  }
}

customElements.define('videl-segment', VidelSegment);
