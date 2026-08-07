/**
 * SQLite KV store for Electron main process.
 * Replaces Chromium localStorage for Lyra state persistence.
 * Uses Node's built-in node:sqlite when available (Node 22+), else better-sqlite3.
 * One DB per variant userData dir.
 */
import { app } from "electron";
import path from "node:path";
import { mkdirSync } from "node:fs";

type DbHandle = {
  prepare: (sql: string) => { get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[]; run: (...args: unknown[]) => unknown };
  exec: (sql: string) => void;
  close: () => void;
  pragma?: (s: string) => unknown;
};

let db: DbHandle | null = null;
let dbPath: string | null = null;

function getDbPath(): string {
  if (dbPath) return dbPath;
  const userData = app.getPath("userData");
  try {
    mkdirSync(userData, { recursive: true });
  } catch {}
  dbPath = path.join(userData, "lyra.db");
  return dbPath;
}

function openDb(): DbHandle {
  if (db) return db;
  const p = getDbPath();
  // Prefer Node's built-in sqlite (no native build, works in AppImage)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => DbHandle };
    if (sqlite?.DatabaseSync) {
      const instance = new sqlite.DatabaseSync(p) as DbHandle;
      try {
        instance.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`);
      } catch (e) {
        console.warn("[lyra sqlite] pragma failed", e);
      }
      instance.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
      db = instance;
      console.log(`[lyra sqlite] opened ${p} via node:sqlite`);
      return instance;
    }
  } catch (e) {
    console.warn("[lyra sqlite] node:sqlite unavailable, trying better-sqlite3", e instanceof Error ? e.message : String(e));
  }
  // Fallback to better-sqlite3 (prebuilds present in dev)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite3 = require("better-sqlite3") as unknown as new (path: string) => DbHandle;
  const instance = new BetterSqlite3(p);
  try {
    (instance as unknown as { pragma?: (s: string) => unknown }).pragma?.("journal_mode = WAL");
    (instance as unknown as { pragma?: (s: string) => unknown }).pragma?.("synchronous = NORMAL");
  } catch (e) {
    console.warn("[lyra sqlite] pragma failed", e);
  }
  instance.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`);
  db = instance;
  console.log(`[lyra sqlite] opened ${p} via better-sqlite3`);
  return instance;
}

export function getDb(): DbHandle {
  return openDb();
}

export function kvGet(key: string): string | null {
  try {
    const row = getDb().prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch (e) {
    console.error("[lyra sqlite] kvGet failed", key, e instanceof Error ? e.message : String(e));
    return null;
  }
}

export function kvSet(key: string, value: string): void {
  try {
    getDb().prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  } catch (e) {
    console.error("[lyra sqlite] kvSet failed", key, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

export function kvRemove(key: string): void {
  try {
    getDb().prepare("DELETE FROM kv WHERE key = ?").run(key);
  } catch (e) {
    console.error("[lyra sqlite] kvRemove failed", key, e instanceof Error ? e.message : String(e));
  }
}

export function kvGetAllKeys(): string[] {
  try {
    const rows = getDb().prepare("SELECT key FROM kv").all() as { key: string }[];
    return rows.map((r) => r.key);
  } catch (e) {
    console.error("[lyra sqlite] kvGetAllKeys failed", e instanceof Error ? e.message : String(e));
    return [];
  }
}

export function kvGetAll(): Record<string, string> {
  try {
    const rows = getDb().prepare("SELECT key, value FROM kv").all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  } catch (e) {
    console.error("[lyra sqlite] kvGetAll failed", e instanceof Error ? e.message : String(e));
    return {};
  }
}

export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {}
    db = null;
  }
}
