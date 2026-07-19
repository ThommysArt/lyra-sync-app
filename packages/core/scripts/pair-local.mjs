/**
 * Single-machine pairing test (no phone / second PC required).
 *
 * Spins up two peer servers on this host, runs the real code-pair flow:
 *   A shows code → B enters code → A accepts → both have authSecret
 *
 * Usage (from monorepo root):
 *   pnpm test:pair
 *   pnpm --filter @lyra-sync-app/core exec tsx scripts/pair-local.mjs
 */
import {
  createDeviceIdentity,
  createLyraStore,
  generatePairingCode,
  hashPairingCode,
} from "@lyra-sync-app/core";
import { fetchPeerInfo, sendPairRequest } from "@lyra-sync-app/net";
import { startPeerServer } from "@lyra-sync-app/net/node";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function log(step, detail = "") {
  const pad = step.padEnd(28);
  console.log(`  ✓ ${pad}${detail}`);
}

console.log("\n╔══════════════════════════════════════════╗");
console.log("║  Lyra single-machine pairing harness     ║");
console.log("╚══════════════════════════════════════════╝\n");

const hostA = await createDeviceIdentity({
  name: "Computer A",
  platform: "linux",
  type: "desktop",
});
const hostB = await createDeviceIdentity({
  name: "Computer B",
  platform: "linux",
  type: "desktop",
});
assert(hostA.ok && hostB.ok, "create identities");
log("identities", `${hostA.identity.name} · ${hostB.identity.name}`);

const code = generatePairingCode(6);
const token = `tok_${code.toLowerCase()}`;
const codeHash = await hashPairingCode(code);
const offer = {
  codeHash,
  token,
  expiresAt: Date.now() + 5 * 60 * 1000,
};

/** @type {Awaited<ReturnType<typeof startPeerServer>> | null} */
let serverA = null;
/** @type {Awaited<ReturnType<typeof startPeerServer>> | null} */
let serverB = null;

try {
  serverA = await startPeerServer({
    identity: hostA.identity,
    port: 0,
    host: "127.0.0.1",
    getPairingOffer: () => offer,
    handlers: {
      onPairRequest: (payload) => {
        log("A received pair_request", `from ${payload.name}`);
        // Host user Accept (simulated after a short think)
        setTimeout(() => {
          const ok = serverA.resolvePairRequest(
            { deviceId: payload.deviceId, token: payload.token },
            { accepted: true, host: "127.0.0.1", port: serverA.port },
          );
          log("A accepted pairing", ok ? "long-poll resolved" : "no waiter");
        }, 40);
      },
    },
  });
  log("peer A listening", `http://127.0.0.1:${serverA.port}`);

  serverB = await startPeerServer({
    identity: hostB.identity,
    port: 0,
    host: "127.0.0.1",
  });
  log("peer B listening", `http://127.0.0.1:${serverB.port}`);

  // --- Prove offer is advertised (this is what was missing in real tests) ---
  const info = await fetchPeerInfo({ host: "127.0.0.1", port: serverA.port });
  assert(info.ok, "fetch /lyra/info A");
  assert(info.pairing?.token === token, "A advertises pairing offer on /lyra/info");
  assert(info.pairing?.codeHash === codeHash, "codeHash matches");
  log("A /lyra/info pairing", `code=${code} hash=${codeHash.slice(0, 10)}…`);

  // --- Joiner store (like phone / second desktop UI) ---
  const storeB = createLyraStore({ storage: null, seedDemo: false, platformHint: "web" });
  await storeB.hydrate();
  // Inject B's identity-ish name for readability (store has its own identity)
  storeB.setDeviceName("Computer B (store)");
  storeB.setLocalLanHint("127.0.0.1");
  storeB.addManualPeer({ host: "127.0.0.1", port: serverA.port, name: "Computer A" });
  log("B store ready", `looking for code ${code}`);

  const result = await storeB.submitPairingCode(code, {
    host: "127.0.0.1",
    port: serverA.port,
  });
  assert(result.ok, `B submitPairingCode: ${result.ok ? "" : result.error}`);
  assert("device" in result, "B finished with paired device");
  assert(result.device.authSecret, "B has authSecret");
  assert(result.device.id === hostA.identity.id, "B paired with A");
  log("B paired", `authSecret=${result.device.authSecret.slice(0, 12)}…`);

  // --- Also exercise raw wire path symmetry ---
  const direct = await sendPairRequest({
    endpoint: { host: "127.0.0.1", port: serverA.port },
    fromIdentity: hostB.identity,
    token,
    code,
    waitForConfirmMs: 5_000,
  });
  // Second request may be rejected/timeout if offer still active — either ok is fine
  log(
    "second pair_request",
    direct.ok ? `type=${direct.envelope?.type}` : `expected-ish: ${direct.error}`,
  );

  console.log("\n┌──────────────────────────────────────────┐");
  console.log("│  PAIRING OK on this machine              │");
  console.log("└──────────────────────────────────────────┘");
  console.log(`
Next: UI test with TWO desktop windows (same PC):

  # Terminal 1 — web UI once
  pnpm run dev:web

  # Terminal 2 — Desktop A
  pnpm run dev:pair-a

  # Terminal 3 — Desktop B  
  pnpm run dev:pair-b

Then: A → Pair → Show code · B → Enter code · A Accepts.
`);
} finally {
  await serverA?.close();
  await serverB?.close();
}
