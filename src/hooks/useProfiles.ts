import { useCallback, useState } from "react";

export type Profile = {
  name: string;
  /** Square JPEG data URL (≈96 px), or null for the default avatar. */
  avatar: string | null;
};

export type Profiles = { me: Profile; them: Profile };

const KEY = "hb.profiles";
const DEFAULTS: Profiles = {
  me: { name: "Bạn", avatar: null },
  them: { name: "Họ", avatar: null },
};

function read(): Profiles {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Profiles> | null;
    return {
      me: { ...DEFAULTS.me, ...raw?.me },
      them: { ...DEFAULTS.them, ...raw?.them },
    };
  } catch {
    return DEFAULTS;
  }
}

/** Names and avatars for the chat timeline. Kept per device (localStorage). */
export function useProfiles() {
  const [profiles, setProfiles] = useState<Profiles>(read);
  const update = useCallback((who: keyof Profiles, patch: Partial<Profile>) => {
    setProfiles((prev) => {
      const next = { ...prev, [who]: { ...prev[who], ...patch } };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  return { profiles, updateProfile: update };
}

/** Crop the center square of an image file and shrink it to `size` px (JPEG data URL). */
export async function imageFileToAvatar(file: File, size = 96): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Không xử lý được ảnh");
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    size,
    size,
  );
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}
