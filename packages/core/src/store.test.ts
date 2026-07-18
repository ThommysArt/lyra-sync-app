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
});
