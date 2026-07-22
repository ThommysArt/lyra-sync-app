import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  base64ToDataUrl,
  dataUrlToBase64,
  generateDemoScreenFrame,
} from "./screen-frames";

describe("generateDemoScreenFrame", () => {
  it("builds a phone-sized frame with data URL", () => {
    const frame = generateDemoScreenFrame({
      platform: "android",
      width: 390,
      height: 844,
      now: 1_700_000_000_000,
      deviceName: "Pixel Test",
      battery: 55,
    });
    assert.equal(frame.width, 390);
    assert.equal(frame.height, 844);
    assert.ok(frame.dataUrl.startsWith("data:"));
    assert.ok(frame.dataUrl.length > 80);
  });

  it("builds a desktop-sized frame", () => {
    const frame = generateDemoScreenFrame({
      platform: "macos",
      width: 960,
      height: 600,
      now: 1_700_000_000_000,
    });
    assert.equal(frame.width, 960);
    assert.equal(frame.height, 600);
  });
});

describe("dataUrl base64 helpers", () => {
  it("round-trips base64 data URLs", () => {
    const raw = "aGVsbG8=";
    const dataUrl = base64ToDataUrl("image/jpeg", raw);
    const parsed = dataUrlToBase64(dataUrl);
    assert.ok(parsed);
    assert.equal(parsed!.mimeType, "image/jpeg");
    assert.equal(parsed!.dataBase64, raw);
  });

  it("returns null for non-base64 data URLs", () => {
    assert.equal(dataUrlToBase64("data:image/svg+xml;charset=utf-8,abc"), null);
  });
});
