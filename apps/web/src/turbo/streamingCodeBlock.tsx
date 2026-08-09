import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Skeleton } from "~/components/ui/skeleton";

/**
 * Streaming code fences are not rendered live.
 *
 * Upstream re-highlights the whole growing fence from the top on every delta —
 * a full Shiki tokenize plus a fresh code DOM plus a reflow, on the main
 * thread, several times a second. This module replaces that with a placeholder
 * card while the message streams; the real, fully coloured block renders once,
 * when the message completes.
 *
 * Two guards make the swap safe:
 *
 * 1. The placeholder reserves the height of the accumulated text, so the
 *    virtualized timeline never sees a card jump from one size to a 400-line
 *    block in a single frame.
 * 2. The placeholder lives *inside* the code-block frame, so the frame's copy
 *    button and wrap toggle keep working on the partial text.
 *
 * There used to be a third: a 4s "the stream went quiet after growing" verdict
 * that revealed unhighlighted partial text, because nothing in the stack ever
 * cleared `OrchestrationMessage.streaming` — a provider `runtime.error`, a
 * `session.exited`, a `turn.aborted` or a socket drop all left it stuck at
 * `true`. The store reducer now clears the flag whenever it settles a turn
 * (`thread.session-set` off "running", and `thread.turn-interrupt-requested`),
 * and every provider death path settles the session status, so the flag is
 * trustworthy for live sessions and that verdict has been deleted. It was also
 * actively wrong on the routine fence-then-prose shape: a fence that closes
 * while the model keeps writing prose goes quiet by design, so the watchdog
 * fired mid-message and the reader got skeleton → unhighlighted text →
 * highlighted block, three appearance changes for a healthy stream. While
 * `isStreaming` is true the placeholder simply holds.
 *
 * What survives is the **history** repair. Rows persisted with
 * `is_streaming = 1` by builds that predate the reducer fix are still in users'
 * databases, and at mount they are indistinguishable from a live stream. A
 * fence that never grows within `STREAMING_CODE_FIRST_DELTA_MS` was never live
 * for this mount, so it gets highlighted normally — without that, every
 * stopped turn in a user's history would pulse forever, on every scroll-in.
 */

/**
 * How long a freshly mounted fence has to produce its first delta before we
 * conclude it is not a live stream at all. Short, because this is the window a
 * stopped turn's history spends pulsing before it gets highlighted; a live
 * stream that is merely slower than this pays one Shiki pass over whatever has
 * accumulated so far and then goes straight back to the placeholder.
 */
export const STREAMING_CODE_FIRST_DELTA_MS = 500;

/**
 * Skeleton rows actually put in the DOM. Beyond this the placeholder reserves
 * height with a single empty spacer instead of more rows: a 400-line fence is
 * 400 elements to reconcile and repaint for a card that is mostly off-screen,
 * and the rows past the first screenful carry no information the spacer does
 * not. Kept above any plausible viewport's worth of code lines.
 */
export const STREAMING_CODE_MAX_PLACEHOLDER_ROWS = 24;

const NEWLINE_CHAR_CODE = 10;

/**
 * Cheap line count for the placeholder: one pass over the string, no split,
 * no allocation. A trailing newline is the fence's own terminator, not another
 * line — Shiki drops it too, so the placeholder and the real block agree.
 */
export function countStreamingCodeLines(code: string): number {
  if (code.length === 0) return 1;
  let lines = 1;
  for (let index = 0; index < code.length; index += 1) {
    if (code.charCodeAt(index) === NEWLINE_CHAR_CODE) lines += 1;
  }
  if (code.charCodeAt(code.length - 1) === NEWLINE_CHAR_CODE) lines -= 1;
  return Math.max(1, lines);
}

/** The running line scan carried between deltas. */
export interface StreamingCodeLineScan {
  /** The exact text the `lines` count was computed from. */
  readonly code: string;
  readonly lines: number;
}

/** A scan that has not looked at anything yet. */
export const EMPTY_STREAMING_CODE_LINE_SCAN: StreamingCodeLineScan = { code: "", lines: 1 };

/**
 * Incremental form of {@link countStreamingCodeLines} for the streaming case:
 * a fence only ever gains characters at its end, so re-scanning the whole
 * string per delta makes the placeholder O(n²) over a message. Counts the
 * appended slice and folds it into the running total.
 *
 * Any `code` that is not a strict extension of the previous text (a re-mount,
 * an edit, a shrink) falls back to the full scan, so the result is always what
 * `countStreamingCodeLines` would have returned.
 */
export function advanceStreamingCodeLineCount(
  code: string,
  previous: StreamingCodeLineScan,
): StreamingCodeLineScan {
  if (code === previous.code) {
    return previous;
  }
  const previousLength = previous.code.length;
  if (
    previousLength === 0 ||
    previousLength > code.length ||
    // `startsWith` on the previous text, not on a slice of `code` — comparing
    // `code` against its own prefix would be vacuously true and would let an
    // edited fence keep a stale count.
    !code.startsWith(previous.code)
  ) {
    return { code, lines: countStreamingCodeLines(code) };
  }

  // The previous count subtracted a trailing newline; undo that before folding
  // in the appended slice, then re-apply the rule to the new tail.
  const previousEndedInNewline = code.charCodeAt(previousLength - 1) === NEWLINE_CHAR_CODE;
  let lines = previous.lines + (previousEndedInNewline ? 1 : 0);
  for (let index = previousLength; index < code.length; index += 1) {
    if (code.charCodeAt(index) === NEWLINE_CHAR_CODE) lines += 1;
  }
  if (code.charCodeAt(code.length - 1) === NEWLINE_CHAR_CODE) lines -= 1;
  return { code, lines: Math.max(1, lines) };
}

export type StreamingCodeBlockView = "highlighted" | "placeholder";

/**
 * What the watchdog has concluded about a fence whose message still reports
 * itself as streaming.
 *
 * - `none` — the fence is growing (or still inside its first-delta window).
 * - `never-started` — it never grew at all: the message is finished history
 *   carrying a `streaming` flag written before the reducer learned to clear it.
 */
export type StreamingCodeStall = "none" | "never-started";

/**
 * The whole policy in one pure function: colour it once the message is done,
 * colour it too when the "stream" turns out to be a stopped turn's history,
 * otherwise hold the placeholder.
 */
export function resolveStreamingCodeBlockView(input: {
  readonly isStreaming: boolean;
  readonly stall: StreamingCodeStall;
}): StreamingCodeBlockView {
  if (!input.isStreaming) return "highlighted";
  if (input.stall === "never-started") return "highlighted";
  return "placeholder";
}

/**
 * Reports whether a fence claiming to stream has produced any delta at all
 * since it mounted.
 *
 * Only the first-delta window is timed. Once the fence has grown once it is a
 * live stream and stays one until `isStreaming` goes false — a fence that
 * closes while the model keeps writing prose is the normal shape, not a fault,
 * and must not change appearance mid-message.
 */
export function useStreamingCodeStall(code: string, isStreaming: boolean): StreamingCodeStall {
  const previousCodeRef = useRef(code);
  const grewRef = useRef(false);
  const [stall, setStall] = useState<StreamingCodeStall>("none");

  useEffect(() => {
    if (!isStreaming) {
      previousCodeRef.current = code;
      grewRef.current = false;
      setStall("none");
      return;
    }

    if (code !== previousCodeRef.current) {
      previousCodeRef.current = code;
      grewRef.current = true;
      setStall("none");
    }

    if (grewRef.current) {
      return;
    }

    const timer = setTimeout(() => {
      setStall("never-started");
    }, STREAMING_CODE_FIRST_DELTA_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [code, isStreaming]);

  return isStreaming ? stall : "none";
}

/** Deterministic bar widths — code-shaped variation without a random per render. */
const PLACEHOLDER_LINE_WIDTHS = [82, 54, 71, 38, 90, 63, 47, 76, 59, 85, 33, 68] as const;

/**
 * Memoized on the line count alone: while a fence streams, the parent
 * re-renders on every delta but this subtree only reconciles when a newline
 * actually arrives — and then only up to
 * {@link STREAMING_CODE_MAX_PLACEHOLDER_ROWS} rows, because everything past
 * them is one spacer whose height is the remaining lines. That is what makes
 * the per-word cost of code streaming effectively zero.
 */
export const StreamingCodeBlockPlaceholder = memo(function StreamingCodeBlockPlaceholder({
  lineCount,
}: {
  lineCount: number;
}) {
  const total = Math.max(1, lineCount);
  const renderedRows = Math.min(total, STREAMING_CODE_MAX_PLACEHOLDER_ROWS);
  const spacerLines = total - renderedRows;

  const lineWidths = useMemo(
    () =>
      Array.from(
        { length: renderedRows },
        (_unused, index) => PLACEHOLDER_LINE_WIDTHS[index % PLACEHOLDER_LINE_WIDTHS.length] ?? 60,
      ),
    [renderedRows],
  );

  return (
    <div
      className="chat-markdown-shiki"
      data-streaming-code-placeholder=""
      data-streaming-code-line-count={lineCount}
      role="status"
      aria-busy="true"
      aria-label="Writing code"
    >
      <pre aria-hidden="true">
        <code className="block">
          {lineWidths.map((width, index) => (
            <span
              key={`streaming-code-line-${index}`}
              className="block"
              data-streaming-code-line=""
            >
              {/* `Skeleton` carries the duty-cycled `animate-skeleton` sweep.
                  `animate-pulse` repaints every frame for the life of the
                  stream, which AGENTS.md "Taste" rules out. */}
              <Skeleton
                className="inline-block h-[0.7em] align-middle"
                style={{ width: `${width}%` }}
              />
              {"​"}
            </span>
          ))}
          {spacerLines > 0 ? (
            // One element instead of `spacerLines` rows: the card still
            // reserves the full height, so the virtualized timeline measures
            // the same box it would have with every row present.
            <span
              className="block"
              data-streaming-code-spacer=""
              data-streaming-code-spacer-lines={spacerLines}
              style={{ height: `${spacerLines}lh` }}
            />
          ) : null}
        </code>
      </pre>
    </div>
  );
});

/**
 * Presentational half of the frame: given a resolved view, render it. Split out
 * from the wired component so every branch is directly renderable.
 */
export function StreamingCodeBlockFrameView({
  view,
  lineCount,
  highlighted,
}: {
  view: StreamingCodeBlockView;
  lineCount: number;
  highlighted: ReactNode;
}) {
  if (view === "highlighted") return <>{highlighted}</>;
  return <StreamingCodeBlockPlaceholder lineCount={lineCount} />;
}

/**
 * Drop-in child of the chat code-block frame. `highlighted` is the Shiki
 * subtree, which upstream already wraps in its own Suspense/error fallbacks.
 */
export function StreamingCodeBlockFrame({
  code,
  isStreaming,
  highlighted,
}: {
  code: string;
  isStreaming: boolean;
  highlighted: ReactNode;
}) {
  const stall = useStreamingCodeStall(code, isStreaming);
  const view = resolveStreamingCodeBlockView({ isStreaming, stall });

  // Incremental across deltas: the full scan is O(n) per delta, i.e. O(n²) per
  // message, and a long fence streams hundreds of deltas. `useRef` rather than
  // `useMemo` because the previous scan is state, not a cache that may be
  // dropped.
  const scanRef = useRef(EMPTY_STREAMING_CODE_LINE_SCAN);
  if (view === "placeholder") {
    // Idempotent when `code` is unchanged, so React's double-render in
    // development cannot double-count.
    scanRef.current = advanceStreamingCodeLineCount(code, scanRef.current);
  }
  const lineCount = view === "placeholder" ? scanRef.current.lines : 0;

  return (
    <StreamingCodeBlockFrameView view={view} lineCount={lineCount} highlighted={highlighted} />
  );
}
