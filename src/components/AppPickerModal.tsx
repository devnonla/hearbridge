import { Button, Empty, Modal } from "devnonla-ui";
import { Check, RefreshCw } from "lucide-react";
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
    <Modal
      open={open}
      onCancel={() => onOpenChange(false)}
      title="Chọn app để nghe"
      width="min(92vw, 860px)"
      centered
      footer={null}
      styles={{ body: { padding: 0 } }}
    >
      <div className="flex items-center justify-between gap-3 px-5 pb-3">
        <p className="text-muted-foreground text-sm">
          HearBridge chỉ bắt âm thanh của app được chọn.
        </p>
        <Button
          size="small"
          loading={refreshing}
          icon={<RefreshCw className="size-3.5" />}
          onClick={() => onRefresh()}
        >
          Tải lại
        </Button>
      </div>

      <div className="max-h-[min(64dvh,560px)] overflow-y-auto px-5 pb-5">
        {apps.length === 0 ? (
          <Empty
            icon="monitor"
            title="Chưa thấy app nào đang phát âm thanh"
            description="Mở Zoom, Meet, Discord hoặc trình duyệt rồi bấm Tải lại."
            action={
              <Button loading={refreshing} onClick={() => onRefresh()}>
                Tải lại
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {apps.map((a) => {
              const selected = a.bundleId === selectedId;
              const preview = pngSrc(a.previewBase64);
              const icon = pngSrc(a.iconBase64);
              return (
                <button
                  key={a.bundleId}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    onSelect(a.bundleId);
                    onOpenChange(false);
                  }}
                  className={cn(
                    "group bg-card relative flex flex-col overflow-hidden rounded-lg border text-left transition-colors",
                    "focus-visible:ring-focus-ring outline-none focus-visible:ring-2",
                    selected
                      ? "border-selected ring-selected ring-1"
                      : "border-border hover:border-input-focus",
                  )}
                >
                  <div className="bg-bar relative aspect-[16/10] w-full overflow-hidden">
                    {preview ? (
                      <img
                        src={preview}
                        alt=""
                        className="size-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.03]"
                      />
                    ) : (
                      <div className="flex size-full items-center justify-center">
                        {icon ? (
                          <img src={icon} alt="" className="size-12" />
                        ) : (
                          <span className="text-muted-foreground text-xl font-semibold">
                            {a.name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                      </div>
                    )}
                    {selected && (
                      <span className="bg-selected text-on-selected absolute top-2 right-2 flex size-5 items-center justify-center rounded-full shadow">
                        <Check className="size-3" strokeWidth={3} />
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 px-2.5 py-2">
                    {icon && <img src={icon} alt="" className="size-5 shrink-0 rounded" />}
                    <span className="truncate text-sm font-medium">{a.name}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}
