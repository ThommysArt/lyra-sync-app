/**
 * Ephemeral self-signed TLS material for LAN peer servers (spec §6 HTTPS option).
 * Uses `openssl` on PATH when available.
 */
import { createHash, generateKeyPairSync, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SelfSignedTls = {
  key: string;
  cert: string;
  fingerprintSha256: string;
};

/**
 * Create a short-lived self-signed certificate for Lyra peer HTTPS.
 * Requires `openssl` on PATH.
 */
export function createSelfSignedTls(opts?: {
  commonName?: string;
  days?: number;
}): SelfSignedTls {
  const cn = (opts?.commonName ?? "lyra-peer.local").replace(/[^a-zA-Z0-9._-]/g, "-");
  const days = opts?.days ?? 365;

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const dir = mkdtempSync(join(tmpdir(), "lyra-tls-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    writeFileSync(keyPath, privateKey);
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-new",
        "-key",
        keyPath,
        "-out",
        certPath,
        "-days",
        String(days),
        "-subj",
        `/CN=${cn}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const cert = readFileSync(certPath, "utf8");
    const x509 = new X509Certificate(cert);
    const fingerprintSha256 = createHash("sha256").update(x509.raw).digest("hex");
    return { key: privateKey, cert, fingerprintSha256 };
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/** Try generate self-signed; return null if openssl unavailable. */
export function tryCreateSelfSignedTls(opts?: {
  commonName?: string;
  days?: number;
}): SelfSignedTls | null {
  try {
    return createSelfSignedTls(opts);
  } catch (e) {
    console.warn(
      "[lyra tls] self-signed generation failed:",
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
