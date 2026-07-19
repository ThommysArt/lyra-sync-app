/**
 * Standalone peer server for local testing:
 *   pnpm --filter @lyra-sync-app/net peer-server
 *   LYRA_PORT=53317 pnpm --filter @lyra-sync-app/net peer-server
 */
import { createHash, randomBytes } from "node:crypto";

import type { DeviceIdentity } from "@lyra-sync-app/protocol";

import { startDiscovery } from "./discovery";
import { deleteOsPath, listOsFiles, readOsFileChunk, renameOsPath } from "./fs-browse";
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
    // Dynamic specifier avoids a hard dependency on core (net stays leaf for packaging).
    const coreSpec = "@lyra-sync-app/core";
    const core = (await import(coreSpec)) as {
      createDeviceIdentity: (opts: {
        name: string;
        platform: "linux";
        type: "desktop";
      }) => Promise<{ ok: true; identity: DeviceIdentity } | { ok: false }>;
    };
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

  const useTls = process.env.LYRA_TLS === "1" || process.env.LYRA_TLS === "true";

  const peer = await startPeerServer({
    identity,
    port,
    tls: useTls,
    // Fall through to built-in handlers (transfer chunks, clipboard, fs, pair)
    onEnvelope: async (envelope) => {
      console.log(`[envelope] ${envelope.type} from ${envelope.fromDeviceId}`);
      return undefined;
    },
    handlers: {
      onFsList: async (path) => {
        // Real OS smart folders + browse (fallback message on error)
        try {
          return await listOsFiles(path);
        } catch (e) {
          console.warn("[fs_list]", e instanceof Error ? e.message : e);
          // Demo fallback if OS path missing (e.g. headless CI)
          if (path === "/" || path === "") {
            return [
              { name: "Documents", path: "/Documents", isDirectory: true },
              { name: "Downloads", path: "/Downloads", isDirectory: true },
            ];
          }
          return [];
        }
      },
      onFsRead: (path, offset, maxBytes) => readOsFileChunk(path, offset, maxBytes),
      onFsDelete: (path) => deleteOsPath(path),
      onFsRename: (path, newName) => renameOsPath(path, newName),
      onOpenUrl: (url) => {
        console.log(`[open_url] ${url}`);
        return true;
      },
      onClipboardPush: (item) => {
        console.log(`[clipboard] ${item.type} from ${item.sourceDeviceName}`);
      },
      onPairRequest: (payload) => {
        console.log(`[pair_request] from ${payload.name} (${payload.deviceId})`);
      },
      onTransferComplete: (state) => {
        console.log(
          `[transfer_complete] ${state.transferId} · ${state.receivedBytes} bytes · ${state.files.length} file(s)${state.diskPath ? ` · disk ${state.diskPath}` : ""}`,
        );
      },
    },
  });

  console.log(`Lyra peer server listening on ${peer.url}`);
  console.log(`  device: ${identity.name} (${identity.id})`);
  console.log(`  fingerprint: ${identity.fingerprint}`);
  if (peer.protocol === "https") {
    console.log(`  TLS fingerprint: ${peer.tlsFingerprint ?? "(unknown)"}`);
  }

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
