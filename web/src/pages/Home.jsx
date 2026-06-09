import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { createSession, getLeases, getPluginSchemas, getSessionDefaults, saveSessionDefaults } from "../api.js";
import { usePoll } from "../hooks.js";
import { useRequireAuth } from "../auth.jsx";
import { Panel, StatusChip, CopyField, Metrics, ErrorNote, fmtClock } from "../components/ui.jsx";

const fallbackPluginSchemas = {
  networkProfiles: [
    { id: "none", labelKey: "network.none", fields: [] },
  ],
};

export default function Home() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const auth = useRequireAuth();
  const { data, error: listError } = usePoll(getLeases, 1000);
  const leases = data || [];
  const [pluginSchemas, setPluginSchemas] = useState(fallbackPluginSchemas);
  const [form, setForm] = useState({
    userId: "demo",
    quotaSeconds: 3600,
    maxConnections: 1,
    launchProfileId: "chrome-url",
    launchUrl: "about:blank",
    networkProfileId: "none",
    networkConfig: {},
  });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (auth.checking || (auth.authRequired && !auth.authenticated)) return;
    let cancelled = false;
    getPluginSchemas()
      .then((schemas) => {
        if (!cancelled) setPluginSchemas(schemas);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [auth.authRequired, auth.authenticated, auth.checking]);

  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const updateNetworkProfile = (event) => {
    const nextProfileId = event.target.value;
    const nextSchema = selectedNetworkSchema(pluginSchemas, nextProfileId);
    setForm({
      ...form,
      networkProfileId: nextProfileId,
      networkConfig: defaultNetworkConfig(nextSchema),
    });
  };
  const updateNetworkField = (name, value) => {
    setForm((current) => ({
      ...current,
      networkConfig: {
        ...current.networkConfig,
        [name]: value,
      },
    }));
  };

  const loadDefaults = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const defaults = await getSessionDefaults(form.userId);
      setForm((current) => applyDefaultsToForm(current, defaults));
      setNotice(t("home.defaultsLoaded", { userId: defaults.userId }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const saveDefaults = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const schema = selectedNetworkSchema(pluginSchemas, form.networkProfileId);
      const networkProfile = buildNetworkProfile(form, schema, t);
      const launchProfile = buildLaunchProfile(form);
      const saved = await saveSessionDefaults(form.userId, {
        quotaSeconds: Number(form.quotaSeconds),
        maxConnections: Number(form.maxConnections),
        launchProfile,
        networkProfile,
      });
      setForm((current) => applyDefaultsToForm(current, saved));
      const warningSuffix = saved.warnings?.length ? t("home.savedWithWarnings", { count: saved.warnings.length }) : "";
      setNotice(`${t("home.defaultsSaved", { userId: saved.userId })}${warningSuffix}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const networkProfile = buildNetworkProfile(form, selectedNetworkSchema(pluginSchemas, form.networkProfileId), t);
      const launchProfile = buildLaunchProfile(form);
      const lease = await createSession({
        userId: form.userId,
        quotaSeconds: Number(form.quotaSeconds),
        maxConnections: Number(form.maxConnections),
        launchProfile,
        networkProfile,
      });
      navigate(`/leases/${lease.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const sorted = [...leases].sort((a, b) => {
    if (a.status === "active" && b.status !== "active") return -1;
    if (a.status !== "active" && b.status === "active") return 1;
    return String(b.id).localeCompare(String(a.id));
  });

  const activeCount = sorted.filter((lease) => lease.status === "active").length;
  const networkSchema = selectedNetworkSchema(pluginSchemas, form.networkProfileId);

  if (auth.checking) {
    return (
      <Panel kicker={t("home.kicker")} title={t("home.title")}>
        <div className="loading">{t("login.checking")}</div>
      </Panel>
    );
  }

  return (
    <Panel
      kicker={t("home.kicker")}
      title={t("home.title")}
      sub={t("home.sub")}
      aside={<StatusChip status={activeCount ? "active" : "issued"} connected={activeCount > 0} />}
    >
      <form onSubmit={submit}>
        <div className="form-grid compact">
          <label className="field">
            <span>{t("home.userId")}</span>
            <input value={form.userId} onChange={update("userId")} />
          </label>
          <label className="field">
            <span>{t("home.quota")}</span>
            <input type="number" min="1" value={form.quotaSeconds} onChange={update("quotaSeconds")} />
          </label>
          <label className="field">
            <span>{t("home.maxConnections")}</span>
            <input type="number" min="1" value={form.maxConnections} onChange={update("maxConnections")} />
          </label>
          <label className="field">
            <span>{t("home.launchProfile")}</span>
            <select value={form.launchProfileId} onChange={update("launchProfileId")}>
              <option value="chrome-url">{t("launch.chromeUrl")}</option>
              <option value="blank-chrome">{t("launch.blankChrome")}</option>
              <option value="fallback-command">{t("launch.fallbackCommand")}</option>
            </select>
          </label>
          {form.launchProfileId === "chrome-url" && (
            <label className="field">
              <span>{t("home.launchUrl")}</span>
              <input value={form.launchUrl} onChange={update("launchUrl")} />
            </label>
          )}
          <label className="field">
            <span>{t("home.networkProfile")}</span>
            <select value={form.networkProfileId} onChange={updateNetworkProfile}>
              {pluginSchemas.networkProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>{t(profile.labelKey)}</option>
              ))}
            </select>
          </label>
        </div>
        <PluginConfigForm
          schema={networkSchema}
          config={form.networkConfig}
          onChange={updateNetworkField}
          t={t}
        />
        <div className="actions">
          <button type="button" onClick={loadDefaults} disabled={busy}>
            {t("home.loadDefaults")}
          </button>
          <button type="button" onClick={saveDefaults} disabled={busy}>
            {t("home.saveDefaults")}
          </button>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? t("home.creating") : t("home.create")}
          </button>
        </div>
      </form>
      {notice && <div className="success-note">{notice}</div>}
      <ErrorNote error={error || listError} />
      <Metrics
        items={[
          { label: t("home.totalSessions"), value: sorted.length },
          { label: t("home.activeSessions"), value: activeCount },
          { label: t("home.defaultQuota"), value: `${form.quotaSeconds}s` },
          { label: t("home.defaultMaxConnections"), value: form.maxConnections },
          { label: t("home.defaultLaunchProfile"), value: form.launchProfileId },
          { label: t("home.defaultNetworkProfile"), value: form.networkProfileId },
        ]}
      />
      <div className="session-list">
        <div className="session-list-head">
          <span>{t("home.sessions")}</span>
          <span>{t("home.autoRefresh")}</span>
        </div>
        {sorted.length === 0 ? (
          <div className="empty-state">{t("home.empty")}</div>
        ) : (
          sorted.map((lease) => (
            <article className="session-card" key={lease.id} data-state={lease.status === "active" ? "active" : "dead"}>
              <div className="session-main">
                <StatusChip status={lease.status} connected={lease.connected} />
                <div>
                  <Link className="session-id" to={`/leases/${lease.id}`}>{lease.id}</Link>
                  <div className="session-meta">
                    {t("lease.display")} <code>{lease.display}</code> · {t("lease.launchProfile")} <code>{lease.launchProfile?.id || "fallback-command"}</code> · {t("lease.networkProfile")} <code>{lease.networkPlugin?.id || "none"}</code>
                  </div>
                </div>
              </div>
              <div className="session-side">
                <strong>{fmtClock(lease.remainingSeconds)}</strong>
                <span>{lease.connected ? t("timer.draining") : t("timer.remaining")}</span>
              </div>
              <div className="session-actions">
                <Link className="button" to={`/leases/${lease.id}`}>{t("home.owner")}</Link>
                {lease.shareUrl && <CopyField label={t("home.share")} value={lease.shareUrl} />}
              </div>
            </article>
          ))
        )}
      </div>
    </Panel>
  );
}

function applyDefaultsToForm(current, defaults) {
  return {
    ...current,
    quotaSeconds: defaults.quotaSeconds,
    maxConnections: defaults.maxConnections,
    launchProfileId: defaults.launchProfile?.id || "chrome-url",
    launchUrl: defaults.launchProfile?.url || "about:blank",
    networkProfileId: defaults.networkProfile?.id || "none",
    networkConfig: networkProfileToConfig(defaults.networkProfile),
  };
}

function PluginConfigForm({ schema, config, onChange, t }) {
  if (!schema?.fields?.length) return null;
  return (
    <div className="plugin-config">
      <div className="plugin-config-head">
        <span>{t("plugin.config")}</span>
        <code>{schema.id}</code>
      </div>
      {schema.fields.map((field) => {
        if (field.type === "keyValueList") {
          return (
            <KeyValueListField
              key={field.name}
              field={field}
              rows={config[field.name] || []}
              onChange={(rows) => onChange(field.name, rows)}
              t={t}
            />
          );
        }
        if (field.type === "routeMappingList") {
          return (
            <RouteMappingListField
              key={field.name}
              field={field}
              rows={config[field.name] || []}
              onChange={(rows) => onChange(field.name, rows)}
              t={t}
            />
          );
        }
        return <UnsupportedField key={field.name} field={field} t={t} />;
      })}
    </div>
  );
}

function KeyValueListField({ field, rows, onChange, t }) {
  const updateRow = (index, key, value) => {
    onChange(rows.map((row, idx) => (idx === index ? { ...row, [key]: value } : row)));
  };
  const removeRow = (index) => onChange(rows.filter((_, idx) => idx !== index));
  const addRow = () => onChange([...rows, { id: rowId("header"), key: "", value: "" }]);

  return (
    <div className="plugin-field">
      <div className="plugin-field-title">
        <span>{t(field.labelKey)}</span>
        <button type="button" className="ghost" onClick={addRow}>{t(field.addLabelKey)}</button>
      </div>
      {rows.length === 0 ? (
        <div className="plugin-empty">{t("plugin.emptyHeaders")}</div>
      ) : (
        <div className="plugin-rows">
          {rows.map((row, index) => (
            <div className="plugin-row key-value-row" key={row.id || index}>
              <label className="field">
                <span>{t(field.keyLabelKey)}</span>
                <input value={row.key} onChange={(event) => updateRow(index, "key", event.target.value)} />
              </label>
              <label className="field">
                <span>{t(field.valueLabelKey)}</span>
                <input
                  type={field.secret ? "password" : "text"}
                  value={row.value}
                  onChange={(event) => updateRow(index, "value", event.target.value)}
                />
              </label>
              <button type="button" className="ghost danger" onClick={() => removeRow(index)} aria-label={t("plugin.remove")}>
                {t("plugin.remove")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RouteMappingListField({ field, rows, onChange, t }) {
  const updateRow = (index, key, value) => {
    onChange(rows.map((row, idx) => (idx === index ? { ...row, [key]: value } : row)));
  };
  const removeRow = (index) => onChange(rows.filter((_, idx) => idx !== index));
  const addRow = () => onChange([...rows, { id: rowId("route"), from: "", to: "", preserveHost: true }]);

  return (
    <div className="plugin-field">
      <div className="plugin-field-title">
        <span>{t(field.labelKey)}</span>
        <button type="button" className="ghost" onClick={addRow}>{t(field.addLabelKey)}</button>
      </div>
      {field.noteKey && <div className="plugin-note">{t(field.noteKey)}</div>}
      {rows.length === 0 ? (
        <div className="plugin-empty">{t("plugin.emptyMappings")}</div>
      ) : (
        <div className="plugin-rows">
          {rows.map((row, index) => (
            <div className="plugin-row route-row" key={row.id || index}>
              <label className="field">
                <span>{t(field.fromLabelKey)}</span>
                <input
                  value={row.from}
                  placeholder="app.example.com/app"
                  onChange={(event) => updateRow(index, "from", event.target.value)}
                />
              </label>
              <label className="field">
                <span>{t(field.toLabelKey)}</span>
                <input
                  value={row.to}
                  placeholder="localhost:4000/app"
                  onChange={(event) => updateRow(index, "to", event.target.value)}
                />
              </label>
              <label className="toggle-field">
                <input
                  type="checkbox"
                  checked={row.preserveHost !== false}
                  onChange={(event) => updateRow(index, "preserveHost", event.target.checked)}
                />
                <span>{t(field.preserveHostLabelKey)}</span>
              </label>
              <button type="button" className="ghost danger" onClick={() => removeRow(index)} aria-label={t("plugin.remove")}>
                {t("plugin.remove")}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function UnsupportedField({ field, t }) {
  return (
    <div className="plugin-field">
      <div className="plugin-field-title">
        <span>{t(field.labelKey, { defaultValue: field.name })}</span>
      </div>
      <div className="plugin-empty">
        {t("plugin.unsupportedField", { type: field.type })}
      </div>
    </div>
  );
}

function selectedNetworkSchema(pluginSchemas, id) {
  return pluginSchemas.networkProfiles.find((profile) => profile.id === id) || pluginSchemas.networkProfiles[0];
}

function defaultNetworkConfig(schema) {
  const config = {};
  for (const field of schema?.fields || []) {
    if (field.type === "keyValueList") {
      config[field.name] = withRowIds(field.default || [], "header");
    } else if (field.type === "routeMappingList") {
      config[field.name] = withRowIds(field.default || [], "route");
    }
  }
  return config;
}

function networkProfileToConfig(profile = {}) {
  return {
    headers: objectToKeyValueRows(profile.headers || {}),
    proxyMappings: proxyMappingsToRows(profile.proxyMappings || []),
  };
}

function objectToKeyValueRows(object) {
  return Object.entries(object || {}).map(([key, value]) => ({ id: rowId("header"), key, value: String(value ?? "") }));
}

function proxyMappingsToRows(mappings) {
  return (mappings || []).map((mapping) => ({
    id: rowId("route"),
    from: mapping.from || formatRoute(mapping.fromHost, mapping.fromPort, mapping.fromPath),
    to: mapping.to || formatRoute(mapping.toHost, mapping.toPort, mapping.toPath),
    preserveHost: mapping.preserveHost !== false,
  }));
}

function formatRoute(host, port, routePath) {
  if (!host) return "";
  const withPort = port ? `${host}:${port}` : host;
  return `${withPort}${routePath || ""}`;
}

function buildNetworkProfile(form, schema, t) {
  if (form.networkProfileId === "none") return { id: "none" };
  const profile = { id: form.networkProfileId };
  for (const field of schema?.fields || []) {
    const value = form.networkConfig[field.name] || [];
    if (field.type === "keyValueList") {
      profile[field.name] = keyValueRowsToObject(value, field, t);
    }
    if (field.type === "routeMappingList") {
      profile[field.name] = routeRowsToMappings(value, field, t);
    }
  }
  return profile;
}

function keyValueRowsToObject(rows, field, t) {
  const result = {};
  const pattern = field.validation?.keyPattern ? new RegExp(field.validation.keyPattern) : null;
  for (const row of rows || []) {
    const key = String(row.key || "").trim();
    const value = String(row.value ?? "");
    if (!key && !value) continue;
    if (!key) throw new Error(t("plugin.errors.emptyHeaderKey"));
    if (field.validation?.disallowNewlines && (/[\r\n]/.test(key) || /[\r\n]/.test(value))) {
      throw new Error(t("plugin.errors.headerNewline", { key }));
    }
    if (pattern && !pattern.test(key)) {
      throw new Error(t("plugin.errors.invalidHeaderKey", { key }));
    }
    result[key] = value;
  }
  return result;
}

function routeRowsToMappings(rows, field, t) {
  return (rows || [])
    .map((row, index) => validateRouteRow(row, index, field, t))
    .filter(Boolean);
}

function validateRouteRow(row, index, field, t) {
  const from = String(row.from || "").trim();
  const to = String(row.to || "").trim();
  if (!from && !to) return null;
  if (!from || !to) {
    throw new Error(t("plugin.errors.incompleteMapping", { index: index + 1 }));
  }
  const fromEndpoint = parseRouteEndpoint(from);
  const toEndpoint = parseRouteEndpoint(to);
  if (!fromEndpoint) throw new Error(t("plugin.errors.invalidRouteFrom", { index: index + 1 }));
  if (!toEndpoint) throw new Error(t("plugin.errors.invalidRouteTo", { index: index + 1 }));
  if (field.validation?.allowHttpsPath === false && (hasHttpsPath(fromEndpoint) || hasHttpsPath(toEndpoint))) {
    throw new Error(t("plugin.errors.httpsPath", { index: index + 1 }));
  }
  return { from, to, preserveHost: row.preserveHost !== false };
}

function parseRouteEndpoint(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const hasProtocol = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw);
  const parseValue = hasProtocol ? raw : `route://${raw}`;
  try {
    const url = new URL(parseValue);
    const protocol = hasProtocol ? url.protocol.slice(0, -1).toLowerCase() : null;
    if (protocol && protocol !== "http" && protocol !== "https") return null;
    if (!url.hostname) return null;
    if (url.port) {
      const port = Number(url.port);
      if (!Number.isInteger(port) || port <= 0 || port >= 65536) return null;
    }
    const rawWithoutProtocol = hasProtocol ? raw.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "") : raw;
    const hasExplicitPath = rawWithoutProtocol.includes("/");
    return {
      protocol,
      host: url.hostname,
      path: hasExplicitPath ? `${url.pathname}${url.search}` : "",
    };
  } catch {
    return null;
  }
}

function hasHttpsPath(endpoint) {
  return endpoint.protocol === "https" && endpoint.path && endpoint.path !== "/";
}

function withRowIds(rows, prefix) {
  return (rows || []).map((row) => ({ id: rowId(prefix), ...row }));
}

function rowId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildLaunchProfile(form) {
  if (form.launchProfileId === "fallback-command") return { id: "fallback-command" };
  if (form.launchProfileId === "blank-chrome") return { id: "blank-chrome" };
  return { id: "chrome-url", url: form.launchUrl || "about:blank" };
}
