/** Read text from the system clipboard (falls back to empty on denial). */
export async function readSystemClipboard(): Promise<string> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      return (await navigator.clipboard.readText()) || "";
    }
  } catch {
    // permission denied or insecure context
  }
  return "";
}

/** Write text to the system clipboard. Returns false if unavailable. */
export async function writeSystemClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied
  }
  return false;
}
