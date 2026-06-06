/**
 * Structured tracing for the videl element tree.
 *
 * Every significant internal operation dispatches a `videl:trace` event that
 * bubbles to `<videl-player>` (and beyond).  A single event name with a
 * structured detail object keeps the listener surface area minimal while
 * still letting the demo (or any DevTools extension) filter by category or
 * action.
 *
 * Detail shape:
 *   {
 *     category : TraceCategory   — broad area of concern
 *     action   : string          — specific operation within that area
 *     data?    : object          — arbitrary key/value context
 *   }
 *
 * Categories
 * ──────────
 *   lifecycle  — src changes, seeks, element connect/disconnect
 *   mse        — MediaSource / SourceBuffer creation and teardown
 *   buffer     — appendBuffer calls (start, complete, error)
 *   fetch      — network requests for init and media segments
 *   abr        — rendition selection and switches
 *   pump       — pump tick decisions (buffer gating, no-ops)
 *   timeline   — segment timeline drift tracking and adjustments
 */

export type TraceCategory =
  | 'lifecycle'
  | 'mse'
  | 'buffer'
  | 'bandwidth'
  | 'fetch'
  | 'abr'
  | 'pump'
  | 'timeline';

export interface TraceDetail {
  category: TraceCategory;
  action:   string;
  data?:    Record<string, unknown>;
}

/**
 * Dispatch a `videl:trace` event from `source`.
 *
 * The event bubbles and is composed so it propagates through shadow boundaries
 * to the nearest `<videl-player>` ancestor where the demo or host application
 * can listen.
 */
export function trace(
  source:   EventTarget,
  category: TraceCategory,
  action:   string,
  data?:    Record<string, unknown>
): void {
  const detail: TraceDetail = data ? { category, action, data } : { category, action };
  source.dispatchEvent(new CustomEvent<TraceDetail>('videl:trace', {
    bubbles: true,
    composed: true,
    detail
  }));
}
