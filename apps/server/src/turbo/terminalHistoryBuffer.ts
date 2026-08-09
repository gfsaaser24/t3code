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
  /**
   * Whether the scrollback has text that has not been handed to the persist worker.
   *
   * This is the persist signal, not "did the last flush append": any scrollback read
   * (a snapshot, an attach) flushes the batch, so the batch tick that follows finds
   * nothing pending and would otherwise conclude nothing needs writing. The flag
   * survives that race and is only cleared where a persist is actually issued.
   */
  dirtySincePersist: boolean;
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
    // The seed text came off disk, so it is already persisted.
    dirtySincePersist: false,
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
  buffer.dirtySincePersist = false;
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
 * Ask `takeTerminalHistoryToPersist` afterwards for the string still owed to disk.
 */
export function endTerminalHistoryStream(buffer: TerminalHistoryBuffer): void {
  flushTerminalHistoryBuffer(buffer);
  buffer.pendingControlSequence = "";
}

/**
 * Flushes the batch, then returns the scrollback string handed to clients and disk.
 * A read is not a persist, so it deliberately leaves `dirtySincePersist` alone.
 */
export function readTerminalHistoryBuffer(buffer: TerminalHistoryBuffer): string {
  flushTerminalHistoryBuffer(buffer);
  buffer.text ??= buffer.lines.join("\n");
  return buffer.text;
}

/**
 * Flushes the batch and returns the string to write when the scrollback still owes a
 * persist, or `null` when it is already on disk. Reading and clearing the flag in one
 * synchronous step is what keeps a concurrent read from stranding the tail.
 */
export function takeTerminalHistoryToPersist(buffer: TerminalHistoryBuffer): string | null {
  flushTerminalHistoryBuffer(buffer);
  return buffer.dirtySincePersist ? takeTerminalHistoryForPersist(buffer) : null;
}

/** The unconditional form, for callers that always write (clear, restart, close). */
export function takeTerminalHistoryForPersist(buffer: TerminalHistoryBuffer): string {
  const text = readTerminalHistoryBuffer(buffer);
  buffer.dirtySincePersist = false;
  return text;
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
  const hasTrailingNewline = lines.at(-1) === "";
  const lineCount = hasTrailingNewline ? lines.length - 1 : lines.length;
  if (buffer.maxLines <= 0) {
    // Upstream `capHistory` slices every line away for a non-positive cap and
    // returns "" - or "\n" when the text ended in one, because it re-appends
    // the terminator. Reaching the splice below with such a cap would delete
    // MORE elements than `lines` has and leave it empty, breaking this
    // module's "never empty" invariant: the next append writes `lines[-1]`,
    // which silently becomes a string property instead of an element.
    if (lineCount > 0) {
      lines.length = 0;
      lines.push("");
      if (hasTrailingNewline) {
        lines.push("");
      }
    }
  } else if (lineCount > buffer.maxLines) {
    lines.splice(0, lineCount - buffer.maxLines);
  }
  buffer.text = null;
  buffer.dirtySincePersist = true;
}
