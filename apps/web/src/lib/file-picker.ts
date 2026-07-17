export type PickedFile = {
  name: string;
  size: number;
  mimeType?: string;
  /** File object when available (web File API) */
  file?: File;
};

/** Open the browser file picker and return selected file metadata. */
export function pickFiles(options?: {
  multiple?: boolean;
  accept?: string;
}): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options?.multiple ?? true;
    if (options?.accept) input.accept = options.accept;
    input.style.display = "none";
    document.body.appendChild(input);

    const cleanup = () => {
      input.remove();
    };

    input.addEventListener("change", () => {
      const list = input.files;
      if (!list || list.length === 0) {
        cleanup();
        resolve([]);
        return;
      }
      const files: PickedFile[] = Array.from(list).map((f) => ({
        name: f.name,
        size: f.size,
        mimeType: f.type || undefined,
        file: f,
      }));
      cleanup();
      resolve(files);
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
