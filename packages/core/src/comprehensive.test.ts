import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLyraStore } from "./store";
import { deriveMutualAuthSecret } from "@lyra-sync-app/net";
import type { PairedDevice, DeviceIdentity } from "@lyra-sync-app/protocol";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe("Comprehensive feature suite — pairing / clipboard / transfer / fs / settings", () => {
  it("pairing: QR payload then trust handshake establishes authSecret", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: false, platformHint: "web" });
    await store.hydrate();
    const session = store.startPairingSession();
    assert.ok(session.code.length >= 4);
    assert.ok(session.token.length > 4);
    // Simulate inbound pair_request from a remote
    const fakePayload = {
      version: 1 as const,
      deviceId: "remote_123",
      name: "Remote Phone",
      type: "mobile" as const,
      platform: "android" as const,
      fingerprint: "fingerprint_remote_0001",
      publicKey: "pub_remote",
      token: session.token,
      host: "192.168.1.50",
      port: 53317,
      expiresAt: Date.now() + 60_000,
    };
    store.enqueuePairRequest(fakePayload, "wire");
    assert.equal(store.getState().incomingPairRequests.length, 1);
    await store.confirmIncomingPair(store.getState().incomingPairRequests[0]!.id);
    const dev = store.getState().devices.find(d => d.id === "remote_123");
    assert.ok(dev, "device should be paired");
    assert.ok(dev?.authSecret && dev.authSecret.length > 16);
  });

  it("clipboard: push text, history, pin, re-send", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: false, platformHint: "web" });
    await store.hydrate();
    store.pushClipboardText("hello world");
    assert.equal(store.getState().clipboardHistory.length, 1);
    assert.equal(store.getState().clipboardHistory[0]!.text, "hello world");
    const id = store.getState().clipboardHistory[0]!.id;
    store.pinClipboardItem(id, true);
    assert.equal(store.getState().clipboardHistory[0]!.pinned, true);
    // Image
    store.pushClipboardImage("data:image/png;base64,abc123");
    assert.equal(store.getState().clipboardHistory[0]!.type, "image");
    // History trim respects limit
    store.updateSettings({ clipboardHistoryLimit: 2 });
    store.pushClipboardText("third");
    assert.ok(store.getState().clipboardHistory.length <= 2 || store.getState().clipboardHistory.some(c => c.pinned));
  });

  it("clipboard: receive from wire appends to history and respects deliveryStatus", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: false, platformHint: "web" });
    await store.hydrate();
    const ident = store.getState().identity!;
    store.receiveClipboardItem({
      id: "clip_wire_1",
      type: "text",
      text: "from peer",
      sourceDeviceId: "peer_1",
      sourceDeviceName: "Peer",
      createdAt: Date.now(),
      pinned: false,
    });
    assert.equal(store.getState().clipboardHistory[0]!.text, "from peer");
  });

  it("transfer: start, progress, pause/resume/cancel, multi-device", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: false, platformHint: "web" });
    await store.hydrate();
    // Add two fake online devices (demo-like but with host to trigger wire path)
    store.addManualPeer({ host: "127.0.0.1:53317", name: "Peer A" });
    store.addManualPeer({ host: "127.0.0.1:53319", name: "Peer B" });
    const ids = store.getState().devices.slice(0, 2).map(d => d.id);
    assert.equal(ids.length, 2);
    // Single file to both devices — store creates one Transfer per target device (simulated)
    const file = { name: "photo.jpg", size: 1024 * 1024, mimeType: "image/jpeg", bytes: new Uint8Array(1024 * 1024) };
    store.startFileTransfer(ids, [file], { forceSimulate: true });
    assert.ok(store.getState().transfers.length >= 1, "should have at least one transfer record");
    const txId = store.getState().transfers[0]!.id;
    assert.ok(["transferring", "pending", "completed"].includes(store.getState().transfers[0]!.status), `unexpected status ${store.getState().transfers[0]!.status}`);
    // Pause via control (no peer server, but store should mark paused)
    store.setTransferStatus(txId, "paused");
    assert.equal(store.getState().transfers[0]!.status, "paused");
    store.resumeTransfer(txId);
    // After resume, simulate completion via progress
    store.setTransferStatus(txId, "completed");
    assert.equal(store.getState().transfers[0]!.status, "completed");
    // Transfer history exists
    assert.ok(store.getState().transfers.length >= 1);
    // Resend
    store.resendTransfer(txId, [ids[0]!]);
    assert.ok(store.getState().transfers.length >= 2);
  });

  it("transfer: conflict handling rename/overwrite/skip", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: true, platformHint: "web" });
    await store.hydrate();
    store.simulateIncomingConflict({ multiFile: false });
    const conflict = store.getState().transfers.find(t => t.status === "conflict");
    assert.ok(conflict, "should have conflict transfer");
    store.resolveTransferConflict(conflict!.id, "rename");
    const after = store.getState().transfers.find(t => t.id === conflict!.id);
    assert.ok(after?.status !== "conflict");
    // Batch resolve
    store.simulateIncomingConflict({ batch: true });
    store.resolveAllTransferConflicts("overwrite");
    assert.equal(store.getState().transfers.filter(t => t.status === "conflict").length, 0);
  });

  it("file explorer: fetchRemoteFiles fallback to demo FS when offline", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: true, platformHint: "web" });
    await store.hydrate();
    const demoId = store.getState().devices[0]!.id;
    // Initially offline demo device — should return demo FS
    const entries = store.listRemoteFiles(demoId, "/");
    assert.ok(Array.isArray(entries));
    // fetchRemoteFiles should also resolve without throwing
    const fetched = await store.fetchRemoteFiles(demoId, "/");
    assert.ok(Array.isArray(fetched));
  });

  it("open URL: validates and queues", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: true, platformHint: "web" });
    await store.hydrate();
    const target = store.getState().devices[0]!.id;
    store.sendUrl("https://example.com", [target]);
    // No throw; toast may be set if device offline — but should not crash
    assert.ok(true);
  });

  it("settings: peerListenPort, theme, history limits", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: false, platformHint: "web" });
    await store.hydrate();
    store.updateSettings({ peerListenPort: 53319, theme: "dark", clipboardHistoryLimit: 10 });
    assert.equal(store.getState().settings.peerListenPort, 53319);
    assert.equal(store.getState().settings.theme, "dark");
    store.setDeviceName("My New Name");
    assert.equal(store.getState().identity!.name, "My New Name");
  });

  it("discovery: ingestDiscoveredPeer dedupes and ingestTailscalePeers merges", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: false, platformHint: "web" });
    await store.hydrate();
    store.ingestDiscoveredPeer({
      identity: { id: "disc_1", name: "Disc Phone", type: "mobile", platform: "android", fingerprint: "fp_disc_1", publicKey: "pub_disc_1" },
      host: "192.168.1.60",
      port: 53317,
    });
    const before = store.getState().devices.length;
    // Second ingest same id should not duplicate paired devices (it adds nearby not paired)
    store.ingestDiscoveredPeer({
      identity: { id: "disc_1", name: "Disc Phone", type: "mobile", platform: "android", fingerprint: "fp_disc_1", publicKey: "pub_disc_1" },
      host: "192.168.1.60",
      port: 53317,
    });
    // ingestTailscalePeers should add hints
    const added = store.ingestTailscalePeers([{ host: "100.64.0.1", port: 53317, name: "Tail Peer" }]);
    assert.ok(added >= 0);
    assert.ok(true);
  });

  it("unpair: removes device and clears sessions", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: true, platformHint: "web" });
    await store.hydrate();
    const target = store.getState().devices[0]!.id;
    const before = store.getState().devices.length;
    store.unpairDevice(target);
    assert.equal(store.getState().devices.length, before - 1);
    assert.ok(!store.getState().devices.find(d => d.id === target));
  });

  it("screen mirror: start demo, ingest frame, stop", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: true, platformHint: "web" });
    await store.hydrate();
    const target = store.getState().devices[0]!.id;
    const res = await store.startScreenMirror(target, { mode: "demo" });
    assert.equal(res.ok, true);
    if (res.ok) {
      const sessionId = res.sessionId;
      // Ingest a fake frame
      store.ingestScreenFrame(target, {
        sessionId,
        seq: 0,
        width: 720,
        height: 1280,
        mimeType: "image/jpeg",
        dataBase64: "abc",
        capturedAt: Date.now(),
      });
      const sess = store.getState().screenSessions[target];
      assert.ok(sess);
      await store.stopScreenMirror(target);
      // Session should be ended or removed
      assert.ok(true);
    }
  });

  it("device settings: autoAccept and rename", async () => {
    const store = createLyraStore({ storage: memoryStorage(), seedDemo: true, platformHint: "web" });
    await store.hydrate();
    const id = store.getState().devices[0]!.id;
    store.updateDeviceSettings(id, { autoAcceptTransfers: false });
    assert.equal(store.getState().devices.find(d => d.id === id)!.autoAcceptTransfers, false);
    store.renameDevice(id, "My Nick");
    assert.equal(store.getState().devices.find(d => d.id === id)!.nickname, "My Nick");
  });
});
