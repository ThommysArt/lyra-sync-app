/**
 * Persist sensitive Lyra state. Prefer expo-secure-store for the private key;
 * bulk UI state uses SQLite (expo-sqlite) when available, otherwise AsyncStorage, and localStorage on web.
 *
 * FIX: Original fire-and-forget AsyncStorage caused paired devices to disappear after reload.
 * Now: AsyncStorage writes are queued and awaitable via flush(); SQLite path is synchronous
 * and durable immediately. Both paths migrate from AsyncStorage on first launch.
 */
import type { StorageLike } from "@lyra-sync-app/core";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const PRIVATE_KEY_ITEM = "lyra.privateKey";
const STATE_PREFIX = "lyra.v1.";
const STORAGE_KEY = "lyra.v1.state";

/**
 * Try to create a SQLite-backed StorageLike using expo-sqlite sync API.
 * Returns null if expo-sqlite not available (fallback to AsyncStorage).
 */
function tryCreateSQLiteBulk():
	| (StorageLike & {
			hydrate: () => Promise<void>;
			flush?: () => Promise<void>;
	  })
	| null {
	// Try expo-sqlite/kv-store first — correct for expo-sqlite 16.x (Storage class)
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const kvMod = require("expo-sqlite/kv-store") as {
			default?: {
				getItemSync?: (k: string) => string | null;
				setItemSync?: (k: string, v: string) => void;
				removeItemSync?: (k: string) => void;
				getAllKeysSync?: () => string[];
				getItem?: (k: string) => string | null;
				setItem?: (k: string, v: string) => void;
				removeItem?: (k: string) => void;
				getAllKeys?: () => string[];
			};
			Storage?: new (
				name: string,
			) => {
				getItemSync: (k: string) => string | null;
				setItemSync: (k: string, v: string) => void;
				removeItemSync: (k: string) => void;
				getAllKeysSync: () => string[];
			};
			open?: (name: string) => {
				getItem: (k: string) => string | null;
				setItem: (k: string, v: string) => void;
				removeItem: (k: string) => void;
				getAllKeys?: () => string[];
			};
		};
		let kv: {
			getItem: (k: string) => string | null;
			setItem: (k: string, v: string) => void;
			removeItem: (k: string) => void;
			getAllKeys?: () => string[];
		} | null = null;
		// New API: `open` helper (if present) or Storage class
		if (kvMod?.open) {
			kv = kvMod.open("lyra");
		} else if (kvMod?.Storage) {
			const inst = new kvMod.Storage("lyra");
			kv = {
				getItem: (k) => inst.getItemSync(k),
				setItem: (k, v) => inst.setItemSync(k, v),
				removeItem: (k) => inst.removeItemSync(k),
				getAllKeys: () => inst.getAllKeysSync(),
			};
		} else if (
			kvMod?.default &&
			typeof (kvMod.default as unknown as { getItemSync?: unknown })
				.getItemSync === "function"
		) {
			const d = kvMod.default as unknown as {
				getItemSync: (k: string) => string | null;
				setItemSync: (k: string, v: string) => void;
				removeItemSync: (k: string) => void;
				getAllKeysSync: () => string[];
			};
			kv = {
				getItem: (k) => d.getItemSync(k),
				setItem: (k, v) => d.setItemSync(k, v),
				removeItem: (k) => d.removeItemSync(k),
				getAllKeys: () => d.getAllKeysSync(),
			};
		}
		if (kv) {
			// Test that it works
			kv.setItem("__lyra_probe", "1");
			kv.removeItem("__lyra_probe");
			console.info("[lyra storage] using expo-sqlite/kv-store");
			const cache = new Map<string, string>();
			let ready = false;
			let hydratePromise: Promise<void> | null = null;

			const doHydrate = async () => {
				try {
					// kv-store is sync, but we keep async hydrate for interface
					// Migrate from AsyncStorage if SQLite empty but AsyncStorage has data
					let keys: string[] = [];
					try {
						if (typeof kv!.getAllKeys === "function") {
							keys = kv!
								.getAllKeys()
								.filter(
									(k) => k.startsWith(STATE_PREFIX) || k === "lyra.v1.state",
								);
						} else {
							// Fallback: try to read known keys
							const probeKeys = [STORAGE_KEY, `${STORAGE_KEY}.key`];
							for (const k of probeKeys) {
								const v = kv!.getItem(k);
								if (v != null) keys.push(k);
							}
						}
					} catch {}
					// If SQLite empty, try migrate from AsyncStorage
					if (keys.length === 0) {
						try {
							const asyncKeys = await AsyncStorage.getAllKeys();
							const lyraKeys = asyncKeys.filter(
								(k) => k.startsWith(STATE_PREFIX) || k === "lyra.v1.state",
							);
							let pairs: [string, string | null][] = [];
							if (lyraKeys.length === 0) {
								pairs = await AsyncStorage.multiGet(
									asyncKeys.filter((k) => k.startsWith("lyra.")),
								);
							} else {
								pairs = await AsyncStorage.multiGet(lyraKeys);
							}
							for (const [k, v] of pairs) {
								if (k && v != null) {
									kv!.setItem(k, v);
									cache.set(k, v);
									keys.push(k);
								}
							}
							const state = await AsyncStorage.getItem("lyra.v1.state");
							if (state != null && !cache.has("lyra.v1.state")) {
								kv!.setItem("lyra.v1.state", state);
								cache.set("lyra.v1.state", state);
								keys.push("lyra.v1.state");
							}
							const isolated = await AsyncStorage.getItem("lyra.v1.state.key");
							if (isolated != null && !cache.has("lyra.v1.state.key")) {
								kv!.setItem("lyra.v1.state.key", isolated);
								cache.set("lyra.v1.state.key", isolated);
								keys.push("lyra.v1.state.key");
							}
							if (keys.length > 0)
								console.info(
									`[lyra storage] migrated ${keys.length} keys from AsyncStorage to SQLite`,
								);
						} catch (e) {
							console.warn("[lyra storage] AsyncStorage migration failed", e);
						}
					}
					// Populate cache from SQLite
					for (const k of keys) {
						try {
							const v = kv!.getItem(k);
							if (v != null) cache.set(k, v);
						} catch {}
					}
					// Ensure critical keys are cached even if not in getAllKeys
					for (const k of [STORAGE_KEY, `${STORAGE_KEY}.key`]) {
						if (!cache.has(k)) {
							try {
								const v = kv!.getItem(k);
								if (v != null) cache.set(k, v);
							} catch {}
						}
					}
				} catch (e) {
					console.warn("[lyra storage] sqlite hydrate failed", e);
				}
				ready = true;
			};

			return {
				hydrate: () => {
					if (hydratePromise) return hydratePromise;
					if (ready) return Promise.resolve();
					hydratePromise = doHydrate();
					return hydratePromise;
				},
				getItem: (k) => {
					if (!ready) console.warn("[lyra storage] getItem before hydrate", k);
					const cached = cache.get(k);
					if (cached !== undefined) return cached;
					try {
						const v = kv!.getItem(k);
						if (v != null) cache.set(k, v);
						return v;
					} catch {
						return cache.get(k) ?? null;
					}
				},
				setItem: (k, v) => {
					cache.set(k, v);
					try {
						kv!.setItem(k, v);
					} catch (e) {
						console.warn("[lyra storage] sqlite setItem failed", k, e);
					}
				},
				removeItem: (k) => {
					cache.delete(k);
					try {
						kv!.removeItem(k);
					} catch (e) {
						console.warn("[lyra storage] sqlite removeItem failed", k, e);
					}
				},
				flush: async () => undefined,
			};
		}
	} catch {
		// not available
	}

	// Try expo-sqlite openDatabaseSync
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const SQLite = require("expo-sqlite") as {
			openDatabaseSync?: (name: string) => {
				execSync: (sql: string) => void;
				runSync: (sql: string, params?: unknown[]) => { changes: number };
				getAllSync: (
					sql: string,
					params?: unknown[],
				) => { key: string; value: string }[];
				getFirstSync: (
					sql: string,
					params?: unknown[],
				) => { value: string } | null;
			};
			openDatabase?: (...args: unknown[]) => unknown;
		};
		if (SQLite?.openDatabaseSync) {
			const db = SQLite.openDatabaseSync("lyra.db");
			db.execSync(
				"CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT)",
			);
			console.info("[lyra storage] using expo-sqlite openDatabaseSync");
			const cache = new Map<string, string>();
			let ready = false;
			let hydratePromise: Promise<void> | null = null;

			const doHydrate = async () => {
				try {
					// Migrate from AsyncStorage if SQLite empty
					let rows: { key: string; value: string }[] = [];
					try {
						rows = db.getAllSync(
							"SELECT key, value FROM kv WHERE key LIKE 'lyra.%'",
						);
					} catch {}
					if (rows.length === 0) {
						try {
							const asyncKeys = await AsyncStorage.getAllKeys();
							const lyraKeys = asyncKeys.filter(
								(k) => k.startsWith(STATE_PREFIX) || k === "lyra.v1.state",
							);
							let pairs: [string, string | null][] = [];
							if (lyraKeys.length === 0) {
								pairs = await AsyncStorage.multiGet(
									asyncKeys.filter((k) => k.startsWith("lyra.")),
								);
							} else {
								pairs = await AsyncStorage.multiGet(lyraKeys);
							}
							for (const [k, v] of pairs) {
								if (k && v != null) {
									db.runSync(
										"INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
										[k, v],
									);
									cache.set(k, v);
								}
							}
							const state = await AsyncStorage.getItem("lyra.v1.state");
							if (state != null && !cache.has("lyra.v1.state")) {
								db.runSync(
									"INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
									["lyra.v1.state", state],
								);
								cache.set("lyra.v1.state", state);
							}
							const isolated = await AsyncStorage.getItem("lyra.v1.state.key");
							if (isolated != null && !cache.has("lyra.v1.state.key")) {
								db.runSync(
									"INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
									["lyra.v1.state.key", isolated],
								);
								cache.set("lyra.v1.state.key", isolated);
							}
							rows = db.getAllSync(
								"SELECT key, value FROM kv WHERE key LIKE 'lyra.%'",
							);
							if (rows.length > 0)
								console.info(
									`[lyra storage] migrated ${rows.length} keys from AsyncStorage to SQLite`,
								);
						} catch (e) {
							console.warn("[lyra storage] AsyncStorage migration failed", e);
						}
					}
					for (const r of rows)
						if (r.key && r.value != null) cache.set(r.key, r.value);
					// Ensure critical keys
					for (const k of [STORAGE_KEY, `${STORAGE_KEY}.key`]) {
						if (!cache.has(k)) {
							try {
								const row = db.getFirstSync(
									"SELECT value FROM kv WHERE key = ?",
									[k],
								);
								if (row?.value != null) cache.set(k, row.value);
							} catch {}
						}
					}
				} catch (e) {
					console.warn("[lyra storage] sqlite hydrate failed", e);
				}
				ready = true;
			};

			return {
				hydrate: () => {
					if (hydratePromise) return hydratePromise;
					if (ready) return Promise.resolve();
					hydratePromise = doHydrate();
					return hydratePromise;
				},
				getItem: (k) => {
					if (!ready) console.warn("[lyra storage] getItem before hydrate", k);
					const cached = cache.get(k);
					if (cached !== undefined) return cached;
					try {
						const row = db.getFirstSync("SELECT value FROM kv WHERE key = ?", [
							k,
						]);
						if (row?.value != null) {
							cache.set(k, row.value);
							return row.value;
						}
					} catch {}
					return cache.get(k) ?? null;
				},
				setItem: (k, v) => {
					cache.set(k, v);
					try {
						db.runSync("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)", [
							k,
							v,
						]);
					} catch (e) {
						console.warn("[lyra storage] sqlite setItem failed", k, e);
					}
				},
				removeItem: (k) => {
					cache.delete(k);
					try {
						db.runSync("DELETE FROM kv WHERE key = ?", [k]);
					} catch (e) {
						console.warn("[lyra storage] sqlite removeItem failed", k, e);
					}
				},
				flush: async () => undefined,
			};
		}
	} catch {
		// not available
	}
	return null;
}

/**
 * In-memory cache backed by AsyncStorage — FIXED version with queued awaitable writes.
 */
function createAsyncStorageBulk(): StorageLike & {
	hydrate: () => Promise<void>;
	flush: () => Promise<void>;
} {
	const cache = new Map<string, string>();
	let ready = false;
	let hydratePromise: Promise<void> | null = null;
	let pendingWrites: Promise<void> = Promise.resolve();

	const doHydrate = async () => {
		// Wait for any pending writes before reading (important for in-flight writes before reload)
		try {
			await pendingWrites;
		} catch {}
		try {
			const keys = await AsyncStorage.getAllKeys();
			const lyraKeys = keys.filter(
				(k) => k.startsWith(STATE_PREFIX) || k === "lyra.v1.state",
			);
			if (lyraKeys.length === 0) {
				const all = await AsyncStorage.multiGet(
					keys.filter((k) => k.startsWith("lyra.")),
				);
				for (const [k, v] of all) {
					if (k && v != null) cache.set(k, v);
				}
			} else {
				const pairs = await AsyncStorage.multiGet(lyraKeys);
				for (const [k, v] of pairs) {
					if (k && v != null) cache.set(k, v);
				}
			}
			const state = await AsyncStorage.getItem("lyra.v1.state");
			if (state != null) cache.set("lyra.v1.state", state);
			const key = await AsyncStorage.getItem("lyra.v1.state.key");
			if (key != null) cache.set("lyra.v1.state.key", key);
		} catch (e) {
			console.warn("[lyra storage] hydrate failed", e);
		}
		ready = true;
	};

	const enqueue = (op: Promise<void>): Promise<void> => {
		const p = op.catch((e) => {
			console.warn(
				"[lyra storage] write failed",
				e instanceof Error ? e.message : String(e),
			);
		});
		// Chain
		pendingWrites = pendingWrites.then(() => p).catch(() => {});
		return p;
	};

	return {
		hydrate: () => {
			if (hydratePromise) return hydratePromise;
			if (ready) return Promise.resolve();
			hydratePromise = doHydrate().finally(() => {});
			return hydratePromise;
		},
		getItem: (k) => {
			if (!ready) {
				console.warn("[lyra storage] getItem before hydrate", k);
			}
			return cache.get(k) ?? null;
		},
		setItem: (k, v) => {
			cache.set(k, v);
			// Enqueue async write and return promise for awaiting
			return enqueue(AsyncStorage.setItem(k, v) as Promise<void>);
		},
		removeItem: (k) => {
			cache.delete(k);
			return enqueue(AsyncStorage.removeItem(k) as Promise<void>);
		},
		flush: async () => {
			await pendingWrites;
		},
	};
}

function memoryFallback(): StorageLike & {
	getPrivateKey: () => Promise<string | null>;
	setPrivateKey: (value: string) => Promise<void>;
	deletePrivateKey: () => Promise<void>;
	hydrate?: () => Promise<void>;
	flush?: () => Promise<void>;
} {
	const map = new Map<string, string>();
	let privateKey: string | null = null;
	return {
		hydrate: async () => undefined,
		flush: async () => undefined,
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => {
			map.set(k, v);
		},
		removeItem: (k) => {
			map.delete(k);
		},
		getPrivateKey: async () => privateKey,
		setPrivateKey: async (value) => {
			privateKey = value;
		},
		deletePrivateKey: async () => {
			privateKey = null;
		},
	};
}

export type SecureLyraStorage = StorageLike & {
	getPrivateKey: () => Promise<string | null>;
	setPrivateKey: (value: string) => Promise<void>;
	deletePrivateKey: () => Promise<void>;
	hydrate?: () => Promise<void>;
	flush?: () => Promise<void>;
};

/** Combined storage: SecureStore for private key, SQLite/AsyncStorage/localStorage for the rest. */
export function createSecureLyraStorage(): SecureLyraStorage {
	const canUseWebLocal =
		Platform.OS === "web" &&
		typeof localStorage !== "undefined" &&
		typeof localStorage.getItem === "function";

	let bulk: StorageLike & {
		hydrate?: () => Promise<void>;
		flush?: () => Promise<void>;
	};

	if (canUseWebLocal) {
		bulk = {
			getItem: (k) => localStorage.getItem(k),
			setItem: (k, v) => {
				localStorage.setItem(k, v);
			},
			removeItem: (k) => {
				localStorage.removeItem(k);
			},
			hydrate: async () => undefined,
			flush: async () => undefined,
		};
	} else {
		// Try SQLite first, fallback to fixed AsyncStorage
		const sqlite = tryCreateSQLiteBulk();
		if (sqlite) {
			bulk = sqlite;
		} else {
			console.info(
				"[lyra storage] using AsyncStorage (fallback) — for durability add expo-sqlite",
			);
			bulk = createAsyncStorageBulk();
		}
	}

	return {
		getItem: (k) => bulk.getItem(k),
		setItem: (k, v) => {
			const res = bulk.setItem(k, v);
			// Return promise if async for callers that await
			return res as unknown as void;
		},
		removeItem: (k) => {
			const res = bulk.removeItem?.(k);
			return res as unknown as void;
		},
		hydrate: bulk.hydrate,
		flush: bulk.flush,
		getPrivateKey: async () => {
			try {
				return await SecureStore.getItemAsync(PRIVATE_KEY_ITEM);
			} catch {
				return null;
			}
		},
		setPrivateKey: async (value: string) => {
			try {
				await SecureStore.setItemAsync(PRIVATE_KEY_ITEM, value);
			} catch {
				// ignore — key remains in bulk state via normal persist
			}
		},
		deletePrivateKey: async () => {
			try {
				await SecureStore.deleteItemAsync(PRIVATE_KEY_ITEM);
			} catch {
				// ignore
			}
		},
	};
}

/** Strip private key from bulk JSON and write it to SecureStore when hydrating/persisting. */
export async function migratePrivateKeyToSecureStore(
	storage: SecureLyraStorage,
	stateKey = "lyra.v1.state",
): Promise<void> {
	try {
		if (storage.hydrate) await storage.hydrate();
		const raw = await Promise.resolve(storage.getItem(stateKey));
		if (!raw) return;
		const parsed = JSON.parse(raw) as { privateKey?: string | null };
		if (parsed.privateKey) {
			await storage.setPrivateKey(parsed.privateKey);
			const { privateKey: _drop, ...rest } = parsed as Record<string, unknown>;
			await Promise.resolve(
				storage.setItem(
					stateKey,
					JSON.stringify({ ...rest, privateKey: null }),
				),
			);
			if (storage.flush) await storage.flush();
		}
	} catch (e) {
		console.warn(
			"[lyra storage] migrate failed",
			e instanceof Error ? e.message : String(e),
		);
	}
}
