/**
 * T3 Turbo - incremental terminal scrollback buffer.
 *
 * Upstream keeps a terminal's scrollback as one string and rebuilds it on every PTY
 * chunk: `capHistory(history + visibleText)` splits, slices and re-joins the whole
 * ~5,000-line buffer per burst. This module keeps exactly the same bytes as a line
 * list so appends and cap trims are incremental, and batches the raw chunks so the
 * sanitize + join pass runs once per output burst instead of once per chunk.
 *
 * Byte-identity is the contract: `readTerminalHistoryBuffer` must return exactly what
 * upstream's `capHistory` would have produced for the same input sequence, cap-trim
 * boundaries included - a second device restores its scrollback from that string.
 *
 * @module turbo/terminalHistoryBuffer
 */

/**
 * The resumable chunk sanitizer (`sanitizeTerminalHistoryChunk` in the terminal
 * Manager). It carries its unconsumed control-sequence suffix, which is what makes
 * batching safe.
 */
export type TerminalHistorySanitizer = (
  pendingControlSequence: string,
  data: string,
) => { visibleText: string; pendingControlSequence: string };

export interface TerminalHistoryBuffer {
  /** `text.split("\n")`, so `lines.join("\n")` is the scrollback string. Never empty. */
  lines: Array<string>;
  /** Memoized `lines.join("\n")`; `null` once an append invalidates it. */
  text: string | null;
  /** Raw PTY chunks waiting for the batched sanitize/append pass. */
  pendingChunks: Array<string>;
  /** Sanitizer carry-over: the trailing bytes of a control sequence still in flight. */
  pendingControlSequence: string;
  readonly maxLines: number;
  readonly sanitize: TerminalHistorySanitizer;
}

export function createTerminalHistoryBuffer(options: {
  readonly text: string;
  readonly maxLines: number;
  readonly sanitize: TerminalHistorySanitizer;
}): TerminalHistoryBuffer {
  return {
    lines: options.text.split("\n"),
    text: options.text,
    pendingChunks: [],
    pendingControlSequence: "",
    maxLines: options.maxLines,
    sanitize: options.sanitize,
  };
}

/** Clears the scrollback and everything the batch is holding (clear/restart/relaunch). */
export function resetTerminalHistoryBuffer(buffer: TerminalHistoryBuffer): void {
  buffer.lines = [""];
  buffer.text = "";
  buffer.pendingChunks = [];
  buffer.pendingControlSequence = "";
}

/** Queues a raw PTY chunk. Nothing is parsed or joined until the batch flushes. */
export function queueTerminalHistoryChunk(buffer: TerminalHistoryBuffer, data: string): void {
  if (data.length === 0) return;
  buffer.pendingChunks.push(data);
}

/**
 * Sanitizes and appends every queued chunk.
 *
 * Sanitizing the concatenation is byte-identical to sanitizing chunk by chunk: the
 * sanitizer consumes a maximal prefix and returns the rest verbatim as
 * `pendingControlSequence`, so a resumed parse re-reads exactly the carried bytes.
 *
 * @returns whether visible text reached the scrollback (i.e. a persist is due).
 */
export function flushTerminalHistoryBuffer(buffer: TerminalHistoryBuffer): boolean {
  const pending = buffer.pendingChunks;
  if (pending.length === 0) return false;
  buffer.pendingChunks = [];
  const data = pending.length === 1 ? (pending[0] ?? "") : pending.join("");
  const sanitized = buffer.sanitize(buffer.pendingControlSequence, data);
  buffer.pendingControlSequence = sanitized.pendingControlSequence;
  if (sanitized.visibleText.length === 0) return false;
  appendVisibleText(buffer, sanitized.visibleText);
  return true;
}

/**
 * Applies anything the batch is holding, then drops the half-parsed control-sequence
 * carry - a stopped PTY will never send the bytes that would complete it. Mirrors
 * upstream's `session.pendingHistoryControlSequence = ""` on stop.
 *
 * @returns whether visible text reached the scrollback, so the caller can persist it
 * (the scheduled batch will find nothing left to do).
 */
export function endTerminalHistoryStream(buffer: TerminalHistoryBuffer): boolean {
  const appended = flushTerminalHistoryBuffer(buffer);
  buffer.pendingControlSequence = "";
  return appended;
}

/** Flushes the batch, then returns the scrollback string handed to clients and disk. */
export function readTerminalHistoryBuffer(buffer: TerminalHistoryBuffer): string {
  flushTerminalHistoryBuffer(buffer);
  buffer.text ??= buffer.lines.join("\n");
  return buffer.text;
}

function appendVisibleText(buffer: TerminalHistoryBuffer, visibleText: string): void {
  const lines = buffer.lines;
  const parts = visibleText.split("\n");
  const lastIndex = lines.length - 1;
  lines[lastIndex] = `${lines[lastIndex] ?? ""}${parts[0] ?? ""}`;
  for (let index = 1; index < parts.length; index += 1) {
    lines.push(parts[index] ?? "");
  }
  // A trailing "" element is the newline terminator, not a counted line - this is
  // upstream `capHistory`'s `if (hasTrailingNewline) lines.pop()` without the copy.
  const lineCount = lines.at(-1) === "" ? lines.length - 1 : lines.length;
  if (lineCount > buffer.maxLines) {
    lines.splice(0, lineCount - buffer.maxLines);
  }
  buffer.text = null;
}
