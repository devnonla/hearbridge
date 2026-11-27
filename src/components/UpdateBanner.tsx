import { openUrl } from "@tauri-apps/plugin-opener";
import { Alert, Button, type ButtonProps, Modal, message } from "devnonla-ui";
import { useUpdater } from "@/hooks/useUpdater";

const RELEASES_URL = "https://github.com/devnonla/hearbridge/releases";

type UpdateBannerProps = {
  /**
   * Captions / interpretation are running. Installing restarts the app, so the
   * banner asks for confirmation first.
   */
  sessionActive?: boolean;
  className?: string;
};

/**
 * Shows "HearBridge X is available" with Install & Restart / Later, and the
 * download progress while an update installs. Renders nothing when up to date.
 */
export function UpdateBanner({ sessionActive = false, className }: UpdateBannerProps) {
  const { visible, pending, progress, busy, canInstall, install, dismiss } = useUpdater();

  const target = visible ?? (busy ? pending : null);
  if (!target && !busy) return null;
  const version = target?.version ?? progress?.version ?? "";

  const runInstall = async () => {
    try {
      await install();
    } catch (err) {
      message.error(`Không cài được bản cập nhật: ${(err as Error).message}`);
    }
  };

  const onInstall = () => {
    if (!sessionActive) {
      void runInstall();
      return;
    }
    Modal.confirm({
      title: `Cài HearBridge ${version}?`,
      content: "HearBridge sẽ khởi động lại để hoàn tất, phụ đề trực tiếp tạm dừng vài giây.",
      okText: "Cài và khởi động lại",
      cancelText: "Để sau",
      onOk: runInstall,
    });
  };

  if (busy && progress) {
    const percent = progress.percent ?? 0;
    const label =
      progress.phase === "downloading"
        ? `Đang tải HearBridge ${progress.version}… ${progress.percent != null ? `${percent}%` : ""}`
        : progress.phase === "installing"
          ? `Đang cài HearBridge ${progress.version}…`
          : "Đang khởi động lại HearBridge…";
    return (
      <Alert type="info" showIcon className={className} message={label}>
        <div
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="h-full rounded-full bg-brand-fill transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
      </Alert>
    );
  }

  if (!target) return null;

  return (
    <Alert
      type="info"
      showIcon
      className={className}
      message={`Đã có HearBridge ${target.version}`}
      description={`Bạn đang dùng bản ${target.currentVersion}.`}
    >
      {target.notes ? (
        <p className="mt-1 line-clamp-4 whitespace-pre-line text-xs text-muted-foreground">{target.notes}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {canInstall ? (
          <Button type="primary" size="small" onClick={onInstall}>
            Cài và khởi động lại
          </Button>
        ) : (
          <Button
            type="primary"
            size="small"
            onClick={() => void openUrl(`${RELEASES_URL}/tag/v${target.version}`).catch(() => {})}
          >
            Xem bản phát hành
          </Button>
        )}
        <Button size="small" type="text" onClick={dismiss}>
          Để sau
        </Button>
      </div>
    </Alert>
  );
}

type CheckForUpdatesButtonProps = Omit<ButtonProps, "onClick" | "loading">;

/** "Check for Updates…" for a settings screen: reports "up to date" or brings up the banner. */
export function CheckForUpdatesButton({ children, ...props }: CheckForUpdatesButtonProps) {
  const { checkNow, checking, currentVersion } = useUpdater();

  const onClick = async () => {
    try {
      const found = await checkNow();
      if (found) message.info(`Đã có HearBridge ${found.version}.`);
      else message.success(`Bạn đang dùng bản mới nhất${currentVersion ? ` (${currentVersion})` : ""}.`);
    } catch (err) {
      message.error(`Không kiểm tra được bản cập nhật: ${typeof err === "string" ? err : (err as Error).message}`);
    }
  };

  return (
    <Button {...props} loading={checking} onClick={() => void onClick()}>
      {children ?? "Kiểm tra cập nhật…"}
    </Button>
  );
}
