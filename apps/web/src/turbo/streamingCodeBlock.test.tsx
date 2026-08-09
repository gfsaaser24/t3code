import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceStreamingCodeLineCount,
  countStreamingCodeLines,
  EMPTY_STREAMING_CODE_LINE_SCAN,
  resolveStreamingCodeBlockView,
  STREAMING_CODE_FIRST_DELTA_MS,
  STREAMING_CODE_MAX_PLACEHOLDER_ROWS,
  StreamingCodeBlockFrameView,
  StreamingCodeBlockPlaceholder,
} from "./streamingCodeBlock";

function placeholderLineCount(html: string): number {
  return html.split("data-streaming-code-line=").length - 1;
}

function spacerLines(html: string): number {
  const match = /data-streaming-code-spacer-lines="(\d+)"/u.exec(html);
  return match ? Number(match[1]) : 0;
}

describe("countStreamingCodeLines", () => {
  it("counts an empty fence as one line", () => {
    expect(countStreamingCodeLines("")).toBe(1);
  });

  it("counts one line per newline and drops the fence's own terminator", () => {
    expect(countStreamingCodeLines("const a = 1;")).toBe(1);
    expect(countStreamingCodeLines("const a = 1;\n")).toBe(1);
    expect(countStreamingCodeLines("const a = 1;\nconst b = 2;")).toBe(2);
    expect(countStreamingCodeLines("const a = 1;\nconst b = 2;\n")).toBe(2);
  });

  it("keeps blank interior lines", () => {
    expect(countStreamingCodeLines("a\n\nb\n")).toBe(3);
  });
});

describe("advanceStreamingCodeLineCount", () => {
  // The whole point of the incremental scan: it must be indistinguishable from
  // the full one. Anything else and the placeholder height drifts from the
  // block that replaces it.
  it("agrees with the full scan at every prefix of a streamed fence", () => {
    const full = 'fn main() {\n  let a = 1;\n\n  println!("{a}");\n}\n\n// done\n';
    let scan = EMPTY_STREAMING_CODE_LINE_SCAN;
    for (let end = 0; end <= full.length; end += 1) {
      const code = full.slice(0, end);
      scan = advanceStreamingCodeLineCount(code, scan);
      expect(scan.lines).toBe(countStreamingCodeLines(code));
    }
  });

  it("is idempotent when the fence has not changed", () => {
    const scan = advanceStreamingCodeLineCount("a\nb", EMPTY_STREAMING_CODE_LINE_SCAN);

    expect(advanceStreamingCodeLineCount("a\nb", scan)).toBe(scan);
  });

  it("falls back to a full scan when the text is not an extension of the last one", () => {
    const scan = advanceStreamingCodeLineCount("a\nb\nc\n", EMPTY_STREAMING_CODE_LINE_SCAN);

    // A shrink (re-mount onto a shorter fence).
    expect(advanceStreamingCodeLineCount("a\n", scan).lines).toBe(1);
    // A same-length edit that shares no prefix.
    expect(advanceStreamingCodeLineCount("x\ny\nz\n", scan).lines).toBe(3);
    // A longer string that diverges from the previous text.
    expect(advanceStreamingCodeLineCount("q\nb\nc\nd\n", scan).lines).toBe(4);
  });
});

describe("streaming code block placeholder", () => {
  // Guard 1: the card grows with the accumulated text, so the virtualized
  // timeline never sees a one-frame jump when the real block lands.
  it("grows one placeholder line per accumulated code line", () => {
    const deltas = ["fn main() {", "fn main() {\n  let a = 1;", "fn main() {\n  let a = 1;\n}\n"];
    const counts = deltas.map((code) =>
      placeholderLineCount(
        renderToStaticMarkup(
          <StreamingCodeBlockPlaceholder lineCount={countStreamingCodeLines(code)} />,
        ),
      ),
    );

    expect(counts).toEqual([1, 2, 3]);
  });

  // A 400-line fence used to be 400 DOM rows re-reconciled on every newline.
  // The card still reserves the full height; it just stops paying per row.
  it("caps the rendered rows and reserves the rest with one spacer", () => {
    const html = renderToStaticMarkup(<StreamingCodeBlockPlaceholder lineCount={400} />);

    expect(placeholderLineCount(html)).toBe(STREAMING_CODE_MAX_PLACEHOLDER_ROWS);
    expect(spacerLines(html)).toBe(400 - STREAMING_CODE_MAX_PLACEHOLDER_ROWS);
    expect(html).toContain('data-streaming-code-line-count="400"');
    // The spacer's height is expressed in line-heights, so it reserves exactly
    // what the rows it replaces would have.
    expect(html).toContain(`${400 - STREAMING_CODE_MAX_PLACEHOLDER_ROWS}lh`);
  });

  it("adds no spacer while the fence still fits under the cap", () => {
    const html = renderToStaticMarkup(
      <StreamingCodeBlockPlaceholder lineCount={STREAMING_CODE_MAX_PLACEHOLDER_ROWS} />,
    );

    expect(placeholderLineCount(html)).toBe(STREAMING_CODE_MAX_PLACEHOLDER_ROWS);
    expect(html).not.toContain("data-streaming-code-spacer");
  });

  // AGENTS.md "Taste": no continuously repainting animation. The repo's
  // duty-cycled `animate-skeleton` replaces Tailwind's per-frame
  // `animate-pulse`.
  it("uses the duty-cycled skeleton sweep, not a per-frame pulse", () => {
    const html = renderToStaticMarkup(<StreamingCodeBlockPlaceholder lineCount={3} />);

    expect(html).toContain("animate-skeleton");
    expect(html).not.toContain("animate-pulse");
  });

  it("advertises itself as busy without claiming a permanent state in text", () => {
    const html = renderToStaticMarkup(<StreamingCodeBlockPlaceholder lineCount={3} />);

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Writing code"');
  });
});

describe("resolveStreamingCodeBlockView", () => {
  it("colours the block once the message stops streaming", () => {
    expect(resolveStreamingCodeBlockView({ isStreaming: false, stall: "none" })).toBe(
      "highlighted",
    );
    expect(resolveStreamingCodeBlockView({ isStreaming: false, stall: "never-started" })).toBe(
      "highlighted",
    );
  });

  // The reducer now clears `streaming` on every turn settle, so a live fence
  // that goes quiet is fence-then-prose, not a drop. It must not change
  // appearance mid-message — the placeholder simply holds until the flag drops
  // and the coloured block lands.
  it("holds the placeholder for a live fence, quiet or not", () => {
    expect(resolveStreamingCodeBlockView({ isStreaming: true, stall: "none" })).toBe("placeholder");
  });

  // Rows persisted with `is_streaming = 1` by builds that predate the reducer
  // fix are finished history, not a live stream: they must keep their syntax
  // highlighting instead of pulsing forever on every scroll-in.
  it("colours a fence that never grew, even though the message still claims to stream", () => {
    expect(resolveStreamingCodeBlockView({ isStreaming: true, stall: "never-started" })).toBe(
      "highlighted",
    );
  });
});

describe("stall window", () => {
  // This is the window a stopped turn's history spends pulsing before it gets
  // highlighted, so it has to be short enough to read as a render, not a wait.
  it("probes for liveness inside a frame budget a reader would not notice", () => {
    expect(STREAMING_CODE_FIRST_DELTA_MS).toBeLessThanOrEqual(500);
  });
});

describe("StreamingCodeBlockFrameView", () => {
  const highlighted = <div data-testid="highlighted">coloured source</div>;

  it("renders the placeholder, and not the real block, while streaming", () => {
    const html = renderToStaticMarkup(
      <StreamingCodeBlockFrameView view="placeholder" lineCount={4} highlighted={highlighted} />,
    );

    expect(placeholderLineCount(html)).toBe(4);
    expect(html).not.toContain("coloured source");
  });

  it("renders the coloured block once on completion", () => {
    const html = renderToStaticMarkup(
      <StreamingCodeBlockFrameView view="highlighted" lineCount={0} highlighted={highlighted} />,
    );

    expect(html).toContain("coloured source");
    expect(html).not.toContain("data-streaming-code-placeholder");
  });
});
