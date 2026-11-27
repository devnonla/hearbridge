import { Button, message } from "devnonla-ui";
import { ImagePlus, X } from "lucide-react";
import { useRef } from "react";
import { imageFileToAvatar, type Profile } from "@/hooks/useProfiles";
import { cn } from "@/lib/utils";

type AvatarProps = {
  profile: Profile;
  /** Shown when there's no custom avatar (e.g. the listened app's icon). */
  fallbackSrc?: string | null;
  tone: "me" | "them";
  size?: number;
  className?: string;
};

/** Round avatar: custom photo → fallback image → initial on a tinted circle. */
export function ChatAvatar({ profile, fallbackSrc, tone, size = 32, className }: AvatarProps) {
  const src = profile.avatar ?? fallbackSrc ?? null;
  const initial = (profile.name.trim()[0] ?? (tone === "me" ? "B" : "H")).toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold select-none",
        !src && (tone === "me" ? "bg-brand-fill text-on-brand" : "bg-bar text-muted-foreground"),
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-hidden
    >
      {src ? (
        <img
          src={src}
          alt=""
          className={cn("size-full", profile.avatar ? "object-cover" : "object-contain p-[12%]")}
        />
      ) : (
        initial
      )}
    </span>
  );
}

type FieldProps = {
  profile: Profile;
  fallbackSrc?: string | null;
  tone: "me" | "them";
  onChange: (avatar: string | null) => void;
};

/** Avatar picker for settings: preview, choose a photo, remove it. */
export function AvatarField({ profile, fallbackSrc, tone, onChange }: FieldProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-2">
      <ChatAvatar profile={profile} fallbackSrc={fallbackSrc} tone={tone} size={36} />
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            onChange(await imageFileToAvatar(file));
          } catch (err) {
            message.error(`Không đọc được ảnh: ${String(err).replace(/^Error:\s*/i, "")}`);
          }
        }}
      />
      <Button
        size="small"
        icon={<ImagePlus className="size-3.5" />}
        onClick={() => input.current?.click()}
      >
        Chọn ảnh
      </Button>
      {profile.avatar && (
        <Button type="icon" size="small" aria-label="Xóa ảnh" onClick={() => onChange(null)}>
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
