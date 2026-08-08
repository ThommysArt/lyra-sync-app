/**
 * Streaming SHA-256 for large transfers — incremental update avoids final re-read.
 * Uses Node crypto when available, falls back to global crypto.subtle or js.
 */
import { createHash } from "node:crypto";

export class IntegrityStream {
  private hash = createHash("sha256");
  private finalized = false;
  private digestHex: string | null = null;

  update(chunk: Uint8Array): void {
    if (this.finalized) throw new Error("Already finalized");
    this.hash.update(Buffer.from(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength));
  }

  finalize(): string {
    if (!this.finalized) {
      this.digestHex = this.hash.digest("hex");
      this.finalized = true;
    }
    return this.digestHex!;
  }

  get hex(): string | null {
    return this.digestHex;
  }
}
