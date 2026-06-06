/**
 * Inline SVG icon templates for the videl player UI.
 *
 * All icons use a 24×24 viewBox, stroke-based (Feather-style). Exported as
 * Lit TemplateResult values so they compose directly into `html` templates.
 */
import { html, svg, type TemplateResult } from 'lit';

/** Wrap path content in a standard 16×16 SVG shell. */
function icon(paths: TemplateResult): TemplateResult {
  return html`<svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >${paths}</svg>`;
}

/** ▶ Play */
export const ICON_PLAY: TemplateResult = icon(
  svg`<polygon points="5 3 19 12 5 21 5 3"/>`
);

/** ⏸ Pause */
export const ICON_PAUSE: TemplateResult = icon(
  svg`<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>`
);

/** 🔊 Volume — speaker with sound waves */
export const ICON_VOLUME: TemplateResult = icon(svg`
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
  <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
`);

/** 🔇 Mute — speaker with X */
export const ICON_MUTE: TemplateResult = icon(svg`
  <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
  <line x1="23" y1="9" x2="17" y2="15"/>
  <line x1="17" y1="9" x2="23" y2="15"/>
`);

/** 🎧 Audio tracks — headphones */
export const ICON_AUDIO: TemplateResult = icon(svg`
  <path d="M3 18v-6a9 9 0 0 1 18 0v6"/>
  <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/>
  <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>
`);

/** CC Captions — rounded rect with two C shapes */
export const ICON_CAPTIONS: TemplateResult = icon(svg`
  <rect x="2" y="4" width="20" height="16" rx="2" ry="2"/>
  <path d="M9.5 10.5c-.6-1-1.5-1.5-2.5-1.5a3 3 0 1 0 0 6c1 0 1.9-.5 2.5-1.5"/>
  <path d="M17.5 10.5c-.6-1-1.5-1.5-2.5-1.5a3 3 0 1 0 0 6c1 0 1.9-.5 2.5-1.5"/>
`);

/** ≡ Quality / renditions — stacked layers */
export const ICON_QUALITY: TemplateResult = icon(svg`
  <polygon points="12 2 2 7 12 12 22 7 12 2"/>
  <polyline points="2 17 12 22 22 17"/>
  <polyline points="2 12 12 17 22 12"/>
`);

/** ⛶ Fullscreen — arrows pointing to corners */
export const ICON_FULLSCREEN: TemplateResult = icon(svg`
  <polyline points="15 3 21 3 21 9"/>
  <polyline points="9 21 3 21 3 15"/>
  <line x1="21" y1="3" x2="14" y2="10"/>
  <line x1="3" y1="21" x2="10" y2="14"/>
`);

/** ⛶ Exit fullscreen — arrows pointing inward */
export const ICON_FULLSCREEN_EXIT: TemplateResult = icon(svg`
  <polyline points="8 3 3 3 3 8"/>
  <polyline points="21 8 21 3 16 3"/>
  <polyline points="3 16 3 21 8 21"/>
  <polyline points="16 21 21 21 21 16"/>
  <line x1="3" y1="3" x2="10" y2="10"/>
  <line x1="21" y1="3" x2="14" y2="10"/>
  <line x1="21" y1="21" x2="14" y2="14"/>
  <line x1="3" y1="21" x2="10" y2="14"/>
`);
