import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Input,
  Segmented,
  Select,
  type SelectOptionConfig,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  message,
} from "devnonla-ui";
import {
  AppWindow,
  AudioLines,
  ChevronRight,
  Headphones,
  Languages,
  Mic,
  RefreshCw,
  Play,
  Send,
  Volume2,
} from "lucide-react";
import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { AvatarField } from "@/components/ChatAvatar";
import { RangeField } from "@/components/RangeField";
import { CheckForUpdatesButton } from "@/components/UpdateBanner";
import { normalizeSpeak, type useCicadaApp } from "@/hooks/useCicadaApp";
import type { Profile, Profiles } from "@/hooks/useProfiles";
import { kokoroVoicesFor } from "@/lib/kokoroVoices";
import { type Engine, LANGS, type TtsEngine } from "@/types";

type HearBridge = ReturnType<typeof useCicadaApp>;

type Props = {
  app: HearBridge;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedAppName: string;
  selectedIcon: string | null;
  profiles: Profiles;
  onProfileChange: (who: keyof Profiles, patch: Partial<Profile>) => void;
  onPickApp: () => void;
};

type Voice = { id: string; name: string; lang: string; gender: string; quality: string };

/** One direction's pipeline settings, whichever block of AppSettings they live in. */
type Pipeline = {
  sttEngine: Engine;
  translateEngine: Engine;
  ttsEngine: TtsEngine;
  sttModel: string;
  translateModel: string;
  ttsModel: string;
  ttsVoice: string;
  appleTtsVoice: string;
  appleTtsRate: number;
  appleTtsPitch: number;
  appleTtsVolume: number;
  kokoroVoice: string;
  kokoroSpeed: number;
};

type KokoroState = {
  installed: boolean;
  downloading: boolean;
  sizeBytes: number;
  progress: { phase: string; downloaded: number; total: number } | null;
  onDownload: () => void;
};

type PackStatus = "installed" | "supported" | "unsupported" | "unknown" | "loading";

/** Keep a saved value visible even when it's missing from a freshly loaded list. */
function withCurrent(options: SelectOptionConfig[], value: string): SelectOptionConfig[] {
  if (!value || options.some((o) => o.value === value)) return options;
  return [{ value, label: value }, ...options];
}

function toModelOpt(m: { id: string; name: string; priceLabel?: string }): SelectOptionConfig {
  return {
    value: m.id,
    label: m.name?.trim() || m.id,
    description: m.priceLabel && m.priceLabel !== "—" ? m.priceLabel : undefined,
  };
}

/** Siri voices only (the natural ones). Falls back to every voice if none is downloaded yet. */
function siriFirst(voices: Voice[]): Voice[] {
  const siri = voices.filter((v) => v.quality === "siri");
  return siri.length ? siri : voices;
}

function voiceOptions(voices: Voice[], current: string): SelectOptionConfig[] {
  return withCurrent(
    siriFirst(voices).map((v) => ({
      value: v.id,
      label: v.name.replace(/\s*\(.*?\)\s*$/, ""),
      description: [v.gender, v.lang].filter(Boolean).join(" · ") || undefined,
    })),
    current,
  );
}

function PackTag({ status }: { status: PackStatus }) {
  switch (status) {
    case "installed":
      return <Tag color="success">Đã tải</Tag>;
    case "supported":
      return <Tag color="warning">Chưa tải</Tag>;
    case "unsupported":
      return <Tag color="error">Không hỗ trợ</Tag>;
    case "loading":
      return <Tag>Đang kiểm tra…</Tag>;
    default:
      return <Tag>Không rõ</Tag>;
  }
}

type FlowStep = { icon: ReactNode; label: string; value: string };

/** One-glance summary of a direction: source, each step's engine, where it plays. */
function FlowStrip({ steps }: { steps: FlowStep[] }) {
  return (
    <div className="bg-bar flex flex-wrap items-center gap-x-0.5 gap-y-1 rounded-lg p-1.5">
      {steps.map((step, i) => (
        <Fragment key={step.label}>
          {i > 0 && (
            <ChevronRight className="text-quaternary-foreground size-3.5 shrink-0" aria-hidden />
          )}
          <span className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1">
            <span className="text-muted-foreground shrink-0 [&>svg]:size-4">{step.icon}</span>
            <span className="min-w-0">
              <span className="text-tertiary-foreground block text-xs leading-tight">
                {step.label}
              </span>
              <span className="block max-w-[7rem] truncate text-sm leading-tight font-medium">
                {step.value}
              </span>
            </span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}

const BLACKHOLE_URL = "https://existential.audio/blackhole/";

const langName = (code: string) => LANGS.find((l) => l.value === code)?.label ?? code;

const engineName = (e: TtsEngine) =>
  e === "openrouter" ? "API" : e === "kokoro" ? "Kokoro" : "Apple";

function KokoroDownload({ kokoro }: { kokoro: KokoroState }) {
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
  const p = kokoro.progress;
  const busy = kokoro.downloading || (p != null && p.phase !== "done");
  const pct = p && p.total ? Math.min(100, Math.round((p.downloaded / p.total) * 100)) : 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-sm">
        Kokoro chạy hoàn toàn trên máy. Cần tải model một lần (khoảng {mb(kokoro.sizeBytes)}).
      </p>
      {busy ? (
        <div className="flex flex-col gap-1.5">
          <div className="bg-muted-strong h-1.5 w-full overflow-hidden rounded-full" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="bg-brand-fill h-full rounded-full transition-[width] duration-300" style={{ width: `${p?.phase === "extracting" ? 100 : pct}%` }} />
          </div>
          <p className="text-tertiary-foreground text-xs">
            {p?.phase === "extracting"
              ? "Đang giải nén…"
              : p
                ? `Đang tải ${mb(p.downloaded)} / ${mb(p.total)} (${pct}%)`
                : "Đang bắt đầu tải…"}
          </p>
        </div>
      ) : (
        <div>
          <Button type="primary" size="small" onClick={kokoro.onDownload}>
            Tải Kokoro
          </Button>
        </div>
      )}
    </div>
  );
}

/** Plays a sample sentence with the current voice settings, on the user's own speaker. */
function PreviewButton({ onPreview }: { onPreview: () => Promise<void> }) {
  const [playing, setPlaying] = useState(false);
  return (
    <Tooltip title="Nghe thử giọng này">
      <Button
        type="icon"
        aria-label="Nghe thử giọng"
        loading={playing}
        onClick={async () => {
          setPlaying(true);
          try {
            await onPreview();
          } catch (err) {
            message.error(`Không phát thử được: ${String(err).replace(/^Error:\s*/i, "")}`);
          } finally {
            setPlaying(false);
          }
        }}
      >
        <Play className="size-3.5 fill-current" />
      </Button>
    </Tooltip>
  );
}

type VoiceCardProps = {
  title: string;
  cfg: Pipeline;
  set: (patch: Partial<Pipeline>) => void;
  hasKey: boolean;
  voices: Voice[];
  onReloadVoices: () => void;
  onOpenVoiceSettings: () => void;
  ttsOpts: SelectOptionConfig[];
  /** Note under the Siri voice picker (e.g. Siri can't go into a virtual mic). */
  voiceNote?: string;
  ttsDefaults: { appleTtsRate: number; appleTtsPitch: number; appleTtsVolume: number };
  onPreview: () => Promise<void>;
  /** App language code the voice reads (myLang for "Nghe", theirLang for "Nói"). */
  ttsLang: string;
  kokoro: KokoroState;
  /** Extra rows at the end of the card (e.g. where the voice plays). */
  children?: ReactNode;
  /** Only Apple (Siri) voices, no engine picker. */
  appleOnly?: boolean;
};

/** Which voice reads the translation: Siri · Kokoro · API, with its options. */
function VoiceCard({
  title,
  cfg,
  set,
  hasKey,
  voices,
  onReloadVoices,
  onOpenVoiceSettings,
  ttsOpts,
  voiceNote,
  ttsDefaults,
  onPreview,
  ttsLang,
  kokoro,
  children,
  appleOnly = false,
}: VoiceCardProps) {
  const kokoroVoices = kokoroVoicesFor(ttsLang);
  const rate = Math.round(cfg.appleTtsRate * 100);
  const pitch = Math.round(cfg.appleTtsPitch * 100);
  const volume = Math.round(cfg.appleTtsVolume * 100);
  const ttsIsDefault =
    rate === Math.round(ttsDefaults.appleTtsRate * 100) &&
    pitch === Math.round(ttsDefaults.appleTtsPitch * 100) &&
    volume === Math.round(ttsDefaults.appleTtsVolume * 100);

  return (
    <Card
      title={title}
      caption={
        cfg.ttsEngine === "kokoro" && !appleOnly ? (
          "Kokoro đọc ngay trên máy, miễn phí, giọng tự nhiên và phát được vào mic ảo."
        ) : cfg.ttsEngine === "openrouter" && !appleOnly ? (
          hasKey ? (
            "Đọc bằng model TTS trên mạng, tính phí theo model. Lỗi thì tự chuyển sang Siri."
          ) : (
            <span className="text-warn">Cần nhập OpenRouter API key ở phần Chung bên dưới.</span>
          )
        ) : (
          <span className="flex flex-wrap gap-x-4 gap-y-1">
            <Button type="link" size="small" onClick={onOpenVoiceSettings}>
              Tải thêm giọng trong Đọc và nói…
            </Button>
            <Button type="link" size="small" onClick={onReloadVoices}>
              Tải lại danh sách giọng
            </Button>
            {!ttsIsDefault && (
              <Button type="link" size="small" onClick={() => set({ ...ttsDefaults })}>
                Đặt lại tốc độ, cao độ, âm lượng
              </Button>
            )}
          </span>
        )
      }
    >
      {!appleOnly && (
      <Card.Item label="Đọc bằng">
        <Segmented
          value={cfg.ttsEngine}
          onChange={(v) =>
            set({ ttsEngine: v === "kokoro" ? "kokoro" : v === "openrouter" ? "openrouter" : "apple" })
          }
          options={[
            { label: "Siri", value: "apple" },
            { label: "Kokoro", value: "kokoro" },
            { label: "API", value: "openrouter" },
          ]}
        />
      </Card.Item>
      )}
      {cfg.ttsEngine === "kokoro" && !appleOnly ? (
        !kokoro.installed ? (
          <Card.Item>
            <KokoroDownload kokoro={kokoro} />
          </Card.Item>
        ) : !kokoroVoices.length ? (
          <Card.Item
            label="Chưa có giọng cho ngôn ngữ này"
            description="Kokoro chưa đọc được tiếng Việt, app sẽ đọc bằng Siri."
          />
        ) : (
          <>
            <Card.Item label="Giọng Kokoro" split>
              <div className="flex w-full min-w-0 items-center gap-2">
                <Select
                  className="min-w-0 flex-1"
                  showSearch
                  popupMatchSelectWidth={false}
                  popupClassName="min-w-64!"
                  value={
                    kokoroVoices.some((v) => v.name === cfg.kokoroVoice)
                      ? cfg.kokoroVoice
                      : kokoroVoices[0]!.name
                  }
                  onChange={(v) => set({ kokoroVoice: String(v ?? cfg.kokoroVoice) })}
                  options={kokoroVoices.map((v) => ({
                    value: v.name,
                    label: v.label,
                    description: v.description,
                  }))}
                />
                <PreviewButton onPreview={onPreview} />
              </div>
            </Card.Item>
            <Card.Item label="Tốc độ" split>
              <RangeField
                aria-label="Tốc độ Kokoro"
                value={Math.round((cfg.kokoroSpeed || 1) * 100)}
                min={50}
                max={200}
                format={(v) => `${(v / 100).toFixed(2)}×`}
                onChange={(v) => set({ kokoroSpeed: v / 100 })}
              />
            </Card.Item>
          </>
        )
      ) : cfg.ttsEngine === "openrouter" && !appleOnly ? (
        <>
          <Card.Item label="Model" split>
            <Select
              showSearch
              popupMatchSelectWidth={false}
              value={cfg.ttsModel}
              onChange={(v) => set({ ttsModel: String(v ?? cfg.ttsModel) })}
              options={withCurrent(ttsOpts, cfg.ttsModel)}
            />
          </Card.Item>
          <Card.Item label="Giọng" description="Tên giọng của model, ví dụ alloy" split>
            <div className="flex w-full min-w-0 items-center gap-2">
              <Input
                className="min-w-0 flex-1"
                spellCheck={false}
                value={cfg.ttsVoice}
                onChange={(e) => set({ ttsVoice: e.target.value })}
                placeholder="alloy"
              />
              <PreviewButton onPreview={onPreview} />
            </div>
          </Card.Item>
        </>
      ) : (
        <>
          <Card.Item label="Giọng Siri" description={voiceNote} split>
            <div className="flex w-full min-w-0 items-center gap-2">
              <Select
                className="min-w-0 flex-1"
                showSearch
                popupMatchSelectWidth={false}
                popupClassName="min-w-64!"
                placeholder="Chọn giọng"
                value={cfg.appleTtsVoice}
                onChange={(v) => set({ appleTtsVoice: String(v ?? "") })}
                options={voiceOptions(voices, cfg.appleTtsVoice)}
              />
              <PreviewButton onPreview={onPreview} />
            </div>
          </Card.Item>
          <Card.Item label="Tốc độ" split>
            <RangeField
              aria-label="Tốc độ đọc"
              value={rate}
              min={0}
              max={100}
              format={(v) => `${v}%`}
              onChange={(v) => set({ appleTtsRate: v / 100 })}
            />
          </Card.Item>
          <Card.Item label="Cao độ" split>
            <RangeField
              aria-label="Cao độ giọng"
              value={pitch}
              min={50}
              max={200}
              format={(v) => (v / 100).toFixed(2)}
              onChange={(v) => set({ appleTtsPitch: v / 100 })}
            />
          </Card.Item>
          <Card.Item label="Âm lượng" split>
            <RangeField
              aria-label="Âm lượng giọng đọc"
              value={volume}
              min={0}
              max={100}
              format={(v) => `${v}%`}
              onChange={(v) => set({ appleTtsVolume: v / 100 })}
            />
          </Card.Item>
        </>
      )}
      {children}
    </Card>
  );
}

export function SettingsDrawer({
  app,
  open,
  onOpenChange,
  selectedAppName,
  selectedIcon,
  profiles,
  onProfileChange,
  onPickApp,
}: Props) {
  const { settings, setSettings } = app;
  const [tab, setTab] = useState<"listen" | "speak">("listen");
  const hasKey = Boolean(settings.openrouterApiKey?.trim());
  const theirCode = settings.theirLang.toUpperCase();
  const myCode = settings.myLang.toUpperCase();

  const deviceOpts = (list: MediaDeviceInfo[]): SelectOptionConfig[] => [
    { value: "", label: "Mặc định hệ thống" },
    ...list.map((d) => ({ value: d.deviceId, label: d.label || d.deviceId })),
  ];
  const micOpts = useMemo(() => deviceOpts(app.mics), [app.mics]);
  const speakerOpts = useMemo(() => deviceOpts(app.speakers), [app.speakers]);
  // Loa để bạn nghe: bỏ thiết bị âm thanh ảo (chọn vào thì bạn không nghe được gì).
  const isVirtual = (label: string) => /blackhole|loopback|soundflower|vb-?cable|virtual/i.test(label);
  const listenSpeakerOpts = useMemo(
    () => deviceOpts(app.speakers.filter((d) => !isVirtual(d.label))),
    [app.speakers],
  );
  const deviceName = (list: MediaDeviceInfo[], id: string, fallback: string) =>
    list.find((d) => d.deviceId === id)?.label || fallback;

  const blackHole = app.speakers.find((d) => /blackhole/i.test(d.label));
  const hasVirtualDevice = app.speakers.some((d) => isVirtual(d.label));
  // Loa nghe bản dịch từng bị chọn là thiết bị ảo → đưa về loa mặc định để bạn nghe được.
  useEffect(() => {
    const cur = app.speakers.find((d) => d.deviceId === app.speakerId);
    if (cur && isVirtual(cur.label)) app.setSpeakerId("");
  }, [app.speakers, app.speakerId]);
  const voiceOutIsBlackHole = Boolean(blackHole && app.voiceOutId === blackHole.deviceId);
  const voiceOutIsOwnSpeaker = app.voiceOutId === app.speakerId;

  // One-click BlackHole install (admin prompt), then pick it as the voice output.
  const [installingMic, setInstallingMic] = useState(false);
  const installMic = async () => {
    setInstallingMic(true);
    try {
      await invoke("install_virtual_mic");
      // Core Audio restarts; wait for the device to show up, then select it.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
        const bh = devices.find((d) => d.kind === "audiooutput" && /blackhole/i.test(d.label));
        if (bh) {
          await app.refreshDevices();
          app.setVoiceOutId(bh.deviceId);
          message.success("Đã cài BlackHole. Trong Discord, chọn micro là BlackHole 2ch.");
          return;
        }
      }
      await app.refreshDevices();
      message.info("Đã cài BlackHole. Nếu chưa thấy trong danh sách, mở lại Cài đặt.");
    } catch (err) {
      const msg = String(err).replace(/^Error:\s*/i, "");
      if (msg.includes("Đã hủy")) message.info("Đã hủy cài đặt");
      else message.error(msg);
    } finally {
      setInstallingMic(false);
    }
  };

  const langOpts = useMemo<SelectOptionConfig[]>(
    () => LANGS.map((l) => ({ value: l.value, label: l.label })),
    [],
  );
  const ttsOpts = useMemo(() => app.filtered.tts.map(toModelOpt), [app.filtered.tts]);

  // Voices in the other side's language for the "Nói" direction.
  const [speakVoices, setSpeakVoices] = useState<Voice[]>([]);
  const loadSpeakVoices = () => {
    void invoke<Voice[]>("list_apple_tts_voices", { lang: settings.theirLang })
      .then(setSpeakVoices)
      .catch(() => setSpeakVoices([]));
  };

  // Apple Translation language packs, both directions.
  const [packs, setPacks] = useState<{ listen: PackStatus; speak: PackStatus }>({
    listen: "loading",
    speak: "loading",
  });
  const checkPacks = () => {
    const read = (sourceLang: string, targetLang: string) =>
      invoke<string>("apple_translate_status", { sourceLang, targetLang })
        .then((s): PackStatus =>
          s === "installed" || s === "supported" || s === "unsupported" ? s : "unknown",
        )
        .catch((): PackStatus => "unknown");
    setPacks({ listen: "loading", speak: "loading" });
    void Promise.all([
      read(settings.theirLang, settings.myLang),
      read(settings.myLang, settings.theirLang),
    ]).then(([listen, speak]) => setPacks({ listen, speak }));
  };
  // Re-check when the drawer opens or the language pair changes.
  useEffect(() => {
    if (!open) return;
    void app.refreshDevices().catch(() => {});
    checkPacks();
    loadSpeakVoices();
  }, [open, settings.theirLang, settings.myLang]);

  const listenCfg: Pipeline = {
    sttEngine: settings.sttEngine,
    translateEngine: settings.translateEngine,
    ttsEngine: settings.ttsEngine,
    sttModel: settings.sttModel,
    translateModel: settings.translateModel,
    ttsModel: settings.ttsModel,
    ttsVoice: settings.ttsVoice,
    appleTtsVoice: settings.appleTtsVoice,
    appleTtsRate: settings.appleTtsRate ?? 0.62,
    appleTtsPitch: settings.appleTtsPitch ?? 1,
    appleTtsVolume: settings.appleTtsVolume ?? 0.45,
    kokoroVoice: settings.kokoroVoice || "af_heart",
    kokoroSpeed: settings.kokoroSpeed || 1,
  };
  const setListen = (patch: Partial<Pipeline>) => setSettings((s) => ({ ...s, ...patch }));
  const speakCfg = normalizeSpeak(settings.speak, settings);

  // Kokoro model: status, download with progress (download keeps going if the drawer closes).
  const [kokoroInfo, setKokoroInfo] = useState({ installed: false, downloading: false, sizeBytes: 0 });
  const [kokoroProgress, setKokoroProgress] = useState<KokoroState["progress"]>(null);
  const refreshKokoro = () =>
    void invoke<{ installed: boolean; downloading: boolean; sizeBytes: number }>("kokoro_status")
      .then(setKokoroInfo)
      .catch(() => {});
  useEffect(() => {
    if (open) refreshKokoro();
  }, [open]);
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<NonNullable<KokoroState["progress"]>>("kokoro-download", (e) => {
      setKokoroProgress(e.payload);
      if (e.payload.phase === "done") refreshKokoro();
    }).then((u) => {
      off = u;
    });
    return () => off?.();
  }, []);
  const downloadKokoro = () => {
    setKokoroInfo((k) => ({ ...k, downloading: true }));
    setKokoroProgress(null);
    void invoke("kokoro_download")
      .then(() => message.success("Đã tải xong Kokoro"))
      .catch((err) => message.error(String(err).replace(/^Error:\s*/i, "")))
      .finally(refreshKokoro);
  };
  const kokoro: KokoroState = { ...kokoroInfo, progress: kokoroProgress, onDownload: downloadKokoro };

  // Chỉ dùng giọng Siri: giọng đang chọn không phải Siri (hoặc trống) → chọn Siri đầu tiên.
  const pickSiri = (voices: Voice[], current: string) => {
    const siri = voices.filter((v) => v.quality === "siri");
    return siri.length && !siri.some((v) => v.id === current) ? siri[0]!.id : null;
  };
  useEffect(() => {
    const next = pickSiri(app.appleTtsVoices, settings.appleTtsVoice);
    if (next) setSettings((s) => ({ ...s, appleTtsVoice: next }));
  }, [app.appleTtsVoices, settings.appleTtsVoice]);
  useEffect(() => {
    const next = pickSiri(speakVoices, speakCfg.appleTtsVoice);
    if (next)
      setSettings((s) => ({ ...s, speak: { ...normalizeSpeak(s.speak, s), appleTtsVoice: next } }));
  }, [speakVoices, speakCfg.appleTtsVoice]);
  const setSpeak = (patch: Partial<Pipeline> & { monitor?: boolean }) =>
    setSettings((s) => ({ ...s, speak: { ...normalizeSpeak(s.speak, s), ...patch } }));

  const listenColumn = (
    <div className="flex flex-col gap-8 pt-5">
      <p className="text-muted-foreground -mb-4 text-sm">
        Họ nói {theirCode}, bạn thấy phụ đề và nghe bản dịch {myCode}.
      </p>
      <FlowStrip
        steps={[
          { icon: <AppWindow />, label: "Nghe từ", value: selectedAppName },
          { icon: <AudioLines />, label: "Nhận giọng", value: "Apple" },
          { icon: <Languages />, label: `Dịch ${theirCode}→${myCode}`, value: "Apple" },
          { icon: <Volume2 />, label: "Đọc", value: engineName(listenCfg.ttsEngine) },
          {
            icon: <Headphones />,
            label: "Phát ra",
            value: deviceName(app.speakers, app.speakerId, "Loa mặc định"),
          },
        ]}
      />

      <Card title="Người bên kia">
        <Card.Item label="Tên · ảnh" description="Hiện trên tin nhắn của họ">
          <div className="flex items-center gap-2">
            <Input
              className="w-32"
              value={profiles.them.name}
              onChange={(e) => onProfileChange("them", { name: e.target.value })}
              placeholder="Họ"
            />
            <AvatarField
              profile={profiles.them}
              fallbackSrc={selectedIcon}
              tone="them"
              onChange={(avatar) => onProfileChange("them", { avatar })}
            />
          </div>
        </Card.Item>
        <Card.Item label="Nghe app" description="Chỉ bắt tiếng của app này">
          <Button
            className="max-w-[14rem]"
            icon={
              selectedIcon ? (
                <img src={selectedIcon} alt="" className="size-4 rounded-sm" />
              ) : undefined
            }
            iconPlacement="start"
            onClick={onPickApp}
          >
            <span className="truncate">{selectedAppName}</span>
            <ChevronRight className="text-tertiary-foreground size-3.5 shrink-0" />
          </Button>
        </Card.Item>
        <Card.Item label="Họ nói tiếng" description="Hiện chỉ nhận giọng được tiếng Anh">
          <Tag>English</Tag>
        </Card.Item>
      </Card>

      <VoiceCard
        title="Giọng đọc bản dịch cho bạn"
        appleOnly
        cfg={listenCfg}
        set={setListen}
        hasKey={hasKey}
        voices={app.appleTtsVoices}
        onReloadVoices={() => void app.loadAppleTtsVoices(settings.myLang)}
        onOpenVoiceSettings={() => void app.openAppleTtsVoiceSettings()}
        ttsOpts={ttsOpts}
        ttsDefaults={{ appleTtsRate: 0.62, appleTtsPitch: 1, appleTtsVolume: 0.45 }}
        onPreview={() => app.previewVoice(false)}
        ttsLang={settings.myLang}
        kokoro={kokoro}
      >
        <Card.Item label="Phát ra" description="Nên dùng tai nghe để không lẫn tiếng" split>
          <Select
            value={listenSpeakerOpts.some((o) => o.value === app.speakerId) ? app.speakerId : ""}
            onChange={(v) => app.setSpeakerId(String(v ?? ""))}
            options={listenSpeakerOpts}
          />
        </Card.Item>
      </VoiceCard>
    </div>
  );

  const speakColumn = (
    <div className="flex flex-col gap-8 pt-5">
      <p className="text-muted-foreground -mb-4 text-sm">
        Bạn nói {myCode}, người kia nghe giọng {theirCode} đã dịch.
      </p>
      <FlowStrip
        steps={[
          { icon: <Mic />, label: "Micro", value: deviceName(app.mics, app.micId, "Mặc định") },
          { icon: <AudioLines />, label: "Nhận giọng", value: "Apple" },
          { icon: <Languages />, label: `Dịch ${myCode}→${theirCode}`, value: "Apple" },
          { icon: <Volume2 />, label: "Đọc", value: engineName(speakCfg.ttsEngine) },
          {
            icon: <Send />,
            label: "Phát tới",
            value: deviceName(app.speakers, app.voiceOutId, "Loa mặc định"),
          },
        ]}
      />

      <Card title="Bạn">
        <Card.Item label="Tên · ảnh" description="Hiện trên tin nhắn của bạn">
          <div className="flex items-center gap-2">
            <Input
              className="w-32"
              value={profiles.me.name}
              onChange={(e) => onProfileChange("me", { name: e.target.value })}
              placeholder="Bạn"
            />
            <AvatarField
              profile={profiles.me}
              tone="me"
              onChange={(avatar) => onProfileChange("me", { avatar })}
            />
          </div>
        </Card.Item>
        <Card.Item label="Phiên dịch giọng tôi" description="Tắt thì app chỉ nghe, không dịch lời bạn">
          <Switch checked={app.interpretReady} onChange={app.setInterpretReady} />
        </Card.Item>
        <Card.Item label="Cách nói">
          <Segmented
            value={app.talkMode}
            onChange={(v) => app.setTalkMode(v === "continuous" ? "continuous" : "hold")}
            options={[
              { label: "Giữ để nói", value: "hold" },
              { label: "Nói liên tục", value: "continuous" },
            ]}
          />
        </Card.Item>
        <Card.Item label="Tôi nói tiếng" split>
          <Select
            value={settings.myLang}
            onChange={(v) => {
              const myLang = String(v ?? settings.myLang);
              setSettings((s) => ({ ...s, myLang }));
              void app.loadAppleTtsVoices(myLang);
            }}
            options={langOpts}
          />
        </Card.Item>
        <Card.Item label="Micro" split>
          <Select
            value={app.micId}
            onChange={(v) => app.setMicId(String(v ?? ""))}
            options={micOpts}
          />
        </Card.Item>
      </Card>

      <VoiceCard
        title="Giọng đọc cho người kia"
        cfg={speakCfg}
        set={setSpeak}
        hasKey={hasKey}
        voices={speakVoices}
        onReloadVoices={loadSpeakVoices}
        onOpenVoiceSettings={() => void app.openAppleTtsVoiceSettings()}
        ttsOpts={ttsOpts}
        voiceNote={
          app.voiceOutId && app.voiceOutId !== app.speakerId
            ? "Siri không đi vào mic ảo được, khi phát cho người kia app đọc bằng API"
            : undefined
        }
        ttsDefaults={{ appleTtsRate: 0.55, appleTtsPitch: 1, appleTtsVolume: 1 }}
        onPreview={() => app.previewVoice(true)}
        ttsLang={settings.theirLang}
        kokoro={kokoro}
      >
        {!hasVirtualDevice && (
          <Card.Item>
            <Alert
              type="warning"
              showIcon
              message="Máy chưa có mic ảo"
              description="Muốn người trong Discord/Zoom/Meet nghe giọng dịch, cần mic ảo BlackHole 2ch (miễn phí). Bấm cài, nhập mật khẩu máy, xong app tự chọn nó."
            >
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="small" type="primary" loading={installingMic} onClick={installMic}>
                  {installingMic ? "Đang cài…" : "Cài mic ảo BlackHole"}
                </Button>
                <Button
                  size="small"
                  type="link"
                  onClick={() => void openUrl(BLACKHOLE_URL).catch(() => {})}
                >
                  Tìm hiểu BlackHole
                </Button>
              </div>
            </Alert>
          </Card.Item>
        )}
        <Card.Item
          label="Phát tới"
          description={hasVirtualDevice ? "Trong Discord/Zoom/Meet, chọn micro là thiết bị này" : undefined}
          split
        >
          <div className="flex w-full min-w-0 items-center gap-2">
            <Select
              className="min-w-0 flex-1"
              value={app.voiceOutId}
              onChange={(v) => app.setVoiceOutId(String(v ?? ""))}
              options={speakerOpts}
            />
            {blackHole && !voiceOutIsBlackHole && (
              <Button size="small" onClick={() => app.setVoiceOutId(blackHole.deviceId)}>
                BlackHole
              </Button>
            )}
          </div>
        </Card.Item>
        <Card.Item
          label="Nghe lại giọng dịch"
          description={
            voiceOutIsOwnSpeaker
              ? "Đang phát ra loa của bạn nên bạn đã nghe được"
              : "Phát thêm ra loa của bạn để tự kiểm tra"
          }
        >
          <Switch
            checked={speakCfg.monitor && !voiceOutIsOwnSpeaker}
            disabled={voiceOutIsOwnSpeaker}
            onChange={(monitor) => setSpeak({ monitor })}
          />
        </Card.Item>
      </VoiceCard>
    </div>
  );

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      title="Cài đặt"
      size="100vw"
      footer={
        <p className="text-tertiary-foreground truncate text-xs">
          Tự lưu mọi thay đổi · {app.configMeta}
        </p>
      }
    >
      <div className="mx-auto w-full max-w-3xl">
        <Tabs
          aria-label="Hướng"
          activeKey={tab}
          onChange={(k) => setTab(k === "speak" ? "speak" : "listen")}
          items={[
            {
              key: "listen",
              label: "Nghe",
              icon: <Headphones className="size-4" />,
              children: listenColumn,
            },
            { key: "speak", label: "Nói", icon: <Mic className="size-4" />, children: speakColumn },
          ]}
        />

        <div className="border-border mt-10 flex flex-col gap-8 border-t pt-8 pb-4">
          <Card
            title="Nhận giọng & dịch (trên máy)"
            caption="Cả hai hướng đều nhận giọng và dịch bằng Apple ngay trên máy, miễn phí. Thiếu gói dịch thì tải trong Cài đặt hệ thống › Chung › Ngôn ngữ & Vùng › Ngôn ngữ dịch."
          >
            <Card.Item label={`Gói dịch ${theirCode} → ${myCode}`} description="Dịch lời họ">
              <PackTag status={packs.listen} />
            </Card.Item>
            <Card.Item label={`Gói dịch ${myCode} → ${theirCode}`} description="Dịch lời bạn">
              <span className="flex items-center gap-2">
                <PackTag status={packs.speak} />
                <Button
                  type="icon"
                  size="small"
                  aria-label="Kiểm tra lại gói dịch"
                  onClick={checkPacks}
                >
                  <RefreshCw className="size-3.5" />
                </Button>
              </span>
            </Card.Item>
            <Card.Item
              label="Đọc chính tả (Dictation)"
              description={`Cần bật và có ${langName(settings.myLang)} để nhận giọng của bạn`}
            >
              <Button size="small" onClick={() => void invoke("open_dictation_settings").catch(() => {})}>
                Mở cài đặt
              </Button>
            </Card.Item>
          </Card>

          <Card title="Chung" caption={app.modelsMeta}>
            <Card.Item label="OpenRouter API key" description="Chỉ cần khi chọn đọc bằng API" split>
              <Input.Password
                autoComplete="off"
                spellCheck={false}
                value={settings.openrouterApiKey}
                onChange={(e) => setSettings((s) => ({ ...s, openrouterApiKey: e.target.value }))}
                placeholder="sk-or-v1-…"
              />
            </Card.Item>
            <Card.Item label="Cập nhật" description="Tự kiểm tra khi mở app">
              <CheckForUpdatesButton size="small" />
            </Card.Item>
          </Card>
        </div>
      </div>
    </Drawer>
  );
}
