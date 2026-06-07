/**
 * DASH SegmentTemplate URL utilities shared between the MPD parser and
 * VidelRepresentation (which expands templates at activation time).
 *
 * Kept in src/parser/ because conceptually these belong to the DASH URL
 * model, even though VidelRepresentation also imports them.
 */

// ---------------------------------------------------------------------------
// Template variable expansion
// ---------------------------------------------------------------------------

/**
 * Expand DASH URI template variables in `template`.
 *
 * Supported variables: $RepresentationID$, $Bandwidth$, $Number$, $Time$.
 * Zero-padding: $Number%05d$ pads the number to 5 digits.
 *
 * Any unrecognised variable (e.g. $Foo$) is left intact.
 *
 * If a variable's value is `undefined` in `vars` it is left unexpanded (the
 * literal `$VarName$` token is preserved).  This allows the parser to
 * pre-expand identity variables ($RepresentationID$, $Bandwidth$) at parse
 * time and leave $Number$ / $Time$ for VidelRepresentation to expand at
 * activation time.
 */
export function expandTemplate(
  template: string,
  vars: {
    id?:        string;
    bandwidth?: number;
    number?:    number;
    time?:      number;
  }
): string {
  return template.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (_match, name: string, padStr?: string) => {
    switch (name) {
      case 'RepresentationID':
        return vars.id !== undefined ? vars.id : `$${name}$`;
      case 'Bandwidth':
        return vars.bandwidth !== undefined ? String(vars.bandwidth) : `$${name}$`;
      case 'Number': {
        if (vars.number === undefined) {
          return padStr ? `$Number%0${padStr}d$` : '$Number$';
        }
        const val = String(vars.number);
        return padStr ? val.padStart(Number(padStr), '0') : val;
      }
      case 'Time':
        return vars.time !== undefined ? String(vars.time) : '$Time$';
      default:
        return `$${name}$`; // unknown variable — leave intact
    }
  });
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/** Resolve `url` against `base`, returning `base` if `url` is empty. */
export function resolveUrl(url: string, base: string): string {
  if (!url) {
    return base;
  }
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}
