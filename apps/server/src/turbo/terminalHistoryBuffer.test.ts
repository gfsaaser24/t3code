import { describe, expect, it } from "vite-plus/test";

import {
  createTerminalHistoryBuffer,
  endTerminalHistoryStream,
  flushTerminalHistoryBuffer,
  queueTerminalHistoryChunk,
  readTerminalHistoryBuffer,
  resetTerminalHistoryBuffer,
  type TerminalHistorySanitizer,
} from "./terminalHistoryBuffer.ts";

/**
 * Byte-identity guard for the S2 scrollback change (see
 * `.plans/23-turbo-performance-audit.md`).
 *
 * A second device restores its terminal from the persisted scrollback string, so the
 * incremental line buffer must produce exactly the bytes upstream's chop-and-reglue
 * produced — cap-trim boundaries included. These tests replay recorded PTY bursts
 * through the upstream shape and the new buffer and assert byte equality.
 */

/** Verbatim copy of upstream `capHistory` (`apps/server/src/terminal/Manager.ts`). */
function capHistory(history: string, maxLines: number): string {
  if (history.length === 0) return history;
  const hasTrailingNewline = history.endsWith("\n");
  const lines = history.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }
  if (lines.length <= maxLines) return history;
  const capped = lines.slice(lines.length - maxLines).join("\n");
  return hasTrailingNewline ? `${capped}\n` : capped;
}

/**
 * The upstream shape: sanitize each chunk on arrival, glue it onto the scrollback
 * string, then re-split/slice/join the whole buffer.
 */
function upstreamHistory(
  initial: string,
  chunks: ReadonlyArray<string>,
  maxLines: number,
  sanitize: TerminalHistorySanitizer,
): string {
  let history = initial;
  let pendingControlSequence = "";
  for (const chunk of chunks) {
    const sanitized = sanitize(pendingControlSequence, chunk);
    pendingControlSequence = sanitized.pendingControlSequence;
    if (sanitized.visibleText.length > 0) {
      history = capHistory(`${history}${sanitized.visibleText}`, maxLines);
    }
  }
  return history;
}

/** The new shape: queue every chunk, let the ~16 ms batch apply them in one pass. */
function bufferedHistory(
  initial: string,
  chunks: ReadonlyArray<string>,
  maxLines: number,
  sanitize: TerminalHistorySanitizer,
  batchEvery: number,
): string {
  const buffer = createTerminalHistoryBuffer({ text: initial, maxLines, sanitize });
  chunks.forEach((chunk, index) => {
    queueTerminalHistoryChunk(buffer, chunk);
    if ((index + 1) % batchEvery === 0) {
      flushTerminalHistoryBuffer(buffer);
    }
  });
  return readTerminalHistoryBuffer(buffer);
}

/** Passes every byte through; isolates the line-list and cap-trim math. */
const passThrough: TerminalHistorySanitizer = (pendingControlSequence, data) => ({
  visibleText: `${pendingControlSequence}${data}`,
  pendingControlSequence: "",
});

/**
 * A stand-in with the same resumable contract as the Manager's sanitizer: it consumes
 * a maximal prefix and carries the unconsumed tail, and it drops DSR queries
 * (`ESC [ … n`) so a stripped sequence split across chunks is exercised.
 */
const stripDeviceStatusReports: TerminalHistorySanitizer = (pendingControlSequence, data) => {
  const input = `${pendingControlSequence}${data}`;
  let visibleText = "";
  let index = 0;
  while (index < input.length) {
    if (input[index] !== "") {
      visibleText += input[index] ?? "";
      index += 1;
      continue;
    }
    const next = input[index + 1];
    if (next === undefined) {
      return { visibleText, pendingControlSequence: input.slice(index) };
    }
    if (next !== "[") {
      visibleText += input.slice(index, index + 2);
      index += 2;
      continue;
    }
    let cursor = index + 2;
    while (cursor < input.length && /[0-9;?]/u.test(input[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= input.length) {
      return { visibleText, pendingControlSequence: input.slice(index) };
    }
    if (input[cursor] !== "n") {
      visibleText += input.slice(index, cursor + 1);
    }
    index = cursor + 1;
  }
  return { visibleText, pendingControlSequence: "" };
};

/** Deterministic chunk splitter — no reliance on a global RNG. */
function splitDeterministically(input: string, seed: number): ReadonlyArray<string> {
  const chunks: Array<string> = [];
  let state = seed;
  let cursor = 0;
  while (cursor < input.length) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const size = 1 + (state % 7);
    chunks.push(input.slice(cursor, cursor + size));
    cursor += size;
  }
  return chunks;
}

const RECORDED_BURST = [
  "npm run build\r\n",
  "[32m✓[0m compiled ",
  "module ",
  "one\nmodule two\nmodule three\n",
  "[6",
  "n",
  "warning: unused import\n",
  "no trailing newline here",
  "\n\n\n",
  "done",
] as const;

describe("terminal history buffer byte identity", () => {
  it("matches upstream for a burst that never reaches the cap", () => {
    const chunks = [...RECORDED_BURST];
    expect(bufferedHistory("", chunks, 5_000, stripDeviceStatusReports, 3)).toBe(
      upstreamHistory("", chunks, 5_000, stripDeviceStatusReports),
    );
  });

  it("matches upstream across the cap-trim boundary", () => {
    const chunks = Array.from({ length: 40 }, (_, index) => `line ${index}\n`);
    for (const maxLines of [1, 2, 3, 7, 39, 40, 41]) {
      expect(bufferedHistory("", chunks, maxLines, passThrough, 4), `maxLines=${maxLines}`).toBe(
        upstreamHistory("", chunks, maxLines, passThrough),
      );
    }
  });

  it("matches upstream when the trimmed burst has no trailing newline", () => {
    const chunks = ["a\nb\nc\nd", "e", "\nf\ng", "\n", "h"];
    for (const maxLines of [1, 2, 3, 4]) {
      expect(bufferedHistory("", chunks, maxLines, passThrough, 2), `maxLines=${maxLines}`).toBe(
        upstreamHistory("", chunks, maxLines, passThrough),
      );
    }
  });

  it("matches upstream when the burst lands on scrollback restored from disk", () => {
    const restored = "restored one\nrestored two\n";
    const chunks = [...RECORDED_BURST];
    for (const maxLines of [2, 5, 500]) {
      expect(
        bufferedHistory(restored, chunks, maxLines, stripDeviceStatusReports, 5),
        `maxLines=${maxLines}`,
      ).toBe(upstreamHistory(restored, chunks, maxLines, stripDeviceStatusReports));
    }
  });

  it("is byte-identical however the recorded stream is chunked and batched", () => {
    const stream = RECORDED_BURST.join("");
    const expected = upstreamHistory("", [stream], 6, stripDeviceStatusReports);
    for (const seed of [1, 17, 4_242, 99_991]) {
      const chunks = splitDeterministically(stream, seed);
      expect(upstreamHistory("", chunks, 6, stripDeviceStatusReports), `seed=${seed}`).toBe(
        expected,
      );
      for (const batchEvery of [1, 2, 5, chunks.length]) {
        expect(
          bufferedHistory("", chunks, 6, stripDeviceStatusReports, batchEvery),
          `seed=${seed} batchEvery=${batchEvery}`,
        ).toBe(expected);
      }
    }
  });
});

describe("terminal history buffer batching", () => {
  it("reports whether a batch put visible text into the scrollback", () => {
    const buffer = createTerminalHistoryBuffer({
      text: "",
      maxLines: 10,
      sanitize: stripDeviceStatusReports,
    });

    expect(flushTerminalHistoryBuffer(buffer)).toBe(false);

    queueTerminalHistoryChunk(buffer, "[6n");
    expect(flushTerminalHistoryBuffer(buffer)).toBe(false);
    expect(readTerminalHistoryBuffer(buffer)).toBe("");

    queueTerminalHistoryChunk(buffer, "hello\n");
    expect(flushTerminalHistoryBuffer(buffer)).toBe(true);
    expect(readTerminalHistoryBuffer(buffer)).toBe("hello\n");
  });

  it("reads flush the batch, so a snapshot never lags the queued output", () => {
    const buffer = createTerminalHistoryBuffer({
      text: "",
      maxLines: 10,
      sanitize: passThrough,
    });

    queueTerminalHistoryChunk(buffer, "first\n");
    queueTerminalHistoryChunk(buffer, "second\n");
    expect(readTerminalHistoryBuffer(buffer)).toBe("first\nsecond\n");
    expect(buffer.pendingChunks).toEqual([]);
  });

  it("keeps a control sequence split across a batch boundary intact", () => {
    const buffer = createTerminalHistoryBuffer({
      text: "",
      maxLines: 10,
      sanitize: stripDeviceStatusReports,
    });

    queueTerminalHistoryChunk(buffer, "before [");
    expect(flushTerminalHistoryBuffer(buffer)).toBe(true);
    expect(buffer.pendingControlSequence).toBe("[");

    queueTerminalHistoryChunk(buffer, "6nafter\n");
    expect(flushTerminalHistoryBuffer(buffer)).toBe(true);
    expect(readTerminalHistoryBuffer(buffer)).toBe("before after\n");
  });

  it("drops the half-parsed carry when the stream ends but keeps the scrollback", () => {
    const buffer = createTerminalHistoryBuffer({
      text: "",
      maxLines: 10,
      sanitize: stripDeviceStatusReports,
    });

    queueTerminalHistoryChunk(buffer, "output\n[");
    endTerminalHistoryStream(buffer);

    expect(readTerminalHistoryBuffer(buffer)).toBe("output\n");
    expect(buffer.pendingControlSequence).toBe("");
  });

  it("clears the scrollback and everything the batch is holding on reset", () => {
    const buffer = createTerminalHistoryBuffer({
      text: "old\n",
      maxLines: 10,
      sanitize: stripDeviceStatusReports,
    });

    queueTerminalHistoryChunk(buffer, "never persisted[");
    resetTerminalHistoryBuffer(buffer);

    expect(readTerminalHistoryBuffer(buffer)).toBe("");
    expect(buffer.pendingChunks).toEqual([]);
    expect(buffer.pendingControlSequence).toBe("");
  });
});
