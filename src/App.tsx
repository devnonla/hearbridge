import { Pin, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppPickerModal } from "@/components/AppPickerModal";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useCicadaApp } from "@/hooks/useCicadaApp";
import { cn } from "@/lib/utils";
import { LANGS } from "@/types";

function withCurrent(options: ComboboxOption[], value: string): ComboboxOption[] {
  if (!value) return options;
  if (options.some((o) => o.value === value)) return options;
  return [{ value, label: value }, ...options];
}

export default function App() {
  const app = useCicadaApp();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [appPickerLoading, setAppPickerLoading] = useState(false);
  const liveEndRef = useRef<HTMLDivElement>(null);
  const liveScrollRootRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const latestId = app.liveLines[app.liveLines.length - 1]?.id;

  const getLiveViewport = () =>
    liveScrollRootRef.current?.querySelector(
      '[data-slot="scroll-area-viewport"]',
    ) as HTMLElement | null;

  useEffect(() => {
    const viewport = getLiveViewport();
    if (!viewport) return;
    const onScroll = () => {
      const gap = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      stickToBottomRef.current = gap < 80;
    };
    onScroll();
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    liveEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [app.liveLines]);

  const selectedApp = app.audioApps.find((a) => a.bundleId === app.listenAppId);
  const selectedAppName = selectedApp?.name || app.listenAppId || "Chọn app…";
  const selectedIcon = selectedApp?.iconBase64
    ? `data:image/png;base64,${selectedApp.iconBase64}`
    : null;

  const openAppPicker = async () => {
    setAppPickerOpen(true);
    setAppPickerLoading(true);
    try {
      await app.refreshAudioApps();
    } finally {
      setAppPickerLoading(false);
    }
  };

  const micOpts = useMemo<ComboboxOption[]>(
    () => [
      { value: "", label: "Mặc định" },
      ...app.mics.map((d) => ({
        value: d.deviceId,
        label: d.label || d.deviceId,
      })),
    ],
    [app.mics],
  );

  const speakerOpts = useMemo<ComboboxOption[]>(
    () => [
      { value: "", label: "Mặc định hệ thống" },
      ...app.speakers.map((d) => ({
        value: d.deviceId,
        label: d.label || d.deviceId,
      })),
    ],
    [app.speakers],
  );

  const langOpts = useMemo<ComboboxOption[]>(
    () => LANGS.map((l) => ({ value: l.value, label: l.label })),
    [],
  );

  const toModelOpt = (m: {
    id: string;
    name: string;
    priceLabel?: string;
  }): ComboboxOption => ({
    value: m.id,
    label: m.name?.trim() || m.id,
    description: m.priceLabel && m.priceLabel !== "—" ? m.priceLabel : undefined,
    keywords: `${m.name} ${m.id} ${m.priceLabel || ""}`,
  });

  const sttOpts = useMemo(
    () => withCurrent(app.filtered.stt.map(toModelOpt), app.settings.sttModel),
    [app.filtered.stt, app.settings.sttModel],
  );
  const chatOpts = useMemo(
    () => withCurrent(app.filtered.chat.map(toModelOpt), app.settings.translateModel),
    [app.filtered.chat, app.settings.translateModel],
  );
  const ttsOpts = useMemo(
    () => withCurrent(app.filtered.tts.map(toModelOpt), app.settings.ttsModel),
    [app.filtered.tts, app.settings.ttsModel],
  );

  return (
    <div className="bg-background flex h-dvh flex-col">
      {/* Top bar — tối giản */}
      <header className="border-border/60 flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-serif text-lg font-semibold leading-none">HearBridge</p>
          <p className="text-muted-foreground mt-0.5 truncate text-[11px]">
            {app.listenOn ? `Nghe · ${selectedAppName}` : "Listen tắt"}
            {" · "}
            {app.settings.theirLang}→{app.settings.myLang}
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          className="max-w-[12rem] shrink-0 gap-1.5 sm:max-w-[16rem]"
          onClick={() => void openAppPicker()}
          title="Chọn app để nghe"
        >
          {selectedIcon ? (
            <img src={selectedIcon} alt="" className="size-4 shrink-0 rounded-sm" />
          ) : null}
          <span className="truncate">{selectedAppName}</span>
        </Button>

        <label className="flex items-center gap-1.5 text-xs">
          <Switch checked={app.listenOn} onCheckedChange={(v) => void app.setListen(v)} />
          Listen
        </label>
        <label
          className="flex items-center gap-1.5 text-xs"
          title="Tắt loa app gốc, vẫn bắt tiếng để dịch và nghe TTS"
        >
          <Switch
            checked={app.muteOriginal}
            onCheckedChange={(v) => void app.setMuteOriginal(v)}
          />
          Tắt âm gốc
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <Switch checked={app.translateOn} onCheckedChange={app.setTranslateOn} />
          Dịch
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <Switch checked={app.ttsOn} onCheckedChange={app.setTtsOn} />
          TTS
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <Checkbox
            checked={app.interpretReady}
            onCheckedChange={(v) => app.setInterpretReady(Boolean(v))}
          />
          Nói
        </label>

        <Button variant="ghost" size="icon-sm" onClick={() => void app.togglePin()} title="Ghim">
          <Pin className={cn("size-4", app.pinned && "text-orange-600")} />
        </Button>

        <Sheet
          open={settingsOpen}
          onOpenChange={(open) => {
            setSettingsOpen(open);
            if (open) void app.loadAppleTtsVoices(app.settings.myLang);
          }}
        >
          <SheetTrigger asChild>
            <Button variant="outline" size="icon-sm" title="Cài đặt">
              <Settings2 className="size-4" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="right"
            className="inset-0 flex h-dvh w-full max-w-none flex-col gap-0 overflow-hidden border-0 p-0 sm:max-w-none"
          >
            <SheetHeader className="shrink-0 border-b px-5 py-4 text-left">
              <SheetTitle className="text-xl">Cài đặt</SheetTitle>
              <SheetDescription className="text-xs">{app.configMeta}</SheetDescription>
            </SheetHeader>
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto w-full max-w-2xl space-y-8 px-5 py-6">
                <section className="space-y-3">
                  <p className="text-base font-semibold">App để nghe</p>
                  <Button
                    variant="outline"
                    className="h-auto w-full justify-start gap-3 px-3 py-3"
                    onClick={() => {
                      setSettingsOpen(false);
                      void openAppPicker();
                    }}
                  >
                    {selectedIcon ? (
                      <img src={selectedIcon} alt="" className="size-10 rounded-lg" />
                    ) : (
                      <span className="bg-muted flex size-10 items-center justify-center rounded-lg text-sm font-semibold">
                        ?
                      </span>
                    )}
                    <span className="min-w-0 flex-1 text-left">
                      <span className="block truncate font-medium">{selectedAppName}</span>
                      <span className="text-muted-foreground block text-xs">
                        Mở bảng chọn kiểu Meet / OBS (có preview cửa sổ)
                      </span>
                    </span>
                  </Button>
                </section>

                  <section className="space-y-3">
                    <p className="text-base font-semibold">Thiết bị & ngôn ngữ</p>
                    <div className="space-y-1">
                      <Label>Mic</Label>
                      <Combobox value={app.micId} onChange={app.setMicId} options={micOpts} />
                    </div>
                    <div className="space-y-1">
                      <Label>Loa</Label>
                      <Combobox
                        value={app.speakerId}
                        onChange={app.setSpeakerId}
                        options={speakerOpts}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label>Tôi nói</Label>
                        <Combobox
                          value={app.settings.myLang}
                          onChange={(v) => app.setSettings((s) => ({ ...s, myLang: v }))}
                          options={langOpts}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label>Họ nói</Label>
                        <Combobox
                          value={app.settings.theirLang}
                          onChange={(v) => app.setSettings((s) => ({ ...s, theirLang: v }))}
                          options={langOpts}
                        />
                      </div>
                    </div>
                  </section>

                  <section className="space-y-3">
                    <p className="text-base font-semibold">Apple</p>
                    <div className="space-y-2">
                      <Label>Giọng đọc dịch</Label>
                      <Combobox
                        value={app.settings.appleTtsVoice}
                        onChange={(v) =>
                          app.setSettings((s) => ({ ...s, appleTtsVoice: v }))
                        }
                        options={withCurrent(
                          [
                            { value: "", label: "Tự chọn" },
                            ...app.appleTtsVoices.map((v) => ({
                              value: v.id,
                              label: v.name,
                              keywords: `${v.name} ${v.gender} ${v.quality}`,
                            })),
                          ],
                          app.settings.appleTtsVoice,
                        )}
                      />
                      <div className="space-y-3 rounded-md border border-border/60 px-3 py-3">
                        <div className="space-y-1.5">
                          <div className="text-muted-foreground flex justify-between text-[11px]">
                            <span>Tốc độ</span>
                            <span>{Math.round((app.settings.appleTtsRate ?? 0.62) * 100)}%</span>
                          </div>
                          <Slider
                            min={0}
                            max={100}
                            step={1}
                            value={[Math.round((app.settings.appleTtsRate ?? 0.62) * 100)]}
                            onValueChange={([v]) =>
                              app.setSettings((s) => ({
                                ...s,
                                appleTtsRate: (v ?? 62) / 100,
                              }))
                            }
                          />
                        </div>
                        <div className="space-y-1.5">
                          <div className="text-muted-foreground flex justify-between text-[11px]">
                            <span>Cao độ</span>
                            <span>{(app.settings.appleTtsPitch ?? 1).toFixed(2)}</span>
                          </div>
                          <Slider
                            min={50}
                            max={200}
                            step={1}
                            value={[Math.round((app.settings.appleTtsPitch ?? 1) * 100)]}
                            onValueChange={([v]) =>
                              app.setSettings((s) => ({
                                ...s,
                                appleTtsPitch: (v ?? 100) / 100,
                              }))
                            }
                          />
                        </div>
                        <div className="space-y-1.5">
                          <div className="text-muted-foreground flex justify-between text-[11px]">
                            <span>Âm lượng</span>
                            <span>{Math.round((app.settings.appleTtsVolume ?? 0.45) * 100)}%</span>
                          </div>
                          <Slider
                            min={0}
                            max={100}
                            step={1}
                            value={[Math.round((app.settings.appleTtsVolume ?? 0.45) * 100)]}
                            onValueChange={([v]) =>
                              app.setSettings((s) => ({
                                ...s,
                                appleTtsVolume: (v ?? 45) / 100,
                              }))
                            }
                          />
                        </div>
                        <button
                          type="button"
                          className="text-destructive text-[11px]"
                          onClick={() =>
                            app.setSettings((s) => ({
                              ...s,
                              appleTtsRate: 0.62,
                              appleTtsPitch: 1,
                              appleTtsVolume: 0.45,
                            }))
                          }
                        >
                          Đặt lại tốc độ / cao độ / âm lượng
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        <button
                          type="button"
                          className="text-primary text-[11px] underline-offset-2 hover:underline"
                          onClick={() => void app.openAppleTtsVoiceSettings()}
                        >
                          Mở Đọc và nói…
                        </button>
                        <button
                          type="button"
                          className="text-muted-foreground text-[11px] underline-offset-2 hover:underline"
                          onClick={() => void app.loadAppleTtsVoices(app.settings.myLang)}
                        >
                          Tải lại danh sách giọng
                        </button>
                      </div>
                    </div>
                  </section>

                  <section className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-base font-semibold">OpenRouter</p>
                      <Button variant="outline" size="xs" onClick={() => void app.loadModels()}>
                        <RefreshCw className="size-3.5" />
                        Tải model
                      </Button>
                    </div>
                    <div className="space-y-1">
                      <Label>API key</Label>
                      <Input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        value={app.settings.openrouterApiKey}
                        onChange={(e) =>
                          app.setSettings((s) => ({
                            ...s,
                            openrouterApiKey: e.target.value,
                          }))
                        }
                        placeholder="sk-or-v1-…"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Base URL</Label>
                      <Input
                        value={app.settings.openrouterBaseUrl}
                        onChange={(e) =>
                          app.setSettings((s) => ({
                            ...s,
                            openrouterBaseUrl: e.target.value,
                          }))
                        }
                        placeholder="https://openrouter.ai/api/v1"
                      />
                    </div>
                    <p className="text-muted-foreground text-xs">{app.modelsMeta}</p>
                    <div className="space-y-1">
                      <Label>STT</Label>
                      <Combobox
                        value={app.settings.sttModel}
                        onChange={(v) => app.setSettings((s) => ({ ...s, sttModel: v }))}
                        options={sttOpts}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>Dịch</Label>
                      <Combobox
                        value={app.settings.translateModel}
                        onChange={(v) => app.setSettings((s) => ({ ...s, translateModel: v }))}
                        options={chatOpts}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>TTS</Label>
                      <Combobox
                        value={app.settings.ttsModel}
                        onChange={(v) => app.setSettings((s) => ({ ...s, ttsModel: v }))}
                        options={ttsOpts}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label>TTS voice</Label>
                      <Input
                        value={app.settings.ttsVoice}
                        onChange={(e) =>
                          app.setSettings((s) => ({ ...s, ttsVoice: e.target.value }))
                        }
                      />
                    </div>
                    <p className="text-muted-foreground text-center text-[11px]">
                      Đổi model / API key sẽ tự lưu.
                    </p>
                  </section>
              </div>
            </ScrollArea>
          </SheetContent>
        </Sheet>

        <AppPickerModal
          open={appPickerOpen}
          onOpenChange={setAppPickerOpen}
          apps={app.audioApps}
          selectedId={app.listenAppId}
          onSelect={(id) => void app.setListenAppId(id)}
          onRefresh={() => {
            setAppPickerLoading(true);
            void app.refreshAudioApps().finally(() => setAppPickerLoading(false));
          }}
          refreshing={appPickerLoading}
        />
      </header>

      {/* Transcript — chỉ nửa trên cho dễ nhìn; nửa dưới để trống */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="border-border/40 relative h-1/2 min-h-[12rem] shrink-0 border-b">
        <ScrollArea ref={liveScrollRootRef} className="h-full">
          <div className="mx-auto flex w-full max-w-4xl flex-col pb-4">
            {app.liveLines.length === 0 && (
              <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 px-3 py-12 text-center text-sm">
                <p className="text-foreground text-base font-medium">Sẵn sàng nghe</p>
                <p>Bật Listen để theo dõi họ nói, hoặc giữ Space / ⌥ để bạn nói.</p>
              </div>
            )}

            {app.liveLines.length > 0 && (
              <div className="border-border/60 text-muted-foreground sticky top-0 z-10 grid grid-cols-[1fr_1fr] gap-3 border-b bg-background/95 px-3 py-2 text-[11px] font-semibold tracking-wide uppercase backdrop-blur">
                <span>English</span>
                <span className="text-right sm:text-left">Tiếng Việt</span>
              </div>
            )}

            <div className="flex flex-col">
              {app.liveLines.map((line) => {
                const isMe = line.role === "me";
                const isLatest = line.id === latestId;
                const isPartial = line.id.endsWith("-partial");
                // Cột theo ngôn ngữ: EN trái, VI phải (Listen: source=EN; Interpreting: source=VI).
                const enText = isMe
                  ? line.translating
                    ? "Đang dịch…"
                    : line.translated || "—"
                  : line.source || "—";
                const viText = isMe
                  ? line.source || "—"
                  : line.translating
                    ? "Đang dịch…"
                    : line.translated || (isPartial ? "…" : "—");

                return (
                  <div
                    key={line.id}
                    className={cn(
                      "border-border/40 grid grid-cols-[1fr_1fr] gap-3 border-b px-3 py-3",
                      isMe && "bg-orange-600/5",
                      isLatest && "bg-primary/5",
                    )}
                  >
                    <div className="min-w-0">
                      <p
                        className={cn(
                          "text-sm leading-relaxed whitespace-pre-wrap",
                          isLatest ? "text-[15px] font-medium" : "text-foreground/90",
                          isMe && line.translating && "text-muted-foreground animate-pulse",
                        )}
                      >
                        {enText}
                      </p>
                    </div>
                    <div className="border-border/50 min-w-0 border-l pl-3">
                      <p
                        className={cn(
                          "text-sm leading-relaxed whitespace-pre-wrap",
                          isLatest ? "text-[15px] font-medium" : "text-foreground/90",
                          !isMe && line.translating && "text-muted-foreground animate-pulse",
                        )}
                      >
                        {viText}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
            <div ref={liveEndRef} />
          </div>
        </ScrollArea>

        {app.liveLines.length > 0 && (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className="absolute top-3 right-3 z-20 shadow-sm"
            onClick={() => app.clearLiveLines()}
          >
            <Trash2 className="size-3.5" />
            Xóa chat
          </Button>
        )}
        </div>
        <div className="min-h-0 flex-1" aria-hidden />
      </div>

      {/* Bottom — nói nhanh */}
      <div className="border-border/60 bg-background/95 absolute inset-x-0 bottom-0 border-t backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-3 py-3">
          <p className="text-muted-foreground truncate text-center text-[11px]">{app.status}</p>
          <button
            type="button"
            onPointerDown={(e) => {
              e.preventDefault();
              void app.startHold().catch((err) => console.error(err));
            }}
            onPointerUp={() => void app.stopHold()}
            onPointerLeave={() => {
              if (app.holding) void app.stopHold();
            }}
            className={cn(
              "rounded-2xl border px-4 py-4 text-center transition select-none",
              app.holding
                ? "bg-primary text-primary-foreground border-primary scale-[0.99]"
                : "bg-card hover:bg-accent/40",
              app.busy && "border-orange-500",
              app.listenOn && !app.holding && "ring-primary/20 ring-1",
            )}
          >
            <p className="text-sm font-semibold">
              {app.holding
                ? "Đang nghe bạn… thả ra để nói"
                : `Giữ Space / ⌥ · ${app.settings.myLang}→${app.settings.theirLang}`}
            </p>
            <div className="bg-foreground/10 mx-auto mt-2 h-1 w-2/3 max-w-xs overflow-hidden rounded-full">
              <div
                className="h-full bg-orange-600 transition-[width] duration-75"
                style={{ width: `${app.level}%` }}
              />
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}
