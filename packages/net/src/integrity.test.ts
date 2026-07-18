import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Transfer } from "@lyra-sync-app/protocol";

import {
  applyChunkProgress,
  canResumeTransfer,
  checksumBytes,
  getResumeState,
  nextSendOffset,
  verifyTransferIntegrity,
} from "./integrity";

function baseTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: "tx_1",
    direction: "sent",
    deviceId: "d1",
    deviceName: "Peer",
    files: [
      { name: "a.txt", size: 100 },
      { name: "b.txt", size: 200 },
    ],
    totalBytes: 300,
    transferredBytes: 0,
    status: "paused",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("integrity + resume", () => {
  it("checksums content stably", async () => {
    const a = await checksumBytes("hello");
    const b = await checksumBytes("hello");
    const c = await checksumBytes("world");
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("builds resume state from session progress", () => {
    const tx = baseTransfer({ transferredBytes: 150, status: "paused" });
    const resume = getResumeState(tx);
    assert.equal(resume.totalOffset, 150);
    assert.equal(resume.fileOffsets[0], 100);
    assert.equal(resume.fileOffsets[1], 50);
    assert.equal(nextSendOffset(tx), 150);
    assert.equal(canResumeTransfer(tx), true);
  });

  it("applies chunk progress", () => {
    const tx = baseTransfer();
    const next = applyChunkProgress(tx, 120);
    assert.equal(next.transferredBytes, 120);
    assert.equal(next.resumeOffset, 120);
  });

  it("verifies declared checksums", async () => {
    const sum = await checksumBytes("file-a");
    const tx = baseTransfer({
      files: [{ name: "a.txt", size: 100, checksum: sum }],
      totalBytes: 100,
    });
    const ok = await verifyTransferIntegrity(tx, { "a.txt": sum });
    assert.equal(ok.ok, true);
    const bad = await verifyTransferIntegrity(tx, { "a.txt": "deadbeef" });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.failed, ["a.txt"]);
  });
});
