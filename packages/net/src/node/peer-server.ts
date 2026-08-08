/**
 * Lyra peer server — persistent raw TCP (no HTTP).
 * This file keeps the historical import path `import { startPeerServer } from "./peer-server"`
 * but now delegates to the new TCP implementation.
 *
 * Old HTTP implementation is archived as `peer-server.http.ts` for reference.
 */

export { startTcpPeerServer as startPeerServer } from "../tcp/nodeTcpServer";
export type { TcpPeerServer as PeerServer, TcpPeerServerOptions as PeerServerOptions, TcpPeerServerOptions } from "../tcp/nodeTcpServer";
export type { TcpPeerCore as PeerPairDecision } from "../tcp/core";
