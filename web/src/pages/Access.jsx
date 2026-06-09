import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { redeemToken, tokenStatus } from "../api.js";
import { Panel, StatusChip, Metrics, ErrorNote } from "../components/ui.jsx";

export default function Access() {
  const { t } = useTranslation();
  const { token } = useParams();
  const navigate = useNavigate();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    tokenStatus(token).then(
      (data) => {
        if (!live) return;
        // Token already redeemed in this broker: jump straight to the lease.
        if (data.leaseId) navigate(`/leases/${data.leaseId}`, { replace: true });
        else setInfo(data);
      },
      (err) => live && setError(err),
    );
    return () => {
      live = false;
    };
  }, [token, navigate]);

  const redeem = async () => {
    setBusy(true);
    setError(null);
    try {
      const lease = await redeemToken(token, { clientLabel: navigator.userAgent });
      navigate(`/leases/${lease.id}`);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  const redeemable = info?.status === "issued";

  return (
    <Panel
      kicker={t("access.kicker")}
      title={t("access.title")}
      sub={t("access.sub")}
      aside={info && <StatusChip status={info.status} connected={redeemable} />}
    >
      <code className="token-block">{token}</code>
      {info && (
        <Metrics
          items={[
            { label: t("access.quotaLabel"), value: `${info.quotaSeconds}s` },
            { label: t("access.expires"), value: new Date(info.expiresAt).toTimeString().slice(0, 8) },
            { label: t("access.redeemable"), value: redeemable ? t("access.yesOnce") : t("access.no") },
          ]}
        />
      )}
      {!info && !error && <div className="loading">{t("access.checking")}</div>}
      <div className="actions">
        <button className="primary" onClick={redeem} disabled={busy || !redeemable}>
          {busy ? t("access.starting") : t("access.redeem")}
        </button>
      </div>
      <ErrorNote error={error} />
      <p className="center-note">{t("access.note")}</p>
    </Panel>
  );
}
