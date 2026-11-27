import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";

/**
 * In-app updates. The Rust side (src-tauri/src/updater.rs) checks the GitHub
 * release feed 15 s after launch and every hour (release builds only) and
 * announces a newer version with `update:available`. Nothing is installed until
 * `install()` is called; it downloads, verifies the signature, installs and
 * restarts the app, reporting progress through `update:progress`.
 */

/** A newer version found by the last check. */
export type PendingUpdate = {
  version: string;
  currentVersion: string;
  /** Release notes (the CHANGELOG section of that version). */
  notes: string | null;
  date: string | null;
};

export type UpdatePhase = "downloading" | "installing" | "restarting" | "error";

export type UpdateProgress = {
  phase: UpdatePhase;
  version: string;
  downloaded: number;
  total: number | null;
  /** 0–100, `null` while the download size is unknown. */
  percent: number | null;
  error: string | null;
};

export type UpdateInfo = {
  /** Running app version. */
  version: string;
  /** Background checks run (release builds only). */
  autoCheck: boolean;
  /** `install()` is allowed (release builds only; dev builds never replace themselves). */
  canInstall: boolean;
  checking: boolean;
  installing: boolean;
  pending: PendingUpdate | null;
};

const DISMISSED_KEY = "hearbridge.update.dismissed";
/** Keeps every `useUpdater()` instance (banner, settings button) in step. */
const DISMISSED_EVENT = "hearbridge:update-dismissed";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string | null) {
  try {
    if (version) localStorage.setItem(DISMISSED_KEY, version);
    else localStorage.removeItem(DISMISSED_KEY);
  } catch {
    // Storage unavailable: dismissal lasts for this session only.
  }
  window.dispatchEvent(new CustomEvent<string | null>(DISMISSED_EVENT, { detail: version }));
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function useUpdater() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [pending, setPending] = useState<PendingUpdate | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());

  useEffect(() => {
    let alive = true;
    const unlisten: Array<() => void> = [];

    invoke<UpdateInfo>("update_info")
      .then((next) => {
        if (!alive) return;
        setInfo(next);
        setPending(next.pending);
      })
      .catch(() => {
        // Not running inside Tauri (plain `vite` in a browser): no updater.
      });

    listen<PendingUpdate | null>("update:available", (event) => {
      if (alive) setPending(event.payload);
    })
      .then((off) => (alive ? unlisten.push(off) : off()))
      .catch(() => {});

    listen<UpdateProgress>("update:progress", (event) => {
      if (alive) setProgress(event.payload);
    })
      .then((off) => (alive ? unlisten.push(off) : off()))
      .catch(() => {});

    const onDismissed = (event: Event) => setDismissed((event as CustomEvent<string | null>).detail);
    window.addEventListener(DISMISSED_EVENT, onDismissed);

    return () => {
      alive = false;
      for (const off of unlisten) off();
      window.removeEventListener(DISMISSED_EVENT, onDismissed);
    };
  }, []);

  /** Check the release feed now. Resolves with the newer version, or `null` when up to date. */
  const checkNow = useCallback(async (): Promise<PendingUpdate | null> => {
    setChecking(true);
    try {
      const found = await invoke<PendingUpdate | null>("check_for_updates");
      setPending(found);
      // A manual check brings back a banner the user dismissed earlier.
      if (found) writeDismissed(null);
      return found;
    } finally {
      setChecking(false);
    }
  }, []);

  /** Download + install the pending update, then restart. Rejects with a readable message on failure. */
  const install = useCallback(async (): Promise<void> => {
    setProgress(null);
    try {
      await invoke("install_update");
    } catch (err) {
      throw new Error(errorText(err));
    }
  }, []);

  /** Hide the banner for this version until a newer one (or a manual check) shows up. */
  const dismiss = useCallback(() => {
    if (pending) writeDismissed(pending.version);
  }, [pending]);

  const busy =
    progress != null && (progress.phase === "downloading" || progress.phase === "installing" || progress.phase === "restarting");

  return {
    /** Running version and build capabilities; `null` until loaded (or outside Tauri). */
    info,
    currentVersion: info?.version ?? null,
    canInstall: info?.canInstall ?? false,
    pending,
    /** `pending`, unless the user dismissed that version. */
    visible: pending && pending.version !== dismissed ? pending : null,
    progress,
    /** Download / install / restart in progress. */
    busy,
    checking,
    checkNow,
    install,
    dismiss,
  };
}

export type UseUpdater = ReturnType<typeof useUpdater>;
