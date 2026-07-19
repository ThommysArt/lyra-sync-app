export type PickedFile = {
  name: string;
  size: number;
  mimeType?: string;
  /** Relative path for folder picks (webkitdirectory) */
  relativePath?: string;
  /** File object when available (web File API) */
  file?: File;
  /**
   * In-memory bytes when pre-read for wire send.
   * Small files only; large files keep `file` and stream via `readFileInChunks`.
   */
  bytes?: Uint8Array;
};

/** Default eager-read cap (above this we stream from File on send). */
export const EAGER_READ_MAX_BYTES = 32 * 1024 * 1024;

/** Read a File into Uint8Array (capped for browser memory safety). */
export async function readFileBytes(
  file: File,
  maxBytes = EAGER_READ_MAX_BYTES,
): Promise<Uint8Array | undefined> {
  if (file.size > maxBytes) return undefined;
  const buf = await file.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Stream a File in chunks without loading the whole blob into RAM.
 * Used for large multi-hundred-MB sends over the wire.
 */
export async function* readFileInChunks(
  file: File,
  chunkSize = 256 * 1024,
): AsyncGenerator<Uint8Array, void, unknown> {
  // Prefer streams when available
  if (typeof file.stream === "function") {
    const reader = file.stream().getReader();
    let leftover = new Uint8Array(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (leftover.byteLength > 0) yield leftover;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      const next = new Uint8Array(leftover.byteLength + value.byteLength);
      next.set(leftover, 0);
      next.set(value, leftover.byteLength);
      leftover = next;
      while (leftover.byteLength >= chunkSize) {
        yield leftover.subarray(0, chunkSize);
        leftover = leftover.subarray(chunkSize);
      }
    }
    return;
  }

  // Fallback: File.slice + arrayBuffer in windows
  let offset = 0;
  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkSize);
    const buf = await file.slice(offset, end).arrayBuffer();
    yield new Uint8Array(buf);
    offset = end;
  }
}

/** Materialize bytes for wire: eager if small, else concatenate streamed chunks (still memory).
 * For multi-GB use `streamFileToWire` in transfer path instead of materializing.
 */
export async function materializeFileBytes(
  file: File,
  maxMaterialize = 256 * 1024 * 1024,
): Promise<Uint8Array | undefined> {
  if (file.size <= EAGER_READ_MAX_BYTES) {
    return readFileBytes(file);
  }
  if (file.size > maxMaterialize) {
    // Too large to hold entirely — caller should stream
    return undefined;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of readFileInChunks(file)) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** Open the browser file picker and return selected file metadata (+ bytes when small enough). */
export function pickFiles(options?: {
  multiple?: boolean;
  accept?: string;
  /** Enable directory picker (folder transfer relative paths) */
  directory?: boolean;
}): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options?.multiple ?? true;
    if (options?.accept) input.accept = options.accept;
    if (options?.directory) {
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
    }
    input.style.display = "none";
    document.body.appendChild(input);

    const cleanup = () => {
      input.remove();
    };

    input.addEventListener("change", () => {
      void (async () => {
        const list = input.files;
        if (!list || list.length === 0) {
          cleanup();
          resolve([]);
          return;
        }
        const files: PickedFile[] = [];
        for (const f of Array.from(list)) {
          const relativePath =
            (f as File & { webkitRelativePath?: string }).webkitRelativePath || undefined;
          // Eager-read only small files; large keep File handle for streaming send
          const bytes = await readFileBytes(f);
          files.push({
            name: f.name,
            size: f.size,
            mimeType: f.type || undefined,
            relativePath: relativePath || undefined,
            file: f,
            bytes,
          });
        }
        cleanup();
        resolve(files);
      })();
    });

    // User cancelled — some browsers fire focus without change
    window.addEventListener(
      "focus",
      () => {
        setTimeout(() => {
          if (!input.files?.length) {
            cleanup();
            resolve([]);
          }
        }, 300);
      },
      { once: true },
    );

    input.click();
  });
}

/** Map DataTransfer files (drag-and-drop) to PickedFile. */
export function filesFromDataTransfer(dt: DataTransfer | null): PickedFile[] {
  if (!dt?.files?.length) return [];
  return Array.from(dt.files).map((f) => ({
    name: f.name,
    size: f.size,
    mimeType: f.type || undefined,
    file: f,
  }));
}
