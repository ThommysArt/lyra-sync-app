import {
  EnvelopeSchema,
  type Envelope,
  type MessageType,
} from "@lyra-sync-app/protocol";

import { randomHex } from "./crypto-util";

export function createEnvelope(input: {
  type: MessageType;
  fromDeviceId: string;
  toDeviceId?: string;
  payload: unknown;
  id?: string;
  timestamp?: number;
}): Envelope {
  return {
    id: input.id ?? `env_${randomHex(8)}`,
    type: input.type,
    fromDeviceId: input.fromDeviceId,
    toDeviceId: input.toDeviceId,
    timestamp: input.timestamp ?? Date.now(),
    payload: input.payload,
  };
}

export function parseEnvelope(raw: unknown):
  | { ok: true; envelope: Envelope }
  | { ok: false; error: string } {
  const parsed = EnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid envelope" };
  }
  return { ok: true, envelope: parsed.data };
}
