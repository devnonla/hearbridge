import { invoke } from "@tauri-apps/api/core";
import { listen as listenEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  AudioApp,
  ConfigInfo,
  OrModel,
  OrModelLists,
  LiveCaption,
  UtteranceResult,
} from "@/types";

type AppleTranscriptEvent = {
  text: string;
  isFinal: boolean;
  engine: string;
};

/** Gỡ dòng trùng id / trùng partial — React StrictMode + double listener hay nhân đôi. */
function sanitizeLiveLines(lines: LiveCaption[]): LiveCaption[] {
  const seen = new Set<string>();
  const out: LiveCaption[] = [];
  let keptPartial = false;
  for (const line of lines) {
    if (seen.has(line.id)) continue;
    if (line.id.endsWith("-partial")) {
      if (keptPartial) continue;
      keptPartial = true;
    }
    seen.add(line.id);
    out.push(line);
  }
  return out;
}

function normalizeSttWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[.!?…,;:"“”‘’()[\]{}]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** SFSpeech trả cumulative — bỏ phần đã chốt (khớp linh hoạt dấu câu/hoa thường). */
function sttDelta(full: string, committedPrefix: string): string {
  const t = full.trim();
  if (!t) return "";
  const c = committedPrefix.trim();
  if (!c) return t;
  const tLow = t.toLowerCase();
  const cLow = c.toLowerCase();
  if (tLow === cLow) return "";
  if (tLow.startsWith(cLow)) {
    return t.slice(cLow.length).replace(/^[\s,.;:!?…"')\]]+/u, "").trim();
  }
  // Prefix lệch dấu câu (đã chốt có "." nhưng STT chưa) → so theo từ
  const tWords = t.split(/\s+/).filter(Boolean);
  const cNorm = normalizeSttWords(c);
  if (cNorm.length === 0) return t;
  let matched = 0;
  for (; matched < cNorm.length && matched < tWords.length; matched++) {
    const tw = tWords[matched]!.toLowerCase().replace(/[^a-z0-9']/gi, "");
    const cw = cNorm[matched]!.replace(/[^a-z0-9']/gi, "");
    if (tw !== cw) break;
  }
  // Khớp ≥80% prefix → coi là tiếp nối, bỏ phần đã chốt
  if (matched >= Math.ceil(cNorm.length * 0.8)) {
    return tWords.slice(matched).join(" ").trim();
  }
  return t;
}

/**
 * Câu mới có phải bản sửa/kéo dài của câu trước (cắt sớm)?
 * → nên edit dòng trên thay vì thêm dòng mới bị ghép.
 */
function isAmendmentOf(prevSource: string, nextText: string): boolean {
  const p = normalizeSttWords(prevSource);
  const n = normalizeSttWords(nextText);
  if (p.length < 4 || n.length < 4) return false;
  if (n.length <= p.length) {
    // STT sửa ngắn lại / sửa giữa câu
    const head = Math.min(6, p.length, n.length);
    return p.slice(0, head).join(" ") === n.slice(0, head).join(" ");
  }
  // next bắt đầu bằng prev (kéo dài sau khi cắt sớm)
  const head = Math.min(p.length, 12);
  return p.slice(0, head).join(" ") === n.slice(0, head).join(" ");
}

/** Kết thúc cụm: .?!… hoặc ,; (có khoảng trắng sau — tránh cắt số 1,000). */
const STT_BREAK_RE = /[.!?…]["'")\]]*|[,;](?=\s|$)/gu;
const STT_COMPLETE_RE = /[.!?…,;]["'")\]]*$/u;

/** Tách mọi cụm theo dấu .?!…,; để dịch sớm (kể cả khi cả đoạn đã kết thúc). */
function splitSentences(full: string): string[] {
  const s = full.trim();
  if (!s) return [];
  const endRe = new RegExp(STT_BREAK_RE.source, STT_BREAK_RE.flags);
  const ends: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = endRe.exec(s)) !== null) {
    ends.push(m.index + m[0].length);
  }
  if (ends.length === 0) return [s];
  const parts: string[] = [];
  let prev = 0;
  for (const end of ends) {
    const piece = s.slice(prev, end).trim();
    if (piece) parts.push(piece);
    prev = end;
  }
  const tail = s.slice(prev).trim();
  if (tail) parts.push(tail);
  return parts;
}

/**
 * Streaming: chốt các cụm đã xong (có .?!…,;), giữ phần cuối làm rest.
 * "A, B, C đang nói" → done=["A,","B,"], rest="C đang nói"
 */
function splitCompletedStt(full: string): { done: string[]; rest: string } {
  const parts = splitSentences(full);
  if (parts.length === 0) return { done: [], rest: "" };
  if (parts.length === 1) return { done: [], rest: parts[0]! };
  return {
    done: parts.slice(0, -1),
    rest: parts[parts.length - 1]!,
  };
}

/** Đoạn quá dài không có dấu câu → cắt theo cụm ~140 ký tự tại khoảng trắng. */
function forceChunk(text: string, maxLen = 140): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];
  const out: string[] = [];
  let left = t;
  while (left.length > maxLen) {
    let cut = left.lastIndexOf(" ", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    out.push(left.slice(0, cut).trim());
    left = left.slice(cut).trim();
  }
  if (left) out.push(left);
  return out;
}

/** Khi chốt hẳn (settle/final): tách hết cụm; đoạn dài không dấu cũng bị cắt. */
function explodeForCommit(text: string): string[] {
  const parts = splitSentences(text.trim());
  const out: string[] = [];
  for (const p of parts) {
    const complete = STT_COMPLETE_RE.test(p);
    if (complete || p.length <= 160) {
      out.push(p);
    } else {
      out.push(...forceChunk(p, 140));
    }
  }
  return out.filter(Boolean);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || "");
      resolve(s.includes(",") ? s.split(",")[1] : s);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function pickMime(): string {
  for (const c of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}

const defaultSettings: AppSettings = {
  sttModel: "openai/gpt-4o-mini-transcribe",
  translateModel: "openai/gpt-4o-mini",
  notesModel: "openai/gpt-4o-mini",
  ttsModel: "openai/gpt-4o-mini-tts",
  ttsVoice: "alloy",
  appleTtsVoice: "",
  appleTtsRate: 0.62,
  appleTtsPitch: 1,
  appleTtsVolume: 0.45,
  myLang: "vi",
  theirLang: "en",
  wordList: [],
  autoNotesEvery: 8,
  openrouterApiKey: "",
  openrouterBaseUrl: "https://openrouter.ai/api/v1",
};

export function useCicadaApp() {
  const [settings, setSettingsState] = useState<AppSettings>(defaultSettings);
  const settingsHydratedRef = useRef(false);
  const settingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [configMeta, setConfigMeta] = useState("…");
  const [status, setStatus] = useState("Sẵn sàng");
  const [liveLines, setLiveLines] = useState<LiveCaption[]>([]);
  const [holding, setHolding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [level, setLevel] = useState(0);
  const [listenOn, setListenOn] = useState(false);
  const [muteOriginal, setMuteOriginalState] = useState(false);
  const [interpretReady, setInterpretReady] = useState(true);
  const [translateOn, setTranslateOn] = useState(true);
  const [ttsOn, setTtsOn] = useState(true);
  const [listenSource] = useState<"app" | "mic">("app");
  const [audioApps, setAudioApps] = useState<AudioApp[]>([]);
  const [listenAppId, setListenAppId] = useState("");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState("");
  const [speakerId, setSpeakerId] = useState("");
  const [modelLists, setModelLists] = useState<OrModelLists | null>(null);
  const [modelsMeta, setModelsMeta] = useState("STT · chat · TTS");
  const [appleTtsVoices, setAppleTtsVoices] = useState<
    { id: string; name: string; lang: string; gender: string; quality: string }[]
  >([]);
  const [pinned, setPinned] = useState(false);

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef(0);
  const levelLastRef = useRef(0);
  const levelPaintAtRef = useRef(0);
  const statusRef = useRef(status);
  const audioElRef = useRef(new Audio());
  const interpretRecorderRef = useRef<MediaRecorder | null>(null);
  const interpretChunksRef = useRef<BlobPart[]>([]);
  const holdingRef = useRef(false);
  const busyRef = useRef(false);
  const listenActiveRef = useRef(false);
  const listenLoopRunningRef = useRef(false);
  const listenProcessingRef = useRef(false);
  const utteranceGenRef = useRef(0);
  const captureGenRef = useRef(0);
  /** Mỗi dòng dịch có gen riêng — request cũ không ghi đè "(lỗi dịch)" lên bản mới. */
  const translateGenRef = useRef(new Map<string, number>());
  const translateOnRef = useRef(translateOn);
  const ttsOnRef = useRef(ttsOn);
  const settingsRef = useRef(settings);
  const listenSourceRef = useRef(listenSource);
  const listenAppIdRef = useRef(listenAppId);
  const micIdRef = useRef(micId);
  const speakerIdRef = useRef(speakerId);
  const interpretReadyRef = useRef(interpretReady);
  const handleAppleFinalRef = useRef<
    (text: string, engine: string, existingId?: string | null) => Promise<void>
  >(async () => {});
  /** Prefix cumulative của SFSpeech đã chốt — tránh nối câu cũ vào câu mới. */
  const sttCommittedPrefixRef = useRef("");
  /** Đang TTS / cooldown — bỏ transcript để khỏi tự nghe lại tiếng mình. */
  const listenMutedUntilRef = useRef(0);
  const liveLinesRef = useRef<LiveCaption[]>([]);
  /** Hàng đợi TTS tuần tự — câu trên xong mới đọc câu dưới. */
  const ttsQueueRef = useRef(Promise.resolve());
  const ttsRunIdRef = useRef(0);
  /** Tránh đọc lại đúng cùng một bản dịch. */
  const lastTtsViRef = useRef("");

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  useEffect(() => {
    listenSourceRef.current = listenSource;
  }, [listenSource]);
  useEffect(() => {
    listenAppIdRef.current = listenAppId;
  }, [listenAppId]);
  useEffect(() => {
    micIdRef.current = micId;
  }, [micId]);
  useEffect(() => {
    speakerIdRef.current = speakerId;
  }, [speakerId]);
  useEffect(() => {
    interpretReadyRef.current = interpretReady;
  }, [interpretReady]);
  useEffect(() => {
    translateOnRef.current = translateOn;
  }, [translateOn]);
  useEffect(() => {
    ttsOnRef.current = ttsOn;
    if (!ttsOn) {
      ttsRunIdRef.current += 1;
      lastTtsViRef.current = "";
      ttsQueueRef.current = Promise.resolve();
      listenMutedUntilRef.current = 0;
      try {
        audioElRef.current?.pause();
      } catch {}
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      void invoke("stop_apple_tts").catch(() => {});
      void invoke("set_system_audio_gated", { gated: false }).catch(() => {});
    }
  }, [ttsOn]);
  useEffect(() => {
    liveLinesRef.current = liveLines;
  }, [liveLines]);
  useEffect(() => {
    holdingRef.current = holding;
  }, [holding]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const setStatusQuiet = useCallback((msg: string) => {
    if (statusRef.current === msg) return;
    statusRef.current = msg;
    setStatus(msg);
  }, []);

  const setLevelThrottled = useCallback((next: number) => {
    const now = performance.now();
    if (now - levelPaintAtRef.current < 80 && Math.abs(next - levelLastRef.current) < 4) {
      return;
    }
    levelPaintAtRef.current = now;
    levelLastRef.current = next;
    setLevel(next);
  }, []);

  const wordList = useCallback(() => [] as string[], []);

  /** 8 cặp nguồn/dịch gần nhất — đưa vào prompt để giữ cách gọi tên đồng bộ. */
  const recentTranslateContext = useCallback((excludeId?: string) => {
    const out: { source: string; translated: string }[] = [];
    for (const line of liveLinesRef.current) {
      if (excludeId && line.id === excludeId) continue;
      if (line.translating) continue;
      const source = line.source.trim();
      const translated = line.translated.trim();
      if (!source || !translated || translated.startsWith("(lỗi")) continue;
      out.push({ source, translated });
    }
    return out.slice(-8);
  }, []);

  const filtered = useMemo(() => {
    if (!modelLists) {
      return { stt: [] as OrModel[], chat: [] as OrModel[], tts: [] as OrModel[] };
    }
    return {
      stt: modelLists.stt,
      chat: modelLists.chat,
      tts: modelLists.tts,
    };
  }, [modelLists]);

  const muteListenFor = useCallback((ms: number) => {
    listenMutedUntilRef.current = Math.max(
      listenMutedUntilRef.current,
      Date.now() + ms,
    );
  }, []);

  const gateSystemAudio = useCallback(async (gated: boolean) => {
    // Không mute FE 12s — native gate đủ khi đang interpreting
    if (!gated) listenMutedUntilRef.current = 0;
    try {
      await invoke("set_system_audio_gated", { gated });
    } catch {}
  }, []);

  const duckSystemAudio = useCallback(async (pauseMs = 1800) => {
    const ms = Math.max(pauseMs, 1200);
    muteListenFor(ms + 900);
    try {
      await invoke("duck_system_audio", { pauseMs: ms });
    } catch {}
  }, [muteListenFor]);

  const playBase64 = useCallback(async (b64: string, mime: string, rate = 1.15) => {
    const sinkId = speakerIdRef.current;
    const audio = audioElRef.current;
    if (sinkId && typeof (audio as any).setSinkId === "function") {
      try {
        await (audio as any).setSinkId(sinkId);
      } catch {}
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    audio.pause();
    audio.volume = 0.55;
    audio.src = url;
    audio.playbackRate = rate;
    try {
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("TTS play lỗi"));
        void audio.play().catch(reject);
      });
    } finally {
      audio.playbackRate = 1;
      audio.volume = 1;
      URL.revokeObjectURL(url);
    }
  }, []);

  /**
   * Apple trước, GPT sau. Hàng đợi tuần tự — mỗi câu dịch đều được xếp đọc.
   * Không stop trước mỗi câu (dễ nuốt câu 2); synthesizer tự nối khi job trước xong.
   */
  const speakApple = useCallback(
    (text: string, lang: string) => {
      if (!ttsOnRef.current) return Promise.resolve(null as number | null);
      const trimmed = text.trim();
      if (!trimmed) return Promise.resolve(null as number | null);
      const ttsLang = lang.toLowerCase().startsWith("vi") ? "vi-VN" : lang;
      const runIdAtEnqueue = ttsRunIdRef.current;

      const job = async (): Promise<number | null> => {
        if (!ttsOnRef.current || runIdAtEnqueue !== ttsRunIdRef.current) return null;
        const t0 = Date.now();
        try {
          try {
            audioElRef.current?.pause();
          } catch {}
          const s = settingsRef.current;
          const voiceId = s.appleTtsVoice?.trim() || undefined;
          return await invoke<number>("speak_apple_tts", {
            text: trimmed,
            lang: ttsLang,
            voiceId,
            rate: s.appleTtsRate ?? 0.62,
            pitch: s.appleTtsPitch ?? 1,
            volume: s.appleTtsVolume ?? 0.45,
          });
        } catch (appleErr) {
          console.warn("Apple TTS lỗi → GPT:", appleErr);
          try {
            const tts = await invoke<{
              audioBase64: string;
              audioMime: string;
              ttsMs: number;
            }>("synthesize_speech", { text: trimmed });
            if (!ttsOnRef.current || runIdAtEnqueue !== ttsRunIdRef.current) return null;
            await playBase64(tts.audioBase64, tts.audioMime || "audio/mpeg", 1.15);
            return tts.ttsMs || Date.now() - t0;
          } catch {
            return null;
          }
        }
      };

      const queued = ttsQueueRef.current.then(job, job);
      ttsQueueRef.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [playBase64],
  );

  const refreshDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    setMics(devices.filter((d) => d.kind === "audioinput"));
    setSpeakers(devices.filter((d) => d.kind === "audiooutput"));
  }, []);

  const setupMeter = useCallback(
    async (stream: MediaStream) => {
      await audioCtxRef.current?.close().catch(() => {});
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        setLevelThrottled(Math.min(100, Math.round(rms * 280)));
        rafRef.current = requestAnimationFrame(tick);
      };
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick);
    },
    [setLevelThrottled],
  );

  const ensureMic = useCallback(
    async (withMeter = true) => {
      const live = mediaStreamRef.current
        ?.getAudioTracks()
        .some((t) => t.readyState === "live");
      if (live && mediaStreamRef.current) {
        if (withMeter && !analyserRef.current) {
          await setupMeter(mediaStreamRef.current);
        }
        return mediaStreamRef.current;
      }
      const deviceId = micIdRef.current || undefined;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      mediaStreamRef.current = stream;
      if (withMeter) await setupMeter(stream);
      return stream;
    },
    [setupMeter],
  );

  const currentRms = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return 0;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i]! - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }, []);

  /** Giữ transcript trên UI; không lưu họp / biên bản. */
  const persistUtterance = useCallback(async (_result: UtteranceResult) => {}, []);

  const patchLiveLine = useCallback((id: string, patch: Partial<LiveCaption>) => {
    setLiveLines((prev) => {
      const base = sanitizeLiveLines(prev);
      let idx = base.findIndex((l) => l.id === id);
      if (idx < 0) {
        idx = base.findIndex((l) => l.translating && l.role === "them");
      }
      if (idx < 0 && base.length > 0) {
        idx = base.length - 1;
      }
      if (idx < 0) return base;
      return base.map((l, i) => (i === idx ? { ...l, ...patch } : l));
    });
  }, []);

  const runUtteranceFromBase64 = useCallback(
    async (audioBase64: string, mimeType: string, role: "me" | "them", speak: boolean) => {
      const gen = ++utteranceGenRef.current;
      const lineId = `${Date.now()}-${gen}`;
      const sourceLang =
        role === "me" ? settingsRef.current.myLang : settingsRef.current.theirLang;
      const targetLang =
        role === "me" ? settingsRef.current.theirLang : settingsRef.current.myLang;

      const wantTranslate = translateOnRef.current;
      if (speak) {
        setBusy(true);
        busyRef.current = true;
      }
      setStatus(role === "me" ? "Interpreting · STT…" : "Listen · STT…");

      try {
        const stt = await invoke<{ text: string; sttMs: number }>("transcribe_audio", {
          audioBase64,
          mimeType,
          language: sourceLang,
        });

        // Append timeline — không replace dòng cũ
        const caption: LiveCaption = {
          id: lineId,
          at: new Date().toISOString(),
          role,
          source: stt.text,
          translated: "",
          translating: wantTranslate,
          sttMs: stt.sttMs,
        };
        setLiveLines((prev) => [...prev, caption].slice(-500));

        const makeResult = (
          translatedText: string,
          translateMs: number,
        ): UtteranceResult => ({
          role,
          sourceText: stt.text,
          translatedText,
          sourceLang,
          targetLang,
          audioBase64: null,
          audioMime: null,
          sttMs: stt.sttMs,
          translateMs,
          ttsMs: null,
          ttsError: null,
        });

        const finishTranslate = async (): Promise<UtteranceResult | null> => {
          if (!wantTranslate) {
            patchLiveLine(lineId, { translating: false, translated: "" });
            return makeResult(stt.text, 0);
          }
          const tGen = (translateGenRef.current.get(lineId) ?? 0) + 1;
          translateGenRef.current.set(lineId, tGen);
          try {
            const tr = await invoke<{ text: string; translateMs: number }>("translate_text", {
              text: stt.text,
              sourceLang,
              targetLang,
              wordList: wordList(),
              context: recentTranslateContext(lineId),
            });
            if (translateGenRef.current.get(lineId) !== tGen) return null;
            patchLiveLine(lineId, {
              translating: false,
              translated: tr.text,
              translateMs: tr.translateMs,
            });
            return makeResult(tr.text, tr.translateMs);
          } catch (err) {
            if (translateGenRef.current.get(lineId) !== tGen) return null;
            throw err;
          }
        };

        // Listen: dịch nền + nhả vòng nghe ngay
        if (!speak) {
          listenProcessingRef.current = false;
          busyRef.current = false;
          setBusy(false);
          if (!wantTranslate) {
            const result = makeResult(stt.text, 0);
            setStatus(`${role === "me" ? "Tôi" : "Họ"} · STT ${stt.sttMs}ms · không dịch`);
            void persistUtterance(result).catch((err) => console.warn(err));
            return;
          }
          setStatus(
            `${role === "me" ? "Tôi" : "Họ"} · transcript ${stt.sttMs}ms · đang dịch…`,
          );
          void (async () => {
            try {
              const result = await finishTranslate();
              if (!result) return;
              await persistUtterance(result);
              setStatus(
                `${role === "me" ? "Tôi" : "Họ"} · STT ${result.sttMs}ms · dịch ${result.translateMs}ms`,
              );
            } catch (err) {
              const reason = String(err).replace(/^Error:\s*/i, "").slice(0, 80);
              patchLiveLine(lineId, {
                translating: false,
                translated: reason ? `(lỗi dịch: ${reason})` : "(lỗi dịch)",
              });
              setStatus(String(err));
            }
          })();
          return;
        }

        // Interpreting: (dịch nếu bật) → TTS
        if (wantTranslate) {
          setStatus(
            `${role === "me" ? "Tôi" : "Họ"} · transcript ${stt.sttMs}ms · đang dịch…`,
          );
        }
        const result = await finishTranslate();
        if (!result) return;
        // Chỉ phát TTS nếu đây vẫn là interpreting mới nhất
        if (gen !== utteranceGenRef.current) {
          await persistUtterance(result);
          return;
        }
        const speakText = wantTranslate ? result.translatedText : result.sourceText;
        const speakLang = wantTranslate ? targetLang : sourceLang;
        const persistP = persistUtterance(result);
        // Interpreting: xếp TTS ngay, không chặn pipeline
        if (ttsOnRef.current) {
          void speakApple(speakText, speakLang).then((ttsMs) => {
            if (ttsMs != null) result.ttsMs = ttsMs;
          });
        }
        await persistP;
        if (gen !== utteranceGenRef.current) return;
        setStatus(
          wantTranslate
            ? `${role === "me" ? "Tôi" : "Họ"} · STT ${result.sttMs}ms · dịch ${result.translateMs}ms`
            : `${role === "me" ? "Tôi" : "Họ"} · STT ${result.sttMs}ms · không dịch`,
        );
      } catch (err) {
        setStatus(String(err));
        throw err;
      } finally {
        if (speak && gen === utteranceGenRef.current) {
          setBusy(false);
          busyRef.current = false;
        }
      }
    },
    [patchLiveLine, persistUtterance, recentTranslateContext, speakApple, wordList],
  );

  const runUtterance = useCallback(
    async (blob: Blob, role: "me" | "them", speak: boolean) => {
      if (blob.size < 1200) {
        setStatus("Audio quá ngắn");
        return;
      }
      const audioBase64 = await blobToBase64(blob);
      await runUtteranceFromBase64(audioBase64, blob.type || "audio/webm", role, speak);
    },
    [runUtteranceFromBase64],
  );

  const listenFromMicOnce = useCallback(async () => {
    const stream = await ensureMic();
    let voiced = false;
    const waitStart = Date.now();
    while (listenActiveRef.current && !holdingRef.current && Date.now() - waitStart < 15000) {
      if (currentRms() > 0.035) {
        voiced = true;
        break;
      }
      await sleep(40);
    }
    if (!listenActiveRef.current || holdingRef.current || !voiced) return;

    const mime = pickMime();
    const parts: BlobPart[] = [];
    const rec = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) parts.push(e.data);
    };
    rec.start(120);
    let silentMs = 0;
    let speechMs = 0;
    const t0 = Date.now();
    while (listenActiveRef.current && !holdingRef.current && Date.now() - t0 < 8000) {
      if (currentRms() > 0.03) {
        silentMs = 0;
        speechMs += 50;
      } else {
        silentMs += 50;
      }
      if (speechMs > 450 && silentMs > 700) break;
      await sleep(50);
    }
    const blob: Blob = await new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(parts, { type: rec.mimeType || "audio/webm" }));
      rec.stop();
    });
    if (!listenActiveRef.current || holdingRef.current) return;
    if (blob.size < 1800 || speechMs < 350) return;
    listenProcessingRef.current = true;
    await runUtterance(blob, "them", false);
  }, [currentRms, ensureMic, runUtterance]);

  const handleAppleFinal = useCallback(
    async (text: string, engine: string, existingId?: string | null) => {
      const sourceLang = settingsRef.current.theirLang;
      const targetLang = settingsRef.current.myLang;
      const trimmed = text.trim();
      if (!trimmed) return;

      const baseNow = sanitizeLiveLines(liveLinesRef.current);
      const partialNow =
        (existingId ? baseNow.find((l) => l.id === existingId) : undefined) ||
        baseNow.find((l) => l.id.endsWith("-partial"));
      const lastDone = [...baseNow]
        .reverse()
        .find(
          (l) =>
            l.role === "them" &&
            !l.id.endsWith("-partial") &&
            (!partialNow || l.id !== partialNow.id),
        );

      // Cắt sớm / STT nối tiếp câu trên → sửa dòng trên, không ghép thành dòng mới
      const amend =
        Boolean(lastDone && isAmendmentOf(lastDone.source, trimmed)) &&
        // partial cùng nội dung tiếp nối cũng amend dòng trên
        (!partialNow || isAmendmentOf(lastDone!.source, trimmed));

      const lineId = amend
        ? lastDone!.id
        : (existingId || `live-${Date.now()}-partial`).replace(/-partial$/, "-apple");
      const amended = amend;

      setLiveLines((prev) => {
        const base = sanitizeLiveLines(prev);
        if (amended) {
          return sanitizeLiveLines(
            base
              .filter((l) => !l.id.endsWith("-partial"))
              .map((l) =>
                l.id === lineId
                  ? {
                      ...l,
                      source: trimmed,
                      translating: true,
                      translated: "",
                    }
                  : l,
              ),
          ).slice(-500);
        }

        const partial =
          (existingId ? base.find((l) => l.id === existingId) : undefined) ||
          base.find((l) => l.id.endsWith("-partial"));

        if (partial) {
          return sanitizeLiveLines(
            base.map((l) =>
              l.id === partial.id
                ? {
                    ...l,
                    id: lineId,
                    source: trimmed,
                    translating: true,
                    translated: "",
                  }
                : l,
            ),
          ).slice(-500);
        }

        const caption: LiveCaption = {
          id: lineId,
          at: new Date().toISOString(),
          role: "them",
          source: trimmed,
          translated: "",
          translating: true,
          sttMs: 0,
        };
        return sanitizeLiveLines([...base, caption]).slice(-500);
      });

      setStatusQuiet(
        amended
          ? `Sửa dòng · ${trimmed.slice(0, 48)}${trimmed.length > 48 ? "…" : ""}`
          : `Họ · ${engine} · ${trimmed.slice(0, 48)}${trimmed.length > 48 ? "…" : ""}`,
      );

      const resultBase: UtteranceResult = {
        role: "them",
        sourceText: trimmed,
        translatedText: trimmed,
        sourceLang,
        targetLang,
        audioBase64: null,
        audioMime: null,
        sttMs: 0,
        translateMs: 0,
        ttsMs: null,
        ttsError: null,
      };

      const tGen = (translateGenRef.current.get(lineId) ?? 0) + 1;
      translateGenRef.current.set(lineId, tGen);
      const stillCurrent = () => translateGenRef.current.get(lineId) === tGen;

      try {
        const tr = await invoke<{ text: string; translateMs: number }>("translate_text", {
          text: trimmed,
          sourceLang,
          targetLang,
          wordList: wordList(),
          context: recentTranslateContext(lineId),
        });
        if (!stillCurrent()) return;
        const vi = tr.text.trim() || trimmed;
        patchLiveLine(lineId, {
          translating: false,
          translated: vi,
          translateMs: tr.translateMs,
          source: trimmed,
        });
        // Dịch xong → xếp TTS (kể cả dòng amend/kéo dài — trước đây !amended làm mất câu 2)
        if (ttsOnRef.current && vi && vi !== lastTtsViRef.current) {
          lastTtsViRef.current = vi;
          setStatusQuiet(`Đang xếp đọc: ${vi.slice(0, 48)}${vi.length > 48 ? "…" : ""}`);
          const ttsLang = targetLang.toLowerCase().startsWith("vi") ? "vi-VN" : targetLang;
          void speakApple(vi, ttsLang).then((ttsMs) => {
            if (ttsMs != null) {
              setStatusQuiet(
                `${amended ? "Sửa · " : ""}dịch ${tr.translateMs}ms · đọc Việt ${ttsMs}ms`,
              );
            }
          });
        } else if (!ttsOnRef.current) {
          setStatusQuiet(`Họ · dịch ${tr.translateMs}ms · TTS tắt`);
        } else {
          setStatusQuiet(
            amended
              ? `Đã sửa dòng · dịch ${tr.translateMs}ms`
              : `Họ · dịch ${tr.translateMs}ms`,
          );
        }
        await persistUtterance({
          ...resultBase,
          translatedText: vi,
          translateMs: tr.translateMs,
          ttsMs: null,
        });
      } catch (err) {
        if (!stillCurrent()) return;
        const reason = String(err).replace(/^Error:\s*/i, "").slice(0, 80);
        patchLiveLine(lineId, {
          translating: false,
          translated: reason ? `(lỗi dịch: ${reason})` : "(lỗi dịch)",
        });
        if (ttsOnRef.current) {
          setStatusQuiet(`Dịch lỗi — xếp đọc EN`);
          void speakApple(trimmed, "en-US");
        }
        setStatus(String(err));
      }
    },
    [patchLiveLine, persistUtterance, recentTranslateContext, setStatusQuiet, speakApple, wordList],
  );

  useEffect(() => {
    handleAppleFinalRef.current = handleAppleFinal;
  }, [handleAppleFinal]);

  const listenLoop = useCallback(async () => {
    if (listenLoopRunningRef.current) return;
    listenLoopRunningRef.current = true;
    try {
      while (listenActiveRef.current) {
        // System audio (Process Tap): transcript tới qua event apple-transcript
        if (listenSourceRef.current === "app") {
          try {
            const st = await invoke<{ running: boolean; peakRms: number }>("apple_listen_status");
            const lvl = Math.min(100, Math.round((st.peakRms || 0) * 400));
            setLevelThrottled(lvl);
          } catch {
            /* ignore */
          }
          await sleep(250);
          continue;
        }
        if (holdingRef.current || busyRef.current || listenProcessingRef.current) {
          await sleep(120);
          continue;
        }
        try {
          await listenFromMicOnce();
        } catch (err) {
          console.warn(err);
          setStatusQuiet(String(err));
          await sleep(1200);
        } finally {
          listenProcessingRef.current = false;
        }
      }
    } finally {
      listenLoopRunningRef.current = false;
    }
  }, [listenFromMicOnce, setLevelThrottled, setStatusQuiet]);

  const startHold = useCallback(async () => {
    if (!interpretReadyRef.current || holdingRef.current || busyRef.current) return;
    setHolding(true);
    holdingRef.current = true;
    await gateSystemAudio(true);
    setStatus("Ghi âm interpreting");
    const stream = await ensureMic();
    interpretChunksRef.current = [];
    const mime = pickMime();
    const rec = mime
      ? new MediaRecorder(stream, { mimeType: mime })
      : new MediaRecorder(stream);
    interpretRecorderRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) interpretChunksRef.current.push(e.data);
    };
    rec.start(180);
  }, [ensureMic, gateSystemAudio]);

  const stopHold = useCallback(async () => {
    if (!holdingRef.current) return;
    setHolding(false);
    holdingRef.current = false;
    const rec = interpretRecorderRef.current;
    interpretRecorderRef.current = null;
    const reopenListen = async () => {
      // Mở lại Listen ngay — không hủy STT bằng duck dài
      listenMutedUntilRef.current = Date.now() + 400;
      try {
        await invoke("set_system_audio_gated", { gated: false });
      } catch {}
    };
    if (!rec || rec.state === "inactive") {
      await reopenListen();
      return;
    }
    const blob: Blob = await new Promise((resolve) => {
      rec.onstop = () =>
        resolve(new Blob(interpretChunksRef.current, { type: rec.mimeType || "audio/webm" }));
      rec.stop();
    });
    try {
      await runUtterance(blob, "me", true);
    } finally {
      await reopenListen();
    }
  }, [runUtterance]);

  const refreshAudioApps = useCallback(async () => {
    try {
      const apps = await invoke<AudioApp[]>("list_audio_apps");
      setAudioApps(apps);
      const nextId = (() => {
        const cur = listenAppIdRef.current;
        if (cur && apps.some((a) => a.bundleId === cur)) return cur;
        const preferred = apps.find((a) => a.preferred);
        return preferred?.bundleId || apps[0]?.bundleId || "";
      })();
      listenAppIdRef.current = nextId;
      setListenAppId(nextId);
      return apps;
    } catch (err) {
      setStatus(String(err));
      return [] as AudioApp[];
    }
  }, []);

  const startAppleSystemListen = useCallback(async () => {
    let bundleId = listenAppIdRef.current.trim();
    if (!bundleId) {
      await refreshAudioApps();
      bundleId = listenAppIdRef.current.trim();
    }
    if (!bundleId) {
      throw new Error("Chưa chọn app để nghe — mở Chrome/Zoom rồi tải lại danh sách");
    }
    const engine = await invoke<string>("start_apple_listen", { bundleId });
    setStatusQuiet(
      engine === "speechanalyzer"
        ? `Listen · ${bundleId} · SpeechAnalyzer`
        : `Listen · chỉ ${bundleId}`,
    );
    return engine;
  }, [refreshAudioApps, setStatusQuiet]);

  const setListen = useCallback(
    async (on: boolean) => {
      setListenOn(on);
      listenActiveRef.current = on;
      if (on) {
        sttCommittedPrefixRef.current = "";
        listenMutedUntilRef.current = 0;
        if (listenSourceRef.current === "app") {
          try {
            await startAppleSystemListen();
          } catch (err) {
            setListenOn(false);
            listenActiveRef.current = false;
            setStatus(String(err));
            return;
          }
        } else {
          setStatusQuiet("Listen micro — để loa ngoài hoặc ngồi trong phòng");
        }
        void listenLoop();
      } else {
        captureGenRef.current += 1;
        sttCommittedPrefixRef.current = "";
        try {
          await invoke("stop_apple_listen");
        } catch {}
        try {
          await invoke("stop_system_audio");
        } catch {}
        setStatusQuiet("Listen tắt");
      }
    },
    [listenLoop, setStatusQuiet, startAppleSystemListen],
  );

  const changeListenApp = useCallback(
    async (bundleId: string) => {
      setListenAppId(bundleId);
      listenAppIdRef.current = bundleId;
      if (!listenActiveRef.current || listenSourceRef.current !== "app") return;
      try {
        await startAppleSystemListen();
      } catch (err) {
        setStatus(String(err));
      }
    },
    [startAppleSystemListen],
  );

  const setMuteOriginal = useCallback(async (muted: boolean) => {
    setMuteOriginalState(muted);
    try {
      await invoke("set_apple_listen_mute_original", { muted });
      setStatusQuiet(
        muted ? "Đã tắt âm gốc — vẫn dịch/TTS" : "Đã bật lại âm gốc",
      );
    } catch (err) {
      setMuteOriginalState(!muted);
      setStatus(String(err));
    }
  }, [setStatusQuiet]);

  const loadModels = useCallback(async () => {
    setModelsMeta("Đang tải models từ OpenRouter…");
    try {
      const lists = await invoke<OrModelLists>("list_openrouter_models");
      setModelLists(lists);
      setModelsMeta(
        `STT ${lists.stt.length} · chat ${lists.chat.length} · TTS ${lists.tts.length} · ${new Date(lists.fetchedAt).toLocaleTimeString()}`,
      );
    } catch (err) {
      setModelsMeta(`Lỗi tải models: ${err}`);
    }
  }, []);

  const openAppleTtsVoiceSettings = useCallback(async () => {
    try {
      await invoke("open_apple_tts_voice_settings");
      setStatusQuiet(
        "Đọc và nói → ⚙ → Voice → Vietnamese → tải Linh Enhanced (Siri 3/4 app không dùng được)",
      );
    } catch (err) {
      setStatus(String(err));
    }
  }, [setStatusQuiet]);

  const loadAppleTtsVoices = useCallback(async (lang?: string) => {
    try {
      const want = (lang || settingsRef.current.myLang || "vi").trim() || "vi";
      const list = await invoke<
        { id: string; name: string; lang: string; gender: string; quality: string }[]
      >("list_apple_tts_voices", { lang: want });
      setAppleTtsVoices(list);
      // Chưa chọn / id cũ mất → ưu tiên Siri Voice 4 (nam), rồi Voice 3, rồi Linh
      const cur = settingsRef.current.appleTtsVoice?.trim();
      const stillValid = cur && list.some((v) => v.id === cur);
      if (!stillValid) {
        const preferred =
          list.find((v) => v.quality === "siri" && /voice 4|vi-VN-D/i.test(v.name)) ||
          list.find((v) => v.quality === "siri" && /male|nam/i.test(`${v.name} ${v.gender}`)) ||
          list.find((v) => v.quality === "siri") ||
          list.find((v) => /linh/i.test(v.name) && v.quality === "enhanced") ||
          list.find((v) => /enhanced|premium/i.test(v.quality)) ||
          list[0];
        if (preferred) {
          setSettingsState((s) => {
            const next = { ...s, appleTtsVoice: preferred.id };
            settingsRef.current = next;
            return next;
          });
        }
      }
    } catch (err) {
      console.warn("list_apple_tts_voices", err);
      setAppleTtsVoices([]);
    }
  }, []);

  const persistSettings = useCallback(
    async (next: AppSettings, opts?: { quiet?: boolean; reloadModels?: boolean }) => {
      try {
        const saved = await invoke<AppSettings>("save_settings", {
          settings: { ...next, wordList: [] },
        });
        const merged: AppSettings = {
          ...defaultSettings,
          ...saved,
          openrouterApiKey: saved.openrouterApiKey || "",
          openrouterBaseUrl: saved.openrouterBaseUrl || defaultSettings.openrouterBaseUrl,
          appleTtsVoice: saved.appleTtsVoice || "",
          appleTtsRate: saved.appleTtsRate ?? defaultSettings.appleTtsRate,
          appleTtsPitch: saved.appleTtsPitch ?? defaultSettings.appleTtsPitch,
          appleTtsVolume: saved.appleTtsVolume ?? defaultSettings.appleTtsVolume,
          wordList: [],
        };
        settingsRef.current = merged;
        setSettingsState(merged);
        setConfigMeta(
          merged.openrouterApiKey?.trim()
            ? `OpenRouter OK · STT ${merged.sttModel} · dịch ${merged.translateModel}`
            : "Chưa có API key — nhập trong Cài đặt",
        );
        if (!opts?.quiet) setStatusQuiet("Đã lưu");
        if (opts?.reloadModels) void loadModels();
      } catch (err) {
        setStatus(`Lưu settings lỗi: ${err}`);
      }
    },
    [loadModels, setStatusQuiet],
  );

  const setSettings = useCallback(
    (update: AppSettings | ((prev: AppSettings) => AppSettings)) => {
      setSettingsState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        settingsRef.current = next;
        if (settingsHydratedRef.current) {
          if (settingsSaveTimerRef.current) clearTimeout(settingsSaveTimerRef.current);
          settingsSaveTimerRef.current = setTimeout(() => {
            void persistSettings(settingsRef.current, { quiet: true });
          }, 350);
        }
        return next;
      });
    },
    [persistSettings],
  );

  const saveSettings = useCallback(async () => {
    if (settingsSaveTimerRef.current) clearTimeout(settingsSaveTimerRef.current);
    await persistSettings(settingsRef.current, { reloadModels: true });
  }, [persistSettings]);

  const togglePin = useCallback(async () => {
    const next = !pinned;
    setPinned(next);
    await getCurrentWindow().setAlwaysOnTop(next);
  }, [pinned]);

  useEffect(() => {
    let unlistenApple: (() => void) | undefined;
    let unlistenStatus: (() => void) | undefined;
    let partialId: string | null = null;
    let lastFinalText = "";
    let lastFinalAt = 0;
    let punctTimer: ReturnType<typeof setTimeout> | null = null;
    let punctCandidate = "";
    let latestSttFull = "";

    void (async () => {
      try {
        const cfg = await invoke<ConfigInfo>("get_config");
        const loaded: AppSettings = {
          ...defaultSettings,
          ...cfg.settings,
          openrouterApiKey: cfg.settings.openrouterApiKey || "",
          openrouterBaseUrl:
            cfg.settings.openrouterBaseUrl || defaultSettings.openrouterBaseUrl,
          appleTtsVoice: cfg.settings.appleTtsVoice || "",
          appleTtsRate: cfg.settings.appleTtsRate ?? defaultSettings.appleTtsRate,
          appleTtsPitch: cfg.settings.appleTtsPitch ?? defaultSettings.appleTtsPitch,
          appleTtsVolume: cfg.settings.appleTtsVolume ?? defaultSettings.appleTtsVolume,
          wordList: [],
        };
        settingsRef.current = loaded;
        setSettingsState(loaded);
        settingsHydratedRef.current = true;
        void loadAppleTtsVoices(loaded.myLang);
        setConfigMeta(
          cfg.hasKey
            ? `OpenRouter sẵn sàng · STT ${cfg.settings.sttModel}`
            : "Chưa có API key — mở Cài đặt để nhập",
        );
      } catch (err) {
        settingsHydratedRef.current = true;
        setConfigMeta(String(err));
      }
      void loadModels();
      void refreshAudioApps();
      try {
        await ensureMic(false);
        await refreshDevices();
        setStatus("Sẵn sàng");
      } catch (err) {
        setStatus(`Cần quyền micro: ${err}`);
      }
      const clearPartialRow = () => {
        partialId = null;
        setLiveLines((prev) =>
          sanitizeLiveLines(prev.filter((l) => !l.id.endsWith("-partial"))),
        );
      };

      const upsertPartial = (visible: string) => {
        const shown = visible.trim();
        if (!shown) {
          clearPartialRow();
          return;
        }
        setLiveLines((prev) => {
          const base = sanitizeLiveLines(prev);
          const open =
            base.find((l) => l.id.endsWith("-partial")) ||
            (partialId ? base.find((l) => l.id === partialId) : undefined);
          if (open) {
            partialId = open.id;
            return base.map((l) =>
              l.id === open.id ? { ...l, source: shown } : l,
            );
          }
          const id = `live-${Date.now()}-partial`;
          partialId = id;
          return sanitizeLiveLines([
            ...base,
            {
              id,
              at: new Date().toISOString(),
              role: "them" as const,
              source: shown,
              translated: "",
              translating: false,
              sttMs: 0,
            },
          ]).slice(-500);
        });
      };

      /** Chốt một câu (đã là delta), cập nhật prefix theo full STT. */
      const commitPiece = (piece: string, engine: string, sttFull: string, usePartialId: boolean) => {
        const text = piece.trim();
        if (!text) return;
        const now = Date.now();
        const norm = text.toLowerCase();
        if (norm === lastFinalText && now - lastFinalAt < 2000) return;
        lastFinalText = norm;
        lastFinalAt = now;

        const full = sttFull.trim();
        const fullLow = full.toLowerCase();
        const pieceLow = text.toLowerCase();
        const idx = fullLow.lastIndexOf(pieceLow);
        if (idx >= 0) {
          sttCommittedPrefixRef.current = full.slice(0, idx + text.length).trimEnd();
        } else {
          const prev = sttCommittedPrefixRef.current.trim();
          sttCommittedPrefixRef.current = prev ? `${prev} ${text}` : text;
        }

        const id = usePartialId ? partialId : null;
        if (usePartialId) partialId = null;
        void handleAppleFinalRef.current(text, engine, id);
      };

      const commitExploded = (blob: string, engine: string, sttFull: string) => {
        const pieces = explodeForCommit(blob);
        pieces.forEach((s, i) => commitPiece(s, engine, sttFull, i === 0));
        if (pieces.length > 0) {
          sttCommittedPrefixRef.current = sttFull.trim();
        }
        clearPartialRow();
      };

      const scheduleSettle = (candidate: string, engine: string) => {
        const looksComplete = STT_COMPLETE_RE.test(candidate);
        // Có ,.;?! → chốt nhanh để dịch luôn; chưa có dấu thì chờ lâu hơn
        const settleMs = looksComplete ? 450 : candidate.length > 160 ? 1100 : 1800;
        if (candidate === punctCandidate && punctTimer) return;
        punctCandidate = candidate;
        if (punctTimer) clearTimeout(punctTimer);
        punctTimer = setTimeout(() => {
          punctTimer = null;
          if (punctCandidate !== candidate || !listenActiveRef.current) return;
          if (Date.now() < listenMutedUntilRef.current) return;
          const sttFull = latestSttFull;
          const latestDelta = sttDelta(sttFull, sttCommittedPrefixRef.current).trim();
          const toCommit =
            !latestDelta
              ? ""
              : latestDelta === candidate ||
                  latestDelta.startsWith(candidate) ||
                  isAmendmentOf(candidate, latestDelta)
                ? latestDelta
                : latestDelta;
          if (!toCommit) {
            clearPartialRow();
            return;
          }
          commitExploded(toCommit, engine, sttFull);
        }, settleMs);
      };

      unlistenApple = await listenEvent<AppleTranscriptEvent>("apple-transcript", (ev) => {
        const { text, isFinal, engine } = ev.payload;
        if (!text?.trim() || !listenActiveRef.current) return;
        // Đang TTS / vừa đọc xong → bỏ qua (tránh tự dịch tiếng loa)
        if (Date.now() < listenMutedUntilRef.current) return;

        const trimmed = text.trim();
        latestSttFull = trimmed;
        const deltaAll = sttDelta(trimmed, sttCommittedPrefixRef.current);
        if (!deltaAll) {
          clearPartialRow();
          return;
        }

        // Có câu đã kết thúc phía trước → chốt ngay từng câu, partial chỉ còn câu đang nói
        const { done, rest } = splitCompletedStt(deltaAll);
        if (done.length > 0) {
          if (punctTimer) {
            clearTimeout(punctTimer);
            punctTimer = null;
          }
          punctCandidate = "";
          done.forEach((s, i) => commitPiece(s, engine, trimmed, i === 0));
          const restIdx = rest
            ? trimmed.toLowerCase().lastIndexOf(rest.toLowerCase())
            : -1;
          sttCommittedPrefixRef.current =
            restIdx > 0 ? trimmed.slice(0, restIdx).trimEnd() : trimmed;
          if (rest) {
            upsertPartial(rest);
            scheduleSettle(rest, engine);
          } else {
            clearPartialRow();
          }
          return;
        }

        if (!isFinal) {
          upsertPartial(deltaAll);
          scheduleSettle(deltaAll, engine);
          return;
        }

        // Final native — luôn tách câu, không bao giờ 1 hàng cả đoạn
        if (punctTimer) {
          clearTimeout(punctTimer);
          punctTimer = null;
        }
        punctCandidate = "";
        commitExploded(deltaAll, engine, trimmed);
      });
      unlistenStatus = await listenEvent<{ message: string }>("apple-listen-status", (ev) => {
        if (!listenActiveRef.current) return;
        const msg = ev.payload?.message?.trim();
        if (msg) setStatusQuiet(msg);
      });
    })();

    const onDevice = () => void refreshDevices();
    navigator.mediaDevices.addEventListener("devicechange", onDevice);

    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.code !== "Space" && e.code !== "AltRight") || e.repeat) return;
      e.preventDefault();
      void startHold().catch((err) => setStatus(String(err)));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.code !== "AltRight") return;
      e.preventDefault();
      void stopHold();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      unlistenApple?.();
      unlistenStatus?.();
      if (punctTimer) clearTimeout(punctTimer);
      navigator.mediaDevices.removeEventListener("devicechange", onDevice);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      cancelAnimationFrame(rafRef.current);
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      void audioCtxRef.current?.close();
      void invoke("stop_apple_listen").catch(() => {});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
  }, [micId]);

  return {
    settings,
    setSettings,
    configMeta,
    status,
    liveLines,
    holding,
    busy,
    level,
    listenOn,
    setListen,
    muteOriginal,
    setMuteOriginal,
    interpretReady,
    setInterpretReady,
    translateOn,
    setTranslateOn,
    ttsOn,
    setTtsOn,
    listenSource,
    audioApps,
    listenAppId,
    setListenAppId: changeListenApp,
    refreshAudioApps,
    mics,
    speakers,
    micId,
    setMicId,
    speakerId,
    setSpeakerId,
    filtered,
    modelsMeta,
    appleTtsVoices,
    loadAppleTtsVoices,
    openAppleTtsVoiceSettings,
    pinned,
    startHold,
    stopHold,
    loadModels,
    saveSettings,
    togglePin,
    clearLiveLines: () => setLiveLines([]),
  };
}
