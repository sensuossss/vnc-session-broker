import { useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getShare } from "../api.js";
import { usePoll } from "../hooks.js";
import VncScreen from "../components/VncScreen.jsx";
import { Panel, StatusChip, Timer, Drain, Metrics, ErrorNote } from "../components/ui.jsx";

// Maps a terminal lease status to a viewer-facing "why it ended" key.
const ENDED_REASON = {
  quota_exhausted: "share.endedQuota",
  idle_timeout: "share.endedIdle",
  revoked_by_user: "share.endedRevoked",
};

export default function Share() {
  const { t } = useTranslation();
  const { viewerToken } = useParams();
  const { data, error } = usePoll(() => getShare(viewerToken), 1000);
  const [vncState, setVncState] = useState("connecting");
  const [attempt, setAttempt] = useState(0);
  const [viewMode, setViewMode] = useState("actual");

  // The gateway advertises a viewer-safe web entry once P0b is live. Until then
  // no such entry exists and the page falls back to the upgrade notice.
  const webEntry = useMemo(
    () =>
      (data?.transport?.entries || []).find(
        (entry) => entry.viewerSafe && entry.url && String(entry.kind || "").startsWith("web-"),
      ),
    [data],
  );

  if (error && !data) {
    return (
      <Panel kicker={t("share.kicker")} title={t("share.title")}>
        <ErrorNote error={error} />
      </Panel>
    );
  }

  if (!data) {
    return (
      <Panel kicker={t("share.kicker")} title={t("share.title")}>
        <div className="loading">{t("share.querying")}</div>
      </Panel>
    );
  }

  const active = data.status === "active";
  const reconnect = () => {
    setVncState("connecting");
    setAttempt((n) => n + 1);
  };

  return (
    <Panel
      kicker={t("share.kicker")}
      title={t("share.title")}
      sub={t("share.sub")}
      aside={<StatusChip status={data.status} connected={data.connected} />}
    >
      <Timer seconds={data.remainingSeconds} draining={data.connected} />
      <Drain active={data.connected && active} />
      <Metrics
        items={[
          { label: t("lease.connected"), value: data.connected ? t("yes") : t("no") },
          { label: t("lease.clients"), value: `${data.connectedCount}/${data.maxConnections}` },
          { label: t("lease.maxConnections"), value: data.maxConnections },
          { label: t("lease.display"), value: data.display },
          { label: t("lease.networkProfile"), value: data.networkPlugin?.label || t("network.none") },
        ]}
      />

      {active && webEntry ? (
        <div className="vnc-panel">
          <div className="vnc-bar">
            <span className="readonly-badge">{t("share.readonly")}</span>
            <span className={`vnc-status is-${vncState}`}>{t(`share.vnc.${vncState}`)}</span>
            <div className="vnc-view-toggle" role="group" aria-label={t("share.viewMode")}>
              <button
                type="button"
                className={viewMode === "actual" ? "is-active" : ""}
                onClick={() => setViewMode("actual")}
              >
                {t("share.viewActual")}
              </button>
              <button
                type="button"
                className={viewMode === "fit" ? "is-active" : ""}
                onClick={() => setViewMode("fit")}
              >
                {t("share.viewFit")}
              </button>
            </div>
            {(vncState === "dropped" || vncState === "error") && (
              <button type="button" className="ghost" onClick={reconnect}>
                {t("share.reconnect")}
              </button>
            )}
          </div>
          <VncScreen key={attempt} url={webEntry.url} mode={viewMode} onState={setVncState} />
        </div>
      ) : active ? (
        <div className="warning-note">
          <strong>{t("share.connectionUnavailableTitle")}</strong>
          <span>{t("share.connectionUnavailable")}</span>
        </div>
      ) : (
        <div className="warning-note is-ended">
          <strong>{t(ENDED_REASON[data.status] || "share.endedGeneric")}</strong>
          <span>{t("share.endedDesc")}</span>
        </div>
      )}

      <p className="center-note">{t("share.note")}</p>
    </Panel>
  );
}
