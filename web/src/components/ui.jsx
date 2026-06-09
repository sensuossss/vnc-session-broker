import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

export function Topbar() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.resolvedLanguage || "en").startsWith("zh") ? "zh" : "en";
  const toggle = () => i18n.changeLanguage(lang === "zh" ? "en" : "zh");
  return (
    <header className="topbar">
      <Link className="brand" to="/">
        <span className="brand-square" />
        {t("brand")}
      </Link>
      <span className="topbar-right">
        <span className="topbar-sys">{t("sys")}</span>
        <button type="button" className="lang-toggle" onClick={toggle} aria-label="switch language">
          {lang === "zh" ? "EN" : "中文"}
        </button>
      </span>
    </header>
  );
}

export function Panel({ kicker, title, sub, aside, children }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          {kicker && <div className="kicker">{kicker}</div>}
          <h1>{title}</h1>
          {sub && <p className="muted">{sub}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function StatusChip({ status, connected }) {
  const { t } = useTranslation();
  const alive = status === "active" || status === "issued";
  const state = alive ? "active" : "dead";
  const led = !alive ? "led-dead" : connected ? "led-on" : "led-idle";
  const label = status
    ? t(`status.${status}`, { defaultValue: String(status).replace(/_/g, " ") })
    : "…";
  return (
    <span className="status-chip" data-state={state}>
      <i className={`led ${led}`} />
      {label}
    </span>
  );
}

export function fmtClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds ?? 0));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const x = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${x}`;
}

export function Timer({ seconds, draining }) {
  const { t } = useTranslation();
  const s = Math.max(0, Math.floor(seconds ?? 0));
  const tone = s < 60 ? "crit" : s < 300 ? "low" : "ok";
  return (
    <div className="timer" data-tone={tone}>
      <strong>{fmtClock(s)}</strong>
      <span className="timer-label">{draining ? t("timer.draining") : t("timer.remaining")}</span>
    </div>
  );
}

export function Drain({ active }) {
  return (
    <div className={active ? "drain is-active" : "drain"}>
      <span />
    </div>
  );
}

export function Metrics({ items }) {
  return (
    <div className="metrics">
      {items.map((item) => (
        <div key={item.label}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function Gateways({ webUrl, macUrl }) {
  const { t } = useTranslation();
  return (
    <div className="gateways">
      <a className="gateway" href={webUrl} target="_blank" rel="noreferrer">
        <span className="gateway-proto">{t("gateway.webProto")}</span>
        <span className="gateway-name">{t("gateway.webName")}</span>
        <span className="gateway-desc">{t("gateway.webDesc")}</span>
        <span className="gateway-arrow">→</span>
      </a>
      <a className="gateway" href={macUrl}>
        <span className="gateway-proto">{t("gateway.macProto")}</span>
        <span className="gateway-name">{t("gateway.macName")}</span>
        <span className="gateway-desc">{t("gateway.macDesc")}</span>
        <span className="gateway-arrow">→</span>
      </a>
    </div>
  );
}

export function CopyField({ label, value, secret = false }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!secret);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const area = document.createElement("textarea");
      area.value = value;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 900);
  };

  return (
    <label className="field">
      <span>{label}</span>
      <span className="field-row">
        <input readOnly value={revealed ? value : "••••••••"} onFocus={(e) => e.target.select()} />
        {secret && (
          <button type="button" className="ghost" onClick={() => setRevealed((v) => !v)}>
            {revealed ? t("hide") : t("show")}
          </button>
        )}
        <button type="button" className={copied ? "ghost is-copied" : "ghost"} onClick={copy}>
          {copied ? t("copied") : t("copy")}
        </button>
      </span>
    </label>
  );
}

export function EventConsole({ events }) {
  const { t } = useTranslation();
  const lines = (events || []).map((event) => {
    const at = new Date(event.at).toTimeString().slice(0, 8);
    const detail = event.type === "connection_rejected"
      ? `${event.client} ${event.connectedCount}/${event.maxConnections}`
      : event.client
      ? event.client
      : event.extraSeconds
        ? `+${event.extraSeconds}s`
        : event.remainingSeconds != null
          ? `→ ${event.remainingSeconds}s`
          : event.reason || "";
    return `[${at}] ${String(event.type).toUpperCase().padEnd(20, " ")} ${detail}`;
  });
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  return (
    <div className="console">
      <div className="console-bar">
        <span>{t("console.title")}</span>
        <span>{t("console.entries", { count: lines.length })}</span>
      </div>
      <pre ref={ref}>{lines.length ? lines.join("\n") : t("console.empty")}</pre>
    </div>
  );
}

export function ErrorNote({ error }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <div className="error-note">
      {t("err")} · {error.message || String(error)}
    </div>
  );
}
