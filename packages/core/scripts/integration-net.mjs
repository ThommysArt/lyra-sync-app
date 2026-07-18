/**
 * Integration: spin up two peer servers, auth, ping, probe via store.
 */
import { createDeviceIdentity, createLyraStore } from "@lyra-sync-app/core";
import {
  authenticateWithPeer,
  createEnvelope,
  fetchPeerInfo,
  probePeer,
  sendEnvelope,
} from "@lyra-sync-app/net";
import { startPeerServer } from "@lyra-sync-app/net/node";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const a = await createDeviceIdentity({ name: "Peer A", platform: "linux", type: "desktop" });
const b = await createDeviceIdentity({ name: "Peer B", platform: "linux", type: "desktop" });
assert(a.ok && b.ok, "identities");

const serverA = await startPeerServer({ identity: a.identity, port: 0, host: "127.0.0.1" });
const serverB = await startPeerServer({ identity: b.identity, port: 0, host: "127.0.0.1" });

try {
  const info = await fetchPeerInfo({ host: "127.0.0.1", port: serverA.port });
  assert(info.ok && info.identity.id === a.identity.id, "info A");

  const auth = await authenticateWithPeer({
    endpoint: { host: "127.0.0.1", port: serverA.port },
    identity: b.identity,
    privateKey: b.privateKey,
  });
  assert(auth.ok, "auth " + (auth.ok ? "" : auth.error));

  const ping = createEnvelope({ type: "ping", fromDeviceId: b.identity.id, payload: {} });
  const pong = await sendEnvelope(
    { host: "127.0.0.1", port: serverA.port },
    ping,
    { sessionToken: auth.sessionToken },
  );
  assert(pong.ok && pong.envelope?.type === "pong", "pong");

  const probe = await probePeer({ host: "127.0.0.1", port: serverB.port });
  assert(probe.ok && probe.name === "Peer B", "probe B");

  const store = createLyraStore({ storage: null, seedDemo: false, platformHint: "web" });
  await store.hydrate();
  store.addManualPeer({ host: "127.0.0.1", port: serverB.port, name: "Live B" });
  const result = await store.probePeerAddress({ host: "127.0.0.1", port: serverB.port });
  assert(result.ok, "store probe");
  const device = store.getState().devices.find((d) => d.host === "127.0.0.1");
  assert(device?.online, "device online after probe");
  assert(typeof device?.lastProbeLatencyMs === "number", "latency");

  store.startFileTransfer([device.id], [{ name: "x.bin", size: 5000 }], { initialOffset: 1000 });
  const tx = store.getState().transfers[0];
  assert(tx.status === "paused" && tx.transferredBytes === 1000, "resume ready");
  store.resumeTransfer(tx.id);
  assert(store.getState().transfers[0].status === "transferring", "resumed");

  console.log("INTEGRATION PASS", {
    portA: serverA.port,
    portB: serverB.port,
    latencyMs: device.lastProbeLatencyMs,
    authTokenLen: auth.sessionToken.length,
  });
} finally {
  await serverA.close();
  await serverB.close();
}
