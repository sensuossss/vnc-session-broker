import fs from "node:fs";
import http from "node:http";

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: node scripts/cdp-sidecar.mjs <config.json>");
  process.exit(2);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const logPath = config.logPath;
const cdpBase = `http://127.0.0.1:${config.cdpPort}`;
const pollMs = Number(config.pollMs || 1000);
const urlRewriteMappings = Array.isArray(config.urlRewriteMappings) ? config.urlRewriteMappings : [];
const configuredTargets = new Set();
const activeClients = new Map();

function log(event, data = {}) {
  const line = JSON.stringify({ at: Date.now(), leaseId: config.leaseId, event, ...data });
  fs.appendFileSync(logPath, `${line}\n`);
}

async function main() {
  log("sidecar_start", {
    cdpPort: config.cdpPort,
    headerKeys: Object.keys(config.headers || {}),
    urlRewriteMappings: urlRewriteMappings.length,
  });

  while (true) {
    try {
      const targets = await getJson(`${cdpBase}/json/list`);
      for (const target of targets) {
        if (!target.webSocketDebuggerUrl || configuredTargets.has(target.id)) continue;
        if (target.type !== "page" && target.type !== "iframe") continue;
        configureTarget(target).catch((error) => {
          log("target_config_error", { targetId: target.id, error: error.message });
          configuredTargets.delete(target.id);
        });
      }
    } catch (error) {
      log("poll_error", { error: error.message });
    }
    await sleep(pollMs);
  }
}

async function configureTarget(target) {
  configuredTargets.add(target.id);
  const client = await connectCdp(target.webSocketDebuggerUrl, () => {
    configuredTargets.delete(target.id);
    activeClients.delete(target.id);
    log("target_closed", { targetId: target.id });
  });
  await client.send("Network.enable");
  await client.send("Network.setExtraHTTPHeaders", { headers: config.headers || {} });
  if (urlRewriteMappings.length > 0) {
    client.on("Fetch.requestPaused", (params) => handleRequestPaused(client, target.id, params));
    await client.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*", requestStage: "Request" },
      ],
    });
  }
  activeClients.set(target.id, client);
  log("target_configured", {
    targetId: target.id,
    type: target.type,
    url: target.url,
    headerKeys: Object.keys(config.headers || {}),
    urlRewriteMappings: urlRewriteMappings.length,
  });
}

async function handleRequestPaused(client, targetId, params) {
  const requestId = params.requestId;
  const sourceUrl = params.request?.url || "";
  const rewrite = rewriteUrl(sourceUrl);
  try {
    if (rewrite) {
      await client.send("Fetch.continueRequest", {
        requestId,
        url: rewrite.url,
      });
      log("url_rewrite", {
        targetId,
        from: sourceUrl,
        to: rewrite.url,
        mapping: rewrite.mapping.from,
      });
    } else {
      await client.send("Fetch.continueRequest", { requestId });
    }
  } catch (error) {
    log("fetch_continue_error", {
      targetId,
      requestId,
      url: sourceUrl,
      error: error.message,
    });
  }
}

function rewriteUrl(sourceUrl) {
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  const mapping = findRewriteMapping(url);
  if (!mapping) return null;
  const targetPath = rewritePath(`${url.pathname}${url.search}`, mapping);
  const targetPort = formatPort(mapping.toProtocol, mapping.toPort);
  return {
    mapping,
    url: `${mapping.toProtocol || "http"}://${mapping.toHost}${targetPort}${targetPath}`,
  };
}

function findRewriteMapping(url) {
  const sourceProtocol = url.protocol.slice(0, -1);
  const sourcePort = url.port ? Number(url.port) : sourceProtocol === "https" ? 443 : 80;
  const candidates = [];
  for (const mapping of urlRewriteMappings) {
    if (!mapping.fromPath) continue;
    if (String(mapping.fromHost || "").toLowerCase() !== url.hostname.toLowerCase()) continue;
    if (mapping.fromProtocol && mapping.fromProtocol !== sourceProtocol) continue;
    if (mapping.fromPort && Number(mapping.fromPort) !== sourcePort) continue;
    if (!pathMatches(`${url.pathname}${url.search}`, mapping.fromPath)) continue;
    candidates.push(mapping);
  }
  candidates.sort((left, right) => String(right.fromPath || "").length - String(left.fromPath || "").length);
  return candidates[0] || null;
}

function pathMatches(path, prefix) {
  if (!prefix) return true;
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
}

function rewritePath(path, mapping) {
  const fromPath = mapping.fromPath || "";
  const toPath = mapping.toPath || "";
  const suffix = fromPath ? path.slice(fromPath.length) : path;
  return mergePath(toPath, suffix || "");
}

function mergePath(prefix, suffix) {
  if (!prefix) return suffix || "/";
  if (!suffix) return prefix;
  if (suffix.startsWith("?")) return `${prefix}${suffix}`;
  return `${prefix.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
}

function formatPort(protocol, port) {
  if (!port) return "";
  const defaultPort = protocol === "https" ? 443 : 80;
  return Number(port) === defaultPort ? "" : `:${port}`;
}

function connectCdp(url, onClose) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let nextId = 1;
    const pending = new Map();
    const handlers = new Map();

    ws.addEventListener("open", () => {
      resolve({
        on(method, handler) {
          const list = handlers.get(method) || [];
          list.push(handler);
          handlers.set(method, list);
        },
        send(method, params = {}) {
          const id = nextId++;
          const payload = JSON.stringify({ id, method, params });
          return new Promise((sendResolve, sendReject) => {
            pending.set(id, { resolve: sendResolve, reject: sendReject });
            ws.send(payload);
          });
        },
        close() {
          ws.close();
        },
      });
    });

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method && handlers.has(message.method)) {
        for (const handler of handlers.get(message.method)) {
          Promise.resolve(handler(message.params || {})).catch((error) => {
            log("event_handler_error", { method: message.method, error: error.message });
          });
        }
      }
      if (!message.id || !pending.has(message.id)) return;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message || "cdp_error"));
      else entry.resolve(message.result || {});
    });

    ws.addEventListener("error", () => reject(new Error("websocket_error")));
    ws.addEventListener("close", () => {
      for (const entry of pending.values()) entry.reject(new Error("websocket_closed"));
      pending.clear();
      onClose?.();
    });
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`http_${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.setTimeout(1000, () => {
      request.destroy(new Error("http_timeout"));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  log("sidecar_fatal", { error: error.message });
  process.exit(1);
});
