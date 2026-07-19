import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLyraStore } from "./store";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}

describe("createLyraStore", () => {
  it("hydrates identity and demo devices", async () => {
    const store = createLyraStore({
      storage: memoryStorage(),
      seedDemo: true,
      platformHint: "web",
    });
    await store.hydrate();
    const s = store.getState();
    assert.equal(s.ready, true);
    assert.ok(s.identity);
    assert.ok(s.privateKey);
    assert.ok(s.devices.length >= 1);
    assert.equal(s.peerServer.running, false);
  });

  it("supports resume offset on new transfers", async () => {
    const store = createLyraStore({
      storage: memoryStorage(),
      seedDemo: true,
      platformHint: "web",
    });
    await store.hydrate();
    const peer = store.getState().devices.find((d) => d.online) ?? store.getState().devices[0]!;
    store.startFileTransfer(
      [peer.id],
      [{ name: "big.bin", size: 1000 }],
      { initialOffset: 400 },
    );
    const tx = store.getState().transfers[0]!;
    assert.equal(tx.status, "paused");
    assert.equal(tx.transferredBytes, 400);
    assert.equal(tx.resumeOffset, 400);

    store.resumeTransfer(tx.id);
    assert.equal(store.getState().transfers[0]!.status, "transferring");
  });

  it("adds manual peers and records probe summary on failure", async () => {
    const store = createLyraStore({
      storage: memoryStorage(),
      seedDemo: false,
      platformHint: "web",
    });
    await store.hydrate();
    const added = store.addManualPeer({ host: "127.0.0.1", port: 1, name: "Nobody" });
    assert.equal(added.ok, true);
    const result = await store.probePeerAddress({ host: "127.0.0.1", port: 1 });
    assert.equal(result.ok, false);
    assert.ok(store.getState().lastProbeSummary);
  });

  it("respects discovery disabled", async () => {
    const store = createLyraStore({
      storage: memoryStorage(),
      seedDemo: true,
      platformHint: "web",
    });
    await store.hydrate();
    store.updateSettings({ discoveryEnabled: false });
    await store.refreshDiscovery();
    // should toast rather than crash — devices unchanged path
    assert.equal(store.getState().settings.discoveryEnabled, false);
  });

  it("dual-confirm pairing derives authSecret", async () => {
    const store = createLyraStore({
      storage: memoryStorage(),
      seedDemo: false,
      platformHint: "web",
    });
    await store.hydrate();
    const submit = await store.submitPairingCode("AB12CD");
    assert.equal(submit.ok, true);
    if (!submit.ok || !("pending" in submit)) throw new Error("expected pending");
    assert.equal(submit.pending, true);
    assert.equal(store.getState().devices.length, 0);
    assert.equal(store.getState().incomingPairRequests.length, 1);
    await store.confirmIncomingPair(submit.requestId);
    const devices = store.getState().devices;
    assert.equal(devices.length, 1);
    assert.ok(devices[0]!.authSecret && devices[0]!.authSecret.length >= 16);
    assert.equal(store.getState().incomingPairRequests.length, 0);
  });

  it("does not re-queue pair request for already trusted device", async () => {
    const store = createLyraStore({
      storage: memoryStorage(),
      seedDemo: false,
      platformHint: "web",
    });
    await store.hydrate();
    const submit = await store.submitPairingCode("ZZ99YY");
    if (!submit.ok || !("pending" in submit)) throw new Error("expected pending");
    await store.confirmIncomingPair(submit.requestId);
    const device = store.getState().devices[0]!;
    store.enqueuePairRequest({
      version: 1,
      deviceId: device.id,
      name: device.name,
      type: device.type,
      platform: device.platform,
      fingerprint: device.fingerprint,
      publicKey: device.publicKey,
      token: "tok_again",
      host: "192.168.1.50",
      port: 53317,
      expiresAt: Date.now() + 60_000,
    });
    assert.equal(store.getState().incomingPairRequests.length, 0);
    assert.equal(store.getState().devices[0]!.host, "192.168.1.50");
  });

  it("manual peers are nearby not trusted", async () => {
    const store = createLyraStore({
      storage: memoryStorage(),
      seedDemo: false,
      platformHint: "web",
    });
    await store.hydrate();
    const res = store.addManualPeer({ host: "10.0.0.9", name: "Lab" });
    assert.equal(res.ok, true);
    if (!res.ok) throw new Error("expected ok");
    assert.equal(res.device.showInMainList, false);
    assert.equal(res.device.authSecret, undefined);
  });

  it("stores clipboard images in history", async () => {
    const store = createLyraStore({
      storage: memoryStorage(),
      seedDemo: false,
      platformHint: "web",
    });
    await store.hydrate();
    store.pushClipboardImage("data:image/png;base64,aaa", []);
    const item = store.getState().clipboardHistory[0]!;
    assert.equal(item.type, "image");
    assert.ok(item.imageData?.startsWith("data:image"));
  });
});
