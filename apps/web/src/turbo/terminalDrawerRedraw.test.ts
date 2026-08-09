import { describe, expect, it } from "vite-plus/test";

import { terminalNeedsRedraw } from "../components/ThreadTerminalDrawer";

// The drawer's write effect used to gate on the version number alone. That is only safe while
// every distinct buffer carries a distinct version, and it stopped being true once a reconnect
// rebuilt the buffer state from a fresh snapshot with the counter restarted at 1 and the frame
// pool delivered the reconnect burst as a single update.

const drawn = { buffer: "$ ls\n", error: null, version: 1 } as const;

describe("terminalNeedsRedraw", () => {
  it("redraws a reconnect that reuses the version number the screen already drew", () => {
    expect(terminalNeedsRedraw(drawn, { buffer: "$ pwd\n", error: null, version: 1 })).toBe(true);
  });

  it("redraws when only the error changed", () => {
    expect(
      terminalNeedsRedraw(drawn, { buffer: drawn.buffer, error: "connection lost", version: 1 }),
    ).toBe(true);
  });

  it("still redraws on a version bump, which is what drives the mount focus", () => {
    expect(terminalNeedsRedraw(drawn, { buffer: drawn.buffer, error: null, version: 2 })).toBe(
      true,
    );
    expect(
      terminalNeedsRedraw(
        { buffer: "", error: null, version: 0 },
        { buffer: "", error: null, version: 1 },
      ),
    ).toBe(true);
  });

  it("skips a re-render that changed nothing the write reads", () => {
    expect(terminalNeedsRedraw(drawn, { ...drawn })).toBe(false);
  });
});
