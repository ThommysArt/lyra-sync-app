import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceIdentity } from "@lyra-sync-app/protocol";

import { authenticateWithPeer, fetchPeerInfo, sendEnvelope } from "../peer-client";
import { createEnvelope } from "../envelope";
import { startPeerServer } from "./peer-server";

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

describe("HTTP peer server", () => {
  it("serves /lyra/info and auth + ping", async () => {
    const peer = await startPeerServer({
      identity,
      port: 0, // ephemeral
      host: "127.0.0.1",
    });

    try {
      const info = await fetchPeerInfo({ host: "127.0.0.1", port: peer.port });
      assert.equal(info.ok, true);
      if (info.ok) {
        assert.equal(info.identity.id, "server_dev");
        assert.equal(info.protocolVersion, 1);
      }

      const auth = await authenticateWithPeer({
        endpoint: { host: "127.0.0.1", port: peer.port },
        identity: clientIdentity,
        privateKey: "unused_for_first_contact",
      });
      assert.equal(auth.ok, true);
      if (!auth.ok) return;

      const ping = createEnvelope({
        type: "ping",
        fromDeviceId: clientIdentity.id,
        payload: {},
      });
      const reply = await sendEnvelope(
        { host: "127.0.0.1", port: peer.port },
        ping,
        { sessionToken: auth.sessionToken },
      );
      assert.equal(reply.ok, true);
      if (reply.envelope) {
        assert.equal(reply.envelope.type, "pong");
      }
    } finally {
      await peer.close();
    }
  });
});
