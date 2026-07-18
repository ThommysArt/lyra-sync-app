/**
 * Standalone peer server for local testing:
 *   pnpm --filter @lyra-sync-app/net peer-server
 *   LYRA_PORT=53317 pnpm --filter @lyra-sync-app/net peer-server
 */
import { createHash, randomBytes } from "node:crypto";

import type { DeviceIdentity } from "@lyra-sync-app/protocol";

import { startDiscovery } from "./discovery";
import { startPeerServer } from "./peer-server";

function createFallbackIdentity(): DeviceIdentity {
  const privateKey = randomBytes(32).toString("hex");
  const publicKey = createHash("sha256").update(`pub:${privateKey}`).digest("hex");
  const fingerprint = createHash("sha256")
    .update(`fp:${publicKey}`)
    .digest("hex")
    .slice(0, 32);
  const id = createHash("sha256").update(`id:${publicKey}`).digest("hex").slice(0, 16);
  return {
    id,
    name: process.env.LYRA_NAME ?? "Lyra Peer Server",
    type: "desktop",
    platform: "linux",
    fingerprint,
    publicKey,
    createdAt: Date.now(),
  };
}

async function resolveIdentity(): Promise<DeviceIdentity> {
  try {
    const core = await import("@lyra-sync-app/core");
    const created = await core.createDeviceIdentity({
      name: process.env.LYRA_NAME ?? "Lyra Peer Server",
      platform: "linux",
      type: "desktop",
    });
    if (created.ok) return created.identity;
  } catch {
    // core may be unavailable in isolation
  }
  return createFallbackIdentity();
}

async function main() {
  const port = Number(process.env.LYRA_PORT ?? 53317);
  const identity = await resolveIdentity();

  const peer = await startPeerServer({
    identity,
    port,
    onEnvelope: async (envelope) => {
      console.log(`[envelope] ${envelope.type} from ${envelope.fromDeviceId}`);
      return { ok: true };
    },
  });

  console.log(`Lyra peer server listening on ${peer.url}`);
  console.log(`  device: ${identity.name} (${identity.id})`);
  console.log(`  fingerprint: ${identity.fingerprint}`);

  let discovery: Awaited<ReturnType<typeof startDiscovery>> | null = null;
  if (process.env.LYRA_DISCOVERY !== "0") {
    discovery = await startDiscovery({
      identity,
      peerPort: peer.port,
      onPeer: (announce, rinfo) => {
        console.log(
          `[discover] ${announce.identity.name} @ ${announce.host}:${announce.port} (from ${rinfo.address})`,
        );
      },
    });
    console.log("UDP multicast discovery enabled");
  }

  const shutdown = async () => {
    await discovery?.stop();
    await peer.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
