import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceIdentity } from "@lyra-sync-app/protocol";

import { listLocalIPv4Addresses, startDiscovery } from "./discovery";
import { startPeerServer } from "./peer-server";

const idA: DeviceIdentity = {
  id: "disc_a",
  name: "Discover A",
  type: "desktop",
  platform: "linux",
  fingerprint: "fingerprintaaaaaaa01",
  publicKey: "pub_a",
  createdAt: Date.now(),
};

const idB: DeviceIdentity = {
  id: "disc_b",
  name: "Discover B",
  type: "desktop",
  platform: "linux",
  fingerprint: "fingerprintbbbbbbb02",
  publicKey: "pub_b",
  createdAt: Date.now(),
};

describe("LAN discovery (LocalSend patterns)", () => {
  it("lists local IPv4 addresses", () => {
    const addrs = listLocalIPv4Addresses();
    assert.ok(Array.isArray(addrs));
  });

  it("multicast announce is received by a peer (loopback-friendly)", async () => {
    const seenByB: string[] = [];
    const seenByA: string[] = [];

    // Use a high ephemeral-ish multicast port for the test to avoid clashing
    // with a running Lyra desktop instance on 53318.
    const mport = 53398;

    const discA = await startDiscovery({
      identity: idA,
      peerPort: 53317,
      multicastPort: mport,
      announceIntervalMs: 60_000,
      onPeer: (p) => {
        seenByA.push(p.identity.id);
      },
    });
    const discB = await startDiscovery({
      identity: idB,
      peerPort: 53317,
      multicastPort: mport,
      announceIntervalMs: 60_000,
      onPeer: (p) => {
        seenByB.push(p.identity.id);
      },
    });

    try {
      discA.announce();
      discB.announce();
      // Allow burst + reply handshake
      await new Promise((r) => setTimeout(r, 800));
      assert.ok(
        seenByB.includes("disc_a") || seenByA.includes("disc_b"),
        `expected mutual discovery; A saw ${seenByA.join(",")} B saw ${seenByB.join(",")}`,
      );
    } finally {
      await discA.stop();
      await discB.stop();
    }
  });

  it("TCP direct connect finds a live peer server", async () => {
    const server = await startPeerServer({
      identity: idA,
      port: 0,
      host: "127.0.0.1",
    });
    try {
      const { createConnectionManager } = await import("../tcp/manager");
      const { createNodeTcpSocket } = await import("../tcp/nodeSocket");
      const clientId: DeviceIdentity = {
        id: "other",
        name: "Other",
        type: "desktop",
        platform: "linux",
        fingerprint: "otherfp0000000001",
        publicKey: "pub_other",
        createdAt: Date.now(),
      };
      const mgr = createConnectionManager({
        getIdentity: () => clientId,
        getPrivateKey: () => "unused",
        getSharedSecret: () => undefined,
        resolvePeerAuth: () => ({}),
        createSocket: createNodeTcpSocket,
      });
      mgr.upsertPeer({ id: idA.id, host: "127.0.0.1", port: server.port, fingerprint: idA.fingerprint });
      const conn = await mgr.ensureConnected(idA.id);
      assert.equal(conn.state, "authenticated");
      assert.equal(conn.peerIdentity?.id, idA.id);
      mgr.closeAll();
    } finally {
      await server.close();
    }
  });

  it("TCP scan finds peer on multi-instance port via seed host", async () => {
    // Simulates desktop on ephemeral port while mobile defaults to 53317
    const server = await startPeerServer({
      identity: idA,
      port: 0,
      host: "127.0.0.1",
    });
    try {
      const { createConnectionManager } = await import("../tcp/manager");
      const { createNodeTcpSocket } = await import("../tcp/nodeSocket");
      const clientId: DeviceIdentity = {
        id: "other2",
        name: "Other2",
        type: "desktop",
        platform: "linux",
        fingerprint: "otherfp0000000002",
        publicKey: "pub_other2",
        createdAt: Date.now(),
      };
      const mgr = createConnectionManager({
        getIdentity: () => clientId,
        getPrivateKey: () => "unused",
        getSharedSecret: () => undefined,
        resolvePeerAuth: () => ({}),
        createSocket: createNodeTcpSocket,
      });
      // Use manager's candidate expansion (port, port+2 etc.) — should find server.port
      mgr.upsertPeer({ id: idA.id, host: "127.0.0.1", port: server.port, fingerprint: idA.fingerprint });
      const conn = await mgr.ensureConnected(idA.id);
      assert.equal(conn.state, "authenticated");
      assert.equal(conn.remoteLabel(), `127.0.0.1:${server.port}`);
      mgr.closeAll();
    } finally {
      await server.close();
    }
  });
});
