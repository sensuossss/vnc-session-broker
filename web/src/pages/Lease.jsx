import { useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getLease, renewLease, revokeLease, setLeaseTime } from "../api.js";
import { usePoll } from "../hooks.js";
import { useRequireAuth } from "../auth.jsx";
import {
  Panel,
  StatusChip,
  Timer,
  Drain,
  Metrics,
  Gateways,
  CopyField,
  EventConsole,
  ErrorNote,
} from "../components/ui.jsx";

export default function Lease() {
  const { t } = useTranslation();
  const { leaseId } = useParams();
  const auth = useRequireAuth();
  const { data, error } = usePoll(() => getLease(leaseId), 1000);
  const [draft, setDraft] = useState(null);
  const [actionError, setActionError] = useState(null);

  const run = async (fn) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err);
    }
  };

  const applyTime = (event) => {
    event.preventDefault();
    if (draft == null) return;
    run(async () => {
      await setLeaseTime(leaseId, Number(draft));
      setDraft(null);
    });
  };

  const revoke = () => {
    if (!window.confirm(t("lease.revokeConfirm"))) return;
    run(() => revokeLease(leaseId));
  };

  if (auth.checking) {
    return (
      <Panel kicker={t("lease.kicker")} title={t("lease.title")} sub={`${t("lease.lease")} ${leaseId}`}>
        <div className="loading">{t("login.checking")}</div>
      </Panel>
    );
  }

  if (error && !data) {
    return (
      <Panel kicker={t("lease.kicker")} title={t("lease.title")} sub={`${t("lease.lease")} ${leaseId}`}>
        <ErrorNote error={error} />
      </Panel>
    );
  }

  if (!data) {
    return (
      <Panel kicker={t("lease.kicker")} title={t("lease.title")} sub={`${t("lease.lease")} ${leaseId}`}>
        <div className="loading">{t("lease.querying")}</div>
      </Panel>
    );
  }

  const active = data.status === "active";

  return (
    <Panel
      kicker={t("lease.kicker")}
      title={t("lease.title")}
      sub={
        <>
          {t("lease.lease")} <code>{data.id}</code> · {t("lease.user")} <code>{data.userId}</code>
        </>
      }
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
          { label: t("lease.vncPort"), value: data.vncPort },
          { label: t("lease.webPort"), value: data.webPort },
          { label: t("lease.launchProfile"), value: data.launchProfile?.label || data.launchProfile?.id || "fallback-command" },
          { label: t("lease.networkProfile"), value: data.networkPlugin?.label || t("network.none") },
          { label: t("lease.networkStatus"), value: data.networkPlugin?.status || "disabled" },
        ]}
      />
      <Warnings warnings={data.warnings} />
      <Gateways webUrl={data.webUrl} macUrl={data.macUrl} />
      <div className="split">
        <div className="fields" style={{ margin: 0 }}>
          <CopyField label={t("lease.shareUrl")} value={data.shareUrl} />
          <CopyField label={t("lease.password")} value={data.password} secret />
          <CopyField label={t("lease.macUrl")} value={data.macUrl} />
          <CopyField label={t("lease.webUrl")} value={data.webUrl} />
          {data.launchProfile?.url && <CopyField label={t("lease.launchUrl")} value={data.launchProfile.url} />}
          {data.networkPlugin?.cdpPort && <CopyField label={t("lease.cdpPort")} value={String(data.networkPlugin.cdpPort)} />}
          {data.networkPlugin?.proxyPort && <CopyField label={t("lease.proxyPort")} value={String(data.networkPlugin.proxyPort)} />}
          {data.networkPlugin?.proxyMappings?.length > 0 && (
            <CopyField label={t("lease.proxyMappings")} value={JSON.stringify(data.networkPlugin.proxyMappings, null, 2)} />
          )}
        </div>
        <div className="controls">
          <div className="controls-label">{t("lease.controls")}</div>
          <div className="row">
            <button disabled={!active} onClick={() => run(() => renewLease(leaseId, 15 * 60))}>
              {t("lease.renew15")}
            </button>
            <button disabled={!active} onClick={() => run(() => renewLease(leaseId, 60 * 60))}>
              {t("lease.renew60")}
            </button>
          </div>
          <form className="row" onSubmit={applyTime}>
            <input
              type="number"
              min="0"
              step="1"
              aria-label={t("lease.remainingSeconds")}
              value={draft ?? data.remainingSeconds}
              onChange={(event) => setDraft(event.target.value)}
              disabled={!active}
            />
            <button type="submit" disabled={!active || draft == null}>
              {t("lease.set")}
            </button>
          </form>
          <hr />
          <button className="danger" onClick={revoke} disabled={!active}>
            {t("lease.revoke")}
          </button>
        </div>
      </div>
      <ErrorNote error={actionError} />
      <EventConsole events={data.events} />
    </Panel>
  );
}

function Warnings({ warnings }) {
  const { t } = useTranslation();
  if (!warnings?.length) return null;
  return (
    <div className="warning-note">
      <strong>{t("lease.warnings")}</strong>
      {warnings.map((warning, index) => (
        <span key={`${warning.code}-${index}`}>
          {warning.message || warning.code}
        </span>
      ))}
    </div>
  );
}
