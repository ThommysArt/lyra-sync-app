import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createAuthChallenge,
  createAuthResponseWithSharedSecret,
  createFirstContactAuthResponse,
  derivePairingSharedSecret,
  verifyAuthResponse,
} from "./auth";

describe("auth challenge-response", () => {
  const identity = {
    id: "dev_a",
    fingerprint: "abc12345deadbeef",
    publicKey: "pub_aaaa",
  };

  it("accepts first-contact identity-binding proof", async () => {
    const challenge = await createAuthChallenge({ fingerprint: "serverfp01234567" });
    const response = await createFirstContactAuthResponse({ challenge, identity });
    const result = await verifyAuthResponse({ challenge, response });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.ok(result.session.sessionToken.length > 8);
      assert.equal(result.session.deviceId, "dev_a");
    }
  });

  it("accepts shared-secret proof after pairing", async () => {
    const sharedSecret = await derivePairingSharedSecret({
      pairingToken: "tok_123",
      localPrivateKey: "priv_local",
      remotePublicKey: "pub_remote",
    });
    const challenge = await createAuthChallenge({ fingerprint: "serverfp01234567" });
    const response = await createAuthResponseWithSharedSecret({
      challenge,
      identity,
      sharedSecret,
    });
    const result = await verifyAuthResponse({ challenge, response, sharedSecret });
    assert.equal(result.ok, true);
  });

  it("rejects wrong fingerprint when expected", async () => {
    const challenge = await createAuthChallenge({ fingerprint: "serverfp01234567" });
    const response = await createFirstContactAuthResponse({ challenge, identity });
    const result = await verifyAuthResponse({
      challenge,
      response,
      expectedFingerprint: "otherfingerprint000",
    });
    assert.equal(result.ok, false);
  });

  it("rejects expired challenge", async () => {
    const challenge = await createAuthChallenge({ fingerprint: "serverfp01234567" });
    challenge.expiresAt = Date.now() - 1;
    const response = await createFirstContactAuthResponse({ challenge, identity });
    const result = await verifyAuthResponse({ challenge, response });
    assert.equal(result.ok, false);
  });
});
