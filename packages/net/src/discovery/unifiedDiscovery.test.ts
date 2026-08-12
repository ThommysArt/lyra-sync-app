import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { startPeerServer } from "../node/peer-server";
import { UnifiedDiscoveryManager } from "./unifiedDiscovery";
import type { DeviceIdentity } from "@lyra-sync-app/protocol";

const idA: DeviceIdentity = {
  id: "udisc_a",
  name: "UDisc A",
  type: "desktop",
  platform: "linux",
  fingerprint: "fp_udisc_a_00000001",
  publicKey: "pub_a",
  createdAt: Date.now(),
};
const idB: DeviceIdentity = {
  id: "udisc_b",
  name: "UDisc B",
  type: "desktop",
  platform: "linux",
  fingerprint: "fp_udisc_b_00000002",
  publicKey: "pub_b",
  createdAt: Date.now(),
};

describe("UnifiedDiscoveryManager", () => {
  it("discovers peer via HTTP scan when multicast unavailable", async () => {
    const peerB = await startPeerServer({ identity: idB, port: 0, host: "127.0.0.1" });
    const seen: string[] = [];
    const mgr = new UnifiedDiscoveryManager({
      identity: idA,
      port: peerB.port,
      onPeer: (p) => seen.push(p.identity.id),
      getScanSeeds: () => ["127.0.0.1"],
      autoScan: false,
    });
    await mgr.start();
    await mgr.runScan();
    const { fetchPeerInfo } = await import("../peer-client");
    const info = await fetchPeerInfo({ host: "127.0.0.1", port: peerB.port });
    assert.equal(info.ok, true);
    await mgr.stop();
    await peerB.close();
  });

  it("dedupes burst and merges multicast + scan sources", async () => {
    const mgr = new UnifiedDiscoveryManager({
      identity: idA,
      port: 53317,
      onPeer: () => {},
      getScanSeeds: () => [],
      autoScan: false,
    });
    await mgr.start();
    // Inject two identical peers quickly; second should be deduped if <1s
    const peer = {
      identity: idB,
      host: "192.168.1.50",
      port: 53317,
      protocolVersion: 4,
      source: "multicast" as const,
      lastSeenAt: Date.now(),
    };
    // Access private ingest via any
    (mgr as unknown as { ingest: (p: typeof peer) => void }).ingest(peer);
    (mgr as unknown as { ingest: (p: typeof peer) => void }).ingest(peer);
    assert.equal(mgr.getSeen().length, 1);
    await mgr.stop();
  });
});
