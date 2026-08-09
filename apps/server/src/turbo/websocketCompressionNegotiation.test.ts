import * as NodeSocket from "@effect/platform-node/NodeSocket";
import { describe, expect, it } from "vite-plus/test";

/**
 * C6-check measurement guard (see `.plans/23a-c6-mobile-compression-measurement.md`).
 *
 * `permessage-deflate` is negotiated once, per connection, from the client's
 * offer — the server may only accept what was offered. A client that never
 * offers therefore gets uncompressed frames in BOTH directions, and no server
 * setting can override that.
 *
 * `apps/server/src/server.test.ts` already asserts the negotiated extension
 * string. This pins the consequence in bytes, because that is the number the
 * mobile client pays: React Native's WebSocket cannot offer the extension
 * (`apps/mobile/src/lib/runtime.ts:29` injects the platform global), so an
 * iOS phone transfers the full uncompressed payload each way.
 */

/** Mirrors the production Node setting at `apps/server/src/server.ts:218`. */
const SERVER_PER_MESSAGE_DEFLATE = true;

/** Repetitive JSON, standing in for a thread-event burst. */
const PAYLOAD = JSON.stringify(
  Array.from({ length: 200 }, (_, index) => ({
    _tag: "ThreadItemUpdated",
    itemId: `item_${index}`,
    version: index,
    text: "the quick brown fox jumps over the lazy dog ".repeat(3),
  })),
);

interface SocketWithTransport extends NodeSocket.NodeWS.WebSocket {
  readonly _socket?: { readonly bytesRead: number };
}

/** `_socket` is ws's internal transport handle. Reading it through `?? 0` would
    turn a rename in a future ws release into a silent 0, and every
    "compressed direction is smaller than the payload" assertion would pass
    vacuously. Fail loudly instead. */
function wireBytesRead(socket: SocketWithTransport): number {
  const bytesRead = socket._socket?.bytesRead;
  if (typeof bytesRead !== "number") {
    throw new Error(
      "ws no longer exposes `_socket.bytesRead`: this probe cannot measure wire bytes",
    );
  }
  return bytesRead;
}

interface InboundMeasurement {
  readonly wireBytes: number;
}

interface DirectionalTransfer {
  readonly negotiatedExtensions: string;
  readonly serverToClientWireBytes: number;
  readonly clientToServerWireBytes: number;
  readonly decodedBytes: number;
}

describe("websocket permessage-deflate negotiation", () => {
  it("leaves both directions uncompressed for a client that never offers the extension", async () => {
    const server = new NodeSocket.NodeWS.WebSocketServer({
      port: 0,
      perMessageDeflate: SERVER_PER_MESSAGE_DEFLATE,
    });

    let reportInbound: ((measurement: InboundMeasurement) => void) | null = null;
    server.on("connection", (socket, request) => {
      socket.on("message", () => {
        reportInbound?.({ wireBytes: request.socket.bytesRead });
      });
      socket.send(PAYLOAD);
    });
    await new Promise<void>((resolve) => server.on("listening", () => resolve()));

    const address = server.address();
    const port = typeof address === "string" || address === null ? 0 : address.port;
    expect(port).toBeGreaterThan(0);

    const measure = async (offersDeflate: boolean): Promise<DirectionalTransfer> => {
      const client = new NodeSocket.NodeWS.WebSocket(`ws://127.0.0.1:${port}`, {
        perMessageDeflate: offersDeflate,
      }) as SocketWithTransport;

      // Both directions reject on socket error or an early close: without
      // that, a failure here parks the promise forever and the run hangs for
      // the full test timeout with the socket still open.
      const failOnSocketTrouble = (reject: (error: Error) => void) => {
        client.on("error", reject);
        client.on("close", () => reject(new Error("socket closed before the measurement landed")));
      };

      // Direction 1: server -> client (the phone receiving a thread burst).
      const decodedBytes = await new Promise<number>((resolve, reject) => {
        failOnSocketTrouble(reject);
        client.on("message", (data: Buffer) => resolve(data.byteLength));
      });
      const serverToClientWireBytes = wireBytesRead(client);

      // Direction 2: client -> server (the phone sending a command).
      const inbound = await new Promise<InboundMeasurement>((resolve, reject) => {
        failOnSocketTrouble(reject);
        reportInbound = resolve;
        client.send(PAYLOAD);
      });
      reportInbound = null;
      client.close();

      return {
        negotiatedExtensions: client.extensions,
        serverToClientWireBytes,
        clientToServerWireBytes: inbound.wireBytes,
        decodedBytes,
      };
    };

    try {
      const offering = await measure(true);
      const silent = await measure(false);

      // A client that offers gets compression on both halves of the connection.
      expect(offering.negotiatedExtensions).toContain("permessage-deflate");
      expect(offering.serverToClientWireBytes).toBeLessThan(offering.decodedBytes / 4);
      expect(offering.clientToServerWireBytes).toBeLessThan(offering.decodedBytes / 4);

      // A client that never offers — the React Native case — gets neither.
      expect(silent.negotiatedExtensions).toBe("");
      expect(silent.serverToClientWireBytes).toBeGreaterThanOrEqual(silent.decodedBytes);
      expect(silent.clientToServerWireBytes).toBeGreaterThanOrEqual(silent.decodedBytes);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
