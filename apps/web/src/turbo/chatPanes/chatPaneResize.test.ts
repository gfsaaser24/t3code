import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../../composerDraftStore";
import { clampPaneWidths, MIN_CHAT_PANE_WIDTH } from "./ChatPaneDivider";
import {
  ChatPaneId,
  chatPaneWeight,
  createChatPaneLayout,
  resetChatPaneWeights,
  resizeChatPaneBoundary,
  type ChatPane,
  type ChatPaneLayout,
} from "./chatPaneLayout";

function pane(id: string, weight?: number): ChatPane {
  return {
    id: ChatPaneId.make(id),
    target: { kind: "draft", draftId: DraftId.make(`${id}-draft`) },
    ...(weight === undefined ? {} : { weight }),
  };
}

function layoutOf(...panes: ChatPane[]): ChatPaneLayout {
  const [first, ...rest] = panes;
  if (!first) throw new Error("at least one pane");
  return { version: 1, panes: [first, ...rest], focusedPaneId: first.id };
}

function paneAt(layout: ChatPaneLayout, index: number): ChatPane {
  const pane = layout.panes[index];
  if (!pane) throw new Error(`expected a pane at index ${index}`);
  return pane;
}

const weightAt = (layout: ChatPaneLayout, index: number) => chatPaneWeight(paneAt(layout, index));

describe("chatPaneWeight", () => {
  it("treats an absent weight as an equal share", () => {
    expect(chatPaneWeight(pane("a"))).toBe(1);
  });

  it("rejects values that would break the flex row", () => {
    expect(chatPaneWeight(pane("a", 0))).toBe(1);
    expect(chatPaneWeight(pane("a", -3))).toBe(1);
    expect(chatPaneWeight(pane("a", Number.NaN))).toBe(1);
    expect(chatPaneWeight(pane("a", Number.POSITIVE_INFINITY))).toBe(1);
  });
});

describe("resizeChatPaneBoundary", () => {
  it("converts pixel widths into proportional weights", () => {
    const next = resizeChatPaneBoundary(layoutOf(pane("a"), pane("b")), 0, 300, 100);

    expect(weightAt(next, 0)).toBeCloseTo(1.5);
    expect(weightAt(next, 1)).toBeCloseTo(0.5);
  });

  it("preserves the pair's combined weight so panes beyond the divider do not move", () => {
    const layout = layoutOf(pane("a"), pane("b"), pane("c", 3));
    const next = resizeChatPaneBoundary(layout, 0, 300, 100);

    const pairBefore = weightAt(layout, 0) + weightAt(layout, 1);
    const pairAfter = weightAt(next, 0) + weightAt(next, 1);
    expect(pairAfter).toBeCloseTo(pairBefore);
    // The untouched third pane keeps its weight, so its rendered width is stable.
    expect(weightAt(next, 2)).toBe(3);
  });

  it("ignores a boundary that does not exist", () => {
    const layout = layoutOf(pane("a"));
    expect(resizeChatPaneBoundary(layout, 0, 300, 100)).toBe(layout);
  });

  it("ignores degenerate widths rather than producing a zero-width pane", () => {
    const layout = layoutOf(pane("a"), pane("b"));
    expect(resizeChatPaneBoundary(layout, 0, 0, 400)).toBe(layout);
    expect(resizeChatPaneBoundary(layout, 0, -10, 400)).toBe(layout);
    expect(resizeChatPaneBoundary(layout, 0, Number.NaN, 400)).toBe(layout);
  });
});

describe("resetChatPaneWeights", () => {
  it("drops stored weights so the row splits evenly", () => {
    const next = resetChatPaneWeights(layoutOf(pane("a", 1.8), pane("b", 0.2)));

    expect(paneAt(next, 0).weight).toBeUndefined();
    expect(paneAt(next, 1).weight).toBeUndefined();
  });

  it("is referentially stable when there is nothing to reset", () => {
    const layout = layoutOf(pane("a"), pane("b"));
    expect(resetChatPaneWeights(layout)).toBe(layout);
  });

  it("leaves a fresh single-pane layout untouched", () => {
    const layout = createChatPaneLayout(pane("a"));
    expect(resetChatPaneWeights(layout)).toBe(layout);
  });
});

describe("clampPaneWidths", () => {
  it("keeps both panes above the minimum", () => {
    const total = 1200;
    expect(clampPaneWidths(10, total).left).toBe(MIN_CHAT_PANE_WIDTH);
    expect(clampPaneWidths(10_000, total).left).toBe(total - MIN_CHAT_PANE_WIDTH);
  });

  it("always fills the row exactly", () => {
    for (const desired of [-500, 0, 120, 600, 1199, 9999]) {
      const { left, right } = clampPaneWidths(desired, 1200);
      expect(left + right).toBeCloseTo(1200);
    }
  });

  it("splits evenly when the row cannot honour both minimums", () => {
    // A window narrower than two minimum panes must not pin one open and
    // collapse the other to nothing.
    const total = MIN_CHAT_PANE_WIDTH * 2 - 100;
    const { left, right } = clampPaneWidths(10, total);
    expect(left).toBeCloseTo(total / 2);
    expect(right).toBeCloseTo(total / 2);
  });

  it("passes through a width that already satisfies the minimum", () => {
    expect(clampPaneWidths(600, 1200).left).toBe(600);
  });
});
