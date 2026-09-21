// Terminal sanitizer for untrusted text (registry metadata, health labels).
//
// Terminals act on escape sequences embedded in printed text: CSI moves the
// cursor / clears the screen (UI spoofing, e.g. faking the [y/N] prompt),
// OSC writes the clipboard or hyperlinks, C0/C1/bidi chars reposition or
// reorder rendered text. A safety tool must not let a hostile package paint
// over its own intel, so every registry-sourced string is scrubbed at the
// render boundary. Our own paint() codes are applied *after* sanitizing,
// so styling is unaffected. Pure and network-free for unit tests.

/** OSC / DCS / SOS / PM / APC string sequences with their payload. */
const STRING_SEQ = new RegExp(
  "\\x1b[\\]PX\\^_][\\s\\S]*?(?:\\x1b\\\\|\\x07|\\u009c)",
  "g",
);
/** CSI and other ESC-led sequences (adapted from the strip-ansi pattern). */
const CSI_SEQ = new RegExp("[\\x1b\\u009b]\\[[0-?]*[ -/]*[@-~]", "g");
/** C0 controls (except \t \n), DEL, and the C1 block. */
const CONTROLS = new RegExp("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]", "g");
/** Line/paragraph separators and explicit bidi overrides. */
const BIDI_SEP = new RegExp(
  "[\\u2028\\u2029\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]",
  "g",
);
/** A bare \r moves the cursor to column 0 (overwrites the line); \r\n survives. */
const BARE_CR = new RegExp("\\r(?!\\n)", "g");

export function sanitizeTerminal(text: string): string {
  return text
    .replace(STRING_SEQ, "")
    .replace(CSI_SEQ, "")
    .replace(CONTROLS, "")
    .replace(BIDI_SEP, "")
    .replace(BARE_CR, "");
}
