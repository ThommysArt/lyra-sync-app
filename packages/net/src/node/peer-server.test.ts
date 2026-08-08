import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceIdentity } from "@lyra-sync-app/protocol";

import { createEnvelope } from "../envelope";
import { startPeerServer } from "./peer-server";
import { createConnectionManager } from "../tcp/manager";
import { createNodeTcpSocket } from "../tcp/nodeSocket";

const identity: DeviceIdentity = {
  id: "server_dev",
  name: "Test Server",
  type: "desktop",
  platform: "linux",
  fingerprint: "serverfingerprint0001",
  publicKey: "pub_server",
  createdAt: Date.now(),
};

const clientIdentity: DeviceIdentity = {
  id: "client_dev",
  name: "Test Client",
  type: "desktop",
  platform: "web",
  fingerprint: "clientfingerprint0001",
  publicKey: "pub_client",
  createdAt: Date.now(),
};

describe("TCP peer server", () => {
  it("performs TCP handshake and ping/pong", async () => {
    const peer = await startPeerServer({
      identity,
      port: 0, // ephemeral
      host: "127.0.0.1",
    });

    try {
      // Create a TCP client manager and connect via persistent TCP
      const mgr = createConnectionManager({
        getIdentity: () => clientIdentity,
        getPrivateKey: () => "unused_for_first_contact",
        getSharedSecret: () => undefined,
        resolvePeerAuth: () => ({}), // allow first contact
        createSocket: createNodeTcpSocket,
      });

      // Upsert server as a peer we want to connect to (use server's identity as deviceId)
      // For test, we know server's deviceId is "server_dev"
      mgr.upsertPeer({ id: identity.id, host: "127.0.0.1", port: peer.port, fingerprint: identity.fingerprint });

      // Wait for connection to authenticate (heartbeat)
      const conn = await mgr.ensureConnected(identity.id);
      assert.equal(conn.state, "authenticated");

      // Send ping envelope and expect pong via request-response
      const ping = createEnvelope({
        type: "ping",
        fromDeviceId: clientIdentity.id,
        toDeviceId: identity.id,
        payload: {},
      });
      // Use requestEnvelope to get reply
      const reply = await (mgr as unknown as { requestEnvelope: (id: string, env: unknown, opts?: unknown) => Promise<import("@lyra-sync-app/protocol").Envelope> }).requestEnvelope(identity.id, ping, { expectType: "pong", timeoutMs: 3000 });
      assert.equal(reply.type, "pong");

      mgr.closeAll();
    } finally {
      await peer.close();
    }
  });
});
