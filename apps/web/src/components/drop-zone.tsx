import { useCallback, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { filesFromDataTransfer, type PickedFile } from "@/lib/file-picker";

export function DropZone({
  disabled,
  onDropFiles,
  children,
  className,
  label = "Drop files to send",
}: {
  disabled?: boolean;
  onDropFiles: (files: PickedFile[]) => void;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  const [active, setActive] = useState(false);

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setActive(true);
    },
    [disabled],
  );

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setActive(false);
      if (disabled) return;
      const files = filesFromDataTransfer(e.dataTransfer);
      if (files.length) onDropFiles(files);
    },
    [disabled, onDropFiles],
  );

  return (
    <div
      className={cn("relative", className)}
      onDragOver={onDragOver}
      onDragEnter={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
      {active && !disabled ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-primary bg-primary/15 backdrop-blur-[1px]">
          <p className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow-sm">
            {label}
          </p>
        </div>
      ) : null}
    </div>
  );
}
