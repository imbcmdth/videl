import { parseMpd } from '../parser/mpd-parser';
import { ManagedSourceBuffer } from '../managed-source-buffer';
import type { PlayerState } from '../player-state';

/**
 * `<videl-player>` — the root orchestrator.
 *
 * Responsibilities:
 *  - Fetches + parses the DASH MPD at `src`.
 *  - Sole owner of `MediaSource` and its object URL.
 *  - Calls `addSourceBuffer` for each content type and distributes the
 *    resulting `ManagedSourceBuffer` to child `<videl-adaptation-set>`
 *    elements before activating the presentation.
 *  - Runs a `setTimeout`-based pump that calls `videlUpdate(PlayerState)`
 *    on the active `<videl-presentation>` every `tick-ms` milliseconds.
 *  - Maintains a rolling bandwidth estimate from `videl:done` events fired
 *    by `<videl-segment>` children and includes it in every `PlayerState`.
 *  - Watches for `videl:mse:error` events and executes the MSE rebuild
 *    procedure to restore playback from the saved `currentTime`.
 *  - Watches for direct-child `<videl-period>` mutations and re-pumps
 *    immediately so ad-insertion changes take effect without waiting for
 *    the next tick.
 *
 * HTMLMediaElement interface:
 *  `play()`, `pause()`, `currentTime` (get/set), `duration`, `paused`,
 *  `buffered`, `volume` (get/set), `muted` (get/set), `readyState`,
 *  `playbackRate` (get/set) — all proxy the internal `<video>` element.
 *
 * Compatibility with media-chrome:
 *  Slot `<videl-player>` as the media element inside `<media-controller>`,
 *  or access the internal video via the `nativeVideo` property.
 *
 * Note: `CustomVideoElement` from `custom-video-element` creates a
 * `document.createElement('template')` at module parse time, which
 * prevents bundling with esbuild in a Node context. `VidelPlayer` therefore
 * extends `HTMLElement` directly and wraps an internal `<video>`, providing
 * an equivalent HTMLMediaElement-compatible surface area.
 */
export class VidelPlayer extends HTMLElement {
  static observedAttributes = ['src', 'tick-ms', 'debug'];

  // ── Internal DOM ──────────────────────────────────────────────────────────

  readonly #shadow: ShadowRoot;
  readonly #video:  HTMLVideoElement;

  // ── MSE state ─────────────────────────────────────────────────────────────

  #mediaSource: MediaSource | null = null;
  #objectUrl:   string | null      = null;
  /** contentType → ManagedSourceBuffer (one per content type per MSE session). */
  #sourceBuffers = new Map<string, ManagedSourceBuffer>();

  // ── Pump state ────────────────────────────────────────────────────────────

  #tickMs       = 250;
  #pumpTimer:   ReturnType<typeof setTimeout> | null = null;
  #activePresentation: Element | null = null;

  // ── Bandwidth estimation (EWMA) ───────────────────────────────────────────

  #bandwidth = 1_000_000; // initial: 1 Mbps

  // ── Load lifecycle ────────────────────────────────────────────────────────

  #loadAbort: AbortController | null = null;

  // ── Observers ─────────────────────────────────────────────────────────────

  readonly #mutationObserver: MutationObserver;

  // ──────────────────────────────────────────────────────────────────────────

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: 'open' });
    this.#shadow.innerHTML = `
      <style>
        :host { display: inline-block; position: relative; }
        video  { width: 100%; height: 100%; display: block; }
      </style>`;

    this.#video = document.createElement('video');
    this.#shadow.appendChild(this.#video);

    // Forward media events from the internal video to this element.
    for (const name of [
      'play','pause','timeupdate','seeking','seeked','ended',
      'waiting','canplay','canplaythrough','durationchange','volumechange',
      'loadedmetadata','loadeddata','error',
    ]) {
      this.#video.addEventListener(name, () => {
        this.dispatchEvent(new Event(name));
      });
    }

    this.#mutationObserver = new MutationObserver(this.#onMutation);
  }

  // ── Custom-element lifecycle ──────────────────────────────────────────────

  connectedCallback(): void {
    this.#mutationObserver.observe(this, { childList: true });
    this.addEventListener('videl:done',      this.#onVidelDone  as EventListener);
    this.addEventListener('videl:mse:error', this.#onMseError   as EventListener);
    this.#video.addEventListener('seeking',  this.#onVideoSeeking);

    // If `src` was set before connection, start loading now.
    const src = this.getAttribute('src');
    if (src) this.#beginLoad(src);
  }

  disconnectedCallback(): void {
    this.#stopPump();
    this.#loadAbort?.abort();
    this.#mutationObserver.disconnect();
    this.removeEventListener('videl:done',      this.#onVidelDone  as EventListener);
    this.removeEventListener('videl:mse:error', this.#onMseError   as EventListener);
    this.#video.removeEventListener('seeking',  this.#onVideoSeeking);
    this.#teardownMse();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (name === 'src') {
      if (value !== old && this.isConnected) this.#beginLoad(value ?? '');
    } else if (name === 'tick-ms') {
      this.#tickMs = Math.max(16, Number(value ?? 250));
    } else if (name === 'debug') {
      this.#propagateDebug(value !== null);
    }
  }

  // ── HTMLMediaElement proxy ────────────────────────────────────────────────

  get src(): string  { return this.getAttribute('src') ?? ''; }
  set src(v: string) { this.setAttribute('src', v); }

  play()  { return this.#video.play(); }
  pause() { this.#video.pause(); }

  get currentTime():        number  { return this.#video.currentTime; }
  set currentTime(v: number)        { this.#seekTo(v); }

  get duration(): number {
    // Prefer the manifest's declared total duration over the MSE duration.
    const pres = this.querySelector('videl-presentation');
    const d    = pres?.getAttribute('media-presentation-duration');
    return d ? Number(d) : (this.#video.duration || NaN);
  }

  get paused():      boolean    { return this.#video.paused; }
  get buffered():    TimeRanges { return this.#video.buffered; }
  get readyState():  number     { return this.#video.readyState; }

  get volume():        number  { return this.#video.volume; }
  set volume(v: number)        { this.#video.volume = v; }

  get muted():         boolean { return this.#video.muted; }
  set muted(v: boolean)        { this.#video.muted = v; }

  get playbackRate():  number  { return this.#video.playbackRate; }
  set playbackRate(v: number)  { this.#video.playbackRate = v; }

  /** Direct access to the internal <video> element for media-chrome slotting. */
  get nativeVideo(): HTMLVideoElement { return this.#video; }

  // ── Load ──────────────────────────────────────────────────────────────────

  async #beginLoad(src: string): Promise<void> {
    if (!src || !this.isConnected) return;

    // Cancel any previous in-flight load and tear down existing MSE.
    this.#loadAbort?.abort();
    this.#loadAbort = new AbortController();
    const signal    = this.#loadAbort.signal;

    this.#stopPump();
    this.#teardownPresentation();
    this.#teardownMse();

    try {
      const resp = await fetch(src, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${src}`);
      const xml = await resp.text();
      if (signal.aborted) return;

      const presEl = parseMpd(xml, src);
      if (signal.aborted) return;

      // Replace any stale presentation children.
      for (const old of [...this.querySelectorAll(':scope > videl-presentation')]) {
        this.removeChild(old);
      }
      this.appendChild(presEl);

      if (this.hasAttribute('debug')) this.#propagateDebug(true);

      await this.#setupMse(presEl, signal);
    } catch (err: unknown) {
      if ((err as any)?.name === 'AbortError') return;
      console.error('[videl-player] load failed:', err);
    }
  }

  // ── MSE setup ─────────────────────────────────────────────────────────────

  async #setupMse(presEl: Element, signal: AbortSignal): Promise<void> {
    const ms  = new MediaSource();
    this.#mediaSource = ms;
    const url = URL.createObjectURL(ms);
    this.#objectUrl   = url;
    this.#video.src   = url;

    // Wait for sourceopen.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ms.removeEventListener('sourceopen', onOpen);
        ms.removeEventListener('error',      onErr);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onErr  = () => { cleanup(); reject(new Error('MediaSource error')); };
      ms.addEventListener('sourceopen', onOpen, { once: true });
      ms.addEventListener('error',      onErr,  { once: true });
      signal.addEventListener('abort',  () => { cleanup(); reject(new DOMException('Aborted', 'AbortError')); });
    });

    if (signal.aborted || ms.readyState !== 'open') return;

    // Create one SourceBuffer per unique content type from the presentation.
    const adsSets = [...presEl.querySelectorAll('videl-adaptation-set')];
    for (const ads of adsSets) {
      const contentType = ads.getAttribute('content-type') ?? '';
      if (this.#sourceBuffers.has(contentType)) {
        // Already created for this content type — distribute to this ads too.
        (ads as any).sourceBuffer = this.#sourceBuffers.get(contentType);
        continue;
      }

      // Resolve the most specific mime+codecs from the first representation.
      const adsMime   = ads.getAttribute('mime-type') ?? '';
      const adsCodecs = ads.getAttribute('codecs')    ?? '';
      const firstRep  = ads.querySelector('videl-representation');
      const mime      = firstRep?.getAttribute('mime-type')  ?? adsMime;
      const codecs    = firstRep?.getAttribute('codecs')     ?? adsCodecs;
      const mimeAndCodecs = codecs ? `${mime}; codecs="${codecs}"` : mime;

      if (!mimeAndCodecs || !MediaSource.isTypeSupported(mimeAndCodecs)) {
        console.warn(`[videl-player] unsupported codec for ${contentType}: ${mimeAndCodecs}`);
        continue;
      }

      try {
        const sb  = ms.addSourceBuffer(mimeAndCodecs);
        const msb = new ManagedSourceBuffer(sb);
        this.#sourceBuffers.set(contentType, msb);
        (ads as any).sourceBuffer = msb;
      } catch (e) {
        console.warn(`[videl-player] addSourceBuffer failed for ${contentType}:`, e);
      }
    }

    if (signal.aborted) return;

    // Activate the presentation — this cascades down through period → adaptation
    // sets → representations.
    (presEl as any).setAttribute('slot', 'active');
    this.#activePresentation = presEl;

    this.#startPump();
  }

  // ── MSE teardown ──────────────────────────────────────────────────────────

  #teardownPresentation(): void {
    if (this.#activePresentation) {
      (this.#activePresentation as any).removeAttribute('slot');
      this.#activePresentation = null;
    }
  }

  #teardownMse(): void {
    if (this.#mediaSource) {
      try {
        if (this.#mediaSource.readyState === 'open') this.#mediaSource.endOfStream();
      } catch { /* ignore */ }
      this.#mediaSource = null;
    }
    if (this.#objectUrl) {
      URL.revokeObjectURL(this.#objectUrl);
      this.#objectUrl = null;
    }
    this.#sourceBuffers.clear();
    this.#video.removeAttribute('src');
    this.#video.load();
  }

  // ── Pump ──────────────────────────────────────────────────────────────────

  #startPump(): void {
    this.#pumpTimer = setTimeout(this.#tick, this.#tickMs);
  }

  #stopPump(): void {
    if (this.#pumpTimer !== null) {
      clearTimeout(this.#pumpTimer);
      this.#pumpTimer = null;
    }
  }

  #tick = (): void => {
    this.#pumpTick();
    if (this.#activePresentation) {
      this.#pumpTimer = setTimeout(this.#tick, this.#tickMs);
    }
  };

  #pumpTick(): void {
    if (!this.#activePresentation) return;
    const state: PlayerState = {
      currentTime:  this.#video.currentTime,
      buffered:     this.#video.buffered,
      bandwidth:    this.#bandwidth,
      playbackRate: Math.max(this.#video.playbackRate, 0.01),
    };
    (this.#activePresentation as any).videlUpdate(state);
  }

  // ── Seek ──────────────────────────────────────────────────────────────────

  #seekTo(time: number): void {
    this.#video.currentTime = time;
    // Pump immediately so the correct segment is activated without waiting
    // for the next scheduled tick.
    this.#stopPump();
    this.#pumpTick();
    this.#startPump();
  }

  #onVideoSeeking = (): void => {
    // Same: pump immediately on browser-initiated seeks.
    this.#stopPump();
    this.#pumpTick();
    this.#startPump();
  };

  // ── Bandwidth estimation ──────────────────────────────────────────────────

  #onVidelDone = (event: Event): void => {
    const target = event.target as Element;
    if (target.tagName.toLowerCase() !== 'videl-segment') return;

    // Use the representation's declared bandwidth as a proxy for actual
    // throughput (EWMA α=0.3 towards the latest sample).
    const repEl = target.closest('videl-representation');
    const bw    = Number(repEl?.getAttribute('bandwidth') ?? 0);
    if (bw > 0) {
      this.#bandwidth = 0.7 * this.#bandwidth + 0.3 * bw;
    }
  };

  // ── Error recovery ────────────────────────────────────────────────────────

  #onMseError = (_event: Event): void => {
    const savedTime = this.#video.currentTime;

    this.#teardownPresentation();
    this.#teardownMse();

    // Re-setup against the existing parsed presentation subtree if present.
    const pres = this.querySelector('videl-presentation');
    if (pres) {
      const ctrl = new AbortController();
      this.#setupMse(pres, ctrl.signal).then(() => {
        if (savedTime > 0) this.#video.currentTime = savedTime;
      }).catch(() => {});
    }
  };

  // ── MutationObserver ──────────────────────────────────────────────────────

  #onMutation = (mutations: MutationRecord[]): void => {
    const hasPeriodChange = mutations.some(m =>
      [...m.addedNodes, ...m.removedNodes].some(
        n => n instanceof Element && n.tagName.toLowerCase() === 'videl-period'
      )
    );
    if (hasPeriodChange) {
      this.#stopPump();
      this.#pumpTick();
      this.#startPump();
    }
  };

  // ── Debug propagation ─────────────────────────────────────────────────────

  #propagateDebug(on: boolean): void {
    const selector = [
      'videl-presentation','videl-period','videl-adaptation-set',
      'videl-representation','videl-segment',
    ].join(',');
    for (const el of this.querySelectorAll(selector)) {
      on ? el.setAttribute('debug', '') : el.removeAttribute('debug');
    }
  }
}

customElements.define('videl-player', VidelPlayer);
