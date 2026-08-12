import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  engineChunkSize,
  engineWindowSize,
  willMeetThroughputSLA,
  ThroughputTracker,
  MIN_GUARANTEED_SPEED_BPS,
} from "./transferEngine";
import { adaptiveWindowSize } from "../transfer-wire";
import { deriveMutualAuthSecret } from "../auth";
import { startPeerServer } from "../node/peer-server";
import { sendFilesOverWire } from "../transfer-wire";
import { getOrCreatePeerSession } from "../peer-client";
import { createHash, randomBytes } from "node:crypto";

function randomBytesOfSize(size: number): Uint8Array {
  const out = new Uint8Array(size);
  if (size) out.set(randomBytes(size));
  return out;
}

describe("Transfer Engine v2 — 3 MB/s SLA", () => {
  it("mobile chunk/window meets 3 MB/s SLA at 30ms RTT", () => {
    const chunk = engineChunkSize(25 * 1024 * 1024, true);
    const win = engineWindowSize(25 * 1024 * 1024, true);
    assert.equal(chunk, 512 * 1024);
    assert.equal(win, 4);
    const { meets, estimatedBps } = willMeetThroughputSLA({ chunkSize: chunk, windowSize: win, estimatedRttMs: 30 });
    assert.equal(meets, true, `estimated ${estimatedBps} bps should meet SLA`);
    assert.ok(estimatedBps >= MIN_GUARANTEED_SPEED_BPS);
  });

  it("desktop chunk/window meets SLA", () => {
    const chunk = engineChunkSize(100 * 1024 * 1024, false);
    const win = engineWindowSize(100 * 1024 * 1024, false);
    const { meets } = willMeetThroughputSLA({ chunkSize: chunk, windowSize: win, estimatedRttMs: 20 });
    assert.equal(meets, true);
  });

  it("adaptiveWindowSize v2 returns 4 for React Native (not 3)", () => {
    const g = globalThis as unknown as { expo?: unknown };
    const prev = g.expo;
    (globalThis as unknown as { expo: unknown }).expo = {};
    try {
      const w = adaptiveWindowSize({ totalBytes: 25 * 1024 * 1024 });
      assert.equal(w, 4, "v2 should return 4 for mobile, not 3");
    } finally {
      if (prev === undefined) delete (globalThis as unknown as { expo?: unknown }).expo;
      else (globalThis as unknown as { expo: unknown }).expo = prev;
    }
  });

  it("ThroughputTracker computes speed and ETA", async () => {
    const tracker = new ThroughputTracker();
    tracker.mark(1024 * 1024);
    await new Promise((r) => setTimeout(r, 20));
    tracker.mark(1024 * 1024);
    const speed = tracker.getSpeedBps();
    assert.ok(speed > 0);
    const eta = tracker.getEtaSeconds(5 * 1024 * 1024);
    assert.ok(eta >= 0);
  });

  it("actual loopback transfer exceeds 3 MB/s", async () => {
    const idA = { id: "eng_a", name: "A", type: "desktop" as const, platform: "linux" as const, fingerprint: "fp_eng_a", publicKey: "pub_eng_a", createdAt: Date.now() };
    const idB = { id: "eng_b", name: "B", type: "desktop" as const, platform: "linux" as const, fingerprint: "fp_eng_b", publicKey: "pub_eng_b", createdAt: Date.now() };
    const secret = await deriveMutualAuthSecret({
      pairingToken: "eng_tok",
      localFingerprint: idA.fingerprint,
      remoteFingerprint: idB.fingerprint,
      localPublicKey: idA.publicKey,
      remotePublicKey: idB.publicKey,
    });
    const received = new Map<string, number>();
    const peerB = await startPeerServer({
      identity: idB,
      port: 0,
      host: "127.0.0.1",
      allowFirstContactAuth: true,
      resolvePeerAuth: ({ deviceId }) => deviceId === idA.id ? { sharedSecret: secret, expectedFingerprint: idA.fingerprint, expectedDeviceId: idA.id } : {},
      handlers: { onTransferComplete: (state) => { received.set(state.transferId, state.receivedBytes); } },
    });
    const peerA = await startPeerServer({
      identity: idA,
      port: 0,
      host: "127.0.0.1",
      allowFirstContactAuth: true,
      resolvePeerAuth: ({ deviceId }) => deviceId === idB.id ? { sharedSecret: secret, expectedFingerprint: idB.fingerprint, expectedDeviceId: idB.id } : {},
    });
    const endpoint = { host: "127.0.0.1", port: peerB.port, protocol: "http" as const };
    const sess = await getOrCreatePeerSession({ endpoint, identity: idA, privateKey: "unused", sharedSecret: secret, peerDeviceId: idB.id });
    assert.equal(sess.ok, true);
    if (!sess.ok) { await peerA.close(); await peerB.close(); return; }

    const size = 5 * 1024 * 1024;
    const bytes = randomBytesOfSize(size);
    const tid = `eng_${Date.now()}`;
    const start = Date.now();
    const res = await sendFilesOverWire({
      endpoint,
      sessionToken: sess.sessionToken,
      fromDeviceId: idA.id,
      toDeviceId: idB.id,
      transferId: tid,
      files: [{ name: "bench.bin", size, bytes, checksum: createHash("sha256").update(bytes).digest("hex") } as unknown as { name: string; size: number; bytes: Uint8Array; checksum: string }],
      sealSecret: secret,
    });
    const elapsed = (Date.now() - start) / 1000;
    const bps = size / Math.max(0.001, elapsed);
    assert.equal(res.ok, true, res.ok ? "" : (res as { error: string }).error);
    assert.ok(bps >= MIN_GUARANTEED_SPEED_BPS, `bps ${bps} should be >= ${MIN_GUARANTEED_SPEED_BPS} (3 MB/s)`);
    assert.equal(received.get(tid), size);
    await peerA.close();
    await peerB.close();
  });
});
