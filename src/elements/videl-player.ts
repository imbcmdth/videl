import { parseMpd } from '../parser/mpd-parser';
import { ErgoMediaSource, TextSourceBuffer } from '../lib/ergo-mse';
import type { ISourceBuffer } from '../lib/ergo-mse';
import type { PlayerState } from '../player-state';
import { trace } from '../trace';
import { VidelAdaptationSet } from './videl-adaptation-set';
import { VidelPresentation } from './videl-presentation';

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

  #ergoMse:      ErgoMediaSource | null = null;
  #sourceBuffers = new Map<string, ISourceBuffer>();

  // ── Pump state ────────────────────────────────────────────────────────────

  #tickMs       = 250;
  #bufferAhead  = 30;
  #pumpTimer:   ReturnType<typeof setTimeout> | null = null;
  #activePresentation: Element | null = null;

  // ── "Now playing" mirror ──────────────────────────────────────────────────
  // The active presentation becomes the stage overlay, so it cannot also sit in
  // the playlist. A single reusable mirror element is moved into the active
  // presentation's slot position and filled with a clone of its card content.

  #mirror: HTMLElement | null = null;

  // ── User-inactivity detection ─────────────────────────────────────────────
  // When the player has an active presentation, a 5-second idle timer runs.
  // Expiry (or pointer leaving the player) sets the `user-inactive` attribute
  // on the player and on the active presentation; any pointer activity clears
  // it. CSS in both shadows responds to the attribute to hide controls and
  // collapse the playlist column.

  static readonly #INACTIVITY_MS = 3_000;
  #inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Bandwidth estimation (EWMA) ───────────────────────────────────────────

  #bandwidth = 1_000_000; // optimistic start; real throughput replaces it quickly
  #minFetchLatency = Infinity; // track the minimum fetch latency observed so far

  // ── Load lifecycle ────────────────────────────────────────────────────────

  #loadAbort: AbortController | null = null;

  // ── Observers ─────────────────────────────────────────────────────────────

  readonly #mutationObserver: MutationObserver;

  // ──────────────────────────────────────────────────────────────────────────

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: 'open' });

    // ── Shadow DOM: two-column layout ────────────────────────────────────────
    //
    //   .layout (grid: 1fr | playlist)
    //     .stage   (col 1)  → <slot name="stage"> + <video>
    //     .playlist(col 2)  → <slot> (default: cards + now-playing mirror)
    //
    // The ACTIVE presentation is assigned slot="stage" by the player, so it
    // renders inside .stage and its position:absolute overlay is contained by
    // .stage (covering only the video, never the playlist). Inactive
    // presentations have no slot attribute and flow as cards in .playlist.
    // The playlist column collapses automatically via the user-inactivity
    // mechanism — there is no manual toggle button.
    this.#shadow.innerHTML = `
      <style>
        :host {
          display: inline-block;
          position: relative;
          overflow: hidden;
          /* Fundamental stage background: the video area is black before/behind
             frames. Consumers can override on the host element if desired. */
          background: #000;
          --videl-playlist-width: 260px;
        }
        /* Collapsed (user) or unavailable (<2 presentations): no playlist column. */
        :host([playlist-collapsed]),
        :host([videl-no-playlist]) {
          --videl-playlist-width: 0px;
        }
        .layout {
          position: absolute;
          inset: 0;
          display: grid;
          grid-template-columns: 1fr var(--videl-playlist-width);
          /* Fill the full container height; without an explicit row the single
             auto row would size to the (absolute-only) stage content = 0, and
             the stage would inherit the playlist cards' height instead. */
          grid-template-rows: minmax(0, 1fr);
          transition: grid-template-columns 0.2s ease;
        }
        .stage {
          position: relative;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          background: #000;
        }
        video {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          display: block;
        }
        video::-webkit-media-text-track-container {
          bottom: 80px;
        }
        :host([videl-user-inactive]) video::-webkit-media-text-track-container {
          bottom: 20px;
        }
        .playlist {
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          background: #0d0d0d;
          border-left: 1px solid #222;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 8px;
          box-sizing: border-box;
        }
        :host([playlist-collapsed]) .playlist,
        :host([videl-no-playlist]) .playlist {
          padding: 0;
          border-left: none;
        }
        /* Cards in the default (playlist) slot. The stage-slotted active
           presentation is excluded because slotted() can't be matched here for
           the named slot — its own :host([videl-state=active]) rule governs it. */
        ::slotted(videl-presentation) {
          width: 100%;
          flex: 0 0 auto;
        }
        /* "Now playing" mirror card — occupies the active presentation's slot
           position in the playlist (the real one is the stage overlay).
           The card-content frame mirrors videl-presentation's .card-frame so
           the cloned content (plain <strong>/<small> tags) renders identically:
           the frame container provides the gradient, padding, bottom-alignment
           and inherited colour/font, and the tags carry their own hierarchy.
           Shadow CSS can't target the cloned descendants directly, so all text
           styling here is inherited. */
        ::slotted(.videl-now-playing) {
          position: relative;
          width: 100%;
          flex: 0 0 auto;
          aspect-ratio: 16 / 9;
          overflow: hidden;
          border: 2px solid #4f9cf9;
          box-shadow: 0 0 0 1px rgba(79, 156, 249, 0.4);
          display: flex;
          flex-direction: column;
          justify-content: flex-end;
          gap: 2px;
          padding: 8px;
          box-sizing: border-box;
          background: linear-gradient(transparent 30%, rgba(0, 0, 0, 0.75)), #000;
          color: #fff;
          font-family: ui-monospace, monospace;
          font-size: 11px;
          line-height: 1.3;
          text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
        }

        /* ── User-inactivity: immersive mode ─────────────────────── */
        /*
         * When the pointer leaves or idles for 5 s, [user-inactive] is set on
         * the host. The playlist column collapses (reusing the same CSS var and
         * existing .layout transition) and the cursor disappears. Any pointer
         * activity removes the attribute immediately.
         */
        :host([videl-user-inactive]) {
          cursor: none;
          --videl-playlist-width: 0px;
        }
      </style>
      <div class="layout">
        <div class="stage"><slot name="stage"></slot></div>
        <aside class="playlist"><slot></slot></aside>
      </div>`;

    this.#video = document.createElement('video');
    this.#shadow.querySelector('.stage')!.appendChild(this.#video);

    for (const name of [
      'play', 'pause', 'timeupdate', 'seeking', 'seeked', 'ended',
      'waiting', 'canplay', 'canplaythrough', 'durationchange', 'volumechange',
      'loadedmetadata', 'loadeddata', 'error'
    ]) {
      this.#video.addEventListener(name, () => this.dispatchEvent(new Event(name)));
    }

    this.#mutationObserver = new MutationObserver(this.#onMutation);
  }

  /**
   * Show the playlist column only when there are at least two presentations to
   * choose from. Single-stream (`src`) mode and one-item playlists collapse it
   * (and hide the toggle) so the video uses the full frame.
   */
  #refreshPlaylistChrome(): void {
    const count = this.#childPresentations.length;
    if (count >= 2) {
      this.removeAttribute('videl-no-playlist');
    } else            {
      this.setAttribute('videl-no-playlist', '');
    }
  }

  #ensureMirror(): HTMLElement {
    if (!this.#mirror) {
      const el = document.createElement('div');
      el.className = 'videl-now-playing';
      el.setAttribute('aria-label', 'Now playing');
      this.#mirror = el;
    }
    return this.#mirror;
  }

  /**
   * Reflect the active presentation into the playlist via a reusable mirror
   * card. The active presentation itself is the stage overlay (position
   * absolute, out of the playlist flow), so the mirror fills its slot position
   * with a clone of its user content. Moved/refilled whenever the active
   * presentation changes; removed when there is no active presentation or no
   * visible playlist.
   */
  #updateMirror(): void {
    const active = this.#activePresentation;
    // Only mirror when the playlist column is actually visible (≥ 2 items).
    const show = !!active && this.#childPresentations.length >= 2;

    if (!show) {
      this.#mirror?.remove();
      return;
    }

    const mirror = this.#ensureMirror();
    mirror.replaceChildren();

    // "Now playing" badge (inline-styled so it needs no external CSS).
    const badge = document.createElement('div');
    badge.textContent = '\u25B6 Now Playing';
    badge.setAttribute(
      'style',
      'position:absolute;top:6px;left:6px;z-index:2;pointer-events:none;' +
      'font:600 10px/1 ui-monospace,monospace;color:#fff;' +
      'background:rgba(79,156,249,0.9);padding:3px 6px;'
    );
    mirror.appendChild(badge);

    // Clone the active presentation's user content (skip technical periods).
    for (const child of Array.from(active!.children)) {
      if (child.tagName.toLowerCase() === 'videl-period') {
        continue;
      }
      mirror.appendChild(child.cloneNode(true));
    }

    // Place the mirror immediately before the active presentation so it sits at
    // the active item's position in the playlist order.
    if (mirror.nextElementSibling !== active) {
      active!.parentElement?.insertBefore(mirror, active!);
    }
  }

  // ── Custom-element lifecycle ──────────────────────────────────────────────

  connectedCallback(): void {
    this.#mutationObserver.observe(this, { childList: true });
    this.addEventListener('videl:done',          this.#onVidelDone    as EventListener);
    this.addEventListener('videl:mse:error',     this.#onMseError     as EventListener);
    this.addEventListener('videl:ui:play-pause',  this.#onUiPlayPause  as EventListener);
    this.addEventListener('videl:ui:seek',        this.#onUiSeek       as EventListener);
    this.addEventListener('videl:ui:volume',      this.#onUiVolume     as EventListener);
    this.addEventListener('videl:ui:mute-toggle', this.#onUiMuteToggle as EventListener);
    this.addEventListener('click',                this.#onPlaylistClick);
    this.#video.addEventListener('seeking', this.#onVideoSeeking);
    this.#video.addEventListener('ended',   this.#onVideoEnded);
    this.addEventListener('pointermove',         this.#onPointerActivity);
    this.addEventListener('pointerdown',         this.#onPointerActivity);
    this.addEventListener('pointerleave',        this.#onPointerLeave);

    this.#refreshPlaylistChrome();

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
    this.removeEventListener('videl:done',          this.#onVidelDone    as EventListener);
    this.removeEventListener('videl:mse:error',     this.#onMseError     as EventListener);
    this.removeEventListener('videl:ui:play-pause',  this.#onUiPlayPause  as EventListener);
    this.removeEventListener('videl:ui:seek',        this.#onUiSeek       as EventListener);
    this.removeEventListener('videl:ui:volume',      this.#onUiVolume     as EventListener);
    this.removeEventListener('videl:ui:mute-toggle', this.#onUiMuteToggle as EventListener);
    this.removeEventListener('click',                this.#onPlaylistClick);
    this.#video.removeEventListener('seeking', this.#onVideoSeeking);
    this.#video.removeEventListener('ended',   this.#onVideoEnded);
    this.removeEventListener('pointermove',         this.#onPointerActivity);
    this.removeEventListener('pointerdown',         this.#onPointerActivity);
    this.removeEventListener('pointerleave',        this.#onPointerLeave);
    this.#clearInactivityTimer();
    this.#teardownMse();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    if (name === 'src') {
      if (value !== old && this.isConnected) {
        this.#beginLoad(value ?? '');
      }
    } else if (name === 'tick-ms') {
      this.#tickMs = Math.max(16, Number(value ?? 250));
    } else if (name === 'buffer-ahead') {
      this.#bufferAhead = Math.max(1, Number(value ?? 30));
    } else if (name === 'debug') {
      this.#propagateDebug(value !== null);
    }
  }

  // ── HTMLMediaElement proxy ────────────────────────────────────────────────

  get src(): string  {
    return this.getAttribute('src') ?? '';
  }
  set src(v: string) {
    this.setAttribute('src', v);
  }

  play()  {
    return this.#video.play();
  }
  pause() {
    this.#video.pause();
  }

  get currentTime():       number  {
    return this.#video.currentTime;
  }
  set currentTime(v: number)       {
    this.#seekTo(v);
  }

  get duration(): number {
    // Prefer the active (or any available) presentation's manifest duration.
    const pres = this.#activePresentation ?? this.querySelector('videl-presentation');
    const mpd  = pres?.getAttribute('media-presentation-duration');
    const disp = pres?.getAttribute('duration');
    const d    = mpd ?? disp;
    return d ? Number(d) : (this.#video.duration || NaN);
  }

  get paused():      boolean    {
    return this.#video.paused;
  }
  get buffered():    TimeRanges {
    return this.#video.buffered;
  }
  get readyState():  number     {
    return this.#video.readyState;
  }

  get volume():        number  {
    return this.#video.volume;
  }
  set volume(v: number)        {
    this.#video.volume = v;
  }

  get muted():         boolean {
    return this.#video.muted;
  }
  set muted(v: boolean)        {
    this.#video.muted = v;
  }

  get playbackRate():  number  {
    return this.#video.playbackRate;
  }
  set playbackRate(v: number)  {
    this.#video.playbackRate = v;
  }

  get bufferAhead():   number  {
    return this.#bufferAhead;
  }
  set bufferAhead(v: number)   {
    this.#bufferAhead = Math.max(1, v);
  }

  get nativeVideo(): HTMLVideoElement {
    return this.#video;
  }

  // ── Playlist helpers ──────────────────────────────────────────────────────

  get #childPresentations(): Element[] {
    return [...this.querySelectorAll(':scope > videl-presentation')];
  }

  /** Start playing the pre-declared playlist from the first presentation. */
  #activatePlaylist(): void {
    const presentations = this.#childPresentations;
    if (presentations.length === 0 || this.#activePresentation) {
      return;
    }

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
      src: presEl.getAttribute('src') ?? ''
    });

    // Populate: fetch + parse MPD if not already done (idempotent).
    if (presEl instanceof VidelPresentation) {
      await presEl.videlPopulate();
    }
    if (signal.aborted) {
      return;
    }

    await this.#setupMse(presEl, signal);
  }

  // ── Legacy load (src attribute) ───────────────────────────────────────────

  async #beginLoad(src: string): Promise<void> {
    if (!src || !this.isConnected) {
      return;
    }

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
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} fetching ${src}`);
      }
      const xml = await resp.text();
      if (signal.aborted) {
        return;
      }

      const presEl = parseMpd(xml, src);
      if (signal.aborted) {
        return;
      }

      // Replace all presentation children with the newly parsed one.
      for (const old of [...this.querySelectorAll(':scope > videl-presentation')]) {
        old.removeAttribute('videl-state');
        this.removeChild(old);
      }
      // Mark as auto-generated so consumers can target `videl-presentation[videl-generated]`
      // in CSS to style (or hide) it differently from declarative playlist cards.
      presEl.setAttribute('videl-generated', '');
      this.appendChild(presEl);

      if (this.hasAttribute('debug')) {
        this.#propagateDebug(true);
      }

      await this.#setupMse(presEl, signal);
      if (wasPlaying) {
        this.#video.play().catch(() => {});
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[videl-player] load failed:', err);
    }
  }

  // ── MSE setup ─────────────────────────────────────────────────────────────

  async #setupMse(presEl: Element, signal: AbortSignal): Promise<void> {
    const mse = new ErgoMediaSource();
    this.#ergoMse = mse;

    await mse.attach(this.#video, signal);

    if (signal.aborted || mse.readyState !== 'open') {
      return;
    }

    trace(this, 'mse', 'source-open', {});

    // For live (type="dynamic") streams, duration must be Infinity so MSE
    // does not try to bound the seekable range by a fixed endpoint.
    // setLiveSeekableRange is called on each pump tick to maintain the
    // sliding DVR window.
    const isLive = presEl.getAttribute('type') === 'dynamic';
    if (isLive) {
      try {
        mse.duration = Infinity;
      } catch { /* ignore — some browsers reject this if readyState != 'open' */ }
    }

    const adsSets = [...presEl.querySelectorAll('videl-adaptation-set')] as VidelAdaptationSet[];

    for (const ads of adsSets) {
      const contentType = ads.getAttribute('content-type') ?? '';

      if (this.#sourceBuffers.has(contentType)) {
        ads.sourceBuffer = this.#sourceBuffers.get(contentType) ?? null;
        continue;
      }

      const adsMime   = ads.getAttribute('mime-type') ?? '';
      const adsCodecs = ads.getAttribute('codecs')    ?? '';
      const firstRep  = ads.querySelector('videl-representation');
      const mime      = firstRep?.getAttribute('mime-type')  ?? adsMime;
      const codecs    = firstRep?.getAttribute('codecs')     ?? adsCodecs;
      const mimeAndCodecs = codecs ? `${mime}; codecs="${codecs}"` : mime;

      const isValidContentType = ['text', 'video', 'audio'].indexOf(contentType) >= 0;
      if (!isValidContentType) {
        console.warn(`Skipping source buffer creation for content type "${contentType}" which is not "text", "video", or "audio". `);
        continue;
      }

      if (!mimeAndCodecs || !ErgoMediaSource.isTypeSupported(mimeAndCodecs)) {
        // eslint-disable-next-line no-console
        console.warn(`[videl-player] unsupported codec for ${contentType}: ${mimeAndCodecs}`);
        continue;
      }

      // Text tracks reuse a single TextSourceBuffer across multiple ADS.
      if (contentType === 'text' && this.#sourceBuffers.has('text')) {
        ads.sourceBuffer = this.#sourceBuffers.get('text') ?? null;
        continue;
      }

      try {
        const label = ads.getAttribute('label') ?? ads.getAttribute('lang') ?? 'subtitles';
        const lang  = ads.getAttribute('lang')  ?? '';

        if (contentType === 'text') {
          trace(this, 'mse', 'add-text-source-buffer', { label, lang, codecs });
        } else {
          trace(this, 'mse', 'add-source-buffer', { contentType, mimeAndCodecs });
        }

        const sb = mse.addSourceBuffer(mimeAndCodecs, { label, lang });
        this.#sourceBuffers.set(contentType, sb);
        ads.sourceBuffer = sb;
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[videl-player] addSourceBuffer failed for ${contentType}:`, e);
      }
    }

    if (signal.aborted) {
      return;
    }

    presEl.setAttribute('videl-state', 'active');
    // Move the active presentation into the stage slot so its overlay covers
    // only the video area, never the playlist column.
    presEl.setAttribute('slot', 'stage');
    this.#activePresentation = presEl;
    this.#updateMirror();
    this.#resetInactivityTimer();

    trace(this, 'mse', 'setup-complete', {
      sourceBuffers: [...this.#sourceBuffers.keys()]
    });

    this.#startPump();
  }

  // ── MSE teardown ──────────────────────────────────────────────────────────

  #teardownPresentation(): void {
    if (this.#activePresentation) {
      this.#activePresentation.removeAttribute('videl-state');
      this.#activePresentation.removeAttribute('videl-user-inactive');
      // Return it to the default (playlist) slot.
      this.#activePresentation.removeAttribute('slot');
      this.#activePresentation = null;
    }
    this.#clearInactivityTimer();
    this.removeAttribute('videl-user-inactive');
    this.#updateMirror();
  }

  #teardownMse(): void {
    // TextTracks cannot be removed from the video element once added, so
    // disable and clear cues on any TextSourceBuffer instances before clearing
    // the map — otherwise stale cues would linger across presentations.
    for (const [ct, sb] of this.#sourceBuffers) {
      if (ct === 'text' && sb instanceof TextSourceBuffer) {
        sb.hide();
        const cues = sb.textTrack.cues;
        if (cues) {
          const list = Array.from(cues);
          for (const c of list) {
            sb.textTrack.removeCue(c);
          }
        }
        sb.textTrack.mode = 'disabled';
      }
    }

    if (this.#ergoMse) {
      trace(this, 'mse', 'teardown', { readyState: this.#ergoMse.readyState });
      this.#ergoMse.detach();
      this.#ergoMse = null;
    }
    this.#sourceBuffers.clear();
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
    if (!this.#activePresentation) {
      return;
    }
    const sourceBuffered = new Map<string, TimeRanges>();
    for (const [ct, msb] of this.#sourceBuffers) {
      sourceBuffered.set(ct, msb.buffered);
    }

    const seekable     = this.#video.seekable;
    const seekableStart = seekable.length > 0 ? seekable.start(0)                    : 0;
    const seekableEnd   = seekable.length > 0 ? seekable.end(seekable.length - 1)    : 0;

    const state: PlayerState = {
      currentTime: this.#video.currentTime,
      buffered: this.#video.buffered,
      bandwidth: this.#bandwidth,
      playbackRate: Math.max(this.#video.playbackRate, 0.01),
      bufferAhead: this.#bufferAhead,
      sourceBuffered,
      paused: this.#video.paused,
      volume: this.#video.volume,
      muted: this.#video.muted,
      seekableStart,
      seekableEnd,
    };
    if (this.#activePresentation instanceof VidelPresentation) {
      this.#activePresentation.videlUpdate(state);
    }
    this.#updateLiveSeekableRange();
    this.#maybeEndOfStream();
  }

  /**
   * For live (type="dynamic") streams, maintain the MSE seekable window by
   * calling `setLiveSeekableRange` on every pump tick.
   *
   * The seekable range is `[liveEdge − TSBD, liveEdge]` where:
   *
   *   liveEdge = (Date.now()/1000 − availabilityStartTime) + timestampOffset
   *
   * At activation time this equals TSBD (the DVR depth).  It grows at 1:1
   * wall-clock rate as the live edge advances.  The window start tracks it
   * at distance TSBD, giving the browser a stable DVR region to expose.
   *
   * Reads `availability-start-time`, `timestamp-offset`, and
   * `time-shift-buffer-depth` directly from the first active live
   * representation — all three are stamped by the parser and/or by
   * VidelRepresentation at activation time.
   */
  #updateLiveSeekableRange(): void {
    const ms = this.#ergoMse;
    if (!ms || ms.readyState !== 'open') {
      return;
    }

    // Find any active live representation (video or audio — they share the
    // same live metadata so either works).
    const activeRep = this.#activePresentation
      ?.querySelector('videl-representation[live]');
    if (!activeRep) {
      return;
    }

    const availStart = Number(activeRep.getAttribute('availability-start-time') ?? '0');
    const tsOffset   = Number(activeRep.getAttribute('timestamp-offset')        ?? '0');
    const tsbd       = Number(activeRep.getAttribute('time-shift-buffer-depth') ?? '0');
    if (tsbd <= 0) {
      return;
    }

    const nowSec   = Date.now() / 1000;
    const liveEdge = (nowSec - availStart) + tsOffset;
    const start    = liveEdge - tsbd;

    try {
      ms.setLiveSeekableRange(Math.max(0, start), liveEdge);
    } catch { /* ignore — setLiveSeekableRange may throw if duration != Infinity */ }
  }

  /**
   * Call `endOfStream()` once every source buffer has finished appending AND
   * its buffered range reaches the presentation's declared duration (within a
   * half-second tolerance for segment-boundary float drift).
   *
   * Without this the browser treats the stream as still-open and stalls
   * playback at the last buffered byte, so `currentTime` never reaches
   * `start + duration`, the period's `videl:done` never fires, and automatic
   * playlist advancement never happens.
   */
  #maybeEndOfStream(): void {
    if (!this.#ergoMse || this.#ergoMse.readyState !== 'open') {
      return;
    }
    if (!this.#activePresentation || this.#sourceBuffers.size === 0) {
      return;
    }

    const dur = Number(this.#activePresentation.getAttribute('media-presentation-duration') ?? 0);
    if (dur <= 0) {
      return;
    } // live / unknown duration — never signal EOS

    for (const [ct, msb] of this.#sourceBuffers) {
      if (ct === 'text') {
        continue;
      } // text tracks don't gate MSE endOfStream
      if (msb.updating) {
        return;
      }   // append still in flight — wait for next tick
      const b = msb.buffered;
      if (b.length === 0 || b.end(b.length - 1) < dur - 0.5) {
        return;
      }
    }

    trace(this, 'mse', 'end-of-stream', { duration: dur });
    try {
      this.#ergoMse!.endOfStream();
    } catch {
      // Already ended or MediaSource closed — safe to ignore.
    }
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

  /**
   * The video element fires `ended` when the playhead reaches the end of the
   * buffered range AND `endOfStream()` has been called on the MediaSource.
   * This is the true "presentation is done playing" signal — it fires AFTER
   * all buffered content has been rendered, not when the last segment is fetched.
   *
   * We fire `videl:done` on the active presentation here so the player's own
   * SequentialMixin (for playlist advancement) receives it at the right moment.
   * The presentation itself no longer fires `videl:done` — that avoided a race
   * where "last segment fetched" (used for seamless period transitions) was
   * incorrectly treated as "video finished playing."
   */
  #onVideoEnded = (): void => {
    const pres = this.#activePresentation;
    if (!(pres instanceof VidelPresentation)) {
      return;
    }
    pres.dispatchEvent(new CustomEvent('videl:done', {
      bubbles: true,
      composed: true,
      detail: { src: pres.src }
    }));
  };

  // ── User-inactivity helpers ───────────────────────────────────────────────

  #clearInactivityTimer(): void {
    if (this.#inactivityTimer !== null) {
      clearTimeout(this.#inactivityTimer);
      this.#inactivityTimer = null;
    }
  }

  /** Start (or restart) the 5-second inactivity timer and mark user active. */
  #resetInactivityTimer(): void {
    this.#clearInactivityTimer();
    this.removeAttribute('videl-user-inactive');
    this.#activePresentation?.removeAttribute('videl-user-inactive');
    // Only run the timer while a presentation is active (playing).
    if (this.#activePresentation) {
      this.#inactivityTimer = setTimeout(this.#onInactivityTimeout, VidelPlayer.#INACTIVITY_MS);
    }
  }

  #onInactivityTimeout = (): void => {
    this.#inactivityTimer = null;
    this.setAttribute('videl-user-inactive', '');
    this.#activePresentation?.setAttribute('videl-user-inactive', '');
  };

  /** Any pointer movement or press inside the player restores active state. */
  #onPointerActivity = (): void => {
    if (this.#activePresentation) {
      this.#resetInactivityTimer();
    }
  };

  /** Pointer leaving the player boundary — let the normal timer run out. */
  #onPointerLeave = (): void => {
    // Don't go inactive immediately; the existing timer (if running) will
    // expire naturally, giving controls the same linger as an idle mouse.
  };

  // ── Event handlers ────────────────────────────────────────────────────────

  #onVidelDone = (event: Event): void => {
    const target = event.target as Element;
    const tag    = target.tagName.toLowerCase();

    if (tag === 'videl-segment') {
      // Bandwidth estimation from real fetch throughput.
      const { bytes = 0, fetchMs = 0 } = (event as CustomEvent).detail ?? {};
      this.#minFetchLatency = Math.min(this.#minFetchLatency, fetchMs);
      // Reject bandwidth samples based on probability increasing from 0 at 10 kB to 1 at 100 kB
      // or if the fetch latency is very low (likely cached) — this filters out samples that would
      // cause us to underestimate bandwidth due to small segment sizes where startup latency dominates.
      const rejectBytes = Math.random() * 90_000 + 10_000;
      const rejectMs    = Math.random() * this.#minFetchLatency + (this.#minFetchLatency / 10);
      if (bytes > rejectBytes && fetchMs >= rejectMs) {
        const measuredBps = (bytes * 8) / (fetchMs / 1000);
        this.#bandwidth = 0.666 * this.#bandwidth + 0.334 * measuredBps;
        this.setAttribute('videl-bandwidth', String(Math.round(this.#bandwidth)));
        trace(this, 'bandwidth', 'update', { bytes, fetchMs, measuredBps: Math.round(measuredBps), bandwidth: Math.round(this.#bandwidth) });
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

    // video.paused is true once the browser fires `ended`, so checking only
    // !paused would always yield false here and the next presentation would
    // never auto-play. video.ended means the user was watching — treat that
    // as "was playing".
    const wasPlaying = !this.#video.paused || this.#video.ended;
    const fromSrc    = completedPres.getAttribute('src') ?? '';

    trace(this, 'lifecycle', 'playlist-advance', {
      from: fromSrc,
      to: nextPres?.getAttribute('src') ?? null,
      index: currentIdx + 1
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
        from: fromSrc,
        to: nextPres.getAttribute('src') ?? '',
        index: currentIdx + 1
      }
    }));

    // Pre-fetch the presentation after next while activating next.
    const afterNext = presentations[currentIdx + 2];
    if (afterNext && !afterNext.getAttribute('videl-state')) {
      afterNext.setAttribute('videl-state', 'next');
    }

    const ctrl      = new AbortController();
    this.#loadAbort = ctrl;
    this.#activatePresentation(nextPres, ctrl.signal).then(() => {
      if (wasPlaying) {
        this.#video.play().catch(() => {});
      }
    }).catch(() => {});
  }

  /**
   * Click-to-activate: clicking a non-active `<videl-presentation>` card in the
   * playlist switches playback to it. Clicks originating inside the active
   * presentation's controls (play/seek/menu) bubble up here too, so we ignore
   * any click whose target is the active presentation or is not a presentation
   * card at all.
   */
  #onPlaylistClick = (event: Event): void => {
    const path   = event.composedPath();
    // Find the nearest videl-presentation in the click path that is a direct
    // child of this player (a playlist card), if any.
    const card = path.find((n): n is Element =>
      n instanceof Element &&
        n.tagName.toLowerCase() === 'videl-presentation' &&
        n.parentElement === this);
    if (!card) {
      return;
    }                      // not a playlist card click
    if (card === this.#activePresentation) {
      return;
    } // already playing

    this.#switchToPresentation(card);
  };

  /**
   * Tear down the current presentation and activate `target`. Mirrors the
   * playlist-advance sequence but for an arbitrary user-selected presentation.
   */
  #switchToPresentation(target: Element): void {
    // Include video.ended so clicking a card after natural playback completion
    // auto-plays the selected presentation (same logic as #onPresentationDone).
    const wasPlaying = !this.#video.paused || this.#video.ended;
    const fromSrc    = this.#activePresentation?.getAttribute('src') ?? null;

    trace(this, 'lifecycle', 'playlist-select', {
      from: fromSrc,
      to: target.getAttribute('src') ?? ''
    });

    // Abort any in-flight activation, then tear down the current stream.
    this.#loadAbort?.abort();
    this.#stopPump();
    this.#teardownPresentation();
    this.#teardownMse();

    // Clear stale next-state from siblings; prefetch the one after target.
    for (const pres of this.#childPresentations) {
      if (pres !== target) {
        pres.removeAttribute('videl-state');
      }
    }
    const idx       = this.#childPresentations.indexOf(target);
    const afterNext = this.#childPresentations[idx + 1];
    if (afterNext && !afterNext.getAttribute('videl-state')) {
      afterNext.setAttribute('videl-state', 'next');
    }

    this.dispatchEvent(new CustomEvent('videl:playlist:advance', {
      bubbles: true,
      detail: { from: fromSrc, to: target.getAttribute('src') ?? '', index: idx }
    }));

    const ctrl      = new AbortController();
    this.#loadAbort = ctrl;
    this.#activatePresentation(target, ctrl.signal).then(() => {
      if (wasPlaying) {
        this.#video.play().catch(() => {});
      }
    }).catch(() => {});
  }

  #onMseError = (_event: Event): void => {
    const savedTime  = this.#video.currentTime;
    const wasPlaying = !this.#video.paused;
    trace(this, 'mse', 'rebuild-start', {
      reason: 'videl:mse:error', savedTime: +savedTime.toFixed(3), wasPlaying
    });

    this.#teardownPresentation();
    this.#teardownMse();

    const pres = this.querySelector('videl-presentation');
    if (pres) {
      const ctrl = new AbortController();
      this.#setupMse(pres, ctrl.signal).then(() => {
        if (savedTime > 0) {
          this.#video.currentTime = savedTime;
        }
        if (wasPlaying) {
          this.#video.play().catch(() => {});
        }
      }).catch(() => {});
    }
  };

  // ── Internal UI event handlers (from presentation controls) ──────────────

  #onUiPlayPause = (): void => {
    if (this.#video.paused) {
      this.#video.play().catch(() => {});
    } else {
      this.#video.pause();
    }
  };

  #onUiSeek = (event: Event): void => {
    const { time } = (event as CustomEvent).detail ?? {};
    if (typeof time === 'number' && isFinite(time)) {
      this.#seekTo(time);
    }
  };

  #onUiVolume = (event: Event): void => {
    const { volume } = (event as CustomEvent).detail ?? {};
    if (typeof volume === 'number') {
      this.#video.volume = Math.max(0, Math.min(1, volume));
    }
  };

  #onUiMuteToggle = (): void => {
    this.#video.muted = !this.#video.muted;
  };

  // ── MutationObserver ──────────────────────────────────────────────────────

  #onMutation = (mutations: MutationRecord[]): void => {
    const added = mutations.flatMap(m => [...m.addedNodes])
      .filter((n): n is Element => n instanceof Element);
    const removed = mutations.flatMap(m => [...m.removedNodes])
      .filter((n): n is Element => n instanceof Element);

    // Presentation set changed → re-evaluate whether to show the playlist column.
    const presChanged =
      added.some(n => n.tagName.toLowerCase() === 'videl-presentation') ||
      removed.some(n => n.tagName.toLowerCase() === 'videl-presentation');
    if (presChanged) {
      this.#refreshPlaylistChrome();
    }

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
      'videl-presentation', 'videl-period', 'videl-adaptation-set',
      'videl-representation', 'videl-segment'
    ].join(',');
    for (const el of this.querySelectorAll(sel)) {
      on ? el.setAttribute('debug', '') : el.removeAttribute('debug');
    }
  }
}

customElements.define('videl-player', VidelPlayer);
