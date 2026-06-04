import { parseMpd } from '../parser/mpd-parser';
import { ManagedSourceBuffer } from '../managed-source-buffer';
import type { PlayerState } from '../player-state';
import { trace } from '../trace';

/**
 * `<videl-player>` — the root orchestrator and playlist container.
 *
 * Two operating modes:
 *
 * **Legacy / single-stream (`src` attribute):**
 * ```html
 * <videl-player src="stream.mpd"></videl-player>
 * ```
 * The player fetches + parses the MPD, creates a `<videl-presentation>` child,
 * and manages the full MSE lifecycle. Changing `src` replaces the presentation
 * and restarts the stream.
 *
 * **Playlist mode (multiple `<videl-presentation>` children):**
 * ```html
 * <videl-player>
 *   <videl-presentation src="ep1.mpd" duration="2700">
 *     <img src="thumb1.jpg" /><h3>Episode 1</h3>
 *   </videl-presentation>
 *   <videl-presentation src="ep2.mpd" duration="2580">…</videl-presentation>
 * </videl-player>
 * ```
 * The player sequences through pre-declared `<videl-presentation>` children:
 *  - On connection, sets `videl-state="active"` on the first presentation and
 *    `videl-state="next"` on the second (prefetch).
 *  - On `videl:done` from a presentation, tears down MSE, advances to the next
 *    presentation, emits `videl:playlist:advance`, and resumes playback.
 *  - Stops (does not loop) after the last presentation.
 *
 * State is communicated via `videl-state` (ADR-0002); the player never sets the
 * `slot` attribute on presentation children.
 *
 * HTMLMediaElement proxy surface:
 *  `play()`, `pause()`, `currentTime` (get/set), `duration`, `paused`,
 *  `buffered`, `volume` (get/set), `muted` (get/set), `readyState`,
 *  `playbackRate` (get/set) — all delegate to the internal `<video>`.
 */
export class VidelPlayer extends HTMLElement {
  static observedAttributes = ['src', 'tick-ms', 'buffer-ahead', 'debug'];

  // ── Internal DOM ──────────────────────────────────────────────────────────

  readonly #shadow: ShadowRoot;
  readonly #video:  HTMLVideoElement;

  // ── MSE state ─────────────────────────────────────────────────────────────

  #mediaSource:  MediaSource | null = null;
  #objectUrl:    string | null      = null;
  #sourceBuffers = new Map<string, ManagedSourceBuffer>();

  // ── Pump state ────────────────────────────────────────────────────────────

  #tickMs       = 250;
  #bufferAhead  = 30;
  #pumpTimer:   ReturnType<typeof setTimeout> | null = null;
  #activePresentation: Element | null = null;

  // ── Bandwidth estimation (EWMA) ───────────────────────────────────────────

  #bandwidth = 1_000_000; // optimistic start; real throughput replaces it quickly

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

    for (const name of [
      'play','pause','timeupdate','seeking','seeked','ended',
      'waiting','canplay','canplaythrough','durationchange','volumechange',
      'loadedmetadata','loadeddata','error',
    ]) {
      this.#video.addEventListener(name, () => this.dispatchEvent(new Event(name)));
    }

    this.#mutationObserver = new MutationObserver(this.#onMutation);
  }

  // ── Custom-element lifecycle ──────────────────────────────────────────────

  connectedCallback(): void {
    this.#mutationObserver.observe(this, { childList: true });
    this.addEventListener('videl:done',      this.#onVidelDone  as EventListener);
    this.addEventListener('videl:mse:error', this.#onMseError   as EventListener);
    this.#video.addEventListener('seeking',  this.#onVideoSeeking);

    const src = this.getAttribute('src');
    if (src) {
      this.#beginLoad(src);
    } else if (this.#childPresentations.length > 0) {
      // Pre-declared playlist — start immediately.
      this.#activatePlaylist();
    }
  }

  disconnectedCallback(): void {
    this.#stopPump();
    this.#loadAbort?.abort();
    // Clear state from any active/next presentations so they aren't stale.
    for (const pres of this.#childPresentations) {
      pres.removeAttribute('videl-state');
    }
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
    } else if (name === 'buffer-ahead') {
      this.#bufferAhead = Math.max(1, Number(value ?? 30));
    } else if (name === 'debug') {
      this.#propagateDebug(value !== null);
    }
  }

  // ── HTMLMediaElement proxy ────────────────────────────────────────────────

  get src(): string  { return this.getAttribute('src') ?? ''; }
  set src(v: string) { this.setAttribute('src', v); }

  play()  { return this.#video.play(); }
  pause() { this.#video.pause(); }

  get currentTime():       number  { return this.#video.currentTime; }
  set currentTime(v: number)       { this.#seekTo(v); }

  get duration(): number {
    // Prefer the active (or any available) presentation's manifest duration.
    const pres = this.#activePresentation ?? this.querySelector('videl-presentation');
    const mpd  = pres?.getAttribute('media-presentation-duration');
    const disp = pres?.getAttribute('duration');
    const d    = mpd ?? disp;
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

  get bufferAhead():   number  { return this.#bufferAhead; }
  set bufferAhead(v: number)   { this.#bufferAhead = Math.max(1, v); }

  get nativeVideo(): HTMLVideoElement { return this.#video; }

  // ── Playlist helpers ──────────────────────────────────────────────────────

  get #childPresentations(): Element[] {
    return [...this.querySelectorAll(':scope > videl-presentation')];
  }

  /** Start playing the pre-declared playlist from the first presentation. */
  #activatePlaylist(): void {
    const presentations = this.#childPresentations;
    if (presentations.length === 0 || this.#activePresentation) return;

    // Pre-fetch the second presentation while the first activates.
    if (presentations.length > 1) {
      presentations[1].setAttribute('videl-state', 'next');
    }

    const ctrl      = new AbortController();
    this.#loadAbort = ctrl;
    this.#activatePresentation(presentations[0], ctrl.signal).catch(() => {});
  }

  /**
   * Core activation sequence for playlist mode:
   *  1. `videlPopulate()` — fetch + parse MPD (idempotent if already done).
   *  2. `#setupMse()`     — open MediaSource, create SourceBuffers.
   *  3. `videl-state="active"` — cascade-activates down to periods.
   */
  async #activatePresentation(presEl: Element, signal: AbortSignal): Promise<void> {
    trace(this, 'lifecycle', 'presentation-activate', {
      src: presEl.getAttribute('src') ?? '',
    });

    // Populate: fetch + parse MPD if not already done (idempotent).
    if (typeof (presEl as any).videlPopulate === 'function') {
      await (presEl as any).videlPopulate();
    }
    if (signal.aborted) return;

    await this.#setupMse(presEl, signal);
  }

  // ── Legacy load (src attribute) ───────────────────────────────────────────

  async #beginLoad(src: string): Promise<void> {
    if (!src || !this.isConnected) return;

    this.#loadAbort?.abort();
    this.#loadAbort = new AbortController();
    const signal    = this.#loadAbort.signal;

    const wasPlaying = !this.#video.paused;
    trace(this, 'lifecycle', 'src-change', { src, wasPlaying });
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

      // Replace all presentation children with the newly parsed one.
      for (const old of [...this.querySelectorAll(':scope > videl-presentation')]) {
        old.removeAttribute('videl-state');
        this.removeChild(old);
      }
      this.appendChild(presEl);

      if (this.hasAttribute('debug')) this.#propagateDebug(true);

      await this.#setupMse(presEl, signal);
      if (wasPlaying) this.#video.play().catch(() => {});
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

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ms.removeEventListener('sourceopen', onOpen);
        ms.removeEventListener('error',      onErr);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onErr  = () => { cleanup(); reject(new Error('MediaSource error')); };
      ms.addEventListener('sourceopen', onOpen, { once: true });
      ms.addEventListener('error',      onErr,  { once: true });
      signal.addEventListener('abort',  () => {
        cleanup();
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });

    if (signal.aborted || ms.readyState !== 'open') return;

    trace(this, 'mse', 'source-open', {});

    const adsSets = [...presEl.querySelectorAll('videl-adaptation-set')];
    for (const ads of adsSets) {
      const contentType = ads.getAttribute('content-type') ?? '';
      if (this.#sourceBuffers.has(contentType)) {
        (ads as any).sourceBuffer = this.#sourceBuffers.get(contentType);
        continue;
      }

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
        trace(this, 'mse', 'add-source-buffer', { contentType, mimeAndCodecs });
        const sb  = ms.addSourceBuffer(mimeAndCodecs);
        const msb = new ManagedSourceBuffer(sb);
        this.#sourceBuffers.set(contentType, msb);
        (ads as any).sourceBuffer = msb;
      } catch (e) {
        console.warn(`[videl-player] addSourceBuffer failed for ${contentType}:`, e);
      }
    }

    if (signal.aborted) return;

    presEl.setAttribute('videl-state', 'active');
    this.#activePresentation = presEl;

    trace(this, 'mse', 'setup-complete', {
      sourceBuffers: [...this.#sourceBuffers.keys()],
    });

    this.#startPump();
  }

  // ── MSE teardown ──────────────────────────────────────────────────────────

  #teardownPresentation(): void {
    if (this.#activePresentation) {
      this.#activePresentation.removeAttribute('videl-state');
      this.#activePresentation = null;
    }
  }

  #teardownMse(): void {
    if (this.#mediaSource) {
      trace(this, 'mse', 'teardown', { readyState: this.#mediaSource.readyState });
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
    const sourceBuffered = new Map<string, TimeRanges>();
    for (const [ct, msb] of this.#sourceBuffers) {
      sourceBuffered.set(ct, msb.buffered);
    }

    const state: PlayerState = {
      currentTime:   this.#video.currentTime,
      buffered:      this.#video.buffered,
      bandwidth:     this.#bandwidth,
      playbackRate:  Math.max(this.#video.playbackRate, 0.01),
      bufferAhead:   this.#bufferAhead,
      sourceBuffered,
    };
    (this.#activePresentation as any).videlUpdate(state);
  }

  // ── Seek ──────────────────────────────────────────────────────────────────

  #seekTo(time: number): void {
    trace(this, 'lifecycle', 'seek', { to: +time.toFixed(3) });
    this.#video.currentTime = time;
    this.#stopPump();
    this.#pumpTick();
    this.#startPump();
  }

  #onVideoSeeking = (): void => {
    this.#stopPump();
    this.#pumpTick();
    this.#startPump();
  };

  // ── Event handlers ────────────────────────────────────────────────────────

  #onVidelDone = (event: Event): void => {
    const target = event.target as Element;
    const tag    = target.tagName.toLowerCase();

    if (tag === 'videl-segment') {
      // Bandwidth estimation from real fetch throughput.
      const { bytes = 0, fetchMs = 0 } = (event as CustomEvent).detail ?? {};
      if (bytes > 0 && fetchMs >= 50) {
        const measuredBps = (bytes * 8) / (fetchMs / 1000);
        this.#bandwidth = 0.666 * this.#bandwidth + 0.334 * measuredBps;
      }
      return;
    }

    if (tag === 'videl-presentation' && target.parentElement === this) {
      this.#onPresentationDone(target);
    }
  };

  #onPresentationDone(completedPres: Element): void {
    const presentations = this.#childPresentations;
    const currentIdx    = presentations.indexOf(completedPres);
    const nextPres      = presentations[currentIdx + 1];

    const wasPlaying = !this.#video.paused;
    const fromSrc    = completedPres.getAttribute('src') ?? '';

    trace(this, 'lifecycle', 'playlist-advance', {
      from:  fromSrc,
      to:    nextPres?.getAttribute('src') ?? null,
      index: currentIdx + 1,
    });

    this.#teardownPresentation();
    this.#teardownMse();

    if (!nextPres) {
      // End of playlist.
      this.#stopPump();
      return;
    }

    this.dispatchEvent(new CustomEvent('videl:playlist:advance', {
      bubbles: true,
      detail: {
        from:  fromSrc,
        to:    nextPres.getAttribute('src') ?? '',
        index: currentIdx + 1,
      },
    }));

    // Pre-fetch the presentation after next while activating next.
    const afterNext = presentations[currentIdx + 2];
    if (afterNext && !afterNext.getAttribute('videl-state')) {
      afterNext.setAttribute('videl-state', 'next');
    }

    const ctrl      = new AbortController();
    this.#loadAbort = ctrl;
    this.#activatePresentation(nextPres, ctrl.signal).then(() => {
      if (wasPlaying) this.#video.play().catch(() => {});
    }).catch(() => {});
  }

  #onMseError = (_event: Event): void => {
    const savedTime  = this.#video.currentTime;
    const wasPlaying = !this.#video.paused;
    trace(this, 'mse', 'rebuild-start', {
      reason: 'videl:mse:error', savedTime: +savedTime.toFixed(3), wasPlaying,
    });

    this.#teardownPresentation();
    this.#teardownMse();

    const pres = this.querySelector('videl-presentation');
    if (pres) {
      const ctrl = new AbortController();
      this.#setupMse(pres, ctrl.signal).then(() => {
        if (savedTime > 0) this.#video.currentTime = savedTime;
        if (wasPlaying) this.#video.play().catch(() => {});
      }).catch(() => {});
    }
  };

  // ── MutationObserver ──────────────────────────────────────────────────────

  #onMutation = (mutations: MutationRecord[]): void => {
    const added = mutations.flatMap(m => [...m.addedNodes])
      .filter((n): n is Element => n instanceof Element);

    // New <videl-presentation> children added while player is idle → start playlist.
    const hasNewPres = added.some(n => n.tagName.toLowerCase() === 'videl-presentation');
    if (hasNewPres && !this.#activePresentation && !this.getAttribute('src')) {
      this.#activatePlaylist();
    }

    // New <videl-period> children (ad insertion inside a presentation) → re-pump.
    const hasNewPeriod = added.some(n => n.tagName.toLowerCase() === 'videl-period');
    if (hasNewPeriod) {
      this.#stopPump();
      this.#pumpTick();
      this.#startPump();
    }
  };

  // ── Debug propagation ─────────────────────────────────────────────────────

  #propagateDebug(on: boolean): void {
    const sel = [
      'videl-presentation','videl-period','videl-adaptation-set',
      'videl-representation','videl-segment',
    ].join(',');
    for (const el of this.querySelectorAll(sel)) {
      on ? el.setAttribute('debug', '') : el.removeAttribute('debug');
    }
  }
}

customElements.define('videl-player', VidelPlayer);
