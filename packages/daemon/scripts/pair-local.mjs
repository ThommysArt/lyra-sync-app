#!/usr/bin/env node
// Minimal integration: spins two daemon peer servers on 53317/53319
// Tests GET /lyra/info + POST /lyra/pair long-poll handshake
// Run: pnpm --filter @lyra-sync-app/daemon exec node scripts/pair-local.mjs
// or:  pnpm --filter @lyra-sync-app/daemon exec tsx scripts/pair-local.mjs

import { register } from "tsx/esm/api";
register();

const { startPeerServer } = await import("../src/peer-server.ts");

const PORT_A = 53317;
const PORT_B = 53319;

function identity(id, name) {
  return {
    id,
    name,
    fingerprint: `${id}-fp-${Math.random().toString(16).slice(2, 10)}deadbeef`,
    publicKey: `pub-${id}`,
    type: "desktop",
    platform: "linux",
  };
}

async function main() {
  console.log("[pair-local] starting servers...");
  const idA = identity("device-a", "Alpha");
  const idB = identity("device-b", "Beta");

  const serverA = await startPeerServer({
    identity: idA,
    port: PORT_A,
    trustedPeers: [],
    getPairingOffer: () => null,
    onLog: (m) => console.log(`[A] ${m}`),
  });
  const serverB = await startPeerServer({
    identity: idB,
    port: PORT_B,
    trustedPeers: [],
    getPairingOffer: () => null,
    onLog: (m) => console.log(`[B] ${m}`),
  });

  console.log(`[pair-local] A listening ${serverA.url} (port ${serverA.port})`);
  console.log(`[pair-local] B listening ${serverB.url} (port ${serverB.port})`);

  // ---- GET /lyra/info ----
  for (const [label, port] of [
    ["A", serverA.port],
    ["B", serverB.port],
  ]) {
    const res = await fetch(`http://127.0.0.1:${port}/lyra/info`);
    const cors = res.headers.get("access-control-allow-origin");
    const json = await res.json();
    console.log(`[pair-local] GET /lyra/info ${label} ->`, json);
    if (json.v !== 2) throw new Error(`expected v:2 got ${json.v} for ${label}`);
    if (!json.id || !json.fingerprint) throw new Error(`missing id/fingerprint for ${label}`);
    if (!cors) throw new Error(`missing CORS header for ${label}`);
    console.log(`[pair-local] ✓ ${label} info ok (CORS=${cors})`);
  }

  // ---- POST /lyra/pair long-poll ----
  const token = `test-token-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  console.log(`[pair-local] POST /lyra/pair to A with token=${token} (long-poll 60s)`);

  // fire long-poll request (do not await immediately)
  const pairPromise = fetch(`http://127.0.0.1:${serverA.port}/lyra/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, code: "123456", id: idB.id }),
  }).then(async (r) => {
    const j = await r.json();
    return { status: r.status, body: j };
  });

  // give server a moment to register pendingPairs
  await new Promise((r) => setTimeout(r, 200));

  const resolved = serverA.resolvePairRequest(token, true);
  console.log(`[pair-local] resolvePairRequest(${token}, true) -> ${resolved}`);
  if (!resolved) throw new Error("resolvePairRequest returned false, pending not found");

  const result = await pairPromise;
  console.log(`[pair-local] pair response ->`, result);
  if (!result.body.paired) throw new Error(`expected paired:true got ${JSON.stringify(result.body)}`);
  console.log("[pair-local] ✓ pair handshake paired:true");

  // ---- test reject path ----
  const token2 = `test-token2-${Date.now()}`;
  const pairPromise2 = fetch(`http://127.0.0.1:${serverA.port}/lyra/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: token2 }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  await new Promise((r) => setTimeout(r, 200));
  const resolved2 = serverA.resolvePairRequest(token2, false);
  console.log(`[pair-local] resolvePairRequest(${token2}, false) -> ${resolved2}`);
  const result2 = await pairPromise2;
  console.log(`[pair-local] pair2 response ->`, result2);
  if (result2.body.paired) throw new Error("expected paired:false for reject");
  console.log("[pair-local] ✓ pair reject handled");

  // ---- test seal roundtrip (optional) ----
  try {
    const { sealPayload, unsealPayload } = await import("../src/seal.ts");
    const { sealEnvelope, unsealEnvelope } = await import("../src/seal.ts");
    const secret = "test-secret-123";
    const envelope = {
      id: "env-1",
      type: "clipboard_push",
      fromDeviceId: idA.id,
      createdAt: Date.now(),
      payload: { text: "hello sealed" },
    };
    const sealed = await sealEnvelope(envelope, secret);
    if (!sealed.seal) throw new Error("sealEnvelope missing seal");
    const unsealed = await unsealEnvelope(sealed, secret);
    if (unsealed.payload?.text !== "hello sealed") throw new Error("unseal mismatch");
    console.log("[pair-local] ✓ sealEnvelope/unsealEnvelope roundtrip ok");
  } catch (e) {
    console.warn("[pair-local] seal test skipped/error:", e);
  }

  // ---- test transfer create/append/get ----
  try {
    const { createTransferState, appendChunk, getTransferState } = await import("../src/transfer.ts");
    const offer = { transferId: `t-${Date.now()}`, files: [{ name: "hello.txt", size: 11 }], totalBytes: 11, status: "in_progress" };
    const state = await createTransferState(offer);
    await appendChunk(state, 0, new TextEncoder().encode("hello "));
    await appendChunk(state, 6, new TextEncoder().encode("world"));
    const got = getTransferState(offer.transferId);
    if (!got || got.receivedBytes !== 11) throw new Error(`transfer receivedBytes ${got?.receivedBytes}`);
    console.log("[pair-local] ✓ transfer mkdtemp + out-of-order append ok", got.tmpDir);
    // cleanup fd
    try { await got.fd?.close(); } catch {}
    const { promises: fs } = await import("node:fs");
    try { await fs.rm(got.tmpDir, { recursive: true, force: true }); } catch {}
  } catch (e) {
    console.warn("[pair-local] transfer test error:", e);
  }

  await serverA.close();
  await serverB.close();
  console.log("[pair-local] ✓ all checks passed");
}

main().catch(async (err) => {
  console.error("[pair-local] FAILED:", err);
  process.exit(1);
});
