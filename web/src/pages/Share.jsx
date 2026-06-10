import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getShare } from "../api.js";
import { usePoll } from "../hooks.js";
import {
  Panel,
  StatusChip,
  Timer,
  Drain,
  Metrics,
  ErrorNote,
} from "../components/ui.jsx";

export default function Share() {
  const { t } = useTranslation();
  const { viewerToken } = useParams();
  const { data, error } = usePoll(() => getShare(viewerToken), 1000);

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

  return (
    <Panel
      kicker={t("share.kicker")}
      title={t("share.title")}
      sub={t("share.sub")}
      aside={<StatusChip status={data.status} connected={data.connected} />}
    >
      <Timer seconds={data.remainingSeconds} draining={data.connected} />
      <Drain active={data.connected && data.status === "active"} />
      <Metrics
        items={[
          { label: t("lease.connected"), value: data.connected ? t("yes") : t("no") },
          { label: t("lease.clients"), value: `${data.connectedCount}/${data.maxConnections}` },
          { label: t("lease.maxConnections"), value: data.maxConnections },
          { label: t("lease.display"), value: data.display },
          { label: t("lease.launchProfile"), value: data.launchProfile?.label || data.launchProfile?.id || "fallback-command" },
          { label: t("lease.networkProfile"), value: data.networkPlugin?.label || t("network.none") },
        ]}
      />
      <div className="warning-note">
        <strong>{t("share.connectionUnavailableTitle")}</strong>
        <span>{t("share.connectionUnavailable")}</span>
      </div>
      <p className="center-note">{t("share.note")}</p>
    </Panel>
  );
}
