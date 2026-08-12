import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deriveMutualAuthSecret } from "../auth";
import { startPeerServer } from "../node/peer-server";
import { LyraConnectionManager } from "./connectionManager";
import type { PairedDevice } from "@lyra-sync-app/protocol";

function makePairedDevice(over: Partial<PairedDevice> & { id: string; host?: string; port?: number }): PairedDevice {
  return {
    name: "Peer",
    type: "desktop",
    platform: "linux",
    fingerprint: "fp_test_12345678",
    publicKey: "pub_test",
    pairedAt: Date.now(),
    lastSeenAt: Date.now(),
    online: false,
    connectionType: "local",
    autoAcceptTransfers: true,
    autoAcceptClipboard: true,
    showInMainList: true,
    ...over,
  } as PairedDevice;
}

describe("LyraConnectionManager — unified keep-alive + sticky endpoint", () => {
  it("establishes session via sticky endpoint and caches token", async () => {
    const identityA = {
      id: "conn_a",
      name: "A",
      type: "desktop" as const,
      platform: "linux" as const,
      fingerprint: "fp_conn_a_00000001",
      publicKey: "pub_a",
      createdAt: Date.now(),
    };
    const identityB = {
      id: "conn_b",
      name: "B",
      type: "desktop" as const,
      platform: "linux" as const,
      fingerprint: "fp_conn_b_00000002",
      publicKey: "pub_b",
      createdAt: Date.now(),
    };
    const secret = await deriveMutualAuthSecret({
      pairingToken: "tok_conn_test",
      localFingerprint: identityA.fingerprint,
      remoteFingerprint: identityB.fingerprint,
      localPublicKey: identityA.publicKey,
      remotePublicKey: identityB.publicKey,
    });

    const peerB = await startPeerServer({
      identity: identityB,
      port: 0,
      host: "127.0.0.1",
      allowFirstContactAuth: true,
      resolvePeerAuth: ({ deviceId }) => {
        if (deviceId === identityA.id) return { sharedSecret: secret, expectedFingerprint: identityA.fingerprint, expectedDeviceId: identityA.id };
        return {};
      },
    });

    const device: PairedDevice = makePairedDevice({
      id: identityB.id,
      host: "127.0.0.1",
      port: peerB.port,
      fingerprint: identityB.fingerprint,
      publicKey: identityB.publicKey,
      online: false,
    });
    (device as unknown as { authSecret: string }).authSecret = secret;

    const mgr = new LyraConnectionManager({
      identity: identityA,
      privateKey: "unused_with_secret",
      resolveAuthSecret: (id) => (id === identityB.id ? secret : undefined),
      healthCheckIntervalMs: 60_000,
    });
    mgr.track(device);

    const res = await mgr.ensureConnection(device);
    assert.equal(res.ok, true, `ensureConnection failed: ${!res.ok ? res.error : ""}`);
    if (res.ok) {
      assert.ok(res.sessionToken.length > 8);
      assert.equal(res.endpoint.host, "127.0.0.1");
      assert.equal(res.endpoint.port, peerB.port);
    }

    const st = mgr.getState(identityB.id);
    assert.ok(st?.online);
    assert.ok(st?.endpoint);

    mgr.close();
    await peerB.close();
  });

  it("circuit-breaker backs off after consecutive failures", async () => {
    const identity = {
      id: "conn_x",
      name: "X",
      type: "desktop" as const,
      platform: "linux" as const,
      fingerprint: "fp_x",
      publicKey: "pub_x",
      createdAt: Date.now(),
    };
    const device = makePairedDevice({
      id: "dead_peer",
      host: "127.0.0.1", // loopback unused port — fails fast with ECONNREFUSED, not 30s timeout
      port: 59999,
      fingerprint: "fp_dead",
      publicKey: "pub_dead",
    });

    const mgr = new LyraConnectionManager({
      identity,
      privateKey: "unused",
      resolveAuthSecret: () => undefined,
      healthCheckIntervalMs: 60_000,
      probeTimeoutMs: 200,
    });
    mgr.track(device);
    const res = await mgr.ensureConnection(device);
    // Should fail but not throw, and should mark backoff
    assert.equal(res.ok, false);
    const st = mgr.getState(device.id);
    assert.ok(st && st.consecutiveFailures >= 1);
    assert.ok(st && st.backoffUntil > Date.now());
    mgr.close();
  });

  it("fast-path reuses cached endpoint on second ensureConnection", async () => {
    const idA = { id: "fast_a", name: "A", type: "desktop" as const, platform: "linux" as const, fingerprint: "fp_fast_a", publicKey: "pub_fast_a", createdAt: Date.now() };
    const idB = { id: "fast_b", name: "B", type: "desktop" as const, platform: "linux" as const, fingerprint: "fp_fast_b", publicKey: "pub_fast_b", createdAt: Date.now() };
    const secret = await deriveMutualAuthSecret({
      pairingToken: "tok_fast",
      localFingerprint: idA.fingerprint,
      remoteFingerprint: idB.fingerprint,
      localPublicKey: idA.publicKey,
      remotePublicKey: idB.publicKey,
    });
    const peerB = await startPeerServer({
      identity: idB,
      port: 0,
      host: "127.0.0.1",
      allowFirstContactAuth: true,
      resolvePeerAuth: ({ deviceId }) => deviceId === idA.id ? { sharedSecret: secret, expectedFingerprint: idA.fingerprint, expectedDeviceId: idA.id } : {},
    });
    const device = makePairedDevice({ id: idB.id, host: "127.0.0.1", port: peerB.port, fingerprint: idB.fingerprint, publicKey: idB.publicKey });
    (device as unknown as { authSecret: string }).authSecret = secret;
    const mgr = new LyraConnectionManager({
      identity: idA,
      privateKey: "unused",
      resolveAuthSecret: (id) => id === idB.id ? secret : undefined,
      healthCheckIntervalMs: 60_000,
    });
    mgr.track(device);
    const r1 = await mgr.ensureConnection(device);
    assert.equal(r1.ok, true);
    const t0 = Date.now();
    const r2 = await mgr.ensureConnection(device);
    const dt = Date.now() - t0;
    assert.equal(r2.ok, true);
    // Second should be fast (<800ms) due to sticky reuse
    assert.ok(dt < 800, `second ensureConnection too slow: ${dt}ms`);
    mgr.close();
    await peerB.close();
  });
});
