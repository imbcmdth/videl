import { LitElement, html, nothing } from 'lit';
import { SequentialMixin } from '../mixins/sequential-mixin';
import { PickOneMixin } from '../mixins/pick-one-mixin';
import { parseMpd } from '../parser/mpd-parser';
import type { PlayerState } from '../player-state';
import {
  ICON_PLAY, ICON_PAUSE,
  ICON_VOLUME, ICON_MUTE,
  ICON_AUDIO, ICON_CAPTIONS, ICON_QUALITY,
} from '../icons';

/**
 * `<videl-presentation>` — the MPD root element, playlist card, and active
 * player UI.
 *
 * ### Three-role element
 *
 * 1. **Manifest owner** — self-populates from its own `src` MPD URL when
 *    `videl-state="next"` (prefetch) or `videl-state="active"` (inline).
 *    Only `<videl-period>` children are replaced on every populate; all
 *    other light-DOM children (user metadata, thumbnails, etc.) are preserved.
 *
 * 2. **Playlist card** — when idle or prefetching, the element is a compact
 *    card. User content (poster image, title, etc.) sits directly inside the
 *    element as light-DOM children and is projected through the default slot.
 *
 * 3. **Player UI overlay** — when `videl-state="active"`, the element expands
 *    to fill `<videl-player>` via `position: absolute; inset: 0; z-index: 2`
 *    with a transparent body (so the `<video>` element behind it shows
 *    through). A controls bar is rendered at the bottom of the overlay:
 *    seekbar (with period boundary markers), play/pause, time display,
 *    mute/volume, and read-only quality/language labels.
 *
 *    All user interactions are dispatched upward as internal events
 *    (`videl:ui:*`) caught by `<videl-player>` — the presentation never
 *    holds a reference to `<video>` directly.
 *
 * ### CSS stacking (in `<videl-player>` shadow DOM)
 *
 * ```
 * DOM order: <slot>(presentations)</slot>  <video>
 * z-index:   —                             auto (on top by DOM order)
 *            active presentation: z-index 2 (lifts above video)
 * ```
 *
 * The active presentation has `background: transparent`, so the video
 * renders through the overlay body. Controls sit in an absolutely-positioned
 * opaque strip at the bottom.
 *
 * ### Mixin stack
 *
 * `SequentialMixin(PickOneMixin(LitElement))`.
 *
 * State lifecycle (ADR-0002 — `videl-state` attribute):
 *   `videl-state="next"`   → self-populate from `src` (prefetch).
 *   `videl-state="active"` → self-populate if needed, then activate first period.
 *   `videl-state` removed  → abort in-flight fetch; cascade-deactivate periods.
 */
export class VidelPresentation extends SequentialMixin(PickOneMixin(LitElement) as any) {
  static properties = {
    src:                       { type: String },
    duration:                  { type: Number },
    mediaPresentationDuration: { type: Number,  attribute: 'media-presentation-duration' },
    minBufferTime:             { type: Number,  attribute: 'min-buffer-time' },
    presentationType:          { type: String,  attribute: 'type' },
    slot:                      { type: String,  reflect: true },
    debug:                     { type: Boolean },
    // Pump-driven playback state (not reflected to attributes — internal only).
    currentTime:               { type: Number,  attribute: false },
    paused:                    { type: Boolean, attribute: false },
    volume:                    { type: Number,  attribute: false },
    muted:                     { type: Boolean, attribute: false },
    // Which informational menu the control bar has open (drives the active period).
    menuOpen:                  { type: String,  attribute: false },
  };

  src                        = '';
  /** Display duration (seconds) — shown before the manifest is fetched.
   *  Replaced by `mediaPresentationDuration` once the MPD is parsed. */
  duration:                  number | null = null;
  mediaPresentationDuration: number | null = null;
  minBufferTime:             number | null = null;
  presentationType:          'static' | 'dynamic' = 'static';
  slot: string | undefined   = undefined;
  debug                      = false;

  // Pump-driven UI state (stamped by videlUpdate on every tick).
  currentTime = 0;
  paused      = true;
  volume      = 1;
  muted       = false;

  /** Which informational menu is open: `'audio' | 'text' | 'quality' | null`. */
  menuOpen: string | null = null;

  #fetchController: AbortController | null = null;
  #populated                               = false;
  #populatePromise: Promise<void> | null   = null;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('videl:done', this.#onPeriodDone);
  }

  disconnectedCallback(): void {
    this.removeEventListener('videl:done', this.#onPeriodDone);
    document.removeEventListener('pointerdown', this.#onDocPointerDown, true);
    super.disconnectedCallback();
  }

  attributeChangedCallback(name: string, old: string | null, value: string | null): void {
    super.attributeChangedCallback(name, old, value);

    if (name !== 'videl-state') return;

    if (value === 'next') {
      // Prefetch: populate so the manifest is ready before activation.
      if (this.src && !this.#populated) this.#ensurePopulated();
    } else if (value === 'active') {
      if (this.src && !this.#populated) {
        // No prior prefetch — populate inline, then activate.
        this.#ensurePopulated().then(() => {
          if (this.getAttribute('videl-state') === 'active') {
            this.#activateFirstPeriod();
          }
        });
      } else {
        this.#activateFirstPeriod();
      }
    } else if (value === null) {
      this.#fetchController?.abort();
      this.#fetchController = null;
      // Presentation deactivated — close any open menu (detaches listener too).
      this.#closeMenu();
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Forward the pump tick to the currently active `<videl-period>`.
   * Also stamps pump-driven UI state (currentTime, paused, volume, muted)
   * as reactive properties so the Lit render() can update controls.
   */
  videlUpdate(state: PlayerState): void {
    if (this.getAttribute('videl-state') !== 'active') return;

    // Stamp UI state. NOTE: with `useDefineForClassFields: true` these class
    // fields shadow Lit's reactive accessors, so assignment alone does not
    // schedule a render. Explicitly request an update so the seekbar / time
    // display track playback on every pump tick.
    this.currentTime = state.currentTime;
    this.paused      = state.paused;
    this.volume      = state.volume;
    this.muted       = state.muted;
    (this as unknown as LitElement).requestUpdate();

    const active = this.#childPeriods.find(
      p => p.getAttribute('videl-state') === 'active'
    );
    if (active) {
      // Keep the open menu attached to whichever period is currently active
      // (periods advance sequentially; the attribute does not follow on its own).
      if (this.menuOpen && active.getAttribute('menu-open') !== this.menuOpen) {
        active.setAttribute('menu-open', this.menuOpen);
      }
      (active as any).videlUpdate(state);
    }
  }

  /**
   * Explicitly trigger self-population. Idempotent — safe to call multiple
   * times; only the first call ever fetches. Called by `<videl-player>` before
   * MSE setup so SourceBuffer creation can see the full adaptation-set tree.
   */
  videlPopulate(): Promise<void> {
    return this.#ensurePopulated();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  get #childPeriods(): Element[] {
    return Array.from((this as unknown as HTMLElement).children).filter(
      (el: unknown) => (el as Element).tagName.toLowerCase() === 'videl-period'
    ) as Element[];
  }

  #activateFirstPeriod(): void {
    const first = this.#childPeriods[0];
    if (first) this.activateChild(first);
  }

  #ensurePopulated(): Promise<void> {
    if (this.#populated) return Promise.resolve();
    if (this.#populatePromise) return this.#populatePromise;
    this.#populatePromise = this.#populate().finally(() => {
      this.#populatePromise = null;
    });
    return this.#populatePromise;
  }

  /**
   * Fetch the MPD at `src`, parse it, and inject `<videl-period>` children.
   *
   * Non-period children (user metadata: thumbnails, headings, etc.) are
   * preserved. Only existing `<videl-period>` elements are removed before
   * injection. Manifest-derived attributes (`media-presentation-duration`,
   * `min-buffer-time`, `type`) are stamped onto this element after parsing.
   */
  async #populate(): Promise<void> {
    if (!this.src) return;

    this.#fetchController = new AbortController();
    try {
      const response = await fetch(this.src, { signal: this.#fetchController.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${this.src}`);
      const xml = await response.text();

      const self    = this as unknown as HTMLElement;
      const subtree = parseMpd(xml, this.src);

      // Remove existing period children — preserve all other light-DOM content.
      for (const child of [...self.children]) {
        if (child.tagName.toLowerCase() === 'videl-period') {
          self.removeChild(child);
        }
      }

      // Adopt parsed period children.
      for (const child of [...subtree.children]) {
        if (child.tagName.toLowerCase() === 'videl-period') {
          self.appendChild(child);
        }
      }

      // Stamp manifest attributes (may override developer-declared display values).
      const dur    = subtree.getAttribute('media-presentation-duration');
      const minBuf = subtree.getAttribute('min-buffer-time');
      const type   = subtree.getAttribute('type');
      if (dur)    self.setAttribute('media-presentation-duration', dur);
      if (minBuf) self.setAttribute('min-buffer-time', minBuf);
      if (type)   self.setAttribute('type', type);

      this.#populated = true;

    } catch (err: unknown) {
      if ((err as any)?.name === 'AbortError') return;
      (this as unknown as HTMLElement).dispatchEvent(
        new CustomEvent('videl:segment:error', {
          bubbles:  true,
          composed: true,
          detail:   { error: err instanceof Error ? err : new Error(String(err)) },
        })
      );
    } finally {
      this.#fetchController = null;
    }
  }

  /**
   * Detect when the last period completes and escalate as presentation done.
   * SequentialMixin handles *advancement* to the next period; this handles
   * the *termination* case (no next period sibling exists).
   */
  #onPeriodDone = (event: Event): void => {
    const target = event.target as Element;
    const self   = this as unknown as HTMLElement;
    if (target.parentElement !== self) return;
    if (target.tagName.toLowerCase() !== 'videl-period') return;
    // If a next period sibling exists, SequentialMixin already activated it.
    let nextPeriod = target.nextElementSibling;
    while (nextPeriod && nextPeriod.tagName.toLowerCase() !== 'videl-period') {
      nextPeriod = nextPeriod.nextElementSibling;
    }
    if (nextPeriod !== null) return;

    self.dispatchEvent(
      new CustomEvent('videl:done', {
        bubbles:  true,
        composed: true,
        detail:   { src: (this as any).src },
      })
    );
  };

  // ── UI event dispatchers ──────────────────────────────────────────────────

  #onClickZone = (): void => {
    this.dispatchEvent(new CustomEvent('videl:ui:play-pause', {
      bubbles: true, composed: true,
    }));
  };

  #onPlayPause = (e: Event): void => {
    e.stopPropagation(); // click-zone above would double-fire otherwise
    this.dispatchEvent(new CustomEvent('videl:ui:play-pause', {
      bubbles: true, composed: true,
    }));
  };

  #onSeekInput = (e: Event): void => {
    const frac = Number((e.target as HTMLInputElement).value);
    const dur  = this.mediaPresentationDuration ?? this.duration ?? 0;
    if (dur > 0) {
      this.dispatchEvent(new CustomEvent('videl:ui:seek', {
        bubbles: true, composed: true,
        detail: { time: frac * dur },
      }));
    }
  };

  #onVolumeInput = (e: Event): void => {
    const vol = Number((e.target as HTMLInputElement).value);
    this.dispatchEvent(new CustomEvent('videl:ui:volume', {
      bubbles: true, composed: true,
      detail: { volume: vol },
    }));
  };

  #onMuteToggle = (e: Event): void => {
    e.stopPropagation();
    this.dispatchEvent(new CustomEvent('videl:ui:mute-toggle', {
      bubbles: true, composed: true,
    }));
  };

  /** Currently active period element, if any. */
  get #activePeriod(): Element | null {
    return this.#childPeriods.find(
      p => p.getAttribute('videl-state') === 'active'
    ) ?? null;
  }

  /**
   * Toggle an informational menu (audio / text / quality). The menu is driven
   * entirely by the existing DOM: setting `menu-open` on the active
   * `<videl-period>` reveals the matching adaptation-set / representation
   * elements via CSS. No menu nodes are created from data.
   */
  #toggleMenu(kind: 'audio' | 'text' | 'quality', e: Event): void {
    e.stopPropagation();
    if (this.menuOpen === kind) {
      this.#closeMenu();
      return;
    }
    this.menuOpen = kind;
    this.#activePeriod?.setAttribute('menu-open', kind);
    // Close on the next outside interaction (click elsewhere, play/pause, seek…).
    document.addEventListener('pointerdown', this.#onDocPointerDown, true);
    (this as unknown as LitElement).requestUpdate();
  }

  /** Close the open menu and detach the outside-click listener. */
  #closeMenu(): void {
    if (!this.menuOpen) return;
    this.menuOpen = null;
    this.#activePeriod?.removeAttribute('menu-open');
    document.removeEventListener('pointerdown', this.#onDocPointerDown, true);
    (this as unknown as LitElement).requestUpdate();
  }

  /**
   * Auto-close the menu when the user interacts anywhere that is not a menu
   * toggle button or the popup itself. `composedPath()` crosses shadow
   * boundaries, so both the presentation's `.menu-btn`s and the period's
   * `.menu` popup are visible here. Clicks on the seekbar / play / volume
   * controls therefore close the menu (and still perform their action).
   */
  #onDocPointerDown = (e: Event): void => {
    if (!this.menuOpen) return;
    const insideMenu = e.composedPath().some(
      n => n instanceof Element &&
        (n.classList.contains('menu-btn') || n.classList.contains('menu'))
    );
    if (!insideMenu) this.#closeMenu();
  };

  #onAudioMenu   = (e: Event): void => this.#toggleMenu('audio', e);
  #onTextMenu    = (e: Event): void => this.#toggleMenu('text', e);
  #onQualityMenu = (e: Event): void => this.#toggleMenu('quality', e);

  // ── UI helpers ────────────────────────────────────────────────────────────

  #formatTime(s: number): string {
    if (!isFinite(s) || s < 0) return '--:--';
    const m   = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return `${m}:${sec}`;
  }

  // ── Lit render ────────────────────────────────────────────────────────────

  render() {
    const totalDur = this.mediaPresentationDuration ?? this.duration ?? 0;
    const progress = totalDur > 0 ? this.currentTime / totalDur : 0;

    return html`
      <style>
        /* ── Host base ───────────────────────────────────────────── */
        :host {
          display: block;
          position: relative;
          box-sizing: border-box;
        }

        /* ── Active: transparent overlay over the video stage ───── */
        /*
         * The player assigns slot="stage" to the active presentation, so this
         * overlay is contained by the player's .stage element and covers only
         * the video — never the playlist column.
         */
        :host([videl-state="active"]) {
          position: absolute;
          inset: 0;
          width: auto;
          height: auto;
          /* Cancel any card aspect-ratio a consumer set for the playlist view;
             when active we must fill the stage exactly (insets determine size),
             otherwise aspect-ratio would shrink the height and lift the controls. */
          aspect-ratio: auto;
          z-index: 2;
          background: transparent;
        }

        /* ── Click zone (play/pause) — covers video area above bar ─ */
        .click-zone {
          display: none;
          position: absolute;
          inset: 0;
          bottom: 72px;
          cursor: pointer;
          background: transparent;
        }
        :host([videl-state="active"]) .click-zone {
          display: block;
        }

        /* ── Controls bar (active only) ─────────────────────────── */
        .controls {
          display: none;
          flex-direction: column;
          gap: 4px;
          position: absolute;
          bottom: 0; left: 0; right: 0;
          padding: 8px 12px 10px;
          background: linear-gradient(transparent, rgba(0, 0, 0, 0.78));
          box-sizing: border-box;
        }
        :host([videl-state="active"]) .controls {
          display: flex;
        }

        /* ── Seekbar row ─────────────────────────────────────────── */
        /*
         * .seek-track is a flex container; each slotted videl-period is a
         * flex item whose flex-grow is set to its duration on the host element
         * directly (dynamic values can't be carried through ::slotted()).
         * The range input overlays the track invisibly — transparent track,
         * visible thumb only — so the period segments are the visual track.
         */
        .seek-row {
          position: relative;
          height: 20px;
          display: flex;
          align-items: center;
        }
        .seek-track {
          display: flex;
          gap: 2px;
          width: 100%;
          height: 4px;
          align-items: stretch;
          border-radius: 2px;
          overflow: visible;
        }
        /* Periods in the seek slot render as seekbar segments.
           flex-grow is set per-element by the period itself. */
        ::slotted(videl-period) {
          display: block !important;
          height: 100%;
        }
        /* The range input overlays the segments: transparent track, thumb only. */
        .seek-input {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          margin: 0;
          padding: 0;
          cursor: pointer;
          z-index: 2;
          appearance: none;
          -webkit-appearance: none;
          background: transparent;
          outline: none;
        }
        .seek-input::-webkit-slider-runnable-track {
          background: transparent;
          height: 4px;
        }
        .seek-input::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #fff;
          box-shadow: 0 0 4px rgba(0,0,0,0.5);
          margin-top: -5px;
        }
        .seek-input::-moz-range-track {
          background: transparent;
          height: 4px;
          border: none;
        }
        .seek-input::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: #fff;
          border: none;
          box-shadow: 0 0 4px rgba(0,0,0,0.5);
        }

        /* ── Control row ─────────────────────────────────────────── */
        .ctrl-row {
          display: flex;
          align-items: center;
          gap: 6px;
          color: #fff;
          user-select: none;
        }
        .ctrl-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          background: none;
          border: none;
          color: #fff;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          line-height: 1;
          flex-shrink: 0;
          transition: background 0.12s;
        }
        .ctrl-btn:hover { background: rgba(255,255,255,0.12); }
        .menu-btn.open  { background: rgba(79, 156, 249, 0.35); }
        .time-display {
          font-family: ui-monospace, monospace;
          font-variant-numeric: tabular-nums;
          font-size: 12px;
          white-space: nowrap;
          flex-shrink: 0;
          color: rgba(255,255,255,0.9);
        }
        .vol-input {
          width: 56px;
          accent-color: #fff;
          cursor: pointer;
        }
        .spacer { flex: 1; }
      </style>

      <!-- User light-DOM content (poster image, title, etc.) -->
      <slot></slot>

      <!-- Click zone: covers the video area above the controls bar -->
      <div class="click-zone" @click=${this.#onClickZone}></div>

      <!-- Controls bar: only visible when active -->
      <div class="controls">

        <!-- Seekbar: period segments (slot="seek") are the visual track;
             the range input sits invisibly on top for interaction. -->
        <div class="seek-row">
          <div class="seek-track">
            <slot name="seek"></slot>
          </div>
          <input
            type="range"
            class="seek-input"
            min="0"
            max="1"
            step="0.0001"
            .value=${String(progress)}
            @input=${this.#onSeekInput}
          />
        </div>

        <!-- Button row -->
        <div class="ctrl-row">
          <button class="ctrl-btn" @click=${this.#onPlayPause}
                  title=${this.paused ? 'Play' : 'Pause'}>
            ${this.paused ? ICON_PLAY : ICON_PAUSE}
          </button>

          <span class="time-display">
            ${this.#formatTime(this.currentTime)} / ${this.#formatTime(totalDur)}
          </span>

          <span class="spacer"></span>

          <!-- Menu buttons — toggle menu-open on the active period.
               The menu CONTENT is the existing ADS/representation DOM,
               revealed by CSS. No new nodes are created from data here. -->
          <button class="ctrl-btn menu-btn ${this.menuOpen === 'audio' ? 'open' : ''}"
                  @click=${this.#onAudioMenu} title="Audio tracks">
            ${ICON_AUDIO}
          </button>
          <button class="ctrl-btn menu-btn ${this.menuOpen === 'text' ? 'open' : ''}"
                  @click=${this.#onTextMenu} title="Subtitles / text tracks">
            ${ICON_CAPTIONS}
          </button>
          <button class="ctrl-btn menu-btn ${this.menuOpen === 'quality' ? 'open' : ''}"
                  @click=${this.#onQualityMenu} title="Video quality">
            ${ICON_QUALITY}
          </button>

          <button class="ctrl-btn" @click=${this.#onMuteToggle}
                  title=${this.muted ? 'Unmute' : 'Mute'}>
            ${this.muted || this.volume === 0 ? ICON_MUTE : ICON_VOLUME}
          </button>

          <input
            type="range"
            class="vol-input"
            min="0"
            max="1"
            step="0.01"
            .value=${String(this.muted ? 0 : this.volume)}
            @input=${this.#onVolumeInput}
          />
        </div>
      </div>

      ${this.debug ? html`
        <div style="font-family:monospace;font-size:11px;border:1px solid #88a;padding:4px;background:rgba(0,0,0,0.7);color:#fff;position:absolute;bottom:0;left:0;z-index:10;pointer-events:none">
          <strong>videl-presentation</strong>
          type=<em>${this.presentationType}</em>
          state=<em>${this.getAttribute('videl-state') ?? 'idle'}</em>
          dur=<em>${this.mediaPresentationDuration ?? this.duration ?? '?'}</em>s
          populated=<em>${this.#populated}</em>
          t=<em>${this.currentTime.toFixed(1)}</em>s
          ${this.paused ? ICON_PAUSE : ICON_PLAY}
        </div>
      ` : nothing}
    `;
  }
}

customElements.define('videl-presentation', VidelPresentation as unknown as CustomElementConstructor);
