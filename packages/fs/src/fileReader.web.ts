/**
 * Web file reader — stable, no native deps.
 * Only handles browser File / bytes. Never touches expo-file-system.
 */

export type FileForWeb = {
  name: string;
  size: number;
  bytes?: Uint8Array;
  file?: File | Blob;
  uri?: string;
};

export function createReadSlice(files: FileForWeb[]) {
  // Web never uses content:// — picker returns File objects via <input> or drag-drop
  return async (fileIndex: number, offset: number, length: number): Promise<Uint8Array> => {
    const f = files[fileIndex];
    if (!f) throw new Error(`No file at index ${fileIndex}`);
    if (f.bytes) {
      return f.bytes.subarray(offset, Math.min(f.bytes.byteLength, offset + length));
    }
    if (f.file) {
      const slice = (f.file as File).slice(offset, offset + length);
      const buf = await slice.arrayBuffer();
      return new Uint8Array(buf);
    }
    // Fallback: if uri is present on web (e.g., blob:), try fetch
    if (f.uri) {
      const res = await fetch(f.uri);
      if (!res.ok) throw new Error(`fetch ${f.uri.slice(0, 60)} failed ${res.status}`);
      const ab = await res.arrayBuffer();
      const full = new Uint8Array(ab);
      return full.subarray(offset, Math.min(full.byteLength, offset + length));
    }
    throw new Error(`No bytes or file for ${f.name}`);
  };
}

export async function copyToStableCache(uri: string): Promise<string> {
  // No-op on web — already stable
  return uri;
}
