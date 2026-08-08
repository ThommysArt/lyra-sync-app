/**
 * React Native peer HTTP server (TCP + minimal HTTP/1.1).
 * Each mobile device hosts its own /lyra/* endpoints so desktops can pair,
 * push clipboard, and transfer files to the phone.
 *
 * Requires a dev client / release build (not Expo Go) — needs native TCP sockets.
 *
 * Implementation notes:
 * - Request buffers are kept as raw bytes until Content-Length is satisfied
 *   (UTF-8 string length ≠ byte length for multi-byte clipboard/filenames).
 * - Listens on 0.0.0.0 so LAN + Tailscale clients can reach the phone.
 */

import { hashPairingCode, type LyraStore } from "@lyra-sync-app/core";
import {
	buildHttpResponse,
	concatBytes,
	createPeerHttpCore,
	type PeerHttpCore,
	type PeerHttpCoreOptions,
	type PeerPairDecision,
	parseHttpRequestBytes,
	parseHttpRequestRaw,
	statusLine,
	toUint8Array,
} from "@lyra-sync-app/net";
import {
	type DeviceIdentity,
	LYRA_DEFAULT_PORT,
} from "@lyra-sync-app/protocol";
import Constants from "expo-constants";
import * as Network from "expo-network";
import { Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";

type TcpSocketModule = typeof import("react-native-tcp-socket");

export type NativePeerHandle = {
	port: number;
	url: string;
	lanHost: string | null;
	core: PeerHttpCore;
	stop: () => Promise<void>;
	setIdentity: (identity: DeviceIdentity) => void;
	setPairingOffer: (
		offer: { code: string; token: string; expiresAt: number } | null,
	) => Promise<void>;
	resolvePairRequest: (
		key: { deviceId?: string; token?: string },
		decision: PeerPairDecision,
	) => boolean;
	/** Transfer control for UI */
	pauseTransfer: (transferId: string) => boolean;
	resumeTransfer: (transferId: string, offset?: number) => boolean;
	cancelTransfer: (transferId: string) => boolean;
	/** Refresh advertised LAN/Tailscale host (Wi‑Fi / VPN changes). */
	refreshLanHost: () => Promise<string | null>;
};

/** True when running inside Expo Go (no custom native modules). */
export function isExpoGoRuntime(): boolean {
	// appOwnership === "expo" → Expo Go; "standalone" / null → store or dev client
	const ownership = Constants.appOwnership;
	if (ownership === "expo") return true;
	// executionEnvironment is more precise on newer Expo
	const env = (Constants as { executionEnvironment?: string })
		.executionEnvironment;
	if (env === "storeClient") return true;
	return false;
}

function loadTcpSocket(): TcpSocketModule | null {
	if (isExpoGoRuntime()) return null;
	if (Platform.OS !== "ios" && Platform.OS !== "android") return null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return require("react-native-tcp-socket") as TcpSocketModule;
	} catch (e) {
		console.warn("[lyra peer] react-native-tcp-socket unavailable", e);
		return null;
	}
}

// Streaming: no hard 8MiB wall — enforce per-chunk limits at handler; keep soft cap for DoS.
const MAX_REQUEST_BYTES = 32 * 1024 * 1024; // 32 MiB (doubled, but chunks still 48KiB sealed)

async function pickLanHost(): Promise<string | null> {
	try {
		const ip = await Network.getIpAddressAsync();
		if (ip && ip !== "0.0.0.0" && ip !== "127.0.0.1") return ip;
	} catch {
		// ignore
	}
	return null;
}

function createNativeDiskTransfer() {
	// Factory for disk-backed receives on native (avoids holding 300MB in RAM)
	return async (input: { transferId: string; totalBytes: number; files: { name: string; size: number }[]; resumeOffset?: number; checksums?: (string | undefined)[] }) => {
		const safeId = input.transferId.replace(/[^a-zA-Z0-9_-]/g, "_");
		const tmpFile = new File(Paths.cache, `lyra-tx-${safeId}-${Date.now()}.bin`);
		try {
			tmpFile.create({ overwrite: true });
		} catch {}
		let received = input.resumeOffset ?? 0;
		// If resuming, we need to truncate or keep; for now just start fresh if resume==0
		if (received === 0) {
			try { tmpFile.write(new Uint8Array(0)); } catch {}
		}
		const state: import("@lyra-sync-app/net").TransferReceiveState = {
			transferId: input.transferId,
			totalBytes: input.totalBytes,
			receivedBytes: received,
			files: input.files,
			chunks: [],
			paused: false,
			checksums: input.checksums,
			diskPath: tmpFile.uri,
			pendingChunks: new Map(),
			appendChunk: async (bytes: Uint8Array, offset: number) => {
				if (offset !== received) {
					if (offset < received) return;
					throw new Error(`gap ${received} vs ${offset}`);
				}
				// Append via File.write with append:true (efficient, no base64) — fail fast if unavailable
				try {
					// New API: write with append (SDK 52+)
					const writer = tmpFile as unknown as { write: (data: Uint8Array, opts?: unknown) => void };
					if (typeof writer.write !== "function") throw new Error("File.write not available — need expo-file-system with File API");
					writer.write(bytes, { append: true });
					console.info(`[lyra peer] appendChunk ${input.transferId.slice(0,8)} offset=${offset} len=${bytes.byteLength} ok`);
				} catch (e) {
					// Do NOT fallback to read-whole-file O(n²) — that caused 150KB/s and OOM.
					console.error(`[lyra peer] appendChunk failed ${input.transferId.slice(0,8)} @${offset} len=${bytes.byteLength}: ${e instanceof Error ? e.message : String(e)} — rebuild with expo-file-system File API`);
					throw new Error(`Disk append failed: ${e instanceof Error ? e.message : String(e)} — update expo-file-system`);
				}
				received += bytes.byteLength;
				(state as { receivedBytes: number }).receivedBytes = received;
			},
			finalizeDisk: async () => {
				let size = received;
				try { size = tmpFile.info().size ?? received; } catch {}
				return { filePath: tmpFile.uri, size, sha256: undefined };
			},
			cleanupDisk: async () => {
				try { tmpFile.delete(); } catch {}
			},
		};
		return state;
	};
}

export type StartNativePeerOptions = {
	identity: DeviceIdentity;
	port?: number;
	advertiseHost?: string | null;
	resolvePeerAuth?: PeerHttpCoreOptions["resolvePeerAuth"];
	handlers?: PeerHttpCoreOptions["handlers"];
	onEnvelope?: PeerHttpCoreOptions["onEnvelope"];
	fallbackPorts?: number[];
};

/**
 * Start listening for Lyra peer HTTP on the device.
 * Returns null when Expo Go or TCP module is unavailable.
 */
export async function startNativePeerServer(
	options: StartNativePeerOptions,
): Promise<NativePeerHandle | null> {
	const TcpSocket = loadTcpSocket();
	if (!TcpSocket) {
		console.info(
			"[lyra peer] skipping native peer server (Expo Go or non-native runtime)",
		);
		return null;
	}

	let currentIdentity = options.identity;
	let pairingOffer: {
		codeHash: string;
		token: string;
		expiresAt: number;
	} | null = null;
	let lanHost = options.advertiseHost?.trim() || (await pickLanHost());
	let boundPort = options.port ?? LYRA_DEFAULT_PORT;

	const diskFactory = createNativeDiskTransfer();
	const mergedHandlers = {
		...(options.handlers as Record<string, unknown>),
		createDiskTransfer: (options.handlers as { createDiskTransfer?: unknown })?.createDiskTransfer ?? diskFactory,
	} as PeerHttpCoreOptions["handlers"];
	const core = createPeerHttpCore({
		getIdentity: () => currentIdentity,
		getPort: () => boundPort,
		getLanHost: () => lanHost,
		getPairingOffer: () => {
			if (!pairingOffer || pairingOffer.expiresAt < Date.now()) return null;
			return pairingOffer;
		},
		allowFirstContactAuth: true,
		resolvePeerAuth: options.resolvePeerAuth,
		handlers: mergedHandlers,
		onEnvelope: options.onEnvelope,
		cors: true,
	});

	const preferred = options.port ?? LYRA_DEFAULT_PORT;
	const candidates = [
		preferred,
		...(options.fallbackPorts ?? [
			preferred + 2,
			preferred + 4,
			preferred + 10,
			0,
		]),
	];

	// react-native-tcp-socket types are incomplete across versions — keep loose here
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type AnyServer = any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	type AnySocket = any;
	let server: AnyServer | null = null;
	let listenError: Error | null = null;

	for (const tryPort of candidates) {
		listenError = null;
		const result = await new Promise<
			{ server: AnyServer; port: number } | { error: Error }
		>((resolve) => {
			let settled = false;
			const srv = TcpSocket.createServer((socket: AnySocket) => {
				const chunks: Uint8Array[] = [];
				let totalBytes = 0;
				let handling = false;
				// Once true, never touch the native socket again (write/destroy).
				// react-native-tcp-socket crashes the app if write() hits a removed id:
				// java.lang.IllegalArgumentException: No socket with id N
				let done = false;
				let idleTimer: ReturnType<typeof setTimeout> | undefined;

				const isLive = () => {
					if (done) return false;
					try {
						if (!socket) return false;
						if (socket.destroyed) return false;
					} catch {
						return false;
					}
					return true;
				};

				/**
				 * Close without writing. Safe to call many times.
				 * Prefer destroy over end() — end() also races getTcpClient on Android.
				 * Fully guarded: never throws, handles native map already cleared.
				 */
				const safeClose = () => {
					if (done) return;
					done = true;
					try {
						clearTimeout(idleTimer);
					} catch {
						// ignore
					}
					// Null socket reference first to avoid re-entry
					const s = socket;
					// Mark done already so isLive() is false
					try {
						if (!s) return;
						let destroyed = false;
						try {
							destroyed = !!s.destroyed;
						} catch {
							destroyed = true;
						}
						if (destroyed) return;
						try {
							s.destroy();
						} catch {
							// Native may already have dropped the id — never rethrow
						}
						try {
							s.removeAllListeners?.();
						} catch {}
					} catch {
						// swallow
					}
				};

				/**
				 * Write one HTTP response then close. Never write twice.
				 * Uses write+destroy (not end) so we fully own the lifecycle flag
				 * before the native bridge is invoked.
				 * Fully guarded against native IllegalArgumentException.
				 */
				const respond = (payload: string) => {
					if (done || !isLive()) return;
					done = true;
					try {
						clearTimeout(idleTimer);
					} catch {
						// ignore
					}
					const s = socket;
					if (!s) return;
					try {
						let destroyed = false;
						try {
							destroyed = !!s.destroyed;
						} catch {
							destroyed = true;
						}
						if (destroyed) return;
						try {
							s.write(payload, "utf8", () => {
								try {
									let d2 = false;
									try {
										d2 = !!s.destroyed;
									} catch {
										d2 = true;
									}
									if (!d2) {
										try {
											s.destroy();
										} catch {}
									}
								} catch {
									// ignore
								}
								try {
									s.removeAllListeners?.();
								} catch {}
							});
						} catch {
							try {
								let d2 = false;
								try {
									d2 = !!s.destroyed;
								} catch {
									d2 = true;
								}
								if (!d2) {
									try {
										s.destroy();
									} catch {}
								}
							} catch {
								// ignore
							}
						}
					} catch {
						try {
							s.destroy?.();
						} catch {}
					}
				};

				const tryHandle = () => {
					if (handling || done) return;
					const buf = concatBytes(chunks);
					// Use raw parsing to preserve binary bodies for /lyra/transfer/*/chunk
					const rawParsed = parseHttpRequestRaw(buf, MAX_REQUEST_BYTES);
					if (!rawParsed) {
						if (totalBytes > MAX_REQUEST_BYTES) {
							respond(
								buildHttpResponse(
									400,
									{ "content-type": "application/json" },
									'{"error":"Request too large"}',
								),
							);
						}
						return;
					}
					if (rawParsed.consumed < 0) {
						respond(
							buildHttpResponse(
								400,
								{ "content-type": "application/json" },
								'{"error":"Request too large"}',
							),
						);
						return;
					}
					const isBinaryChunk = rawParsed.path.startsWith("/lyra/transfer/") && rawParsed.path.includes("/chunk");
					const parsed = isBinaryChunk
						? { method: rawParsed.method, path: rawParsed.path, headers: rawParsed.headers, body: "", consumed: rawParsed.consumed }
						: (() => {
								try {
									return { method: rawParsed.method, path: rawParsed.path, headers: rawParsed.headers, body: new TextDecoder().decode(rawParsed.bodyBytes), consumed: rawParsed.consumed };
								} catch {
									return { method: rawParsed.method, path: rawParsed.path, headers: rawParsed.headers, body: "", consumed: rawParsed.consumed };
								}
							})();

					handling = true;
					chunks.length = 0;
					totalBytes = 0;

					// react-native-tcp-socket sets remoteAddress after connect
					const remoteRaw =
						(socket as { remoteAddress?: string }).remoteAddress ??
						(socket as { _remoteAddress?: string })._remoteAddress ??
						null;
					const remote =
						typeof remoteRaw === "string"
							? remoteRaw.replace(/^::ffff:/, "").replace(/%.*$/, "")
							: null;

					const reqStarted = Date.now();
					const routePath = (parsed.path.split("?")[0] || parsed.path).trim();
					void core
						.handle({
							method: parsed.method,
							path: parsed.path,
							headers: parsed.headers,
							body: parsed.body,
							rawBody: isBinaryChunk ? rawParsed.bodyBytes : undefined,
							remoteAddress: remote,
						})
						.then((res) => {
							if (done || !isLive()) return;
							const ms = Date.now() - reqStarted;
							const interesting =
								routePath !== "/lyra/info" && routePath !== "/lyra/health"
									? true
									: parsed.method.toUpperCase() !== "GET";
							if (interesting || res.status >= 400) {
								console.info(
									`[lyra peer] ${parsed.method} ${routePath} ← ${remote ?? "?"} → ${res.status} ${ms}ms`,
								);
							}
							respond(buildHttpResponse(res.status, res.headers, res.body));
						})
						.catch((err) => {
							console.warn(
								`[lyra peer] ${parsed.method} ${routePath} ← ${remote ?? "?"} error`,
								err instanceof Error ? err.message : err,
							);
							if (done || !isLive()) return;
							respond(
								buildHttpResponse(
									500,
									{ "content-type": "application/json" },
									JSON.stringify({ error: "Internal error" }),
								),
							);
						});
				};

				// Avoid library auto-end() on peer FIN racing our write (known crash).
				try {
					socket.allowHalfOpen = true;
				} catch {
					// ignore
				}

				const bumpIdle = () => {
					try {
						clearTimeout(idleTimer);
					} catch {
						// ignore
					}
					idleTimer = setTimeout(() => {
						// Only kill if we never started handling a complete request
						if (!handling && !done) safeClose();
					}, 20_000);
				};

				try {
					socket.on("data", (data: unknown) => {
						if (done || handling) return;
						try {
							const bytes = toUint8Array(data);
							chunks.push(bytes);
							totalBytes += bytes.byteLength;
							bumpIdle();
							if (totalBytes > MAX_REQUEST_BYTES) {
								respond(
									buildHttpResponse(
										400,
										{ "content-type": "application/json" },
										'{"error":"Request too large"}',
									),
								);
								return;
							}
							tryHandle();
						} catch (e) {
							console.warn("[lyra peer] data handler error", e);
							try {
								safeClose();
							} catch {}
						}
					});
				} catch {}
				try {
					socket.on("error", () => {
						// Peer reset / aborted probe — just drop; never write afterwards
						try {
							safeClose();
						} catch {}
					});
				} catch {}
				try {
					socket.on("close", () => {
						done = true;
						try {
							clearTimeout(idleTimer);
						} catch {
							// ignore
						}
						// Ensure we don't leak listeners
						try {
							socket.removeAllListeners?.();
						} catch {}
					});
				} catch {}
				try {
					socket.on("end", () => {
						// Peer half-closed after sending body without Content-Length
						if (!handling && !done && chunks.length > 0) {
							tryHandle();
						}
						// If still nothing to handle, abandon
						if (!handling && !done) {
							try {
								safeClose();
							} catch {}
						}
					});
				} catch {}

				// Idle timeout for half-open / stalled clients
				idleTimer = setTimeout(() => {
					if (!handling && !done) safeClose();
				}, 20_000);
			});

			srv.on("error", (err: Error) => {
				if (settled) return;
				settled = true;
				try {
					srv.close();
				} catch {
					// ignore
				}
				resolve({ error: err });
			});

			// Host 0.0.0.0 so LAN + Tailscale clients can reach us
			srv.listen({ port: tryPort, host: "0.0.0.0", reuseAddress: true }, () => {
				if (settled) return;
				settled = true;
				let actual = tryPort === 0 ? preferred : tryPort;
				try {
					const addr = srv.address?.() as
						| { port?: number }
						| string
						| null
						| undefined;
					if (
						addr &&
						typeof addr === "object" &&
						typeof addr.port === "number"
					) {
						actual = addr.port;
					}
				} catch {
					// keep fallback
				}
				resolve({ server: srv, port: actual });
			});
		});

		if ("error" in result) {
			listenError = result.error;
			const msg = result.error.message || String(result.error);
			if (/EADDRINUSE|address already in use|already in use/i.test(msg)) {
				console.warn(`[lyra peer] port ${tryPort} in use, trying next…`);
				continue;
			}
			console.warn("[lyra peer] listen failed", msg);
			continue;
		}

		server = result.server;
		boundPort = result.port;
		break;
	}

	if (!server) {
		throw new Error(
			listenError?.message ||
				`Could not bind peer server (tried ${candidates.join(", ")})`,
		);
	}

	// Refresh LAN IP once more after bind
	lanHost = options.advertiseHost?.trim() || (await pickLanHost()) || lanHost;

	console.info(
		`[lyra peer] native peer server listening on 0.0.0.0:${boundPort}` +
			(lanHost ? ` (LAN ${lanHost})` : ""),
	);

	const refreshLanHost = async () => {
		const next = options.advertiseHost?.trim() || (await pickLanHost());
		if (next) lanHost = next;
		return lanHost;
	};

	return {
		port: boundPort,
		url: lanHost
			? `http://${lanHost}:${boundPort}`
			: `http://127.0.0.1:${boundPort}`,
		lanHost,
		core,
		setIdentity: (identity) => {
			currentIdentity = identity;
		},
		setPairingOffer: async (offer) => {
			if (!offer) {
				pairingOffer = null;
				return;
			}
			const codeHash = await hashPairingCode(offer.code);
			pairingOffer = {
				codeHash,
				token: offer.token,
				expiresAt: offer.expiresAt,
			};
		},
		resolvePairRequest: (key, decision) =>
			core.resolvePairRequest(key, decision),
		pauseTransfer: (transferId: string) => core.pauseTransfer(transferId),
		resumeTransfer: (transferId: string, offset?: number) =>
			core.resumeTransfer(transferId, offset),
		cancelTransfer: (transferId: string) => core.cancelTransfer(transferId),
		refreshLanHost,
		stop: () =>
			new Promise((resolve) => {
				try {
					server?.close(() => resolve());
				} catch {
					resolve();
				}
				// Ensure resolve even if close never fires
				setTimeout(() => resolve(), 500);
			}),
	};
}

/**
 * Wire native peer server into a Lyra store (status, pairing offer, accept/decline).
 * Returns a cleanup function.
 */
export function attachNativePeerToStore(
	store: LyraStore,
	peer: NativePeerHandle,
): () => void {
	const syncStatus = () => {
		store.setPeerServerStatus({
			running: true,
			port: peer.port,
			url: peer.lanHost ? `http://${peer.lanHost}:${peer.port}` : peer.url,
			lanHost: peer.lanHost,
			discoveryActive: true, // HTTP /24 scan is the mobile discovery path
			lastError: null,
		});
		if (peer.lanHost) store.setLocalLanHint(peer.lanHost);
	};
	syncStatus();

	// Keep settings in sync when we fell back to an alternate port (EADDRINUSE)
	// Don't persist ephemeral random ports (fallback to 0) — they aren't in the scan matrix
	// and would be probed as 44119 etc. on next launch, missing the real 53317 peers.
	if (peer.port && peer.port !== store.getState().settings.peerListenPort) {
		const preferred = store.getState().settings.peerListenPort ?? 53317;
		const known = new Set([
			53317,
			53319,
			53321,
			53327,
			53329,
			53337,
			53339,
			preferred,
			preferred + 2,
			preferred + 4,
			preferred + 10,
		]);
		if (known.has(peer.port)) {
			store.updateSettings({ peerListenPort: peer.port });
		} else {
			console.warn(
				`[lyra peer] ephemeral port ${peer.port} not persisted (will retry ${preferred} next launch)`,
			);
		}
	}

	// Identity changes
	let lastIdentityKey = "";
	const syncIdentity = () => {
		const id = store.getState().identity;
		if (!id) return;
		const key = `${id.id}:${id.fingerprint}:${id.name}`;
		if (key === lastIdentityKey) return;
		lastIdentityKey = key;
		peer.setIdentity(id);
	};
	syncIdentity();

	// Pairing offer advertisement
	let lastOfferKey = "";
	const syncOffer = () => {
		const active = store.getState().activePairing;
		const key = active
			? `${active.code}:${active.token}:${active.expiresAt}`
			: "";
		if (key === lastOfferKey) return;
		lastOfferKey = key;
		void peer.setPairingOffer(
			active
				? {
						code: active.code,
						token: active.token,
						expiresAt: active.expiresAt,
					}
				: null,
		);
	};
	syncOffer();

	// Accept/Decline on phone → resolve long-poll for joiners
	store.setPairDecisionResolver?.((payload) => {
		const ok = peer.resolvePairRequest(
			{ deviceId: payload.deviceId, token: payload.token },
			payload.accepted
				? {
						accepted: true,
						host: peer.lanHost ?? undefined,
						port: peer.port,
					}
				: { accepted: false, reason: payload.reason ?? "declined" },
		);
		return Promise.resolve(
			ok
				? { ok: true as const }
				: { ok: false as const, error: "No pending pair request" },
		);
	});

	const unsub = store.subscribe(() => {
		syncIdentity();
		syncOffer();
	});

	// Refresh advertised IP periodically (Wi‑Fi ↔ Tailscale interface changes)
	const ipTimer = setInterval(() => {
		void peer.refreshLanHost().then((host) => {
			if (host) {
				store.setLocalLanHint(host);
				syncStatus();
			}
		});
	}, 20_000);

	// Self-test outbound peer HTTP against our own listen socket (loopback).
	// Confirms the TCP transport can complete a real GET before LAN scans.
	const selfTestTimer = setTimeout(() => {
		void (async () => {
			try {
				const { probePeer } = await import("@lyra-sync-app/net");
				const r = await probePeer(
					{ host: "127.0.0.1", port: peer.port },
					{ timeoutMs: 2000 },
				);
				console.info(
					`[lyra peer] self-test 127.0.0.1:${peer.port} → ${r.ok ? "ok" : r.error}`,
				);
			} catch (e) {
				console.warn(
					"[lyra peer] self-test failed",
					e instanceof Error ? e.message : e,
				);
			}
		})();
	}, 500);

	// Initial discovery once peer is fully up — slight delay so the listen
	// socket is ready and we don't self-scan during bind races.
	let discoveryTimer: ReturnType<typeof setTimeout> | null = null;
	if (store.getState().settings.discoveryEnabled) {
		discoveryTimer = setTimeout(() => {
			void store.refreshDiscovery();
		}, 1200);
	}

	return () => {
		if (discoveryTimer) clearTimeout(discoveryTimer);
		clearTimeout(selfTestTimer);
		clearInterval(ipTimer);
		unsub();
		store.setPairDecisionResolver?.(null);
		store.setPeerServerStatus({
			running: false,
			port: null,
			url: null,
			lanHost: null,
			discoveryActive: false,
			lastError: null,
		});
	};
}
