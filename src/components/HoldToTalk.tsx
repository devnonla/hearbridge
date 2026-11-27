import { Kbd, Segmented } from "devnonla-ui";
import { Mic } from "lucide-react";
import { cn } from "@/lib/utils";

type TalkMode = "hold" | "continuous";

type Props = {
  holding: boolean;
  busy: boolean;
  level: number;
  status: string;
  fromLabel: string;
  toLabel: string;
  /** Where the translated voice plays (the device the other side hears). */
  outputLabel: string;
  /** "Phiên dịch giọng tôi" is on. */
  enabled: boolean;
  mode: TalkMode;
  onModeChange: (mode: TalkMode) => void;
  /** Continuous mode: a sentence is being captured right now. */
  autoTalking: boolean;
  onStart: () => void;
  onStop: () => void;
};

/**
 * Your-voice bar. "Giữ để nói": push-to-talk (also Space / ⌥, handled in the hook).
 * "Nói liên tục": the mic stays open and sentences are cut on pauses.
 */
export function HoldToTalk({
  holding,
  busy,
  level,
  status,
  fromLabel,
  toLabel,
  outputLabel,
  enabled,
  mode,
  onModeChange,
  autoTalking,
  onStart,
  onStop,
}: Props) {
  const continuous = mode === "continuous";
  const live = holding || (continuous && autoTalking);

  const title = !enabled
    ? "Phiên dịch giọng tôi đang tắt"
    : continuous
      ? autoTalking
        ? "Đang nghe bạn… ngừng một chút là app tự dịch"
        : "Nói liên tục · đang chờ bạn nói"
      : holding
        ? "Đang ghi… thả ra để dịch và đọc"
        : "Giữ để nói";

  const pad = (
    <>
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          live ? "bg-white/20" : "bg-bar text-muted-foreground",
          continuous && enabled && !autoTalking && "hb-pulse",
        )}
      >
        <Mic className="size-4" />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{title}</span>
        <span
          className={cn(
            "block truncate text-xs",
            live ? "text-on-brand/80" : "text-tertiary-foreground",
          )}
        >
          {fromLabel} → {toLabel} · phát tới {outputLabel}
        </span>
      </span>

      {!continuous && !holding && enabled && (
        <span className="hidden shrink-0 items-center gap-1.5 md:flex">
          <Kbd>Space</Kbd>
          <span className="text-tertiary-foreground text-xs">hoặc</span>
          <Kbd>⌥</Kbd>
        </span>
      )}

      {/* Mic level */}
      <span className="absolute inset-x-0 bottom-0 h-0.5" aria-hidden>
        <span
          className={cn(
            "block h-full transition-[width] duration-75",
            live ? "bg-white/70" : "bg-brand-fill",
          )}
          style={{ width: `${Math.max(0, Math.min(100, level))}%` }}
        />
      </span>
    </>
  );

  const padClass = cn(
    "relative flex h-14 min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-xl border px-4 text-left select-none",
    "transition-[background-color,border-color,transform] duration-150",
    live
      ? "bg-brand-fill text-on-brand border-transparent"
      : "bg-background border-border",
    busy && !live && "border-warn-border",
    !enabled && "opacity-60",
  );

  return (
    <footer className="border-border bg-card shrink-0 border-t px-4 pt-3 pb-2.5">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        <div className="flex items-center gap-3">
          <Segmented
            value={mode}
            onChange={(v) => onModeChange(v === "continuous" ? "continuous" : "hold")}
            options={[
              { label: "Giữ để nói", value: "hold" },
              { label: "Nói liên tục", value: "continuous" },
            ]}
          />
          {continuous ? (
            <div className={padClass} aria-live="polite">
              {pad}
            </div>
          ) : (
            <button
              type="button"
              aria-pressed={holding}
              disabled={!enabled}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                // Capture: kéo chuột ra ngoài nút vẫn đang giữ, thả ở đâu cũng dừng.
                e.currentTarget.setPointerCapture(e.pointerId);
                onStart();
              }}
              onPointerUp={onStop}
              onPointerCancel={onStop}
              onLostPointerCapture={onStop}
              onKeyDown={(e) => {
                // Space/Option đã xử lý toàn cục; tránh nút tự "click" thêm.
                if (e.key === " " || e.key === "Enter") e.preventDefault();
              }}
              className={cn(
                padClass,
                "focus-visible:ring-focus-ring outline-none focus-visible:ring-2",
                holding && "scale-[0.995]",
                enabled ? "hover:bg-ink-hover" : "cursor-not-allowed",
                holding && "hover:bg-brand-fill",
              )}
            >
              {pad}
            </button>
          )}
        </div>

        <p className="text-tertiary-foreground truncate text-center text-xs" aria-live="polite">
          {status}
        </p>
      </div>
    </footer>
  );
}
