import { invoke } from "@tauri-apps/api/core";
import { kokoroVoice, kokoroVoicesFor } from "@/lib/kokoroVoices";
import { listen as listenEvent } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AppSettings,
  AudioApp,
  ConfigInfo,
  Engine,
  SpeakSettings,
  TtsEngine,
  SystemAudioChunk,
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

/**
 * Kết thúc câu: .?!… (theo sau là khoảng trắng hoặc hết chuỗi, để không cắt "5.30").
 * Không tách ở dấu phẩy/chấm phẩy: "Did you open the trunk, please?" phải là một tin.
 */
const STT_BREAK_RE = /[.!?…]["'")\]]*(?=\s|$)/gu;
const STT_COMPLETE_RE = /[.!?…]["'")\]]*$/u;

/** Tách thành các câu theo dấu kết thúc câu .?!… */
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

/** Câu quá dài → cắt ~140 ký tự, ưu tiên sau dấu phẩy/chấm phẩy, rồi mới tới khoảng trắng. */
function forceChunk(text: string, maxLen = 140): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= maxLen) return [t];
  const out: string[] = [];
  let left = t;
  while (left.length > maxLen) {
    const clause = Math.max(left.lastIndexOf(", ", maxLen), left.lastIndexOf("; ", maxLen));
    let cut = clause >= maxLen * 0.4 ? clause + 1 : left.lastIndexOf(" ", maxLen);
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

/** Per-device conveniences (mic / output picks). Storage can be unavailable; never throw. */
function readPref(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writePref(key: string, value: string) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {}
}

/** Kokoro voice to use for `lang`: the chosen one if it speaks that language, else the first that does. */
function kokoroFor(voiceName: string, lang: string) {
  const voices = kokoroVoicesFor(lang);
  if (!voices.length) return null;
  const chosen = kokoroVoice(voiceName);
  return chosen && voices.includes(chosen) ? chosen : voices[0]!;
}

function asTtsEngine(v: unknown): TtsEngine {
  return v === "kokoro" ? "kokoro" : asEngine(v);
}

function asEngine(v: unknown): Engine {
  return v === "openrouter" ? "openrouter" : "apple";
}

/** Decode a MediaRecorder blob and re-encode it as 16 kHz mono 16-bit WAV (base64) for Apple STT. */
async function blobToWavBase64(blob: Blob): Promise<string> {
  const rate = 16000;
  const ctx = new AudioContext({ sampleRate: rate });
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void ctx.close().catch(() => {});
  }
  const n = audio.length;
  const chans = audio.numberOfChannels;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let c = 0; c < chans; c++) v += audio.getChannelData(c)[i];
    v /= chans;
    pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  const out = new DataView(new ArrayBuffer(44 + pcm.byteLength));
  const tag = (o: number, t: string) => {
    for (let i = 0; i < 4; i++) out.setUint8(o + i, t.charCodeAt(i));
  };
  tag(0, "RIFF");
  out.setUint32(4, 36 + pcm.byteLength, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, audio.sampleRate, true);
  out.setUint32(28, audio.sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  tag(36, "data");
  out.setUint32(40, pcm.byteLength, true);
  new Int16Array(out.buffer, 44).set(pcm);
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Fill a saved (possibly missing / partial) speak block. New installs copy the listen models. */
export function normalizeSpeak(raw: unknown, base: AppSettings): SpeakSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<SpeakSettings>;
  const str = (v: unknown, d: string) => (typeof v === "string" && v.trim() ? v : d);
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return {
    // Nhận giọng luôn chạy Apple trên máy.
    sttEngine: "apple",
    // Dịch luôn bằng Apple Translation trên máy.
    translateEngine: "apple",
    ttsEngine: asTtsEngine(r.ttsEngine ?? base.ttsEngine),
    sttModel: str(r.sttModel, base.sttModel),
    translateModel: str(r.translateModel, base.translateModel),
    ttsModel: str(r.ttsModel, base.ttsModel),
    ttsVoice: str(r.ttsVoice, base.ttsVoice),
    appleTtsVoice: typeof r.appleTtsVoice === "string" ? r.appleTtsVoice : "",
    appleTtsRate: num(r.appleTtsRate, 0.55),
    appleTtsPitch: num(r.appleTtsPitch, 1),
    appleTtsVolume: num(r.appleTtsVolume, 1),
    kokoroVoice: str(r.kokoroVoice, "af_heart"),
    kokoroSpeed: num(r.kokoroSpeed, 1),
    monitor: Boolean(r.monitor),
  };
}

/** Engines, models and voice for one direction. `undefined` model = Rust uses the saved listen default. */
function direction(s: AppSettings, mine: boolean) {
  if (mine) return normalizeSpeak(s.speak, s);
  return {
    sttEngine: "apple" as Engine,
    translateEngine: "apple" as Engine,
    ttsEngine: "apple" as TtsEngine,
    sttModel: undefined as string | undefined,
    translateModel: undefined as string | undefined,
    ttsModel: undefined as string | undefined,
    ttsVoice: undefined as string | undefined,
    appleTtsVoice: s.appleTtsVoice,
    appleTtsRate: s.appleTtsRate,
    appleTtsPitch: s.appleTtsPitch,
    appleTtsVolume: s.appleTtsVolume,
    kokoroVoice: s.kokoroVoice,
    kokoroSpeed: s.kokoroSpeed || 1,
    monitor: false,
  };
}

/** 50 ms of silence (16 kHz mono 16-bit WAV), used to wake an output device. */
const SILENCE_WAV_BASE64 = (() => {
  const n = 800;
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const tag = (o: number, t: string) => {
    for (let i = 0; i < 4; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, n * 2, true);
  return btoa(String.fromCharCode(...new Uint8Array(v.buffer)));
})();

/** Câu mẫu để nghe thử giọng, theo ngôn ngữ đọc. */
const VOICE_SAMPLES: Record<string, string> = {
  vi: "Xin chào, đây là giọng đọc bản dịch của HearBridge.",
  en: "Hello, this is how your translated voice will sound.",
  zh: "你好，这是 HearBridge 翻译语音的效果。",
  ja: "こんにちは、これは HearBridge の翻訳音声です。",
  ko: "안녕하세요, HearBridge 번역 음성입니다.",
};

/** Float32 PCM chunks at `inRate` → 16 kHz mono 16-bit WAV (base64). */
function floatChunksToWavBase64(chunks: Float32Array[], inRate: number): string {
  const outRate = 16000;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    input.set(c, off);
    off += c.length;
  }
  const ratio = inRate / outRate;
  const n = Math.floor(total / ratio);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, total - 1);
    const v = input[i0]! + (input[i1]! - input[i0]!) * (pos - i0);
    pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  const out = new DataView(new ArrayBuffer(44 + pcm.byteLength));
  const tag = (o: number, t: string) => {
    for (let i = 0; i < 4; i++) out.setUint8(o + i, t.charCodeAt(i));
  };
  tag(0, "RIFF");
  out.setUint32(4, 36 + pcm.byteLength, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, outRate, true);
  out.setUint32(28, outRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  tag(36, "data");
  out.setUint32(40, pcm.byteLength, true);
  new Int16Array(out.buffer, 44).set(pcm);
  const bytes = new Uint8Array(out.buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
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
  sttEngine: "apple",
  translateEngine: "apple",
  ttsEngine: "apple",
  kokoroVoice: "",
  kokoroSpeed: 1,
  speak: {
    sttEngine: "apple",
    translateEngine: "apple",
    ttsEngine: "apple",
    sttModel: "openai/gpt-4o-mini-transcribe",
    translateModel: "openai/gpt-4o-mini",
    ttsModel: "openai/gpt-4o-mini-tts",
    ttsVoice: "alloy",
    appleTtsVoice: "",
    appleTtsRate: 0.55,
    appleTtsPitch: 1,
    appleTtsVolume: 1,
    kokoroVoice: "af_heart",
    kokoroSpeed: 1,
    monitor: false,
  },
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
  /** "hold": giữ phím để nói. "continuous": mic luôn mở, tự cắt câu khi bạn ngừng nói. */
  const [talkMode, setTalkModeState] = useState<"hold" | "continuous">(() =>
    readPref("hb.talkMode") === "continuous" ? "continuous" : "hold",
  );
  /** Đang thu một câu trong chế độ nói liên tục. */
  const [autoTalking, setAutoTalking] = useState(false);
  const [translateOn, setTranslateOn] = useState(true);
  const [ttsOn, setTtsOn] = useState(true);
  const [listenSource] = useState<"app" | "mic">("app");
  const [audioApps, setAudioApps] = useState<AudioApp[]>([]);
  const [listenAppId, setListenAppId] = useState(() => readPref("hb.listenAppId"));
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<MediaDeviceInfo[]>([]);
  const speakersRef = useRef<MediaDeviceInfo[]>([]);
  const [micId, setMicId] = useState(() => readPref("hb.micId"));
  /** Loa nghe bản dịch lời họ (cho bạn). */
  const [speakerId, setSpeakerId] = useState(() => readPref("hb.speakerId"));
  /** Thiết bị phát giọng dịch lời bạn (cho họ), vd. BlackHole làm micro trong Zoom/Meet. */
  const [voiceOutId, setVoiceOutId] = useState(() => readPref("hb.voiceOutId"));
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
  /** Bộ phát riêng cho giọng phiên dịch lời bạn → không tranh với bản dịch lời họ. */
  const voiceAudioElRef = useRef(new Audio());
  const interpretRecorderRef = useRef<MediaRecorder | null>(null);
  const interpretChunksRef = useRef<BlobPart[]>([]);
  const holdingRef = useRef(false);
  const busyRef = useRef(false);
  const holdTokenRef = useRef(0);
  const talkModeRef = useRef<"hold" | "continuous">("hold");
  const continuousRunningRef = useRef(false);
  /** Số câu TTS đang phát (cả hai hướng): tạm ngưng thu mic để không tự nghe lại chính app. */
  const ttsPlayingRef = useRef(0);
  /** Lần cuối nghe thấy người bên kia (Apple Listen): đừng thu mic khi họ đang nói qua loa. */
  const lastThemSoundAtRef = useRef(0);
  const pcmTapRef = useRef<{
    ctx: AudioContext;
    rate: number;
    ring: Float32Array[];
    recording: Float32Array[] | null;
  } | null>(null);
  const holdStartedAtRef = useRef(0);
  const pendingSpeechRef = useRef(0);
  const speechChainRef = useRef<Promise<void>>(Promise.resolve());
  /** Mở Cài đặt Đọc chính tả tối đa một lần mỗi phiên. */
  const dictationHelpShownRef = useRef(false);
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
  const voiceOutIdRef = useRef(voiceOutId);
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
  /** Hàng đợi riêng cho giọng phiên dịch lời bạn: không phải chờ bản dịch lời họ đọc xong. */
  const voiceQueueRef = useRef(Promise.resolve());
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
    writePref("hb.listenAppId", listenAppId);
  }, [listenAppId]);
  useEffect(() => {
    micIdRef.current = micId;
    writePref("hb.micId", micId);
  }, [micId]);
  useEffect(() => {
    speakerIdRef.current = speakerId;
    writePref("hb.speakerId", speakerId);
  }, [speakerId]);
  useEffect(() => {
    voiceOutIdRef.current = voiceOutId;
    writePref("hb.voiceOutId", voiceOutId);
  }, [voiceOutId]);
  // Làm nóng thiết bị phát giọng dịch (lần mở đầu tiên của macOS mất ~2–3s).
  useEffect(() => {
    const name = speakers.find((d) => d.deviceId === voiceOutId)?.label;
    if (!name) return;
    void invoke("play_audio_device", {
      audioBase64: SILENCE_WAV_BASE64,
      deviceName: name,
      volume: 0,
    }).catch(() => {});
  }, [voiceOutId, speakers]);
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

  const gateSystemAudio = useCallback(async (gated: boolean) => {
    // Không mute FE 12s — native gate đủ khi đang interpreting
    if (!gated) listenMutedUntilRef.current = 0;
    try {
      await invoke("set_system_audio_gated", { gated });
    } catch {}
  }, []);

  const playBase64 = useCallback(
    async (
      b64: string,
      mime: string,
      /** Luôn 1.0: không tăng tốc giọng (WebKit cũng bỏ qua rate khi đổi thiết bị → hai bên nghe lệch). */
      rate = 1,
      sinkId: string = speakerIdRef.current,
      volume = 0.55,
      /** Phát đồng thời ra thiết bị này (tự nghe lại). */
      monitorSinkId: string | null = null,
      audio: HTMLAudioElement = audioElRef.current,
    ) => {
      // Thiết bị cụ thể (vd. BlackHole): WKWebView không đổi được thiết bị của <audio>
      // (setSinkId lỗi), nên phát native bằng AVAudioPlayer theo tên thiết bị.
      const label = (id: string) => speakersRef.current.find((d) => d.deviceId === id)?.label;
      const deviceName = sinkId ? label(sinkId) : undefined;
      if (deviceName) {
        await invoke("play_audio_device", {
          audioBase64: b64,
          deviceName,
          monitorDeviceName:
            monitorSinkId === null ? undefined : monitorSinkId ? (label(monitorSinkId) ?? "") : "",
          volume,
        });
        return;
      }
      // "" = thiết bị mặc định; luôn set để không kẹt ở thiết bị chọn lần trước.
      if (typeof (audio as any).setSinkId === "function" && (audio as any).sinkId !== sinkId) {
        try {
          await (audio as any).setSinkId(sinkId);
        } catch (err) {
          console.warn("setSinkId lỗi:", err);
        }
      }
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      audio.pause();
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.src = url;
      audio.playbackRate = rate;
      // Bản sao phát ra loa của bạn để tự nghe lại; lỗi ở đây không ảnh hưởng bản chính.
      let monitor: HTMLAudioElement | null = null;
      if (monitorSinkId !== null && monitorSinkId !== sinkId) {
        monitor = new Audio(url);
        monitor.playbackRate = rate;
        monitor.volume = 0.8;
        if (typeof (monitor as any).setSinkId === "function") {
          await (monitor as any).setSinkId(monitorSinkId).catch(() => {});
        }
      }
      try {
        void monitor?.play().catch(() => {});
        await new Promise<void>((resolve, reject) => {
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error("TTS play lỗi"));
          void audio.play().catch(reject);
        });
      } finally {
        monitor?.pause();
        audio.playbackRate = 1;
        audio.volume = 1;
        URL.revokeObjectURL(url);
      }
    },
    [],
  );

  /**
   * Đọc bằng engine đã chọn (settings.ttsEngine); engine kia là dự phòng khi lỗi.
   * `target`: "me" = bản dịch lời họ, phát ra loa của bạn, tắt được bằng "Đọc bản dịch";
   * "them" = giọng phiên dịch lời bạn, phát ra thiết bị "Phát giọng dịch tới" (vd. BlackHole).
   * Hàng đợi tuần tự — mỗi câu dịch đều được xếp đọc.
   * Không stop trước mỗi câu (dễ nuốt câu 2); synthesizer tự nối khi job trước xong.
   */
  const enqueueSpeech = useCallback(
    (text: string, lang: string, target: "me" | "them" = "me") => {
      const allowed = () => target === "them" || ttsOnRef.current;
      if (!allowed()) return Promise.resolve(null as number | null);
      const trimmed = text.trim();
      if (!trimmed) return Promise.resolve(null as number | null);
      const ttsLang = lang.toLowerCase().startsWith("vi") ? "vi-VN" : lang;
      const runIdAtEnqueue = ttsRunIdRef.current;

      const job = async (): Promise<number | null> => {
        const cancelled = () =>
          !allowed() || (target === "me" && runIdAtEnqueue !== ttsRunIdRef.current);
        if (cancelled()) return null;
        const t0 = Date.now();
        const el = target === "them" ? voiceAudioElRef.current : audioElRef.current;
        const s = direction(settingsRef.current, target === "them");
        const sink = target === "them" ? voiceOutIdRef.current : speakerIdRef.current;
        const appleVolume = s.appleTtsVolume ?? 0.45;
        // Tự nghe lại giọng dịch của mình khi nó đang phát vào thiết bị khác (mic ảo).
        const monitorSink =
          target === "them" && s.monitor && sink !== speakerIdRef.current
            ? speakerIdRef.current
            : null;

        const viaApple = async (): Promise<number | null> => {
          try {
            el.pause();
          } catch {}
          // Hướng "Nói" luôn render (bộ đọc riêng) để không cắt ngang giọng đọc lời họ.
          if (sink || target === "them") {
            // Thiết bị riêng: render WAV rồi phát qua <audio> + setSinkId.
            try {
              const wav = await invoke<{ audioBase64: string; audioMime: string }>(
                "render_apple_tts",
                {
                  text: trimmed,
                  lang: ttsLang,
                  voiceId: s.appleTtsVoice?.trim() || undefined,
                  rate: s.appleTtsRate ?? 0.62,
                  pitch: s.appleTtsPitch ?? 1,
                },
              );
              if (cancelled()) return null;
              const readyMs = Date.now() - t0;
              await playBase64(wav.audioBase64, wav.audioMime, 1, sink, appleVolume, monitorSink, el);
              return readyMs;
            } catch (err) {
              // Người kia phải nghe được → để engine dự phòng (API) phát vào đúng thiết bị.
              if (target === "them") throw err;
              // Giọng Siri neural không render được → phát thẳng ra loa mặc định.
              console.warn("Apple TTS render lỗi → phát loa mặc định:", err);
              setStatusQuiet("Giọng này chỉ phát ra loa mặc định, chọn giọng khác để chuyển thiết bị");
            }
          }
          return await invoke<number>("speak_apple_tts", {
            text: trimmed,
            lang: ttsLang,
            voiceId: s.appleTtsVoice?.trim() || undefined,
            rate: s.appleTtsRate ?? 0.62,
            pitch: s.appleTtsPitch ?? 1,
            volume: s.appleTtsVolume ?? 0.45,
          });
        };

        const viaOpenRouter = async (): Promise<number | null> => {
          const tts = await invoke<{
            audioBase64: string;
            audioMime: string;
            ttsMs: number;
          }>("synthesize_speech", { text: trimmed, voice: s.ttsVoice, model: s.ttsModel });
          if (cancelled()) return null;
          const readyMs = Date.now() - t0;
          await playBase64(
            tts.audioBase64,
            tts.audioMime || "audio/mpeg",
            1,
            sink,
            target === "them" ? 1 : 0.55,
            monitorSink,
            el,
          );
          return readyMs;
        };

        // Kokoro: on-device, render WAV → phát tới đúng thiết bị (kể cả mic ảo).
        const kokoro = kokoroFor(s.kokoroVoice, ttsLang);
        const viaKokoro = async (): Promise<number | null> => {
          if (!kokoro) throw new Error("Kokoro không đọc được ngôn ngữ này");
          const wav = await invoke<{ audioBase64: string; audioMime: string }>("kokoro_render", {
            text: trimmed,
            sid: kokoro.sid,
            lang: kokoro.kokoroLang,
            speed: s.kokoroSpeed || 1,
          });
          if (cancelled()) return null;
          const readyMs = Date.now() - t0;
          await playBase64(
            wav.audioBase64,
            wav.audioMime,
            1,
            sink,
            target === "them" ? 1 : 0.8,
            monitorSink,
            el,
          );
          return readyMs;
        };

        const engine = s.ttsEngine === "kokoro" && !kokoro ? "apple" : s.ttsEngine;
        const primary =
          engine === "kokoro" ? viaKokoro : engine === "openrouter" ? viaOpenRouter : viaApple;
        const fallback = engine === "apple" ? viaOpenRouter : viaApple;
        try {
          return await primary();
        } catch (err) {
          console.warn(`TTS ${engine} lỗi → dự phòng:`, err);
          if (cancelled()) return null;
          try {
            return await fallback();
          } catch {
            return null;
          }
        }
      };

      // Thời gian chờ trong hàng đợi cũng tính vào độ trễ người kia cảm nhận.
      const enqueuedAt = Date.now();
      const timed = async () => {
        const waitMs = Date.now() - enqueuedAt;
        ttsPlayingRef.current += 1;
        try {
          const readyMs = await job();
          return readyMs == null ? null : waitMs + readyMs;
        } finally {
          ttsPlayingRef.current -= 1;
        }
      };
      const queueRef = target === "them" ? voiceQueueRef : ttsQueueRef;
      const queued = queueRef.current.then(timed, timed);
      queueRef.current = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },
    [playBase64, setStatusQuiet],
  );

  /**
   * Nghe thử giọng đọc của một hướng với cài đặt hiện tại. Luôn phát ra loa của bạn
   * (không vào mic ảo), không qua hàng đợi.
   */
  const previewVoice = useCallback(
    async (mine: boolean) => {
      const all = settingsRef.current;
      const cfg = direction(all, mine);
      const lang = mine ? all.theirLang : all.myLang;
      const text = VOICE_SAMPLES[lang.slice(0, 2).toLowerCase()] ?? VOICE_SAMPLES.en!;
      const sink = speakerIdRef.current;
      const kokoro = cfg.ttsEngine === "kokoro" ? kokoroFor(cfg.kokoroVoice, lang) : null;
      if (kokoro) {
        const wav = await invoke<{ audioBase64: string; audioMime: string }>("kokoro_render", {
          text,
          sid: kokoro.sid,
          lang: kokoro.kokoroLang,
          speed: cfg.kokoroSpeed || 1,
        });
        await playBase64(wav.audioBase64, wav.audioMime, 1, sink, 1);
        return;
      }
      if (cfg.ttsEngine === "openrouter") {
        const tts = await invoke<{ audioBase64: string; audioMime: string }>("synthesize_speech", {
          text,
          voice: cfg.ttsVoice,
          model: cfg.ttsModel,
        });
        await playBase64(tts.audioBase64, tts.audioMime || "audio/mpeg", 1, sink, 1);
        return;
      }
      const ttsLang = lang.toLowerCase().startsWith("vi") ? "vi-VN" : lang;
      try {
        const wav = await invoke<{ audioBase64: string; audioMime: string }>("render_apple_tts", {
          text,
          lang: ttsLang,
          voiceId: cfg.appleTtsVoice?.trim() || undefined,
          rate: cfg.appleTtsRate ?? 0.62,
          pitch: cfg.appleTtsPitch ?? 1,
        });
        await playBase64(wav.audioBase64, wav.audioMime, 1, sink, cfg.appleTtsVolume ?? 1);
      } catch {
        // Giọng Siri neural không render được → đọc thẳng ra loa mặc định.
        await invoke("speak_apple_tts", {
          text,
          lang: ttsLang,
          voiceId: cfg.appleTtsVoice?.trim() || undefined,
          rate: cfg.appleTtsRate ?? 0.62,
          pitch: cfg.appleTtsPitch ?? 1,
          volume: cfg.appleTtsVolume ?? 1,
        });
      }
    },
    [playBase64],
  );

  const refreshDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    // "default"/"communications" are aliases of a real device; "Mặc định hệ thống" already covers them.
    const real = (d: MediaDeviceInfo) => d.deviceId !== "default" && d.deviceId !== "communications";
    setMics(devices.filter((d) => d.kind === "audioinput" && real(d)));
    const outs = devices.filter((d) => d.kind === "audiooutput" && real(d));
    speakersRef.current = outs;
    setSpeakers(outs);
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
    async (
      audioBase64: string,
      mimeType: string,
      role: "me" | "them",
      speak: boolean,
      /** Listen qua API (system audio): đọc bản dịch như luồng Apple. Không dùng cho mic (dội loa). */
      speakTranslation = false,
      /** "apple": audio là WAV, nhận giọng bằng Apple (lỗi → API). */
      sttVia: Engine = "openrouter",
    ) => {
      const gen = ++utteranceGenRef.current;
      const lineId = `${Date.now()}-${gen}`;
      const sourceLang =
        role === "me" ? settingsRef.current.myLang : settingsRef.current.theirLang;
      const targetLang =
        role === "me" ? settingsRef.current.theirLang : settingsRef.current.myLang;

      const wantTranslate = translateOnRef.current;
      setStatus(role === "me" ? "Interpreting · STT…" : "Listen · STT…");

      try {
        type SttResult = { text: string; sttMs: number };
        const dir = direction(settingsRef.current, role === "me");
        const viaApi = () =>
          invoke<SttResult>("transcribe_audio", {
            audioBase64,
            mimeType,
            language: sourceLang,
            model: dir.sttModel,
          });
        const stt =
          sttVia === "apple"
            ? await invoke<SttResult>("transcribe_apple", {
                audioBase64,
                language: sourceLang,
              })
            : await viaApi();

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
              engine: dir.translateEngine,
              model: dir.translateModel,
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
              if (speakTranslation && ttsOnRef.current && result.translatedText.trim()) {
                void enqueueSpeech(result.translatedText, targetLang).then((ttsMs) => {
                  if (ttsMs != null) result.ttsMs = ttsMs;
                });
              }
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
        const speakText = wantTranslate ? result.translatedText : result.sourceText;
        const speakLang = wantTranslate ? targetLang : sourceLang;
        const persistP = persistUtterance(result);
        // Interpreting: xếp TTS ngay, không chặn pipeline. Lời bạn → phát cho họ (không phụ thuộc "Đọc bản dịch").
        {
          void enqueueSpeech(speakText, speakLang, role === "me" ? "them" : "me").then((ttsMs) => {
            if (ttsMs == null) return;
            result.ttsMs = ttsMs;
            // Độ trễ từng chặng, để biết chặng nào làm người kia phải chờ.
            const sec = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
            setStatus(
              `${role === "me" ? "Bạn" : "Họ"} · nhận giọng ${sec(result.sttMs)} · dịch ${sec(result.translateMs)} · tạo giọng ${sec(ttsMs)}`,
            );
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
      }
    },
    [patchLiveLine, persistUtterance, recentTranslateContext, enqueueSpeech, setStatusQuiet, wordList],
  );

  const runUtterance = useCallback(
    async (blob: Blob, role: "me" | "them", speak: boolean) => {
      if (blob.size < 1200) {
        setStatus("Audio quá ngắn");
        return;
      }
      if (direction(settingsRef.current, role === "me").sttEngine === "apple") {
        let wav: string | null = null;
        try {
          wav = await blobToWavBase64(blob);
        } catch (err) {
          console.warn("Đổi audio sang WAV lỗi → API:", err);
        }
        if (wav) {
          await runUtteranceFromBase64(wav, "audio/wav", role, speak, false, "apple");
          return;
        }
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
          engine: "apple",
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
          void enqueueSpeech(vi, ttsLang).then((ttsMs) => {
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
          void enqueueSpeech(trimmed, "en-US");
        }
        setStatus(String(err));
      }
    },
    [patchLiveLine, persistUtterance, recentTranslateContext, setStatusQuiet, enqueueSpeech, wordList],
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
        if (listenSourceRef.current === "app" && settingsRef.current.sttEngine === "openrouter") {
          // STT qua API: Rust cắt system audio theo câu (VAD), mình gửi từng câu lên OpenRouter.
          if (holdingRef.current) {
            await sleep(120);
            continue;
          }
          let chunk: SystemAudioChunk | null = null;
          try {
            chunk = await invoke<SystemAudioChunk | null>("pull_system_utterance", {
              maxWaitMs: 1000,
              maxUtteranceMs: 8000,
            });
          } catch (err) {
            setStatusQuiet(String(err));
            await sleep(1000);
            continue;
          }
          if (!chunk || !listenActiveRef.current || settingsRef.current.sttEngine !== "openrouter") {
            continue;
          }
          setLevelThrottled(Math.min(100, Math.round((chunk.rms || 0) * 400)));
          try {
            await runUtteranceFromBase64(chunk.audioBase64, chunk.mimeType, "them", false, true);
          } catch (err) {
            console.warn(err);
          }
          continue;
        }
        if (listenSourceRef.current === "app") {
          try {
            const st = await invoke<{ running: boolean; peakRms: number }>("apple_listen_status");
            if ((st.peakRms || 0) > 0.02) lastThemSoundAtRef.current = Date.now();
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
  }, [listenFromMicOnce, runUtteranceFromBase64, setLevelThrottled, setStatusQuiet]);

  /**
   * Xếp một câu của bạn (STT → dịch → đọc cho người kia) chạy nền theo đúng thứ tự nói.
   * Dùng chung cho Giữ để nói và Nói liên tục.
   */
  const queueMine = useCallback(
    (work: () => Promise<void>) => {
      pendingSpeechRef.current += 1;
      busyRef.current = true;
      setBusy(true);
      setStatus("Đang dịch câu của bạn…");
      const job = async () => {
        try {
          await work();
        } catch (err) {
          const msg = String(err);
          if (/dictation|siri/i.test(msg)) {
            // macOS chỉ cho nhận giọng khi Đọc chính tả đang bật (và đã tải gói ngôn ngữ).
            setStatus(
              "Cần bật Đọc chính tả của macOS: Cài đặt hệ thống › Bàn phím › Đọc chính tả, thêm Tiếng Việt",
            );
            if (!dictationHelpShownRef.current) {
              dictationHelpShownRef.current = true;
              void invoke("open_dictation_settings").catch(() => {});
            }
            return;
          }
          setStatus(
            msg.includes("STT không trả text") || msg.includes("quá ngắn")
              ? "Không nghe rõ, nói lại nhé"
              : msg.replace(/^Error:\s*/i, ""),
          );
        } finally {
          pendingSpeechRef.current -= 1;
          if (pendingSpeechRef.current <= 0) {
            pendingSpeechRef.current = 0;
            busyRef.current = false;
            setBusy(false);
          }
        }
      };
      speechChainRef.current = speechChainRef.current.then(job, job);
    },
    [],
  );

  /**
   * Giữ = ghi, thả = xong. Xử lý (STT → dịch → đọc) chạy nền theo thứ tự câu,
   * không chặn lần giữ tiếp theo.
   */
  const startHold = useCallback(async () => {
    if (!interpretReadyRef.current || holdingRef.current || talkModeRef.current === "continuous")
      return;
    const token = ++holdTokenRef.current;
    holdingRef.current = true;
    holdStartedAtRef.current = performance.now();
    setHolding(true);
    setStatus("Đang ghi giọng bạn… thả ra để dịch");
    try {
      await gateSystemAudio(true);
      const stream = await ensureMic();
      // Thả ra trước khi mic kịp mở → bỏ, không để máy ghi chạy mồ côi.
      if (!holdingRef.current || token !== holdTokenRef.current) return;
      const chunks: Blob[] = [];
      const mime = pickMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      interpretChunksRef.current = chunks;
      interpretRecorderRef.current = rec;
      rec.start(180);
    } catch (err) {
      holdingRef.current = false;
      setHolding(false);
      setStatus(`Không mở được micro: ${String(err).replace(/^Error:\s*/i, "")}`);
      void invoke("set_system_audio_gated", { gated: false }).catch(() => {});
    }
  }, [ensureMic, gateSystemAudio]);

  const stopHold = useCallback(async () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    setHolding(false);
    const heldMs = performance.now() - holdStartedAtRef.current;
    const rec = interpretRecorderRef.current;
    const chunks = interpretChunksRef.current;
    interpretRecorderRef.current = null;
    // Mở lại Listen ngay — không hủy STT bằng duck dài
    listenMutedUntilRef.current = Date.now() + 400;
    void invoke("set_system_audio_gated", { gated: false }).catch(() => {});

    if (!rec || rec.state === "inactive") {
      setStatus("Giữ lâu hơn một chút rồi hãy nói");
      return;
    }
    const blob: Blob = await new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
      rec.stop();
    });
    if (heldMs < 450) {
      setStatus("Giữ lâu hơn một chút rồi hãy nói");
      return;
    }

    queueMine(() => runUtterance(blob, "me", true));
  }, [queueMine, runUtterance]);

  /** PCM tap on the mic with a 0.5 s ring buffer, so a sentence keeps its first syllable. */
  const ensurePcmTap = useCallback(async () => {
    const stream = await ensureMic();
    const ctx = audioCtxRef.current;
    if (!ctx) throw new Error("Không mở được micro");
    if (pcmTapRef.current?.ctx === ctx) return pcmTapRef.current;
    const tap = {
      ctx,
      rate: ctx.sampleRate,
      ring: [] as Float32Array[],
      recording: null as Float32Array[] | null,
    };
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    const ringMax = Math.ceil((ctx.sampleRate * 0.5) / 2048);
    node.onaudioprocess = (e) => {
      const chunk = new Float32Array(e.inputBuffer.getChannelData(0));
      if (tap.recording) tap.recording.push(chunk);
      tap.ring.push(chunk);
      while (tap.ring.length > ringMax) tap.ring.shift();
    };
    src.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
    pcmTapRef.current = tap;
    return tap;
  }, [ensureMic]);

  /**
   * Nói liên tục: mic luôn mở, phát hiện bạn bắt đầu nói / ngừng ~0,7 s thì chốt câu và xử lý nền.
   * Tạm ngưng thu khi app đang đọc hoặc người bên kia đang nói (tránh tự dịch lại tiếng loa).
   */
  const continuousLoop = useCallback(async () => {
    if (continuousRunningRef.current) return;
    continuousRunningRef.current = true;
    const active = () => talkModeRef.current === "continuous" && interpretReadyRef.current;
    const quiet = () =>
      ttsPlayingRef.current > 0 || Date.now() - lastThemSoundAtRef.current < 400;
    try {
      const tap = await ensurePcmTap();
      setStatus("Nói liên tục · cứ nói, ngừng một chút là app tự dịch");
      while (active()) {
        if (quiet() || currentRms() < 0.04) {
          await sleep(40);
          continue;
        }
        // Bắt đầu câu: lấy cả 0,5 s đệm trước đó.
        tap.recording = [...tap.ring];
        setAutoTalking(true);
        let silentMs = 0;
        let speechMs = 0;
        const t0 = Date.now();
        while (active() && Date.now() - t0 < 15000) {
          if (quiet()) break;
          if (currentRms() > 0.03) {
            silentMs = 0;
            speechMs += 50;
          } else {
            silentMs += 50;
          }
          if (speechMs > 300 && silentMs > 700) break;
          await sleep(50);
        }
        const chunks = tap.recording ?? [];
        tap.recording = null;
        setAutoTalking(false);
        if (speechMs < 350 || !chunks.length) continue;
        const wav = floatChunksToWavBase64(chunks, tap.rate);
        queueMine(() => runUtteranceFromBase64(wav, "audio/wav", "me", true, false, "apple"));
      }
    } catch (err) {
      setStatus(`Không mở được micro: ${String(err).replace(/^Error:\s*/i, "")}`);
    } finally {
      if (pcmTapRef.current) pcmTapRef.current.recording = null;
      continuousRunningRef.current = false;
      setAutoTalking(false);
    }
  }, [currentRms, ensurePcmTap, queueMine, runUtteranceFromBase64]);

  const setTalkMode = useCallback((mode: "hold" | "continuous") => {
    talkModeRef.current = mode;
    writePref("hb.talkMode", mode);
    setTalkModeState(mode);
  }, []);

  useEffect(() => {
    talkModeRef.current = talkMode;
    if (talkMode === "continuous" && interpretReady) void continuousLoop();
    else if (talkMode === "continuous") setStatus("Nói liên tục đang tạm dừng (Phiên dịch giọng tôi đang tắt)");
  }, [talkMode, interpretReady, continuousLoop]);

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

  const startSystemListen = useCallback(async () => {
    let bundleId = listenAppIdRef.current.trim();
    if (!bundleId) {
      await refreshAudioApps();
      bundleId = listenAppIdRef.current.trim();
    }
    if (!bundleId) {
      throw new Error("Chưa chọn app để nghe — mở Chrome/Zoom rồi tải lại danh sách");
    }
    if (settingsRef.current.sttEngine === "openrouter") {
      try {
        await invoke("stop_apple_listen");
      } catch {}
      await invoke("start_system_audio", { bundleId });
      setStatusQuiet(`Listen · ${bundleId} · nhận giọng qua API`);
      return "openrouter";
    }
    try {
      await invoke("stop_system_audio");
    } catch {}
    const engine = await invoke<string>("start_apple_listen", { bundleId });
    setStatusQuiet(
      engine === "speechanalyzer"
        ? `Listen · ${bundleId} · SpeechAnalyzer`
        : `Listen · chỉ ${bundleId}`,
    );
    return engine;
  }, [refreshAudioApps, setStatusQuiet]);

  // Đổi engine nhận giọng khi đang nghe app → khởi động lại nguồn audio tương ứng.
  const prevSttEngineRef = useRef(settings.sttEngine);
  useEffect(() => {
    if (prevSttEngineRef.current === settings.sttEngine) return;
    prevSttEngineRef.current = settings.sttEngine;
    if (!listenActiveRef.current || listenSourceRef.current !== "app") return;
    void startSystemListen().catch((err) => setStatus(String(err)));
  }, [settings.sttEngine, startSystemListen]);

  const setListen = useCallback(
    async (on: boolean) => {
      setListenOn(on);
      listenActiveRef.current = on;
      if (on) {
        sttCommittedPrefixRef.current = "";
        listenMutedUntilRef.current = 0;
        if (listenSourceRef.current === "app") {
          try {
            await startSystemListen();
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
    [listenLoop, setStatusQuiet, startSystemListen],
  );

  const changeListenApp = useCallback(
    async (bundleId: string) => {
      setListenAppId(bundleId);
      listenAppIdRef.current = bundleId;
      if (!listenActiveRef.current || listenSourceRef.current !== "app") return;
      try {
        await startSystemListen();
      } catch (err) {
        setStatus(String(err));
      }
    },
    [startSystemListen],
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
          sttEngine: "apple",
          // Nhận giọng phía họ (Apple Listen) hiện chỉ hỗ trợ tiếng Anh.
          theirLang: "en",
          translateEngine: "apple",
          // Đọc bản dịch cho bạn: luôn Apple (nhanh nhất).
          ttsEngine: "apple",
          kokoroSpeed: saved.kokoroSpeed || 1,
          speak: normalizeSpeak(saved.speak, { ...defaultSettings, ...saved } as AppSettings),
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
          sttEngine: "apple",
          // Nhận giọng phía họ (Apple Listen) hiện chỉ hỗ trợ tiếng Anh.
          theirLang: "en",
          translateEngine: "apple",
          // Đọc bản dịch cho bạn: luôn Apple (nhanh nhất).
          ttsEngine: "apple",
          kokoroSpeed: cfg.settings.kokoroSpeed || 1,
          speak: normalizeSpeak(cfg.settings.speak, { ...defaultSettings, ...cfg.settings } as AppSettings),
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
        const words = candidate.split(/\s+/).filter(Boolean).length;
        // Hết câu (.?!) → chốt nhanh để dịch luôn. Chưa hết câu: chờ người nói nói tiếp;
        // mẩu ngắn (vd. "I am") chờ lâu hơn để ghép với phần sau thay vì thành tin riêng.
        const settleMs = looksComplete
          ? 450
          : candidate.length > 160
            ? 1100
            : words < 4
              ? 2400
              : 1800;
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

    // Space hoặc Option (trái/phải). Bỏ qua khi đang gõ trong ô nhập.
    const isHoldKey = (e: KeyboardEvent) => e.code === "Space" || e.key === "Alt";
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isHoldKey(e) || isTyping(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      void startHold();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!isHoldKey(e) || !holdingRef.current) return;
      e.preventDefault();
      void stopHold();
    };
    // Mất focus khi đang giữ (Cmd+Tab…) → coi như thả.
    const onBlur = () => {
      if (holdingRef.current) void stopHold();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    return () => {
      unlistenApple?.();
      unlistenStatus?.();
      if (punctTimer) clearTimeout(punctTimer);
      navigator.mediaDevices.removeEventListener("devicechange", onDevice);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
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
    previewVoice,
    talkMode,
    setTalkMode,
    autoTalking,
    refreshDevices,
    voiceOutId,
    setVoiceOutId,
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
