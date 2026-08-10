import type {
  EnvironmentId,
  TerminalAttachStreamEvent,
  TerminalMetadataStreamEvent,
  TerminalSessionSnapshot,
  TerminalSummary,
  ThreadId,
} from "@t3tools/contracts";

export interface TerminalSessionState {
  readonly summary: TerminalSummary | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalBufferState {
  readonly buffer: string;
  /**
   * Running UTF-8 byte length of `buffer`. It lives in the state object on purpose: the
   * reducer is handed to `Stream.scan` by reference, so a running total passed as a
   * function parameter would silently unbind and the buffer would be re-measured per append.
   */
  readonly bufferBytes: number;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export function selectRunningSubprocessTerminalIds(
  sessions: ReadonlyArray<KnownTerminalSession>,
): ReadonlyArray<string> {
  return sessions
    .filter((session) => session.state.hasRunningSubprocess)
    .map((session) => session.target.terminalId);
}

export const EMPTY_TERMINAL_BUFFER_STATE = Object.freeze<TerminalBufferState>({
  buffer: "",
  bufferBytes: 0,
  status: "closed",
  error: null,
  updatedAt: null,
  version: 0,
});

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  summary: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
});

export const DEFAULT_MAX_TERMINAL_BUFFER_BYTES = 512 * 1024;

/**
 * Appends are allowed to overshoot the cap by this fraction before the buffer is trimmed
 * back down *to* the cap. It bounds retained output at cap + slack (640 KiB by default,
 * which phones still render fine) while making a trim — and the full repaint it forces in
 * the xterm consumer — happen once per slack-worth of output instead of once per frame.
 */
export const TERMINAL_BUFFER_TRIM_SLACK_RATIO = 0.25;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface TrimmedTerminalBuffer {
  readonly buffer: string;
  readonly bufferBytes: number;
}

function terminalBufferTrimThreshold(maxBufferBytes: number): number {
  if (maxBufferBytes <= 0) {
    return 0;
  }
  return maxBufferBytes + Math.ceil(maxBufferBytes * TERMINAL_BUFFER_TRIM_SLACK_RATIO);
}

/**
 * UTF-8 byte length without allocating an encoded copy. Lone surrogates encode as U+FFFD
 * (three bytes), matching `TextEncoder`, so this stays in step with `trimBufferToBytes`.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function trimBufferToBytes(buffer: string, maxBufferBytes: number): TrimmedTerminalBuffer {
  if (maxBufferBytes <= 0) {
    return { buffer: "", bufferBytes: 0 };
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return { buffer, bufferBytes: encoded.byteLength };
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  const retained = encoded.subarray(start);
  return { buffer: textDecoder.decode(retained), bufferBytes: retained.byteLength };
}

export function terminalBufferStateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalBufferState {
  const trimmed = trimBufferToBytes(snapshot.history, maxBufferBytes);
  return {
    buffer: trimmed.buffer,
    bufferBytes: trimmed.bufferBytes,
    status: snapshot.status,
    error: null,
    updatedAt: snapshot.updatedAt,
    version: 1,
  };
}

function latestTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

export function combineTerminalSessionState(
  summary: TerminalSummary | null,
  buffer: TerminalBufferState,
): TerminalSessionState {
  return {
    summary,
    buffer: buffer.buffer,
    status: buffer.version > 0 ? buffer.status : (summary?.status ?? buffer.status),
    error: buffer.error,
    hasRunningSubprocess: summary?.hasRunningSubprocess ?? false,
    updatedAt: latestTimestamp(summary?.updatedAt ?? null, buffer.updatedAt),
    version: buffer.version,
  };
}

export function applyTerminalAttachStreamEvent(
  current: TerminalBufferState,
  event: TerminalAttachStreamEvent,
  maxBufferBytes = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
): TerminalBufferState {
  switch (event.type) {
    case "snapshot":
    case "restarted":
      return terminalBufferStateFromSnapshot(event.snapshot, maxBufferBytes);
    case "output": {
      const appended = `${current.buffer}${event.data}`;
      const appendedBytes = current.bufferBytes + utf8ByteLength(event.data);
      const status = current.status === "closed" ? "running" : current.status;
      // Below the slack threshold the append stays verbatim, so the consumer's
      // incremental-draw check (new buffer starts with the old one) keeps holding.
      const trimmed =
        appendedBytes <= terminalBufferTrimThreshold(maxBufferBytes)
          ? { buffer: appended, bufferBytes: appendedBytes }
          : trimBufferToBytes(appended, maxBufferBytes);
      return {
        ...current,
        buffer: trimmed.buffer,
        bufferBytes: trimmed.bufferBytes,
        status,
        error: null,
        version: current.version + 1,
      };
    }
    case "cleared":
      return {
        ...current,
        buffer: "",
        bufferBytes: 0,
        error: null,
        version: current.version + 1,
      };
    case "exited":
      return {
        ...current,
        status: "exited",
        error: null,
        version: current.version + 1,
      };
    case "closed":
      return {
        ...current,
        status: "closed",
        error: null,
        version: current.version + 1,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: event.message,
        version: current.version + 1,
      };
    case "activity":
      return current;
  }
}

export function applyTerminalMetadataStreamEvent(
  current: ReadonlyArray<TerminalSummary>,
  event: TerminalMetadataStreamEvent,
): ReadonlyArray<TerminalSummary> {
  if (event.type === "snapshot") {
    return event.terminals;
  }
  if (event.type === "remove") {
    return current.filter(
      (terminal) =>
        terminal.threadId !== event.threadId || terminal.terminalId !== event.terminalId,
    );
  }
  const next = current.filter(
    (terminal) =>
      terminal.threadId !== event.terminal.threadId ||
      terminal.terminalId !== event.terminal.terminalId,
  );
  return [...next, event.terminal];
}
