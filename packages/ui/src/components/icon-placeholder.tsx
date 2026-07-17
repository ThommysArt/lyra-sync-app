import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleCheckIcon,
  CircleIcon,
  InfoIcon,
  Loader2Icon,
  LoaderCircleIcon,
  type LucideIcon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "@lyra-sync-app/ui/lib/utils";

/** Maps shadcn registry IconPlaceholder props onto lucide-react icons. */
const LUCIDE_MAP: Record<string, LucideIcon> = {
  XIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CircleIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
  Cancel01Icon: XIcon,
  IconX: XIcon,
  IconCheck: CheckIcon,
  IconChevronDown: ChevronDownIcon,
  IconChevronRight: ChevronRightIcon,
  IconChevronUp: ChevronUpIcon,
  RiCloseLine: XIcon,
};

type Props = ComponentProps<"svg"> & {
  lucide?: string;
  tabler?: string;
  hugeicons?: string;
  phosphor?: string;
  remixicon?: string;
};

export function IconPlaceholder({
  lucide,
  className,
  ...props
}: Props) {
  const Icon = (lucide && LUCIDE_MAP[lucide]) || XIcon;
  return <Icon className={cn("size-4", className)} {...props} />;
}
