/**
 * Priority lanes for native TCP concurrency.
 * PAIR (pair long-poll) > INTERACTIVE (clipboard/file/auth) > SCAN (discovery probes)
 * Scan yields to interactive work so clipboard/file never starve behind /24 scan.
 */

export const Lane = {
  PAIR: 0,
  INTERACTIVE: 1,
  SCAN: 2,
} as const;
export type Lane = (typeof Lane)[keyof typeof Lane];

export const NATIVE_HTTP_MAX_IN_FLIGHT = 8;
// How many SCAN slots may be in-flight when INTERACTIVE is waiting.
// We cap concurrent SCAN to 4 so at least 4 slots remain for interactive.
export const MAX_SCAN_IN_FLIGHT = 4;

type Waiter = {
  lane: Lane;
  resolve: () => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  enqueuedAt: number;
};

let inFlight = 0;
let scanInFlight = 0;
const queue: Waiter[] = [];

function detach(w: Waiter) {
  const i = queue.indexOf(w);
  if (i >= 0) queue.splice(i, 1);
  if (w.signal && w.onAbort) {
    try {
      w.signal.removeEventListener("abort", w.onAbort);
    } catch {}
  }
}

function canTakeSlot(lane: Lane): boolean {
  if (inFlight < NATIVE_HTTP_MAX_IN_FLIGHT) {
    if (lane === Lane.SCAN && scanInFlight >= MAX_SCAN_IN_FLIGHT) {
      // If higher-priority waiters exist, don't take last scan slots
      const hasHigher = queue.some((q) => q.lane < Lane.SCAN);
      if (hasHigher) return false;
      // Even without higher waiters, cap scan
      return false;
    }
    return true;
  }
  return false;
}

function dequeueAndRun() {
  if (queue.length === 0) return;
  // Pick lowest lane value (highest priority) FIFO within lane
  let bestIdx = 0;
  for (let i = 1; i < queue.length; i++) {
    if (queue[i]!.lane < queue[bestIdx]!.lane) bestIdx = i;
  }
  const candidate = queue[bestIdx]!;
  if (!canTakeSlot(candidate.lane)) return;
  queue.splice(bestIdx, 1);
  if (candidate.signal && candidate.onAbort) {
    try {
      candidate.signal.removeEventListener("abort", candidate.onAbort);
    } catch {}
  }
  candidate.resolve();
}

export async function withPrioritySlot<T>(fn: () => Promise<T>, lane: Lane = Lane.INTERACTIVE, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) throw new Error("Aborted");

  if (!canTakeSlot(lane)) {
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = { lane, resolve, reject, signal, enqueuedAt: Date.now() };
      w.onAbort = () => {
        detach(w);
        reject(new Error("Aborted"));
      };
      queue.push(w);
      if (signal) signal.addEventListener("abort", w.onAbort!, { once: true });
    });
  }

  if (signal?.aborted) throw new Error("Aborted");

  inFlight++;
  if (lane === Lane.SCAN) scanInFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    if (lane === Lane.SCAN) scanInFlight--;
    // Wake next waiter that can now fit
    dequeueAndRun();
    // If still not taking (scan-capped), try again after scan slot freed
    // Loop to drain
    while (queue.length > 0) {
      const before = queue.length;
      dequeueAndRun();
      if (queue.length === before) break;
    }
  }
}

// For tests / introspection
export function __queueState() {
  return { inFlight, scanInFlight, queued: queue.length, lanes: queue.map((q) => q.lane) };
}
export function __resetQueue() {
  inFlight = 0;
  scanInFlight = 0;
  queue.length = 0;
}
