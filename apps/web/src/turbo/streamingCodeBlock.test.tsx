import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  countStreamingCodeLines,
  resolveStreamingCodeBlockView,
  StreamingCodeBlockFrameView,
  StreamingCodeBlockPlaceholder,
} from "./streamingCodeBlock";

function placeholderLineCount(html: string): number {
  return html.split("data-streaming-code-line=").length - 1;
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

  it("renders a line per row of a large block rather than a fixed-size card", () => {
    const html = renderToStaticMarkup(<StreamingCodeBlockPlaceholder lineCount={400} />);

    expect(placeholderLineCount(html)).toBe(400);
    expect(html).toContain('data-streaming-code-line-count="400"');
  });

  it("advertises itself as busy without claiming a permanent state in text", () => {
    const html = renderToStaticMarkup(<StreamingCodeBlockPlaceholder lineCount={3} />);

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Writing code"');
  });
});

describe("resolveStreamingCodeBlockView", () => {
  it("colours the block once the message stops streaming", () => {
    expect(resolveStreamingCodeBlockView({ isStreaming: false, stalled: false })).toBe(
      "highlighted",
    );
    expect(resolveStreamingCodeBlockView({ isStreaming: false, stalled: true })).toBe(
      "highlighted",
    );
  });

  it("holds the placeholder while the fence is still growing", () => {
    expect(resolveStreamingCodeBlockView({ isStreaming: true, stalled: false })).toBe(
      "placeholder",
    );
  });

  // Guard 3: a dropped stream must never leave a card pulsing forever.
  it("falls back to partial text when the fence goes quiet mid-stream", () => {
    expect(resolveStreamingCodeBlockView({ isStreaming: true, stalled: true })).toBe(
      "partial-text",
    );
  });
});

describe("StreamingCodeBlockFrameView", () => {
  const partialText = <pre data-testid="partial">partial source</pre>;
  const highlighted = <div data-testid="highlighted">coloured source</div>;

  it("renders the placeholder, and neither real view, while streaming", () => {
    const html = renderToStaticMarkup(
      <StreamingCodeBlockFrameView
        view="placeholder"
        lineCount={4}
        partialText={partialText}
        highlighted={highlighted}
      />,
    );

    expect(placeholderLineCount(html)).toBe(4);
    expect(html).not.toContain("partial source");
    expect(html).not.toContain("coloured source");
  });

  it("shows the partial text when the stream drops mid-block", () => {
    const html = renderToStaticMarkup(
      <StreamingCodeBlockFrameView
        view="partial-text"
        lineCount={4}
        partialText={partialText}
        highlighted={highlighted}
      />,
    );

    expect(html).toContain("partial source");
    expect(html).not.toContain("data-streaming-code-placeholder");
  });

  it("renders the coloured block once on completion", () => {
    const html = renderToStaticMarkup(
      <StreamingCodeBlockFrameView
        view="highlighted"
        lineCount={0}
        partialText={partialText}
        highlighted={highlighted}
      />,
    );

    expect(html).toContain("coloured source");
    expect(html).not.toContain("data-streaming-code-placeholder");
  });
});
