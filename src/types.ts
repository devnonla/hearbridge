export type AppSettings = {
  sttModel: string;
  translateModel: string;
  notesModel: string;
  ttsModel: string;
  ttsVoice: string;
  /** Identifier AVSpeech (Voice 3/4…). Rỗng = tự chọn. */
  appleTtsVoice: string;
  /** 0..1 chậm→nhanh */
  appleTtsRate: number;
  /** 0.5..2 cao độ */
  appleTtsPitch: number;
  /** 0..1 âm lượng Apple TTS */
  appleTtsVolume: number;
  myLang: string;
  theirLang: string;
  wordList: string[];
  autoNotesEvery: number;
  openrouterApiKey: string;
  openrouterBaseUrl: string;
};

export type ConfigInfo = {
  hasKey: boolean;
  baseUrl: string;
  settings: AppSettings;
};

export type UtteranceResult = {
  role: string;
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  audioBase64: string | null;
  audioMime: string | null;
  sttMs: number;
  translateMs: number;
  ttsMs: number | null;
  ttsError: string | null;
};

/** Dòng phụ đề sống trên timeline (không ghi đè) */
export type LiveCaption = {
  id: string;
  at: string;
  role: "me" | "them";
  source: string;
  translated: string;
  translating: boolean;
  sttMs: number;
  translateMs?: number;
};

export type MeetingNotes = {
  summary: string;
  topics: string[];
  decisions: string[];
  todos: string[];
  glossary: { term: string; note: string }[];
  updatedAt?: string | null;
};

export type TranscriptLine = {
  id: string;
  at: string;
  role: string;
  source: string;
  translated: string;
  sourceLang: string;
  targetLang: string;
  sttMs: number;
  translateMs: number;
};

export type Meeting = {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string | null;
  myLang: string;
  theirLang: string;
  lines: TranscriptLine[];
  notes: MeetingNotes;
  wordList: string[];
};

export type MeetingSummary = {
  id: string;
  title: string;
  startedAt: string;
  endedAt?: string | null;
  lineCount: number;
  hasNotes: boolean;
};

export type SystemAudioChunk = {
  audioBase64: string;
  mimeType: string;
  durationMs: number;
  rms: number;
};

export type SystemAudioStatus = {
  running: boolean;
  available: boolean;
  sampleRate: number;
  bufferedMs: number;
  rms: number;
  platform: string;
  bundleId?: string | null;
  appName?: string | null;
};

export type AudioApp = {
  bundleId: string;
  name: string;
  processId: number;
  preferred: boolean;
  iconBase64?: string | null;
  previewBase64?: string | null;
};

export type OrModel = {
  id: string;
  name: string;
  inputModalities: string[];
  outputModalities: string[];
  supportedVoices: string[];
  capability: string;
  priceLabel: string;
  promptPrice?: number | null;
  completionPrice?: number | null;
};

export type OrModelLists = {
  stt: OrModel[];
  tts: OrModel[];
  chat: OrModel[];
  fetchedAt: string;
};

export const LANGS = [
  { value: "vi", label: "Tiếng Việt" },
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
] as const;
