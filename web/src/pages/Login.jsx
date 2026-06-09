import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { getAuth, loginAdmin } from "../api.js";
import { ErrorNote, Panel, StatusChip } from "../components/ui.jsx";

export default function Login() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const next = safeNext(params.get("next"));

  useEffect(() => {
    let live = true;
    getAuth()
      .then((auth) => {
        if (live && (!auth.authRequired || auth.authenticated)) {
          navigate(next, { replace: true });
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [navigate, next]);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginAdmin(password);
      navigate(next, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      kicker={t("login.kicker")}
      title={t("login.title")}
      sub={t("login.sub")}
      aside={<StatusChip status="issued" connected={false} />}
    >
      <form onSubmit={submit}>
        <label className="field">
          <span>{t("login.password")}</span>
          <input
            autoFocus
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy || !password}>
            {busy ? t("login.signingIn") : t("login.signIn")}
          </button>
        </div>
      </form>
      <ErrorNote error={error} />
    </Panel>
  );
}

function safeNext(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}
