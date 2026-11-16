import { Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { AudioApp } from "@/types";

function pngSrc(b64?: string | null) {
  if (!b64) return null;
  return `data:image/png;base64,${b64}`;
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apps: AudioApp[];
  selectedId: string;
  onSelect: (bundleId: string) => void;
  onRefresh: () => void;
  refreshing?: boolean;
};

export function AppPickerModal({
  open,
  onOpenChange,
  apps,
  selectedId,
  onSelect,
  onRefresh,
  refreshing,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(90dvh,48rem)] w-[min(96vw,52rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        showCloseButton
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 text-left">
          <div className="flex items-center justify-between gap-3 pr-8">
            <div>
              <DialogTitle>Chọn app để nghe</DialogTitle>
              <DialogDescription className="text-xs">
                Chỉ bắt audio của app được chọn.
              </DialogDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={refreshing}
              onClick={() => onRefresh()}
            >
              <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
              Tải lại
            </Button>
          </div>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="px-4 py-4">
            {apps.length === 0 ? (
              <div className="border-border rounded-xl border border-dashed px-4 py-12 text-center text-sm">
                <p className="font-medium">Chưa thấy app nào</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  Mở Discord / Chrome / Zoom rồi bấm Tải lại.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-4 gap-3">
                {apps.map((a) => {
                  const selected = a.bundleId === selectedId;
                  const preview = pngSrc(a.previewBase64);
                  const icon = pngSrc(a.iconBase64);
                  return (
                    <button
                      key={a.bundleId}
                      type="button"
                      onClick={() => {
                        onSelect(a.bundleId);
                        onOpenChange(false);
                      }}
                      className={cn(
                        "relative flex flex-col overflow-hidden rounded-xl border text-left transition",
                        selected
                          ? "border-primary ring-primary/30 ring-1"
                          : "border-border hover:bg-accent/30",
                      )}
                    >
                      <div className="bg-muted relative aspect-[5/3] w-full overflow-hidden">
                        {preview ? (
                          <img
                            src={preview}
                            alt=""
                            className="size-full object-cover object-top"
                          />
                        ) : (
                          <div className="flex size-full items-center justify-center bg-zinc-100 dark:bg-zinc-800">
                            {icon ? (
                              <img src={icon} alt="" className="size-12" />
                            ) : (
                              <span className="text-muted-foreground text-lg font-semibold">
                                {a.name.slice(0, 1).toUpperCase()}
                              </span>
                            )}
                          </div>
                        )}
                        {icon && preview && (
                          <img
                            src={icon}
                            alt=""
                            className="absolute bottom-1.5 left-1.5 size-7 rounded-md shadow"
                          />
                        )}
                        {selected && (
                          <span className="bg-primary text-primary-foreground absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full">
                            <Check className="size-3" />
                          </span>
                        )}
                      </div>
                      <p className="truncate px-2 py-1.5 text-xs font-medium">{a.name}</p>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
