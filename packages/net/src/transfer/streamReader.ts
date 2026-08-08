/**
 * Platform-agnostic streaming reader for file bytes.
 * Avoids loading whole file into RAM.
 */

export type SliceReader = (fileIndex: number, offset: number, length: number) => Promise<Uint8Array>;

export type FileSource = {
  name: string;
  size: number;
  mimeType?: string;
  checksum?: string;
  bytes?: Uint8Array;
  uri?: string;
  file?: unknown; // Web File / Blob
};

export function createWebSliceReader(files: FileSource[]): SliceReader {
  return async (idx, offset, len) => {
    const f = files[idx]!;
    if (f.bytes) return f.bytes.subarray(offset, Math.min(f.bytes.byteLength, offset + len));
    if (f.file) {
      const fileObj = f.file as unknown as { slice: (s: number, e: number) => Blob };
      const slice = fileObj.slice(offset, offset + len);
      const buf = await slice.arrayBuffer();
      return new Uint8Array(buf);
    }
    throw new Error(`No bytes or file for ${f.name}`);
  };
}

export function createMemorySliceReader(files: FileSource[]): SliceReader {
  return async (idx, offset, len) => {
    const f = files[idx]!;
    if (!f.bytes) throw new Error(`Missing bytes for ${f.name}`);
    return f.bytes.subarray(offset, Math.min(f.bytes.byteLength, offset + len));
  };
}
