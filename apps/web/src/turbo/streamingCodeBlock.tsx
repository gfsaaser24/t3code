import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Streaming code fences are not rendered live.
 *
 * Upstream re-highlights the whole growing fence from the top on every delta —
 * a full Shiki tokenize plus a fresh code DOM plus a reflow, on the main
 * thread, several times a second. This module replaces that with a placeholder
 * card while the message streams; the real, fully coloured block renders once,
 * when the message completes.
 *
 * Three guards make the swap safe:
 *
 * 1. The placeholder grows with a cheap line count of the accumulated text, so
 *    the virtualized timeline never sees a card jump from one size to a
 *    400-line block in a single frame.
 * 2. The placeholder lives *inside* the code-block frame, so the frame's copy
 *    button and wrap toggle keep working on the partial text.
 * 3. If the stream dies mid-fence the placeholder reveals the partial text
 *    instead of pulsing forever. The message-level `streaming` flag cannot
 *    carry this: nothing in the stack ever clears it (a provider
 *    `runtime.error`, a `session.exited`, or a plain socket drop all leave
 *    `OrchestrationMessage.streaming` stuck at `true`, and it is persisted that
 *    way), so the signal we key on is the accumulated fence text going quiet —
 *    no growth for `STREAMING_CODE_STALL_MS` while the message still claims to
 *    be streaming.
 */

/**
 * How long the accumulated fence text may sit unchanged before we assume the
 * stream is gone and reveal the partial text (guard 3). Well above the gap
 * between deltas on a healthy stream, well below a user's patience.
 */
export const STREAMING_CODE_STALL_MS = 4_000;

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

export type StreamingCodeBlockView = "highlighted" | "partial-text" | "placeholder";

/**
 * The whole policy in one pure function: colour it once the message is done,
 * fall back to partial text when the stream went quiet, otherwise hold the
 * placeholder.
 */
export function resolveStreamingCodeBlockView(input: {
  readonly isStreaming: boolean;
  readonly stalled: boolean;
}): StreamingCodeBlockView {
  if (!input.isStreaming) return "highlighted";
  return input.stalled ? "partial-text" : "placeholder";
}

/**
 * True once the fence text has stopped growing for `STREAMING_CODE_STALL_MS`
 * while the message still reports itself as streaming. Deliberately one-way
 * for the life of the stream: a fence that recovers keeps showing its plain
 * partial text rather than flipping back to a card, which would be a visible
 * jump for no gain.
 */
export function useStreamingCodeStall(code: string, isStreaming: boolean): boolean {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    if (!isStreaming) {
      setStalled(false);
      return;
    }
    // `code` in the dependency list restarts the countdown on every delta, so
    // the timer only fires when the fence has genuinely gone quiet.
    const timer = setTimeout(() => setStalled(true), STREAMING_CODE_STALL_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [code, isStreaming]);

  return stalled && isStreaming;
}

/** Deterministic bar widths — code-shaped variation without a random per render. */
const PLACEHOLDER_LINE_WIDTHS = [82, 54, 71, 38, 90, 63, 47, 76, 59, 85, 33, 68] as const;

/**
 * Memoized on the line count alone: while a fence streams, the parent
 * re-renders on every delta but this subtree only reconciles when a newline
 * actually arrives. That is what makes the per-word cost of code streaming
 * effectively zero.
 */
export const StreamingCodeBlockPlaceholder = memo(function StreamingCodeBlockPlaceholder({
  lineCount,
}: {
  lineCount: number;
}) {
  const lineWidths = useMemo(() => {
    const total = Math.max(1, lineCount);
    return Array.from(
      { length: total },
      (_unused, index) => PLACEHOLDER_LINE_WIDTHS[index % PLACEHOLDER_LINE_WIDTHS.length] ?? 60,
    );
  }, [lineCount]);

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
        <code className="block animate-pulse">
          {lineWidths.map((width, index) => (
            <span
              key={`streaming-code-line-${index}`}
              className="block"
              data-streaming-code-line=""
            >
              <span
                className="inline-block h-[0.7em] rounded-[2px] bg-foreground/15 align-middle"
                style={{ width: `${width}%` }}
              />
              {"\u200B"}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
});

/**
 * Presentational half of the frame: given a resolved view, render it. Split out
 * from the wired component so every branch — including the dropped-stream one,
 * which is otherwise only reachable through a timer — is directly renderable.
 */
export function StreamingCodeBlockFrameView({
  view,
  lineCount,
  partialText,
  highlighted,
}: {
  view: StreamingCodeBlockView;
  lineCount: number;
  partialText: ReactNode;
  highlighted: ReactNode;
}) {
  if (view === "highlighted") return <>{highlighted}</>;
  if (view === "partial-text") return <>{partialText}</>;
  return <StreamingCodeBlockPlaceholder lineCount={lineCount} />;
}

/**
 * Drop-in child of the chat code-block frame. `partialText` is the plain,
 * unhighlighted `<pre>` upstream already builds as its Suspense fallback;
 * `highlighted` is the Shiki subtree.
 */
export function StreamingCodeBlockFrame({
  code,
  isStreaming,
  partialText,
  highlighted,
}: {
  code: string;
  isStreaming: boolean;
  partialText: ReactNode;
  highlighted: ReactNode;
}) {
  const stalled = useStreamingCodeStall(code, isStreaming);
  const view = resolveStreamingCodeBlockView({ isStreaming, stalled });

  return (
    <StreamingCodeBlockFrameView
      view={view}
      lineCount={view === "placeholder" ? countStreamingCodeLines(code) : 0}
      partialText={partialText}
      highlighted={highlighted}
    />
  );
}
