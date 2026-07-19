/**
 * Integration: spin up two peer servers, auth, ping, probe via store,
 * real code-pairing (host accept long-poll), clipboard wire, multi-chunk transfer.
 */
import { createDeviceIdentity, createLyraStore, hashPairingCode } from "@lyra-sync-app/core";
import {
  authenticateWithPeer,
  createEnvelope,
  deriveMutualAuthSecret,
  fetchPeerInfo,
  probePeer,
  pushClipboardToPeer,
  sendEnvelope,
  sendFilesOverWire,
  textToBytes,
} from "@lyra-sync-app/net";
import { startPeerServer } from "@lyra-sync-app/net/node";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const a = await createDeviceIdentity({ name: "Peer A", platform: "linux", type: "desktop" });
const b = await createDeviceIdentity({ name: "Peer B", platform: "linux", type: "desktop" });
assert(a.ok && b.ok, "identities");

const pairingToken = "tok_integration_1";
const sharedSecret = await deriveMutualAuthSecret({
  pairingToken,
  localFingerprint: a.identity.fingerprint,
  remoteFingerprint: b.identity.fingerprint,
  localPublicKey: a.identity.publicKey,
  remotePublicKey: b.identity.publicKey,
});
// Mutual: B computes same secret
const sharedFromB = await deriveMutualAuthSecret({
  pairingToken,
  localFingerprint: b.identity.fingerprint,
  remoteFingerprint: a.identity.fingerprint,
  localPublicKey: b.identity.publicKey,
  remotePublicKey: a.identity.publicKey,
});
assert(sharedSecret === sharedFromB, "mutual auth secret");

const received = { clipboard: null, pair: null };
/** Live pairing offer advertised on /lyra/info */
const livePairCode = "ZZ9K2A";
const livePairToken = "tok_live_pair";
const livePairOffer = {
  codeHash: await hashPairingCode(livePairCode),
  token: livePairToken,
  expiresAt: Date.now() + 5 * 60 * 1000,
};

/** set after startPeerServer so onPairRequest can resolve long-poll */
let serverA = null;

serverA = await startPeerServer({
  identity: a.identity,
  port: 0,
  host: "127.0.0.1",
  getPairingOffer: () => livePairOffer,
  resolvePeerAuth: ({ fingerprint }) => {
    if (fingerprint === b.identity.fingerprint) {
      return {
        sharedSecret,
        expectedFingerprint: b.identity.fingerprint,
        expectedDeviceId: b.identity.id,
      };
    }
    return {};
  },
  handlers: {
    onClipboardPush: (item) => {
      received.clipboard = item;
    },
    onPairRequest: (payload) => {
      received.pair = payload;
      // Host user Accept (simulated) — unblocks joiner long-poll
      setTimeout(() => {
        serverA.resolvePairRequest(
          { deviceId: payload.deviceId, token: payload.token },
          { accepted: true, host: "127.0.0.1", port: serverA.port },
        );
      }, 30);
    },
  },
});
const serverB = await startPeerServer({ identity: b.identity, port: 0, host: "127.0.0.1" });

try {
  const info = await fetchPeerInfo({ host: "127.0.0.1", port: serverA.port });
  assert(info.ok && info.identity.id === a.identity.id, "info A");

  // First-contact still works for unpaired hello path
  const authFirst = await authenticateWithPeer({
    endpoint: { host: "127.0.0.1", port: serverA.port },
    identity: b.identity,
    privateKey: b.privateKey,
  });
  assert(authFirst.ok, "auth first " + (authFirst.ok ? "" : authFirst.error));

  // Paired shared-secret auth
  const auth = await authenticateWithPeer({
    endpoint: { host: "127.0.0.1", port: serverA.port },
    identity: b.identity,
    privateKey: b.privateKey,
    sharedSecret,
  });
  assert(auth.ok, "auth shared " + (auth.ok ? "" : auth.error));

  const ping = createEnvelope({ type: "ping", fromDeviceId: b.identity.id, payload: {} });
  const pong = await sendEnvelope(
    { host: "127.0.0.1", port: serverA.port },
    ping,
    { sessionToken: auth.sessionToken },
  );
  assert(pong.ok && pong.envelope?.type === "pong", "pong");

  // clipboard_push requires session — sealed with pairing secret (encryption default)
  const clip = await pushClipboardToPeer({
    endpoint: { host: "127.0.0.1", port: serverA.port },
    sessionToken: auth.sessionToken,
    fromDeviceId: b.identity.id,
    toDeviceId: a.identity.id,
    item: {
      id: "clip_1",
      type: "text",
      text: "hello wire",
      sourceDeviceId: b.identity.id,
      sourceDeviceName: b.identity.name,
      createdAt: Date.now(),
    },
    sealSecret: sharedSecret,
  });
  assert(clip.ok, "clipboard push sealed " + (clip.ok ? "" : clip.error));
  assert(received.clipboard?.text === "hello wire", "clipboard received");

  // ECDSA identity shape
  assert(a.identity.publicKey.startsWith("ecdsa-p256:") || a.privateKey.length === 64, "identity material");

  // multi-chunk transfer (sealed)
  const body = textToBytes("x".repeat(120_000));
  const wire = await sendFilesOverWire({
    endpoint: { host: "127.0.0.1", port: serverA.port },
    sessionToken: auth.sessionToken,
    fromDeviceId: b.identity.id,
    toDeviceId: a.identity.id,
    transferId: "tx_wire_1",
    files: [{ name: "big.txt", size: body.byteLength, bytes: body }],
    chunkSize: 16_384,
    sealSecret: sharedSecret,
  });
  assert(wire.ok, "wire transfer " + (wire.ok ? "" : wire.error));

  // auth required for non-public messages
  const noAuth = await sendEnvelope(
    { host: "127.0.0.1", port: serverA.port },
    createEnvelope({
      type: "clipboard_push",
      fromDeviceId: b.identity.id,
      payload: { id: "x", type: "text", text: "nope", sourceDeviceId: "x", sourceDeviceName: "x", createdAt: 1 },
    }),
  );
  assert(!noAuth.ok, "clipboard without auth should fail");

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

  store.startFileTransfer([device.id], [{ name: "x.bin", size: 5000 }], {
    initialOffset: 1000,
    forceSimulate: true,
  });
  const tx = store.getState().transfers[0];
  assert(tx.status === "paused" && tx.transferredBytes === 1000, "resume ready");
  store.resumeTransfer(tx.id);
  assert(store.getState().transfers[0].status === "transferring", "resumed");

  // Real code pairing: store finds A's offer, waits for host Accept, stores authSecret
  const infoOffer = await fetchPeerInfo({ host: "127.0.0.1", port: serverA.port });
  assert(infoOffer.ok && infoOffer.pairing?.token === livePairToken, "pairing offer advertised");

  // Joiner knows a candidate address (LAN discovery / manual); ephemeral test port ≠ default
  store.addManualPeer({ host: "127.0.0.1", port: serverA.port, name: "Host A" });
  const paired = await store.submitPairingCode(livePairCode);
  assert(paired.ok && "device" in paired, "code pair completed " + (paired.ok ? "" : paired.error));
  assert(store.getState().devices.some((d) => d.authSecret && d.id === a.identity.id), "authSecret for host A");
  assert(received.pair?.token === livePairToken, "host received pair_request");

  // unpair revoke sessions
  const n = serverA.revokeDevice(b.identity.id);
  assert(n >= 1, "revoke sessions");

  console.log("INTEGRATION PASS", {
    portA: serverA.port,
    portB: serverB.port,
    latencyMs: device.lastProbeLatencyMs,
    authTokenLen: auth.sessionToken.length,
    wireBytes: body.byteLength,
    ecdsa: a.identity.publicKey.startsWith("ecdsa-p256:"),
    revoked: n,
  });
} finally {
  await serverA.close();
  await serverB.close();
}
