/**
 * Browser / Electron display capture → JPEG frames for P2P screen share.
 *
 * Electron: main process must install setDisplayMediaRequestHandler +
 * permission handlers for "display-capture" (see apps/desktop/electron/main.ts).
 * Browser: getDisplayMedia prompts the system picker (HTTPS or localhost).
 */

export type CapturedFrame = {
  dataBase64: string;
  width: number;
  height: number;
  mimeType: "image/jpeg";
  capturedAt: number;
};

export type DisplayCaptureHandle = {
  stop: () => void;
  width: number;
  height: number;
  /** Underlying MediaStream (for diagnostics). */
  stream: MediaStream;
};

export type StartDisplayCaptureOpts = {
  maxEdge?: number;
  fps?: number;
  quality?: number;
  onFrame: (frame: CapturedFrame) => void;
  onError?: (message: string) => void;
  onEnded?: () => void;
};

function dataUrlToBase64Body(dataUrl: string): string | null {
  const i = dataUrl.indexOf(",");
  if (i < 0) return null;
  return dataUrl.slice(i + 1);
}

function scaleToMaxEdge(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h };
  const scale = maxEdge / long;
  return {
    width: Math.max(2, Math.round(w * scale)),
    height: Math.max(2, Math.round(h * scale)),
  };
}

/** Human-readable getDisplayMedia / capture failures. */
export function formatCaptureError(err: unknown): string {
  if (err instanceof DOMException) {
    if (err.name === "NotAllowedError") {
      return "Screen share permission denied — allow display capture when prompted";
    }
    if (err.name === "NotFoundError") {
      return "No screen or window available to share";
    }
    if (err.name === "NotSupportedError") {
      return "Screen capture is not supported in this environment";
    }
    if (err.name === "AbortError") {
      return "Screen share picker was cancelled";
    }
    return err.message || err.name;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Request display media (system/window picker) and stream JPEG frames.
 * Caller must stop() when the session ends.
 */
export async function startDisplayCapture(
  opts: StartDisplayCaptureOpts,
): Promise<DisplayCaptureHandle> {
  const maxEdge = opts.maxEdge ?? 720;
  const fps = Math.min(30, Math.max(1, opts.fps ?? 12));
  const quality = Math.min(1, Math.max(0.2, opts.quality ?? 0.72));

  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("getDisplayMedia is not available — use the desktop app or a modern browser");
  }

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: fps, max: Math.max(fps, 24) },
      // Prefer full monitor when the browser exposes the constraint
      displaySurface: "monitor",
    } as MediaTrackConstraints,
    audio: false,
  });

  const track = stream.getVideoTracks()[0];
  if (!track) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("No video track from display capture");
  }

  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;
  await video.play();

  // Wait one frame so videoWidth/Height are set
  await new Promise<void>((resolve) => {
    if (video.videoWidth > 0) {
      resolve();
      return;
    }
    video.onloadedmetadata = () => resolve();
    setTimeout(() => resolve(), 800);
  });

  const srcW = video.videoWidth || 1280;
  const srcH = video.videoHeight || 720;
  const { width, height } = scaleToMaxEdge(srcW, srcH, maxEdge);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("Canvas 2D unavailable for frame encoding");
  }

  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const paint = () => {
    if (stopped || !ctx) return;
    try {
      ctx.drawImage(video, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const dataBase64 = dataUrlToBase64Body(dataUrl);
      if (!dataBase64) return;
      opts.onFrame({
        dataBase64,
        width,
        height,
        mimeType: "image/jpeg",
        capturedAt: Date.now(),
      });
    } catch (e) {
      opts.onError?.(formatCaptureError(e));
    }
  };

  const intervalMs = Math.max(40, Math.round(1000 / fps));
  timer = setInterval(paint, intervalMs);
  // First frame ASAP
  paint();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    try {
      video.pause();
      video.srcObject = null;
    } catch {
      // ignore
    }
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        // ignore
      }
    });
  };

  track.addEventListener("ended", () => {
    stop();
    opts.onEnded?.();
  });

  return { stop, width, height, stream };
}

/** @deprecated Prefer device-geometry.computeSimulatorLayout */
export const PHONE_ASPECT = 9 / 19.5;
export const DESKTOP_ASPECT = 16 / 9;
