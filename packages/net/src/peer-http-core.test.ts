import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DeviceIdentity } from "@lyra-sync-app/protocol";

import { createPeerHttpCore } from "./peer-http-core";

const identity: DeviceIdentity = {
  id: "core_test_dev",
  name: "Test Phone",
  type: "mobile",
  platform: "android",
  fingerprint: "coretestfingerprint0001",
  publicKey: "pub_core_test",
  createdAt: Date.now(),
};

describe("createPeerHttpCore", () => {
  it("serves /lyra/info and health", async () => {
    const core = createPeerHttpCore({
      getIdentity: () => identity,
      getPort: () => 53317,
      getLanHost: () => "192.168.1.50",
    });

    const health = await core.handle({
      method: "GET",
      path: "/lyra/health",
      headers: {},
    });
    assert.equal(health.status, 200);
    const healthBody = JSON.parse(health.body) as { ok: boolean; deviceId: string };
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.deviceId, identity.id);

    const info = await core.handle({
      method: "GET",
      path: "/lyra/info",
      headers: {},
    });
    assert.equal(info.status, 200);
    const infoBody = JSON.parse(info.body) as {
      identity: { id: string; name: string };
      host?: string;
      port?: number;
    };
    assert.equal(infoBody.identity.id, identity.id);
    assert.equal(infoBody.host, "192.168.1.50");
    assert.equal(infoBody.port, 53317);
  });

  it("advertises pairing offer on /lyra/info", async () => {
    const core = createPeerHttpCore({
      getIdentity: () => identity,
      getPort: () => 53319,
      getPairingOffer: () => ({
        codeHash: "abc123hash",
        token: "tok_test",
        expiresAt: Date.now() + 60_000,
      }),
    });

    const info = await core.handle({
      method: "GET",
      path: "/lyra/info",
      headers: {},
    });
    const body = JSON.parse(info.body) as {
      pairing?: { codeHash: string; token: string };
    };
    assert.equal(body.pairing?.codeHash, "abc123hash");
    assert.equal(body.pairing?.token, "tok_test");
  });
});
