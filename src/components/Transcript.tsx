import { Button, Empty, Kbd, Shimmer } from "devnonla-ui";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ChatAvatar } from "@/components/ChatAvatar";
import type { Profiles } from "@/hooks/useProfiles";
import { cn } from "@/lib/utils";
import type { LiveCaption } from "@/types";

type Props = {
  lines: LiveCaption[];
  /** Left column: what the other side speaks. */
  theirLabel: string;
  /** Right column: the user's language. */
  myLabel: string;
  listening: boolean;
  profiles: Profiles;
  /** Default avatar for the other side (icon of the app being listened to). */
  themFallbackSrc?: string | null;
  /** Live input level 0..100 of the app being listened to. */
  level: number;
  /** Name of the app being listened to. */
  sourceName: string;
  emptyAction?: ReactNode;
};

/** Live signal meter + a hint when the tapped app stays silent. */
function SignalMeter({ level, sourceName }: { level: number; sourceName: string }) {
  const [silentFor, setSilentFor] = useState(0);
  useEffect(() => {
    if (level > 2) {
      setSilentFor(0);
      return;
    }
    const t = setInterval(() => setSilentFor((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [level]);
  const bars = 12;
  const lit = Math.round((Math.min(100, level) / 100) * bars);
  return (
    <div className="mt-5 flex flex-col items-center gap-2">
      <div className="flex h-5 items-end gap-1" aria-label={`Mức tín hiệu ${level}%`}>
        {Array.from({ length: bars }, (_, i) => (
          <span
            key={i}
            className={cn(
              "w-1.5 rounded-full transition-[height,background-color] duration-150",
              i < lit ? "bg-success-fill" : "bg-muted-strong",
            )}
            style={{ height: `${30 + (i / bars) * 70}%` }}
          />
        ))}
      </div>
      <p className="text-tertiary-foreground text-xs">
        {silentFor >= 4
          ? `Chưa nhận được âm thanh từ ${sourceName}. Kiểm tra app đó có đang phát tiếng không.`
          : `Đang nhận tín hiệu từ ${sourceName}`}
      </p>
    </div>
  );
}

const STICK_GAP = 80;

const timeOf = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
};

export function Transcript({
  lines,
  theirLabel,
  myLabel,
  listening,
  profiles,
  themFallbackSrc,
  level,
  sourceName,
  emptyAction,
}: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      const stick = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_GAP;
      stickRef.current = stick;
      setAtBottom(stick);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || !stickRef.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lines]);

  const jumpToLatest = () => {
    const el = viewportRef.current;
    if (!el) return;
    stickRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="flex min-h-full items-center justify-center px-6 py-10">
            <Empty
              bordered={false}
              icon="globe"
              title={listening ? "Đang chờ người nói…" : "Sẵn sàng nghe"}
              description={
                listening ? (
                  `Phụ đề ${theirLabel} → ${myLabel} sẽ hiện ở đây.`
                ) : (
                  <span className="inline-flex flex-wrap items-center justify-center gap-1.5">
                    Bật nghe để có phụ đề, hoặc giữ <Kbd>Space</Kbd> / <Kbd>⌥</Kbd> để bạn nói.
                  </span>
                )
              }
              action={listening ? undefined : emptyAction}
            >
              {listening && <SignalMeter level={level} sourceName={sourceName} />}
            </Empty>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col px-4 pt-4 pb-6">
            {lines.map((line, i) => {
              const isMe = line.role === "me";
              const prev = lines[i - 1];
              // Gộp các câu liền nhau của cùng một người (trong 2 phút): chỉ hiện avatar + tên một lần.
              const grouped =
                prev?.role === line.role &&
                Math.abs(new Date(line.at).getTime() - new Date(prev.at).getTime()) < 120_000;
              const isPartial = line.id.endsWith("-partial");
              const pending = <Shimmer className="text-tertiary-foreground">Đang dịch…</Shimmer>;
              // Họ: bản dịch là chính, câu gốc phụ. Bạn: câu bạn nói là chính, bản dịch phụ.
              // theirText = tiếng của họ (xanh), mineText = tiếng của bạn (cam).
              const theirText = isMe
                ? line.translating
                  ? pending
                  : line.translated || null
                : line.source || (isPartial ? "…" : "—");
              const mineText = isMe
                ? line.source || "…"
                : line.translating
                  ? pending
                  : line.translated || null;
              const profile = isMe ? profiles.me : profiles.them;
              return (
                <div
                  key={line.id}
                  className={cn(
                    "flex items-end gap-2.5",
                    isMe && "flex-row-reverse",
                    grouped ? "mt-1" : "mt-4 first:mt-0",
                  )}
                >
                  <div className="w-8 shrink-0">
                    {!grouped && (
                      <ChatAvatar
                        profile={profile}
                        fallbackSrc={isMe ? null : themFallbackSrc}
                        tone={isMe ? "me" : "them"}
                      />
                    )}
                  </div>
                  <div
                    className={cn(
                      "flex max-w-[78%] min-w-0 flex-col gap-1",
                      isMe ? "items-end" : "items-start",
                    )}
                  >
                    {!grouped && (
                      <span className="text-tertiary-foreground px-1 text-xs">
                        {profile.name} · {timeOf(line.at)}
                      </span>
                    )}
                    <div
                      className={cn(
                        "rounded-2xl px-3.5 py-2 leading-relaxed whitespace-pre-wrap",
                        isMe
                          ? "bg-bar border-border-secondary rounded-br-md border"
                          : "bg-card border-border rounded-bl-md border",
                        isPartial && "opacity-70",
                      )}
                    >
                      {/* Câu gốc của người nói ở trên, bản dịch ở dưới. Màu theo ngôn ngữ. */}
                      {(isMe ? [mineText, theirText] : [theirText, mineText]).map((text, k) =>
                        text ? (
                          <p
                            key={k}
                            className={cn(
                              "text-md",
                              (isMe ? k === 0 : k === 1) ? "hb-lang-mine font-medium" : "hb-lang-their",
                              k === 1 && "mt-1",
                            )}
                          >
                            {text}
                          </p>
                        ) : null,
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!atBottom && lines.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            size="small"
            shape="round"
            className="pointer-events-auto shadow-md"
            icon={<ArrowDown className="size-3.5" />}
            onClick={jumpToLatest}
          >
            Mới nhất
          </Button>
        </div>
      )}
    </div>
  );
}
