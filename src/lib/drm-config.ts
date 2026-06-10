/**
 * DRM (Digital Rights Management) configuration types for EME support.
 *
 * Consumers configure DRM by setting the `drmConfig` property on
 * `<videl-player>` (player-wide default) or `<videl-presentation>`
 * (presentation-specific override).
 */

/**
 * Per-DRM-system configuration.
 *
 * Keyed by EME key system string:
 *   - `com.widevine.alpha` (Widevine)
 *   - `com.microsoft.playready` (PlayReady)
 *   - `com.apple.fps` or `com.apple.fps.1_0` (FairPlay)
 *   - `org.w3.clearkey` (ClearKey)
 */
export interface DrmSystemConfig {
  /**
   * License server URL. For Widevine, PlayReady, ClearKey, and FairPlay, this
   * is where the challenge/SPC is sent and the license/CKC is received.
   *
   * Optional for ClearKey when keys are provided inline via the `keys` property.
   */
  serverUrl?: string;

  /**
   * Custom HTTP headers to include with every license request.
   * Example: `{ Authorization: "Bearer <token>" }`.
   */
  httpRequestHeaders?: Record<string, string>;

  /**
   * License request timeout in milliseconds (optional).
   */
  httpTimeout?: number;

  /**
   * FairPlay: server certificate (DER-encoded, binary).
   *
   * Required for FairPlay. Provide either:
   *   - `certificate`: pre-fetched binary data
   *   - `certificateUrl`: player fetches automatically
   *
   * If both are provided, `certificate` takes precedence.
   */
  certificateUrl?: string;
  certificate?: Uint8Array;

  /**
   * FairPlay: custom initData transform.
   *
   * FairPlay `encrypted` events carry provider-defined initData (e.g., skd:// URLs,
   * UUID blobs, custom formats). This must be wrapped in Apple's binary envelope
   * before calling `generateRequest()`.
   *
   * DEFAULT: treats initData as UTF-8 skd:// URL, extracts contentId (portion
   * after "skd://"), and builds the standard envelope.
   *
   * OVERRIDE: provide this callback when the provider uses a non-skd:// format
   * or custom contentId derivation.
   */
  initDataTransform?: (
    initData: Uint8Array,
    initDataType: string,
    cert: Uint8Array | null
  ) => Uint8Array | Promise<Uint8Array>;

  /**
   * License response parser.
   *
   * The HTTP response format is entirely provider-defined:
   *   - Raw binary bytes (Widevine, PlayReady, FairPlay CKC)
   *   - Base64-encoded bytes
   *   - JSON wrapper: `{"license":"<b64>"}` or `{"ckc":"<b64>"}`
   *   - XML wrapper (legacy PlayReady)
   *
   * DEFAULT: returns raw response bytes unchanged (correct for binary-only responses).
   *
   * OVERRIDE: provide this for any provider that wraps or encodes the response.
   */
  parseLicenseResponse?: (
    responseBody: ArrayBuffer
  ) => ArrayBuffer | Promise<ArrayBuffer>;

  /**
   * License request filter.
   *
   * Mutate the outgoing request before it is sent:
   *   - Change URL dynamically based on skd:// contentId
   *   - Add custom headers or authentication
   *   - Wrap or transform the SPC/challenge body
   *
   * The filter receives and may modify:
   *   - `url`: license server URL
   *   - `headers`: HTTP headers map
   *   - `body`: challenge/SPC bytes
   */
  requestFilter?: (request: {
    url: string;
    headers: Record<string, string>;
    body: ArrayBuffer;
  }) => void | Promise<void>;

  /**
   * ClearKey: inline key mapping (no license server needed).
   *
   * For ClearKey streams, provide key IDs and their corresponding key bytes
   * in hex. The player builds a synthetic JSON license from this mapping
   * when no `serverUrl` is configured.
   *
   * Example:
   * ```ts
   * keys: {
   *   'abc123def456': '0123456789abcdef0123456789abcdef'
   * }
   * ```
   */
  keys?: Record<string, string>;
}

/**
 * DRM configuration map, keyed by EME key system URN.
 */
export type DrmConfig = Record<string, DrmSystemConfig>;
