import { Button, Popconfirm, Switch, Tooltip } from "devnonla-ui";
import {
  AudioLines,
  ChevronDown,
  Languages,
  Pin,
  PinOff,
  Play,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AppPickerModal } from "@/components/AppPickerModal";
import { HoldToTalk } from "@/components/HoldToTalk";
import { SettingsDrawer } from "@/components/SettingsDrawer";
import { Transcript } from "@/components/Transcript";
import { UpdateBanner } from "@/components/UpdateBanner";
import { useCicadaApp } from "@/hooks/useCicadaApp";
import { useProfiles } from "@/hooks/useProfiles";
import { cn } from "@/lib/utils";
import { LANGS } from "@/types";

function langLabel(code: string) {
  return LANGS.find((l) => l.value === code)?.label ?? code;
}

type ToggleProps = {
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
};

function Toggle({ label, hint, checked, disabled, onChange }: ToggleProps) {
  return (
    <Tooltip title={hint} placement="bottom">
      <label
        className={cn(
          "flex shrink-0 items-center gap-2 text-sm select-none",
          disabled ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <Switch size="small" checked={checked} disabled={disabled} onChange={onChange} />
        <span
          className={
            disabled
              ? "text-quaternary-foreground"
              : checked
                ? "text-foreground"
                : "text-muted-foreground"
          }
        >
          {label}
        </span>
      </label>
    </Tooltip>
  );
}

export default function App() {
  const app = useCicadaApp();
  const { profiles, updateProfile } = useProfiles();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [appPickerLoading, setAppPickerLoading] = useState(false);

  const selectedApp = app.audioApps.find((a) => a.bundleId === app.listenAppId);
  const selectedAppName = selectedApp?.name || app.listenAppId || "Chọn app…";
  const selectedIcon = selectedApp?.iconBase64
    ? `data:image/png;base64,${selectedApp.iconBase64}`
    : null;
  const voiceOutLabel =
    app.speakers.find((d) => d.deviceId === app.voiceOutId)?.label || "loa mặc định";
  const theirLabel = langLabel(app.settings.theirLang);
  const myLabel = langLabel(app.settings.myLang);

  const openSettings = (open: boolean) => {
    setSettingsOpen(open);
    if (open) void app.loadAppleTtsVoices(app.settings.myLang);
  };

  const refreshApps = async () => {
    setAppPickerLoading(true);
    try {
      await app.refreshAudioApps();
    } finally {
      setAppPickerLoading(false);
    }
  };

  const openAppPicker = () => {
    setAppPickerOpen(true);
    void refreshApps();
  };

  // ⌘, opens settings, like every Mac app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ",") {
        e.preventDefault();
        openSettings(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex h-full flex-col">
      {/* ── Header: identity, source, the one main action ── */}
      <header className="border-border bg-card flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <div className="bg-brand-fill text-on-brand flex size-8 shrink-0 items-center justify-center rounded-lg">
          <AudioLines className="size-4.5" strokeWidth={2.25} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base leading-tight font-semibold">HearBridge</p>
          <p className="text-tertiary-foreground flex items-center gap-1.5 truncate text-xs">
            <span
              className={cn(
                "inline-block size-1.5 shrink-0 rounded-full",
                app.listenOn ? "bg-success-fill hb-pulse" : "bg-quaternary-foreground",
              )}
              aria-hidden
            />
            {app.listenOn ? `Đang nghe ${selectedAppName}` : "Tạm dừng"}
          </p>
        </div>

        <Tooltip title="Chọn app để nghe" placement="bottom">
          <Button
            className="max-w-[13rem]"
            icon={
              selectedIcon ? (
                <img src={selectedIcon} alt="" className="size-4 rounded-sm" />
              ) : undefined
            }
            onClick={openAppPicker}
          >
            <span className="truncate">{selectedAppName}</span>
            <ChevronDown className="text-tertiary-foreground size-3.5 shrink-0" />
          </Button>
        </Tooltip>

        {app.listenOn ? (
          <Button
            icon={<Square className="text-destructive size-3 fill-current" />}
            onClick={() => void app.setListen(false)}
          >
            Dừng nghe
          </Button>
        ) : (
          <Button
            type="primary"
            icon={<Play className="size-3.5 fill-current" />}
            onClick={() => void app.setListen(true)}
          >
            Bắt đầu nghe
          </Button>
        )}

        <div className="bg-border mx-1 h-5 w-px" aria-hidden />

        <Tooltip title={app.pinned ? "Bỏ ghim" : "Ghim trên các cửa sổ khác"} placement="bottom">
          <Button
            type="icon"
            aria-label={app.pinned ? "Bỏ ghim" : "Ghim"}
            aria-pressed={app.pinned}
            className={cn(app.pinned && "bg-ink-active")}
            onClick={() => void app.togglePin()}
          >
            {app.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          </Button>
        </Tooltip>
        <Tooltip title="Cài đặt  ⌘," placement="bottom">
          <Button type="icon" aria-label="Cài đặt" onClick={() => openSettings(true)}>
            <Settings2 className="size-4" />
          </Button>
        </Tooltip>
      </header>

      {/* ── Toolbar: pipeline switches ── */}
      <div className="border-border flex h-11 shrink-0 items-center gap-5 overflow-x-auto border-b px-4 whitespace-nowrap">
        <Toggle
          label="Dịch"
          hint="Dịch phụ đề sang ngôn ngữ của bạn"
          checked={app.translateOn}
          onChange={app.setTranslateOn}
        />
        <Toggle
          label="Đọc bản dịch"
          hint="Đọc to bản dịch lời họ cho bạn nghe"
          checked={app.ttsOn}
          onChange={app.setTtsOn}
        />
        <Toggle
          label="Tắt âm gốc"
          hint="Tắt loa của app gốc, vẫn bắt tiếng để dịch và đọc"
          checked={app.muteOriginal}
          onChange={(v) => void app.setMuteOriginal(v)}
        />
        <Toggle
          label="Phiên dịch giọng tôi"
          hint="Khi giữ Space / ⌥: dịch lời bạn nói và đọc cho bên kia"
          checked={app.interpretReady}
          onChange={app.setInterpretReady}
        />

        <div className="flex-1" />

        <Tooltip title="Đổi ngôn ngữ trong Cài đặt" placement="bottom">
          <Button
            type="text"
            size="small"
            icon={<Languages className="size-3.5" />}
            onClick={() => openSettings(true)}
          >
            {app.settings.theirLang.toUpperCase()} → {app.settings.myLang.toUpperCase()}
          </Button>
        </Tooltip>
        <Popconfirm
          title="Xóa toàn bộ phụ đề?"
          description="Không thể hoàn tác."
          okText="Xóa"
          cancelText="Hủy"
          okType="danger"
          placement="bottomRight"
          disabled={app.liveLines.length === 0}
          onConfirm={() => app.clearLiveLines()}
        >
          <Button
            type="text"
            size="small"
            disabled={app.liveLines.length === 0}
            icon={<Trash2 className="size-3.5" />}
          >
            Xóa
          </Button>
        </Popconfirm>
      </div>

      <UpdateBanner sessionActive={app.listenOn || app.holding} className="mx-4 mt-3" />

      {/* ── Live captions ── */}
      <Transcript
        lines={app.liveLines}
        theirLabel={theirLabel}
        myLabel={myLabel}
        listening={app.listenOn}
        profiles={profiles}
        themFallbackSrc={selectedIcon}
        level={app.level}
        sourceName={selectedAppName}
        emptyAction={
          !selectedApp ? <Button onClick={openAppPicker}>Chọn app để nghe</Button> : undefined
        }
      />

      {/* ── Push to talk ── */}
      <HoldToTalk
        holding={app.holding}
        busy={app.busy}
        level={app.level}
        status={app.status}
        fromLabel={myLabel}
        toLabel={theirLabel}
        outputLabel={voiceOutLabel}
        enabled={app.interpretReady}
        mode={app.talkMode}
        onModeChange={app.setTalkMode}
        autoTalking={app.autoTalking}
        onStart={() => void app.startHold()}
        onStop={() => void app.stopHold()}
      />

      <SettingsDrawer
        app={app}
        open={settingsOpen}
        onOpenChange={openSettings}
        selectedAppName={selectedAppName}
        selectedIcon={selectedIcon}
        profiles={profiles}
        onProfileChange={updateProfile}
        onPickApp={() => {
          setSettingsOpen(false);
          openAppPicker();
        }}
      />

      <AppPickerModal
        open={appPickerOpen}
        onOpenChange={setAppPickerOpen}
        apps={app.audioApps}
        selectedId={app.listenAppId}
        onSelect={(id) => void app.setListenAppId(id)}
        onRefresh={() => void refreshApps()}
        refreshing={appPickerLoading}
      />
    </div>
  );
}
