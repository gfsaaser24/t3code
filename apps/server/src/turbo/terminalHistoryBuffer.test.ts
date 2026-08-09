import { describe, expect, it } from "vite-plus/test";

import { sanitizeTerminalHistoryChunk } from "../terminal/Manager.ts";
import {
  createTerminalHistoryBuffer,
  endTerminalHistoryStream,
  flushTerminalHistoryBuffer,
  queueTerminalHistoryChunk,
  readTerminalHistoryBuffer,
  resetTerminalHistoryBuffer,
  takeTerminalHistoryForPersist,
  takeTerminalHistoryToPersist,
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
    if (input[index] !== "\u001b") {
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
  "\u001b[32m✓\u001b[0m compiled ",
  "module ",
  "one\nmodule two\nmodule three\n",
  "\u001b[6",
  "n",
  "warning: unused import\n",
  // A CR-only progress bar: the last line is rewritten in place many times without
  // ever advancing, so the buffer must keep growing one line rather than adding any.
  "\rbundling  0%",
  "\rbundling 48%",
  "\rbundling 100%",
  "\r\u001b[Kbundled\n",
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

describe("terminal history buffer byte identity with the real sanitizer", () => {
  /**
   * Closes the coverage gap between this file's stand-in sanitizer and production:
   * these cases drive the Manager's own `sanitizeTerminalHistoryChunk` through the
   * batch, so an upstream change to how the carry is held (e.g. capping it) fails here
   * rather than silently corrupting a second device's restored scrollback.
   */
  const REAL_BURST = [
    "prompt ",
    "\u001b[32mok\u001b[0m ",
    "\u001b]11;rgb:ffff/ffff/ffff\u0007",
    "\u001b[1;1R",
    // Deliberately split mid-sequence, the case batching has to get right.
    "\u001b[?2026$",
    "pafter ",
    "\u001bP$q ",
    "m\u001b",
    "\\after ",
    "\u009b?3",
    "1uafter ",
    "\u0090+q544e",
    "\u009cafter\n",
    '\u001b[!p\u001b["p\u001b[4 q\u001b[u',
    "done\n",
  ] as const;

  it("matches upstream for the recorded query/reply burst", () => {
    const chunks = [...REAL_BURST];
    for (const maxLines of [1, 2, 5, 5_000]) {
      expect(
        bufferedHistory("", chunks, maxLines, sanitizeTerminalHistoryChunk, 4),
        `maxLines=${maxLines}`,
      ).toBe(upstreamHistory("", chunks, maxLines, sanitizeTerminalHistoryChunk));
    }
  });

  it("is byte-identical however the real stream is chunked and batched", () => {
    const stream = REAL_BURST.join("");
    const expected = upstreamHistory("", [stream], 4, sanitizeTerminalHistoryChunk);
    for (const seed of [3, 29, 7_777]) {
      const chunks = splitDeterministically(stream, seed);
      expect(upstreamHistory("", chunks, 4, sanitizeTerminalHistoryChunk), `seed=${seed}`).toBe(
        expected,
      );
      for (const batchEvery of [1, 3, chunks.length]) {
        expect(
          bufferedHistory("", chunks, 4, sanitizeTerminalHistoryChunk, batchEvery),
          `seed=${seed} batchEvery=${batchEvery}`,
        ).toBe(expected);
      }
    }
  });
});

describe("terminal history buffer persist tracking", () => {
  const newBuffer = (text = "") =>
    createTerminalHistoryBuffer({ text, maxLines: 10, sanitize: passThrough });

  it("still owes the persist when a read flushed the batch before the batch tick", () => {
    // The exact race: chunk queued -> snapshot/attach read flushes it into the
    // scrollback -> batch worker wakes to an empty pending list. Gating on "did this
    // flush append" would drop the tail forever.
    const buffer = newBuffer();
    queueTerminalHistoryChunk(buffer, "tail\n");

    expect(readTerminalHistoryBuffer(buffer)).toBe("tail\n");
    expect(flushTerminalHistoryBuffer(buffer)).toBe(false);

    expect(takeTerminalHistoryToPersist(buffer)).toBe("tail\n");
  });

  it("still owes the persist at exit when a read already drained the batch", () => {
    const buffer = newBuffer();
    queueTerminalHistoryChunk(buffer, "last line\n");
    readTerminalHistoryBuffer(buffer);
    expect(takeTerminalHistoryToPersist(buffer)).toBe("last line\n");

    // And the same once more via the PTY-exit path.
    queueTerminalHistoryChunk(buffer, "after exit\n");
    readTerminalHistoryBuffer(buffer);
    endTerminalHistoryStream(buffer);
    expect(takeTerminalHistoryToPersist(buffer)).toBe("last line\nafter exit\n");
  });

  it("does not re-persist scrollback that is already on disk", () => {
    const buffer = newBuffer();
    queueTerminalHistoryChunk(buffer, "written\n");
    expect(takeTerminalHistoryToPersist(buffer)).toBe("written\n");
    expect(takeTerminalHistoryToPersist(buffer)).toBeNull();

    endTerminalHistoryStream(buffer);
    expect(takeTerminalHistoryToPersist(buffer)).toBeNull();
  });

  it("owes nothing for scrollback restored from disk until new output arrives", () => {
    const buffer = newBuffer("restored\n");
    expect(takeTerminalHistoryToPersist(buffer)).toBeNull();

    queueTerminalHistoryChunk(buffer, "fresh\n");
    expect(takeTerminalHistoryToPersist(buffer)).toBe("restored\nfresh\n");
  });

  it("owes nothing after a stripped-only burst", () => {
    const buffer = createTerminalHistoryBuffer({
      text: "",
      maxLines: 10,
      sanitize: stripDeviceStatusReports,
    });
    queueTerminalHistoryChunk(buffer, "\u001b[6n");
    expect(takeTerminalHistoryToPersist(buffer)).toBeNull();
  });

  it("clears the debt on reset and on an unconditional take", () => {
    const buffer = newBuffer();
    queueTerminalHistoryChunk(buffer, "discarded\n");
    resetTerminalHistoryBuffer(buffer);
    expect(takeTerminalHistoryToPersist(buffer)).toBeNull();

    queueTerminalHistoryChunk(buffer, "kept\n");
    expect(takeTerminalHistoryForPersist(buffer)).toBe("kept\n");
    expect(takeTerminalHistoryToPersist(buffer)).toBeNull();
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

    queueTerminalHistoryChunk(buffer, "\u001b[6n");
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

    queueTerminalHistoryChunk(buffer, "before \u001b[");
    expect(flushTerminalHistoryBuffer(buffer)).toBe(true);
    expect(buffer.pendingControlSequence).toBe("\u001b[");

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

    queueTerminalHistoryChunk(buffer, "output\n\u001b[");
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

    queueTerminalHistoryChunk(buffer, "never persisted\u001b[");
    resetTerminalHistoryBuffer(buffer);

    expect(readTerminalHistoryBuffer(buffer)).toBe("");
    expect(buffer.pendingChunks).toEqual([]);
    expect(buffer.pendingControlSequence).toBe("");
  });
});
