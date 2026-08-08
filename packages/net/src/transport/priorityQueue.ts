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

export const NATIVE_HTTP_MAX_IN_FLIGHT = 48;
// Reserve 24 for interactive/transfers (3 parallel files × window 8)
export const MAX_SCAN_IN_FLIGHT = 24;
export const MAX_TRANSFER_IN_FLIGHT = 16;

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
      // Scan capped to 24 to reserve capacity for interactive transfers.
      // If higher-priority waiters exist, never exceed cap.
      // If no higher waiters and we still have spare total capacity, allow scan to borrow
      // idle interactive slots (up to total 48) for faster discovery when no transfers active.
      const hasHigher = queue.some((q) => q.lane < Lane.SCAN);
      if (hasHigher) return false;
      // Allow scan to use spare capacity when system is otherwise idle
      return inFlight < MAX_SCAN_IN_FLIGHT;
    }
    // Reserve 1 slot for PAIR when near capacity
    if (lane !== Lane.PAIR && inFlight >= NATIVE_HTTP_MAX_IN_FLIGHT - 1) {
      const hasPairWaiter = queue.some((q) => q.lane === Lane.PAIR);
      if (hasPairWaiter) return false;
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
