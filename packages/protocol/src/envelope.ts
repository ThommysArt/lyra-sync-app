import { z } from "zod";
import { LyraMessageTypeSchema, type LyraMessageType } from "./messages.js";

export const LyraSealSchema = z.object({
  v: z.literal(1),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
});
export type LyraSeal = z.infer<typeof LyraSealSchema>;

export const LyraEnvelopeSchema = z.object({
  id: z.string().min(1),
  type: LyraMessageTypeSchema,
  fromDeviceId: z.string().min(1),
  toDeviceId: z.string().optional(),
  createdAt: z.number(),
  payload: z.unknown(),
  seal: LyraSealSchema.optional(),
});

export type LyraEnvelope = z.infer<typeof LyraEnvelopeSchema>;

export function createEnvelope(
  type: LyraMessageType,
  fromDeviceId: string,
  payload: unknown,
  opts?: { toDeviceId?: string; id?: string; createdAt?: number; seal?: LyraSeal },
): LyraEnvelope {
  return {
    id: opts?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    type,
    fromDeviceId,
    toDeviceId: opts?.toDeviceId,
    createdAt: opts?.createdAt ?? Date.now(),
    payload,
    seal: opts?.seal,
  };
}

export function parseEnvelope(data: unknown): LyraEnvelope {
  return LyraEnvelopeSchema.parse(data);
}

export function isLyraEnvelope(data: unknown): data is LyraEnvelope {
  return LyraEnvelopeSchema.safeParse(data).success;
}
