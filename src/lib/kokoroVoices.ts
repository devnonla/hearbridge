/**
 * Kokoro multi-lang v1.0 speakers, in model order (index = speaker id) —
 * matches `speaker_names` in model.onnx metadata (54 voices).
 * Name prefix: language (a/b English US/UK, e Spanish, f French, h Hindi, i Italian,
 * j Japanese, p Portuguese, z Chinese) + gender (f/m).
 */
const NAMES = [
  "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore", "af_nicole",
  "af_nova", "af_river", "af_sarah", "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir",
  "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa", "bf_alice", "bf_emma",
  "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis", "ef_dora",
  "em_alex", "ff_siwis", "hf_alpha", "hf_beta", "hm_omega", "hm_psi", "if_sara", "im_nicola",
  "jf_alpha", "jf_gongitsune", "jf_nezumi", "jf_tebukuro", "jm_kumo", "pf_dora", "pm_alex",
  "pm_santa", "zf_xiaobei", "zf_xiaoni", "zf_xiaoxiao", "zf_xiaoyi", "zm_yunjian", "zm_yunxi",
  "zm_yunxia", "zm_yunyang", "em_santa",
] as const;

/**
 * Voice prefix → [app language code, espeak-ng lang for Kokoro, accent label].
 * Only codes sherpa-onnx accepts: "en-gb", "fr-fr" and "zh" crash it natively.
 */
const PREFIX: Record<string, [string, string, string]> = {
  a: ["en", "en-us", "Mỹ"],
  b: ["en", "en", "Anh"],
  e: ["es", "es", ""],
  f: ["fr", "fr", ""],
  h: ["hi", "hi", ""],
  i: ["it", "it", ""],
  j: ["ja", "ja", ""],
  p: ["pt", "pt-br", ""],
  z: ["zh", "cmn", ""],
};

export type KokoroVoice = {
  name: string;
  sid: number;
  /** App language code ("en", "ja"…). */
  lang: string;
  /** Lang passed to Kokoro ("en-us"…). */
  kokoroLang: string;
  label: string;
  description: string;
};

export const KOKORO_VOICES: KokoroVoice[] = NAMES.map((name, sid) => {
  const [lang, kokoroLang, accent] = PREFIX[name[0]!] ?? ["en", "en-us", ""];
  const female = name[1] === "f";
  const pretty = name.slice(3).replace(/^\w/, (c) => c.toUpperCase());
  return {
    name,
    sid,
    lang,
    kokoroLang,
    label: pretty,
    description: [female ? "Nữ" : "Nam", accent && `giọng ${accent}`].filter(Boolean).join(" · "),
  };
});

/** Voices that can read `lang` (app code like "en", "vi"). Empty = Kokoro can't speak it. */
export function kokoroVoicesFor(lang: string): KokoroVoice[] {
  const code = lang.slice(0, 2).toLowerCase();
  return KOKORO_VOICES.filter((v) => v.lang === code);
}

export function kokoroVoice(name: string): KokoroVoice | undefined {
  return KOKORO_VOICES.find((v) => v.name === name);
}
