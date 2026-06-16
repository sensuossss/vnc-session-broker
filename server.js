import crypto from "node:crypto";
import des from "des.js";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultResolution = process.env.VNC_RESOLUTION || "2560x1440x24";

const config = {
  controlPort: intEnv("CONTROL_PORT", 7070),
  publicHost: process.env.PUBLIC_HOST || os.hostname(),
  attachDisplay: process.env.VNC_ATTACH_DISPLAY || ":1",
  desktopMode: process.env.VNC_DESKTOP_MODE || "attach",
  resolution: defaultResolution,
  dpi: intEnv("VNC_DPI", 144),
  sessionCommand: process.env.VNC_SESSION_COMMAND || "",
  chromeProfileTemplateDir: process.env.CHROME_PROFILE_TEMPLATE_DIR || "",
  chromeWindowSize: process.env.CHROME_WINDOW_SIZE || resolutionToWindowSize(defaultResolution),
  mapSuperToControl: process.env.MAP_SUPER_TO_CONTROL !== "false",
  displayBase: intEnv("DISPLAY_BASE", 20),
  vncPortBase: intEnv("VNC_PORT_BASE", 6101),
  webPortBase: intEnv("WEB_PORT_BASE", 7101),
  cdpPortBase: intEnv("CDP_PORT_BASE", 9101),
  proxyPortBase: intEnv("PROXY_PORT_BASE", 9201),
  tokenTtlSeconds: intEnv("TOKEN_TTL_SECONDS", 15 * 60),
  defaultQuotaSeconds: intEnv("DEFAULT_QUOTA_SECONDS", 30 * 60),
  defaultMaxConnections: intEnv("DEFAULT_MAX_CONNECTIONS", 1),
  idleTtlSeconds: intEnv("IDLE_TTL_SECONDS", 10 * 60),
  watchdogMs: intEnv("WATCHDOG_MS", 1000),
  runtimeDir: process.env.RUNTIME_DIR || path.join(__dirname, "runtime"),
  noVncWebRoot: process.env.NOVNC_WEB_ROOT || "/usr/share/novnc",
  noVncResize: choiceEnv("NOVNC_RESIZE", "scale", ["off", "scale", "remote"]),
  noVncQuality: boundedIntEnv("NOVNC_QUALITY", 9, 0, 9),
  noVncCompression: boundedIntEnv("NOVNC_COMPRESSION", 2, 0, 9),
  x11vncNoXDamage: process.env.X11VNC_NOXDAMAGE !== "false",
  x11vncExtraArgs: argListEnv("X11VNC_EXTRA_ARGS"),
  webDistDir: process.env.WEB_DIST || path.join(__dirname, "web", "dist"),
  sessionDefaultsFile: process.env.SESSION_DEFAULTS_FILE || path.join(__dirname, "session-defaults.json"),
  brokerStateFile: process.env.BROKER_STATE_FILE || path.join(__dirname, "broker-state.json"),
  adminPassword: process.env.ADMIN_PASSWORD || "",
  adminToken: process.env.ADMIN_TOKEN || "",
  adminSessionTtlSeconds: intEnv("ADMIN_SESSION_TTL_SECONDS", 12 * 60 * 60),
};

fs.mkdirSync(config.runtimeDir, { recursive: true });

const tokens = new Map();
const leases = new Map();
const adminSessions = new Map();
let nextDisplay = config.displayBase;
let nextVncPort = config.vncPortBase;
let nextWebPort = config.webPortBase;
let nextCdpPort = config.cdpPortBase;
let nextProxyPort = config.proxyPortBase;
let brokerStateDirty = false;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      return json(res, {
        authRequired: adminAuthRequired(),
        authenticated: isAdminRequest(req),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJson(req);
      return loginAdmin(req, res, body);
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      clearAdminCookie(res);
      return json(res, { authenticated: false });
    }

    if (req.method === "POST" && url.pathname === "/api/tokens") {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const token = issueToken(body);
      return json(res, token);
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const lease = await createSession(body);
      return json(res, publicLease(lease));
    }

    if (req.method === "GET" && url.pathname === "/api/leases") {
      if (!requireAdmin(req, res)) return;
      return json(res, [...leases.values()].map((lease) => publicLease(lease)));
    }

    if (req.method === "GET" && url.pathname === "/api/plugin-schemas") {
      if (!requireAdmin(req, res)) return;
      return json(res, pluginSchemas());
    }

    const defaultsMatch = url.pathname.match(/^\/api\/session-defaults\/([^/]+)$/);
    if (req.method === "GET" && defaultsMatch) {
      if (!requireAdmin(req, res)) return;
      return json(res, publicSessionDefaults(defaultsMatch[1]));
    }
    if (req.method === "PUT" && defaultsMatch) {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      return json(res, saveUserSessionDefaults(defaultsMatch[1], body));
    }

    const redeemMatch = url.pathname.match(/^\/api\/tokens\/([^/]+)\/redeem$/);
    if (req.method === "POST" && redeemMatch) {
      const body = await readJson(req);
      const lease = await redeemToken(redeemMatch[1], body);
      return json(res, publicLease(lease));
    }

    const tokenStatusMatch = url.pathname.match(/^\/api\/tokens\/([^/]+)$/);
    if (req.method === "GET" && tokenStatusMatch) {
      const record = tokens.get(tokenStatusMatch[1]);
      if (!record) return notFound(res);
      const existingLease = [...leases.values()].find((lease) => lease.token === record.token);
      const expired = record.status === "issued" && Date.now() > record.expiresAt;
      if (expired && record.status !== "expired") {
        record.status = "expired";
        markBrokerStateDirty();
        persistBrokerStateNow();
      }
      return json(res, {
        status: expired ? "expired" : record.status,
        quotaSeconds: record.quotaSeconds,
        expiresAt: record.expiresAt,
        leaseId: existingLease ? existingLease.id : null,
      });
    }

    const leaseApiMatch = url.pathname.match(/^\/api\/leases\/([^/]+)$/);
    if (req.method === "GET" && leaseApiMatch) {
      if (!requireAdmin(req, res)) return;
      const lease = leases.get(leaseApiMatch[1]);
      if (!lease) return notFound(res);
      return json(res, publicLease(lease));
    }

    const shareApiMatch = url.pathname.match(/^\/api\/share\/([^/]+)$/);
    if (req.method === "GET" && shareApiMatch) {
      const lease = findLeaseByViewerToken(shareApiMatch[1]);
      if (!lease) return notFound(res);
      return json(res, publicLease(lease, "viewer"));
    }

    const renewMatch = url.pathname.match(/^\/api\/leases\/([^/]+)\/renew$/);
    if (req.method === "POST" && renewMatch) {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const lease = renewLease(renewMatch[1], intValue(body.extraSeconds, 15 * 60));
      return json(res, publicLease(lease));
    }

    const timeMatch = url.pathname.match(/^\/api\/leases\/([^/]+)\/time$/);
    if (req.method === "PUT" && timeMatch) {
      if (!requireAdmin(req, res)) return;
      const body = await readJson(req);
      const lease = setLeaseRemainingSeconds(timeMatch[1], Number(body.remainingSeconds));
      return json(res, publicLease(lease));
    }

    const revokeMatch = url.pathname.match(/^\/api\/leases\/([^/]+)\/revoke$/);
    if (req.method === "POST" && revokeMatch) {
      if (!requireAdmin(req, res)) return;
      const lease = revokeLease(revokeMatch[1], "revoked_by_user");
      return json(res, publicLease(lease));
    }

    if ((req.method === "GET" || req.method === "HEAD") && !url.pathname.startsWith("/api/")) {
      return serveWeb(res, url.pathname, req.method === "HEAD");
    }

    return notFound(res);
  } catch (error) {
    console.error(error);
    return json(res, { error: error.message || "internal_error" }, 500);
  }
});

server.on("upgrade", (req, socket, head) => {
  handleUpgrade(req, socket, head).catch((error) => {
    console.error(error);
    try {
      socket.destroy();
    } catch {
      // Socket is already gone.
    }
  });
});

await loadBrokerState();

server.listen(config.controlPort, "0.0.0.0", () => {
  console.log(`VNC session broker listening on http://0.0.0.0:${config.controlPort}`);
});

setInterval(tickLeases, config.watchdogMs).unref();

function issueToken(input = {}) {
  const token = randomId(24);
  const quotaSeconds = intValue(input.quotaSeconds, config.defaultQuotaSeconds);
  const ttlSeconds = intValue(input.ttlSeconds, config.tokenTtlSeconds);
  const networkProfileResult = normalizeNetworkProfileWithWarnings(input.networkProfile);
  const record = {
    token,
    userId: input.userId || "anonymous",
    quotaSeconds,
    maxConnections: intValue(input.maxConnections, config.defaultMaxConnections),
    networkProfile: networkProfileResult.profile,
    warnings: networkProfileResult.warnings,
    launchProfile: normalizeLaunchProfile(input.launchProfile),
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlSeconds * 1000,
    status: "issued",
  };
  tokens.set(token, record);
  markBrokerStateDirty();
  persistBrokerStateNow();
  return {
    token,
    accessUrl: `http://${config.publicHost}:${config.controlPort}/access/${token}`,
    expiresAt: record.expiresAt,
    quotaSeconds,
    maxConnections: record.maxConnections,
    networkProfile: record.networkProfile,
    warnings: record.warnings,
    launchProfile: record.launchProfile,
  };
}

async function redeemToken(token, input = {}) {
  const record = tokens.get(token);
  if (!record) throw new Error("token_not_found");
  if (record.status !== "issued") throw new Error(`token_${record.status}`);
  if (Date.now() > record.expiresAt) {
    record.status = "expired";
    throw new Error("token_expired");
  }

  record.status = "redeemed";
  record.redeemedAt = Date.now();
  record.redeemedBy = input.clientLabel || null;

  const lease = await createLease(record);
  leases.set(lease.id, lease);
  markBrokerStateDirty();
  persistBrokerStateNow();
  return lease;
}

async function createSession(input = {}) {
  const defaults = getUserSessionDefaults(input.userId || "owner");
  const merged = {
    ...defaults,
    ...input,
    networkProfile: input.networkProfile || defaults.networkProfile,
    launchProfile: input.launchProfile || defaults.launchProfile,
  };
  const quotaSeconds = intValue(merged.quotaSeconds, config.defaultQuotaSeconds);
  const networkProfileResult = normalizeNetworkProfileWithWarnings(merged.networkProfile);
  const record = {
    token: null,
    userId: merged.userId || "owner",
    quotaSeconds,
    maxConnections: intValue(merged.maxConnections, config.defaultMaxConnections),
    networkProfile: networkProfileResult.profile,
    warnings: networkProfileResult.warnings,
    launchProfile: normalizeLaunchProfile(merged.launchProfile),
    issuedAt: Date.now(),
    expiresAt: null,
    status: "direct",
  };
  const lease = await createLease(record);
  leases.set(lease.id, lease);
  markBrokerStateDirty();
  persistBrokerStateNow();
  return lease;
}

async function createLease(tokenRecord) {
  const id = randomId(12);
  const dir = path.join(config.runtimeDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const processes = [];
  let chromeProfileDir = "";

  try {
    const transport = await prepareTransportAdapter("legacy-vnc", {
      id,
      dir,
      maxConnections: tokenRecord.maxConnections,
    });
    processes.push(...transport.processes);
    const plugin = await prepareSessionPlugin(tokenRecord.networkProfile, id, dir);
    chromeProfileDir = prepareChromeProfileDir(dir);

    if (transport.startSessionCommand) {
      const sessionCommand = buildSessionCommand(tokenRecord.launchProfile, { chromeProfileDir });
      if (sessionCommand) {
        if (plugin.proxyConfigPath) {
          processes.push(startProcess(process.execPath, [
            path.join(__dirname, "scripts", "network-proxy.mjs"),
            plugin.proxyConfigPath,
          ], { logPath: path.join(dir, "network-proxy.stderr.log") }));
          await sleep(250);
        }
        if (plugin.chromeArgs.length > 0) {
          writeChromeLaunchWrappers(dir, plugin.chromeArgs);
        }
        processes.push(startProcess("sh", [
          "-c",
          sessionCommand,
        ], {
          logPath: path.join(dir, "session-command.log"),
          env: {
            DISPLAY: transport.display,
            PATH: `${dir}:${process.env.PATH || ""}`,
            VNC_SESSION_ID: id,
            VNC_NETWORK_PROFILE: plugin.publicState.id,
            VNC_LAUNCH_PROFILE: tokenRecord.launchProfile.id,
          },
        }));
        await sleep(1000);
      }
    }

    if (plugin.sidecarConfigPath) {
      processes.push(startProcess(process.execPath, [
        path.join(__dirname, "scripts", "cdp-sidecar.mjs"),
        plugin.sidecarConfigPath,
      ], { logPath: path.join(dir, "cdp-sidecar.stderr.log") }));
    }

    processes.push(...await startTransportGateways(transport));

    return {
      id,
      token: tokenRecord.token,
      userId: tokenRecord.userId,
      status: "active",
      transport: transport.publicState,
      display: transport.display,
      vncPort: transport.vncPort,
      internalVncPort: transport.internalVncPort,
      webPort: transport.webPort,
      password: transport.password,
      passFile: transport.passFile,
      logPath: transport.logPath,
      admissionLogPath: transport.admissionLogPath,
      acceptScriptPath: transport.acceptScriptPath,
      dir,
      chromeProfileDir,
      processes,
      nativeGatewayServer: transport.nativeGatewayServer || null,
      maxConnections: tokenRecord.maxConnections,
      networkPlugin: plugin.publicState,
      warnings: tokenRecord.warnings || [],
      launchProfile: tokenRecord.launchProfile,
      issuedAt: Date.now(),
      lastTickAt: Date.now(),
      connected: false,
      connectedCount: 0,
      connectionState: emptyConnectionState(),
      pendingClients: {},
      activeClients: {},
      connectedSince: null,
      lastDisconnectAt: null,
      remainingSeconds: tokenRecord.quotaSeconds,
      idleDeadline: Date.now() + config.idleTtlSeconds * 1000,
      viewerToken: randomId(18),
      viewerGatewayClients: new Set(),
      viewerGatewayPending: 0,
      connectionEvents: [],
      lastLogSize: 0,
      lastAdmissionLogSize: 0,
    };
  } catch (error) {
    for (const proc of processes) {
      killProcess(proc, "SIGTERM");
    }
    setTimeout(() => {
      for (const proc of processes) {
        killProcess(proc, "SIGKILL");
      }
    }, 1000).unref();
    cleanupChromeProfileDir({ dir, chromeProfileDir });
    throw error;
  }
}

async function prepareTransportAdapter(adapterId, context) {
  if (adapterId !== "legacy-vnc") throw new Error(`unknown_transport_adapter:${adapterId}`);
  return prepareLegacyVncTransport(context);
}

async function prepareLegacyVncTransport({ dir, maxConnections }) {
  const password = randomPassword();
  const passFile = path.join(dir, "vnc.passwd");
  runChecked("x11vnc", ["-storepasswd", password, passFile]);

  const vncPort = await allocatePort("vnc");
  const internalVncPort = await allocatePort("vnc");
  const webPort = await allocatePort("web");
  const display = config.desktopMode === "xvfb" ? `:${nextDisplay++}` : config.attachDisplay;
  const logPath = path.join(dir, "x11vnc.log");
  const admissionLogPath = path.join(dir, "admission.log");
  const acceptScriptPath = path.join(dir, "accept-client.sh");
  const processes = [];

  writeAcceptScript(acceptScriptPath, admissionLogPath, maxConnections);

  if (config.desktopMode === "xvfb") {
    processes.push(startProcess("Xvfb", [
      display,
      "-screen",
      "0",
      config.resolution,
      "-dpi",
      String(config.dpi),
      "-ac",
    ], { logPath: path.join(dir, "xvfb.log") }));
    await sleep(500);

    if (config.mapSuperToControl) {
      processes.push(startProcess("sh", [
        "-c",
        "xmodmap -e 'remove mod4 = Super_L Super_R' -e 'add control = Super_L Super_R'",
      ], {
        logPath: path.join(dir, "xmodmap.log"),
        env: { DISPLAY: display },
      }));
      await sleep(200);
    }
  }

  return {
    id: "legacy-vnc",
    display,
    vncPort,
    internalVncPort,
    webPort,
    password,
    passFile,
    logPath,
    admissionLogPath,
    acceptScriptPath,
    processes,
    startSessionCommand: config.desktopMode === "xvfb",
    publicState: legacyTransportState(),
  };
}

async function startTransportGateways(transport) {
  if (transport.id !== "legacy-vnc") throw new Error(`unknown_transport_adapter:${transport.id}`);
  return startLegacyVncGateways(transport);
}

async function startLegacyVncGateways(transport) {
  const x11vnc = startProcess("x11vnc", [
    "-display",
    transport.display,
    "-listen",
    "127.0.0.1",
    "-no6",
    "-noipv6",
    "-rfbport",
    String(transport.internalVncPort),
    "-rfbportv6",
    "-1",
    "-rfbauth",
    transport.passFile,
    "-forever",
    "-shared",
    "-accept",
    transport.acceptScriptPath,
    ...(config.x11vncNoXDamage ? ["-noxdamage"] : []),
    "-repeat",
    ...config.x11vncExtraArgs,
    "-o",
    transport.logPath,
  ], { logPath: path.join(path.dirname(transport.logPath), "x11vnc.stderr.log") });

  await assertLegacyVncListenSurface(x11vnc, {
    port: transport.internalVncPort,
    host: "127.0.0.1",
  });

  transport.nativeGatewayServer = await startNativeVncGateway(transport);

  const websockify = startProcess("websockify", [
    "--web",
    config.noVncWebRoot,
    String(transport.webPort),
    `127.0.0.1:${transport.internalVncPort}`,
  ], { logPath: path.join(path.dirname(transport.logPath), "websockify.log") });

  return [x11vnc, websockify];
}

function startNativeVncGateway(transport) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const backend = net.connect(transport.internalVncPort, "127.0.0.1");
      client.on("error", () => backend.destroy());
      backend.on("error", () => client.destroy());
      client.on("close", () => backend.destroy());
      backend.on("close", () => client.destroy());
      client.pipe(backend);
      backend.pipe(client);
    });
    server.on("error", reject);
    server.listen(transport.vncPort, "0.0.0.0", () => {
      server.off("error", reject);
      try {
        assertNativeGatewayListenSurface(server, transport.vncPort);
        resolve(server);
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });
}

function findLeaseByViewerToken(viewerToken) {
  return [...leases.values()].find((lease) => lease.viewerToken === viewerToken);
}

async function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const match = url.pathname.match(/^\/share\/([^/]+)\/connect\/web$/);
  if (!match) {
    return rejectUpgrade(socket, 404, "not_found");
  }
  const lease = findLeaseByViewerToken(match[1]);
  const validation = validateViewerGatewayLease(lease);
  if (!validation.ok) {
    return rejectUpgrade(socket, validation.httpStatus, validation.reason);
  }

  const ws = acceptWebSocket(req, socket, head);
  runViewerRfbGateway(lease, ws).catch((error) => {
    console.error(error);
    ws.close(1011, "gateway_error");
  });
}

function validateViewerGatewayLease(lease) {
  if (!lease) return { ok: false, httpStatus: 404, reason: "token_invalid" };
  if (lease.status !== "active") return { ok: false, httpStatus: 409, reason: "lease_inactive" };
  if (lease.remainingSeconds <= 0) return { ok: false, httpStatus: 409, reason: "quota_exhausted" };
  const pending = lease.viewerGatewayPending || 0;
  if ((lease.connectedCount || 0) + pending >= lease.maxConnections) {
    return { ok: false, httpStatus: 429, reason: "capacity_exceeded" };
  }
  return { ok: true };
}

function rejectUpgrade(socket, status, reason) {
  const statusText = status === 404
    ? "Not Found"
    : status === 429
      ? "Too Many Requests"
      : "Forbidden";
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\n${reason}\n`);
  socket.destroy();
}

function renewLease(id, extraSeconds) {
  const lease = leases.get(id);
  if (!lease) throw new Error("lease_not_found");
  if (lease.status !== "active") throw new Error(`lease_${lease.status}`);
  lease.remainingSeconds += extraSeconds;
  lease.idleDeadline = Date.now() + config.idleTtlSeconds * 1000;
  lease.connectionEvents.push({ at: Date.now(), type: "renew", extraSeconds });
  markBrokerStateDirty();
  persistBrokerStateNow();
  return lease;
}

function setLeaseRemainingSeconds(id, remainingSeconds) {
  const lease = leases.get(id);
  if (!lease) throw new Error("lease_not_found");
  if (lease.status !== "active") throw new Error(`lease_${lease.status}`);
  if (!Number.isFinite(remainingSeconds) || remainingSeconds < 0) {
    throw new Error("invalid_remaining_seconds");
  }
  lease.remainingSeconds = Math.floor(remainingSeconds);
  lease.lastTickAt = Date.now();
  lease.idleDeadline = Date.now() + config.idleTtlSeconds * 1000;
  lease.connectionEvents.push({
    at: Date.now(),
    type: "set_remaining_seconds",
    remainingSeconds: lease.remainingSeconds,
  });
  if (lease.remainingSeconds <= 0) expireLease(lease, "quota_exhausted");
  markBrokerStateDirty();
  persistBrokerStateNow();
  return lease;
}

function revokeLease(id, reason) {
  const lease = leases.get(id);
  if (!lease) throw new Error("lease_not_found");
  expireLease(lease, reason);
  return lease;
}

function tickLeases() {
  const now = Date.now();
  for (const lease of leases.values()) {
    if (lease.status !== "active") continue;
    markBrokerStateDirty();
    syncTransportConnectionState(lease);

    if (lease.connected) {
      const deltaSeconds = Math.max(0, (now - lease.lastTickAt) / 1000);
      lease.remainingSeconds = Math.max(0, lease.remainingSeconds - deltaSeconds);
      lease.idleDeadline = now + config.idleTtlSeconds * 1000;
    }
    lease.lastTickAt = now;

    if (lease.remainingSeconds <= 0) {
      expireLease(lease, "quota_exhausted");
      continue;
    }
    if (!lease.connected && now > lease.idleDeadline) {
      expireLease(lease, "idle_timeout");
    }
  }
  persistBrokerStateNow();
}

function syncTransportConnectionState(lease) {
  if (transportAdapterId(lease) !== "legacy-vnc") {
    lease.connectionState = emptyConnectionState();
    lease.connected = false;
    lease.connectedCount = 0;
    return;
  }

  scanX11vncLog(lease);
  scanAdmissionLog(lease);
  lease.connectionState = legacyVncConnectionState(lease);
}

function legacyVncConnectionState(lease) {
  const viewerCount = lease.viewerGatewayClients?.size || 0;
  const totalCount = Math.max(lease.connectedCount, viewerCount);
  return {
    native: {
      connected: lease.connectedCount > 0,
      connectedCount: lease.connectedCount,
    },
    web: {
      connected: false,
      connectedCount: 0,
    },
    viewer: {
      connected: viewerCount > 0,
      connectedCount: viewerCount,
    },
    total: {
      connected: totalCount > 0,
      connectedCount: totalCount,
    },
  };
}

function emptyConnectionState() {
  return {
    native: { connected: false, connectedCount: 0 },
    web: { connected: false, connectedCount: 0 },
    viewer: { connected: false, connectedCount: 0 },
    total: { connected: false, connectedCount: 0 },
  };
}

function transportAdapterId(lease) {
  return lease.transport?.id || "legacy-vnc";
}

async function loadBrokerState() {
  const state = readBrokerState();
  if (!state) return;

  for (const rawToken of arrayValue(state.tokens)) {
    const token = hydrateToken(rawToken);
    if (token) tokens.set(token.token, token);
  }

  for (const rawLease of arrayValue(state.leases)) {
    const lease = await hydrateLease(rawLease);
    if (!lease) continue;
    leases.set(lease.id, lease);
    advanceAllocatorsFromLease(lease);
  }

  persistBrokerStateNow();
  console.log(`restored broker state: ${leases.size} leases, ${tokens.size} tokens`);
}

function readBrokerState() {
  if (!fs.existsSync(config.brokerStateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(config.brokerStateFile, "utf8"));
  } catch (error) {
    console.error(`failed to read broker state: ${error.message}`);
    return null;
  }
}

function hydrateToken(rawToken) {
  if (!rawToken || typeof rawToken !== "object" || !rawToken.token) return null;
  return {
    token: String(rawToken.token),
    userId: rawToken.userId || "anonymous",
    quotaSeconds: positiveNumber(rawToken.quotaSeconds, config.defaultQuotaSeconds),
    maxConnections: positiveNumber(rawToken.maxConnections, config.defaultMaxConnections),
    networkProfile: normalizeNetworkProfile(rawToken.networkProfile),
    warnings: arrayValue(rawToken.warnings),
    launchProfile: normalizeLaunchProfile(rawToken.launchProfile),
    issuedAt: positiveNumber(rawToken.issuedAt, Date.now()),
    expiresAt: rawToken.expiresAt == null ? null : positiveNumber(rawToken.expiresAt, Date.now()),
    status: String(rawToken.status || "issued"),
    redeemedAt: rawToken.redeemedAt || null,
    redeemedBy: rawToken.redeemedBy || null,
  };
}

async function hydrateLease(rawLease) {
  if (!rawLease || typeof rawLease !== "object" || !rawLease.id) return null;
  const id = String(rawLease.id);
  const dir = path.join(config.runtimeDir, id);
  const status = String(rawLease.status || "terminated");
  const lease = {
    id,
    token: rawLease.token || null,
    userId: rawLease.userId || "owner",
    status,
    transport: hydrateTransportState(rawLease),
    display: rawLease.display || config.attachDisplay,
    vncPort: positiveNumber(rawLease.vncPort, 0),
    internalVncPort: positiveNumber(rawLease.internalVncPort, rawLease.vncPort || 0),
    webPort: positiveNumber(rawLease.webPort, 0),
    password: String(rawLease.password || ""),
    passFile: rawLease.passFile || path.join(dir, "vnc.passwd"),
    logPath: rawLease.logPath || path.join(dir, "x11vnc.log"),
    admissionLogPath: rawLease.admissionLogPath || path.join(dir, "admission.log"),
    acceptScriptPath: rawLease.acceptScriptPath || path.join(dir, "accept-client.sh"),
    dir,
    chromeProfileDir: rawLease.chromeProfileDir || null,
    processes: hydrateProcesses(rawLease.processes),
    nativeGatewayServer: null,
    maxConnections: positiveNumber(rawLease.maxConnections, config.defaultMaxConnections),
    networkPlugin: rawLease.networkPlugin || viewerNetworkPluginState(null),
    warnings: arrayValue(rawLease.warnings),
    launchProfile: normalizeLaunchProfile(rawLease.launchProfile),
    issuedAt: positiveNumber(rawLease.issuedAt, Date.now()),
    lastTickAt: Date.now(),
    connected: Boolean(rawLease.connected),
    connectedCount: positiveNumber(rawLease.connectedCount, 0),
    connectionState: normalizeConnectionState(rawLease.connectionState),
    pendingClients: objectValue(rawLease.pendingClients),
    activeClients: objectValue(rawLease.activeClients),
    connectedSince: rawLease.connectedSince || null,
    lastDisconnectAt: rawLease.lastDisconnectAt || null,
    remainingSeconds: nonNegativeNumber(rawLease.remainingSeconds, 0),
    idleDeadline: positiveNumber(rawLease.idleDeadline, Date.now() + config.idleTtlSeconds * 1000),
    viewerToken: rawLease.viewerToken || randomId(18),
    viewerGatewayClients: new Set(),
    viewerGatewayPending: 0,
    connectionEvents: arrayValue(rawLease.connectionEvents).slice(-200),
    lastLogSize: nonNegativeNumber(rawLease.lastLogSize, 0),
    lastAdmissionLogSize: nonNegativeNumber(rawLease.lastAdmissionLogSize, 0),
    expiredAt: rawLease.expiredAt || null,
  };

  if (lease.status === "active") {
    const vncAlive = lease.vncPort > 0 && !(await isPortFree(lease.vncPort));
    const webAlive = lease.webPort > 0 && !(await isPortFree(lease.webPort));
    if (!vncAlive || !webAlive) {
      lease.status = "terminated";
      lease.expiredAt = Date.now();
      lease.connected = false;
      lease.connectedCount = 0;
      lease.pendingClients = {};
      lease.activeClients = {};
      lease.connectionEvents.push({ at: Date.now(), type: "restore_terminated", reason: "ports_not_alive" });
    } else if (!lease.connected) {
      lease.idleDeadline = Date.now() + config.idleTtlSeconds * 1000;
      lease.connectionEvents.push({ at: Date.now(), type: "restore_active" });
    } else {
      lease.connectionEvents.push({ at: Date.now(), type: "restore_active" });
    }
    markBrokerStateDirty();
  }

  return lease;
}

function hydrateProcesses(rawProcesses) {
  return arrayValue(rawProcesses)
    .map((rawProcess) => ({
      pid: Number(rawProcess?.pid),
      command: rawProcess?.command || "",
      args: arrayValue(rawProcess?.args),
      recovered: true,
      exitCode: null,
      signalCode: null,
    }))
    .filter((proc) => Number.isInteger(proc.pid) && proc.pid > 0);
}

function advanceAllocatorsFromLease(lease) {
  if (lease.vncPort >= nextVncPort) nextVncPort = lease.vncPort + 1;
  if (lease.internalVncPort >= nextVncPort) nextVncPort = lease.internalVncPort + 1;
  if (lease.webPort >= nextWebPort) nextWebPort = lease.webPort + 1;
  const cdpPort = Number(lease.networkPlugin?.cdpPort || 0);
  const proxyPort = Number(lease.networkPlugin?.proxyPort || 0);
  if (cdpPort >= nextCdpPort) nextCdpPort = cdpPort + 1;
  if (proxyPort >= nextProxyPort) nextProxyPort = proxyPort + 1;
  const displayMatch = String(lease.display || "").match(/^:(\d+)$/);
  if (displayMatch) {
    const displayNumber = Number(displayMatch[1]);
    if (displayNumber >= nextDisplay) nextDisplay = displayNumber + 1;
  }
}

function markBrokerStateDirty() {
  brokerStateDirty = true;
}

function persistBrokerStateNow() {
  if (!brokerStateDirty) return;
  const state = {
    version: 1,
    savedAt: Date.now(),
    tokens: [...tokens.values()].map(serializeToken),
    leases: [...leases.values()].map(serializeLease),
  };
  try {
    fs.mkdirSync(path.dirname(config.brokerStateFile), { recursive: true });
    const tmpPath = `${config.brokerStateFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
    fs.renameSync(tmpPath, config.brokerStateFile);
    brokerStateDirty = false;
  } catch (error) {
    brokerStateDirty = true;
    console.error(`failed to write broker state: ${error.message}`);
  }
}

function serializeToken(token) {
  return {
    token: token.token,
    userId: token.userId,
    quotaSeconds: token.quotaSeconds,
    maxConnections: token.maxConnections,
    networkProfile: token.networkProfile,
    warnings: token.warnings || [],
    launchProfile: token.launchProfile,
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    status: token.status,
    redeemedAt: token.redeemedAt || null,
    redeemedBy: token.redeemedBy || null,
  };
}

function serializeLease(lease) {
  return {
    id: lease.id,
    token: lease.token,
    userId: lease.userId,
    status: lease.status,
    transport: lease.transport || legacyTransportState(),
    display: lease.display,
    vncPort: lease.vncPort,
    internalVncPort: lease.internalVncPort,
    webPort: lease.webPort,
    password: lease.password,
    passFile: lease.passFile,
    logPath: lease.logPath,
    admissionLogPath: lease.admissionLogPath,
    acceptScriptPath: lease.acceptScriptPath,
    dir: lease.dir,
    chromeProfileDir: lease.chromeProfileDir || null,
    processes: lease.processes.map(serializeProcess).filter(Boolean),
    maxConnections: lease.maxConnections,
    networkPlugin: lease.networkPlugin,
    warnings: lease.warnings || [],
    launchProfile: lease.launchProfile,
    issuedAt: lease.issuedAt,
    lastTickAt: lease.lastTickAt,
    connected: lease.connected,
    connectedCount: lease.connectedCount,
    connectionState: normalizeConnectionState(lease.connectionState),
    pendingClients: lease.pendingClients,
    activeClients: lease.activeClients,
    connectedSince: lease.connectedSince,
    lastDisconnectAt: lease.lastDisconnectAt,
    remainingSeconds: lease.remainingSeconds,
    idleDeadline: lease.idleDeadline,
    viewerToken: lease.viewerToken,
    connectionEvents: lease.connectionEvents.slice(-200),
    lastLogSize: lease.lastLogSize,
    lastAdmissionLogSize: lease.lastAdmissionLogSize,
    expiredAt: lease.expiredAt || null,
  };
}

function serializeProcess(proc) {
  if (!proc || !Number.isInteger(proc.pid) || proc.pid <= 0) return null;
  const spawnArgs = Array.isArray(proc.spawnargs) ? proc.spawnargs : [];
  return {
    pid: proc.pid,
    command: proc.spawnfile || proc.command || spawnArgs[0] || "",
    args: proc.args || spawnArgs.slice(1),
    recovered: Boolean(proc.recovered),
  };
}

function scanX11vncLog(lease) {
  if (!fs.existsSync(lease.logPath)) return;
  const stat = fs.statSync(lease.logPath);
  if (stat.size < lease.lastLogSize) lease.lastLogSize = 0;
  if (stat.size === lease.lastLogSize) return;

  const fd = fs.openSync(lease.logPath, "r");
  const buffer = Buffer.alloc(stat.size - lease.lastLogSize);
  fs.readSync(fd, buffer, 0, buffer.length, lease.lastLogSize);
  fs.closeSync(fd);
  lease.lastLogSize = stat.size;

  for (const line of buffer.toString("utf8").split(/\r?\n/)) {
    const pendingMatch = line.match(/Got connection from client ([^\s]+)/);
    if (pendingMatch) {
      const client = pendingMatch[1];
      incrementClient(lease.pendingClients, client);
      lease.connectionEvents.push({ at: Date.now(), type: "pending_connect", client, line });
      markBrokerStateDirty();
    }

    const authenticatedMatch =
      line.match(/Pixel format for client ([^:]+):/) ||
      line.match(/Using \S+ encoding for client ([^\s]+)/) ||
      line.match(/Switching from \S+ to \S+ Encoding for client ([^\s]+)/);
    if (authenticatedMatch) {
      activateClient(lease, authenticatedMatch[1], line);
    }

    const goneMatch = line.match(/Client ([^\s]+) gone/);
    if (goneMatch) {
      disconnectClient(lease, goneMatch[1], line);
    }

    const countMatch = line.match(/client_count:\s+(\d+)/);
    if (countMatch && Number(countMatch[1]) === 0) {
      lease.pendingClients = {};
      lease.activeClients = {};
      updateConnectedState(lease);
      markBrokerStateDirty();
    }
  }
}

function scanAdmissionLog(lease) {
  if (!fs.existsSync(lease.admissionLogPath)) return;
  const stat = fs.statSync(lease.admissionLogPath);
  if (stat.size < lease.lastAdmissionLogSize) lease.lastAdmissionLogSize = 0;
  if (stat.size === lease.lastAdmissionLogSize) return;

  const fd = fs.openSync(lease.admissionLogPath, "r");
  const buffer = Buffer.alloc(stat.size - lease.lastAdmissionLogSize);
  fs.readSync(fd, buffer, 0, buffer.length, lease.lastAdmissionLogSize);
  fs.closeSync(fd);
  lease.lastAdmissionLogSize = stat.size;

  for (const line of buffer.toString("utf8").split(/\r?\n/)) {
    if (!line) continue;
    const event = parseAdmissionLine(line);
    if (!event) continue;
    lease.connectionEvents.push({ at: Date.now(), ...event, line });
    markBrokerStateDirty();
  }
}

function parseAdmissionLine(line) {
  const fields = {};
  for (const part of line.split(/\s+/)) {
    const [key, ...rest] = part.split("=");
    if (!key || !rest.length) continue;
    fields[key] = rest.join("=");
  }
  if (fields.type !== "reject") return null;
  return {
    type: "connection_rejected",
    client: fields.client || "",
    connectedCount: Number(fields.count || 0),
    maxConnections: Number(fields.limit || 0),
  };
}

function activateClient(lease, client, line) {
  if ((lease.activeClients[client] || 0) > 0 && (lease.pendingClients[client] || 0) === 0) {
    return;
  }
  decrementClient(lease.pendingClients, client);
  incrementClient(lease.activeClients, client);
  updateConnectedState(lease);
  lease.connectionEvents.push({ at: Date.now(), type: "connect", client, line });
  markBrokerStateDirty();
}

function writeAcceptScript(scriptPath, admissionLogPath, maxConnections) {
  const script = `#!/bin/sh
limit=${Math.max(1, Math.floor(maxConnections))}
count="\${RFB_CLIENT_COUNT:-0}"
client="\${RFB_CLIENT_IP:-unknown}:\${RFB_CLIENT_PORT:--1}"
case "$count" in
  ''|*[!0-9]*) count=0 ;;
esac
if [ "$count" -ge "$limit" ]; then
  printf '%s type=reject client=%s count=%s limit=%s state=%s\\n' "$(date -Is)" "$client" "$count" "$limit" "\${RFB_STATE:-UNKNOWN}" >> ${shellQuote(admissionLogPath)}
  exit 1
fi
printf '%s type=accept client=%s count=%s limit=%s state=%s\\n' "$(date -Is)" "$client" "$count" "$limit" "\${RFB_STATE:-UNKNOWN}" >> ${shellQuote(admissionLogPath)}
exit 0
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
}

function disconnectClient(lease, client, line) {
  const wasActive = (lease.activeClients[client] || 0) > 0;
  if (wasActive) {
    decrementClient(lease.activeClients, client);
  } else {
    decrementClient(lease.pendingClients, client);
  }
  updateConnectedState(lease);
  lease.connectionEvents.push({
    at: Date.now(),
    type: wasActive ? "disconnect" : "pending_disconnect",
    client,
    line,
  });
  markBrokerStateDirty();
}

function incrementClient(clients, client) {
  clients[client] = (clients[client] || 0) + 1;
}

function decrementClient(clients, client) {
  if (!clients[client]) return;
  clients[client] -= 1;
  if (clients[client] <= 0) delete clients[client];
}

async function prepareSessionPlugin(rawProfile, leaseId, dir) {
  const profile = normalizeNetworkProfile(rawProfile);
  const publicState = {
    id: profile.id,
    label: networkProfileLabel(profile.id),
    enabled: profile.id !== "none",
    status: profile.id === "none" ? "disabled" : "enabled",
    headerKeys: Object.keys(profile.headers),
    proxyMappings: profile.proxyMappings || [],
  };

  if (profile.id === "none") {
    return { chromeArgs: [], sidecarConfigPath: null, proxyConfigPath: null, publicState };
  }

  if (profile.id !== "header-proxy") {
    throw new Error(`unknown_network_profile:${profile.id}`);
  }

  const cdpPort = await allocatePort("cdp");
  const sidecarConfigPath = path.join(dir, "cdp-sidecar.json");
  const sidecarLogPath = path.join(dir, "cdp-sidecar.log");
  const chromeArgs = [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
  ];
  let proxyConfigPath = null;
  let proxyPort = null;
  let proxyLogPath = null;

  if (profile.proxyMappings.length > 0) {
    proxyPort = await allocatePort("proxy");
    proxyConfigPath = path.join(dir, "network-proxy.json");
    proxyLogPath = path.join(dir, "network-proxy.log");
    fs.writeFileSync(proxyConfigPath, JSON.stringify({
      leaseId,
      listenHost: "127.0.0.1",
      listenPort: proxyPort,
      mappings: profile.proxyMappings,
      logPath: proxyLogPath,
    }, null, 2));
    chromeArgs.push(`--proxy-server=http://127.0.0.1:${proxyPort}`);
  }

  fs.writeFileSync(sidecarConfigPath, JSON.stringify({
    leaseId,
    cdpPort,
    headers: profile.headers,
    urlRewriteMappings: profile.proxyMappings,
    logPath: sidecarLogPath,
    pollMs: 1000,
  }, null, 2));

  return {
    chromeArgs,
    sidecarConfigPath,
    proxyConfigPath,
    publicState: {
      ...publicState,
      status: "enabled",
      cdpPort,
      logPath: sidecarLogPath,
      proxyPort,
      proxyLogPath,
    },
  };
}

function normalizeNetworkProfile(input = {}) {
  return normalizeNetworkProfileWithWarnings(input).profile;
}

function normalizeNetworkProfileWithWarnings(input = {}) {
  const warnings = [];
  const id = normalizeNetworkProfileId(input?.id);
  if (id === "none" || id === "default") {
    return { profile: { id: "none", headers: {}, proxyMappings: [] }, warnings };
  }
  if (id !== "header-proxy") {
    throw new Error(`unknown_network_profile:${id}`);
  }
  const headers = sanitizeHeaders(input.headers || {}, warnings);
  const proxyMappings = normalizeProxyMappings(input.proxyMappings || [], warnings);
  return { profile: { id, headers, proxyMappings }, warnings };
}

function normalizeNetworkProfileId(value) {
  const id = String(value || "none");
  if (id === "ppe-header-proxy") return "header-proxy";
  return id;
}

function normalizeProxyMappings(input = [], warnings = []) {
  if (!Array.isArray(input)) {
    warnings.push({
      code: "invalid_proxy_mappings",
      field: "proxyMappings",
      message: "proxyMappings must be an array",
    });
    return [];
  }
  return input
    .map((entry, index) => normalizeProxyMapping(entry, warnings, index))
    .filter(Boolean);
}

function normalizeProxyMapping(entry, warnings = [], index = 0) {
  if (!entry || typeof entry !== "object") {
    warnings.push({
      code: "invalid_proxy_mapping",
      field: "proxyMappings",
      index,
      message: "proxy mapping must be an object",
    });
    return null;
  }
  const from = parseRouteEndpoint(entry.from || {
    host: entry.fromHost,
    port: entry.fromPort,
    path: entry.fromPath,
    protocol: entry.fromProtocol,
  }, { side: "from" });
  const to = parseRouteEndpoint(entry.to || {
    host: entry.toHost,
    port: entry.toPort,
    path: entry.toPath,
    protocol: entry.toProtocol,
  }, { side: "to" });
  if (!from || !from.host) {
    warnings.push({
      code: "invalid_proxy_mapping_from",
      field: "proxyMappings",
      index,
      value: entry.from,
      message: "proxy mapping from is invalid",
    });
    return null;
  }
  if (!to || !to.host) {
    warnings.push({
      code: "invalid_proxy_mapping_to",
      field: "proxyMappings",
      index,
      value: entry.to,
      message: "proxy mapping to is invalid",
    });
    return null;
  }
  return {
    from: formatRouteEndpoint(from),
    to: formatRouteEndpoint(to),
    fromProtocol: from.protocol,
    fromHost: from.host,
    fromPort: from.port,
    fromPath: from.path,
    toProtocol: to.protocol || "http",
    toHost: to.host,
    toPort: to.port || (to.protocol === "https" ? 443 : 80),
    toPath: to.path,
    preserveHost: entry.preserveHost !== false,
  };
}

function parseRouteEndpoint(value, options = {}) {
  if (typeof value === "object" && value !== null) {
    const host = String(value.host || "").trim();
    if (!host) return null;
    const protocol = normalizeRouteProtocol(value.protocol);
    return {
      protocol,
      host,
      port: normalizeOptionalPort(value.port),
      path: normalizeRoutePath(value.path),
    };
  }

  const raw = String(value || "").trim();
  if (!raw) return null;
  const hasProtocol = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw);
  const parseValue = hasProtocol ? raw : `route://${raw}`;
  try {
    const url = new URL(parseValue);
    const protocol = hasProtocol ? normalizeRouteProtocol(url.protocol.slice(0, -1)) : null;
    const rawWithoutProtocol = hasProtocol ? raw.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "") : raw;
    const hasExplicitPath = rawWithoutProtocol.includes("/");
    const port = url.port ? Number(url.port) : defaultRoutePort(protocol, options.side);
    return {
      protocol,
      host: url.hostname,
      port,
      path: hasExplicitPath ? normalizeRoutePath(`${url.pathname}${url.search}`) : "",
    };
  } catch {
    return null;
  }
}

function normalizeRouteProtocol(protocol) {
  const value = String(protocol || "").toLowerCase();
  if (value === "http" || value === "https") return value;
  return null;
}

function defaultRoutePort(protocol, side) {
  if (protocol === "http") return 80;
  if (protocol === "https") return 443;
  return side === "to" ? 80 : null;
}

function normalizeOptionalPort(value) {
  if (value === null || value === undefined || value === "") return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function normalizeRoutePath(value) {
  const pathValue = String(value || "").trim();
  if (!pathValue) return "";
  return pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
}

function formatRouteEndpoint(endpoint) {
  const port = endpoint.port ? `:${endpoint.port}` : "";
  return `${endpoint.host}${port}${endpoint.path || ""}`;
}

function sanitizeHeaders(headers, warnings = []) {
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(headers || {})) {
    const key = String(rawKey).trim();
    const value = String(rawValue ?? "");
    if (!key) {
      warnings.push({
        code: "empty_header_key",
        field: "headers",
        key: rawKey,
        message: "header key is empty",
      });
      continue;
    }
    if (/[\r\n]/.test(key) || /[\r\n]/.test(value)) {
      warnings.push({
        code: "invalid_header_newline",
        field: "headers",
        key,
        message: "header key/value must not contain newlines",
      });
      continue;
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(key)) {
      warnings.push({
        code: "invalid_header_key",
        field: "headers",
        key,
        message: "header key contains unsupported characters",
      });
      continue;
    }
    result[key] = value;
  }
  return result;
}

function networkProfileLabel(id) {
  if (id === "header-proxy") return "Header proxy";
  return "No network plugin";
}

function pluginSchemas() {
  return {
    networkProfiles: [
      {
        id: "none",
        labelKey: "network.none",
        fields: [],
      },
      {
        id: "header-proxy",
        labelKey: "network.headerProxy",
        fields: [
          {
            name: "headers",
            type: "keyValueList",
            labelKey: "home.networkHeaders",
            keyLabelKey: "plugin.headerKey",
            valueLabelKey: "plugin.headerValue",
            addLabelKey: "plugin.addHeader",
            default: [
              { key: "x-example-header", value: "1" },
            ],
            validation: {
              keyPattern: "^[A-Za-z0-9._:-]+$",
              disallowNewlines: true,
            },
          },
          {
            name: "proxyMappings",
            type: "routeMappingList",
            labelKey: "home.networkProxyMappings",
            fromLabelKey: "plugin.routeFrom",
            toLabelKey: "plugin.routeTo",
            preserveHostLabelKey: "plugin.preserveHost",
            addLabelKey: "plugin.addMapping",
            noteKey: "plugin.mappingNote",
            default: [],
            validation: {
              allowHttpsPath: true,
            },
          },
        ],
      },
    ],
  };
}

function normalizeLaunchProfile(input) {
  if (!input) {
    return { id: "fallback-command" };
  }
  const id = String(input.id || "fallback-command");
  if (id === "fallback-command") {
    return { id };
  }
  if (id === "blank-chrome") {
    return { id, url: "about:blank" };
  }
  if (id === "chrome-url") {
    return { id, url: normalizeLaunchUrl(input.url || "about:blank") };
  }
  throw new Error(`unknown_launch_profile:${id}`);
}

function normalizeLaunchUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "about:blank";
  if (raw === "about:blank") return raw;
  const parsed = new URL(raw);
  if (!["http:", "https:", "file:", "about:"].includes(parsed.protocol)) {
    throw new Error("unsupported_launch_url_scheme");
  }
  return parsed.href;
}

function buildSessionCommand(launchProfile, options = {}) {
  const profile = normalizeLaunchProfile(launchProfile);
  if (profile.id === "fallback-command") return config.sessionCommand;
  if (profile.id === "blank-chrome" || profile.id === "chrome-url") {
    const url = profile.id === "blank-chrome" ? "about:blank" : profile.url;
    const profileArg = options.chromeProfileDir
      ? `--user-data-dir=${shellQuote(options.chromeProfileDir)}`
      : "--user-data-dir=/tmp/vnc-chrome-$DISPLAY";
    return [
      "google-chrome",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-fre",
      "--ozone-platform=x11",
      profileArg,
      "--window-position=0,0",
      `--window-size=${config.chromeWindowSize}`,
      "--new-window",
      shellQuote(url),
    ].join(" ");
  }
  throw new Error(`unknown_launch_profile:${profile.id}`);
}

function prepareChromeProfileDir(dir) {
  if (!config.chromeProfileTemplateDir) return null;
  const templateDir = path.resolve(config.chromeProfileTemplateDir);
  if (!fs.existsSync(templateDir) || !fs.statSync(templateDir).isDirectory()) {
    throw new Error(`chrome_profile_template_not_found:${templateDir}`);
  }
  const profileDir = path.join(dir, "chrome-profile");
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  runChecked("cp", ["-a", "--reflink=auto", `${templateDir}${path.sep}.`, profileDir]);
  for (const lockName of ["SingletonCookie", "SingletonLock", "SingletonSocket"]) {
    fs.rmSync(path.join(profileDir, lockName), { force: true });
  }
  return profileDir;
}

function cleanupChromeProfileDir(lease) {
  if (!lease.chromeProfileDir) return;
  const profileDir = path.resolve(lease.chromeProfileDir);
  const leaseDir = path.resolve(lease.dir);
  if (!profileDir.startsWith(`${leaseDir}${path.sep}`)) return;
  fs.rm(profileDir, { recursive: true, force: true }, (error) => {
    if (error) console.error(`failed to remove chrome profile ${profileDir}: ${error.message}`);
  });
}

function launchProfileLabel(profile) {
  if (!profile || profile.id === "fallback-command") return "Fallback command";
  if (profile.id === "blank-chrome") return "Blank Chrome";
  if (profile.id === "chrome-url") return "Chrome URL";
  return profile.id;
}

function getUserSessionDefaults(userId) {
  const defaults = readSessionDefaults();
  return {
    ...(defaults.default || {}),
    ...(defaults.users?.[userId] || {}),
  };
}

function publicSessionDefaults(rawUserId) {
  const userId = decodeURIComponent(rawUserId || "");
  const defaults = getUserSessionDefaults(userId);
  return {
    userId,
    quotaSeconds: intValue(defaults.quotaSeconds, config.defaultQuotaSeconds),
    maxConnections: intValue(defaults.maxConnections, config.defaultMaxConnections),
    networkProfile: normalizeNetworkProfile(defaults.networkProfile),
    launchProfile: normalizeLaunchProfile(defaults.launchProfile),
  };
}

function saveUserSessionDefaults(rawUserId, input = {}) {
  const userId = decodeURIComponent(rawUserId || "").trim();
  if (!userId) throw new Error("invalid_user_id");
  const defaults = readSessionDefaults();
  const networkProfileResult = normalizeNetworkProfileWithWarnings(input.networkProfile);
  const entry = {
    quotaSeconds: intValue(input.quotaSeconds, config.defaultQuotaSeconds),
    maxConnections: intValue(input.maxConnections, config.defaultMaxConnections),
    launchProfile: normalizeLaunchProfile(input.launchProfile),
    networkProfile: networkProfileResult.profile,
  };
  const nextDefaults = {
    ...defaults,
    users: {
      ...(defaults.users || {}),
      [userId]: entry,
    },
  };
  writeSessionDefaults(nextDefaults);
  return {
    userId,
    ...entry,
    warnings: networkProfileResult.warnings,
  };
}

function readSessionDefaults() {
  if (!fs.existsSync(config.sessionDefaultsFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(config.sessionDefaultsFile, "utf8"));
  } catch (error) {
    console.error(`failed to read session defaults: ${error.message}`);
    return {};
  }
}

function writeSessionDefaults(defaults) {
  fs.mkdirSync(path.dirname(config.sessionDefaultsFile), { recursive: true });
  const tmpPath = `${config.sessionDefaultsFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(defaults, null, 2)}\n`);
  fs.renameSync(tmpPath, config.sessionDefaultsFile);
}

function writeChromeLaunchWrappers(dir, chromeArgs) {
  const binaries = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const binary of binaries) {
    const realPath = findExecutable(binary, dir);
    if (!realPath) continue;
    const wrapperPath = path.join(dir, binary);
    const args = chromeArgs.map(shellQuote).join(" ");
    fs.writeFileSync(wrapperPath, `#!/bin/sh\nexec ${shellQuote(realPath)} ${args} "$@"\n`, { mode: 0o700 });
  }
}

function findExecutable(binary, excludeDir) {
  const paths = (process.env.PATH || "").split(path.delimiter).filter((entry) => entry && entry !== excludeDir);
  for (const entry of paths) {
    const candidate = path.join(entry, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching.
    }
  }
  return null;
}

function updateConnectedState(lease) {
  lease.connectedCount = Object.values(lease.activeClients)
    .reduce((sum, count) => sum + count, 0);
  const connected = lease.connectedCount > 0;
  if (connected && !lease.connected) {
    lease.connectedSince = Date.now();
  }
  if (!connected && lease.connected) {
    lease.connectedSince = null;
    lease.lastDisconnectAt = Date.now();
  }
  lease.connected = connected;
}

function expireLease(lease, reason) {
  if (lease.status !== "active") return;
  closeViewerGatewayClients(lease, closeCodeForLeaseReason(reason), reason);
  lease.status = reason;
  lease.expiredAt = Date.now();
  lease.connected = false;
  lease.connectedCount = 0;
  lease.pendingClients = {};
  lease.activeClients = {};
  lease.connectionEvents.push({ at: Date.now(), type: "expire", reason });
  markBrokerStateDirty();
  persistBrokerStateNow();
  for (const proc of lease.processes) {
    killProcess(proc, "SIGTERM");
  }
  closeNativeGatewayServer(lease);
  setTimeout(() => {
    for (const proc of lease.processes) {
      killProcess(proc, "SIGKILL");
    }
    cleanupChromeProfileDir(lease);
  }, 3000).unref();
}

function closeNativeGatewayServer(lease) {
  if (!lease.nativeGatewayServer) return;
  try {
    lease.nativeGatewayServer.close();
  } catch {
    // Server may already be closed.
  }
  lease.nativeGatewayServer = null;
}

function closeViewerGatewayClients(lease, code, reason) {
  for (const client of lease.viewerGatewayClients || []) {
    client.close(code, reason);
  }
}

function closeCodeForLeaseReason(reason) {
  if (reason === "quota_exhausted") return 4003;
  if (reason === "idle_timeout") return 4005;
  return 4002;
}

function killProcess(proc, signal) {
  try {
    if (proc.exitCode === null && proc.signalCode === null) process.kill(-proc.pid, signal);
  } catch {
    try {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill(signal);
    } catch {
      // Process may already be gone.
    }
  }
}

async function allocatePort(kind) {
  let port = kind === "vnc"
    ? nextVncPort
    : kind === "web"
      ? nextWebPort
      : kind === "cdp"
        ? nextCdpPort
        : nextProxyPort;
  while (!(await isPortFree(port))) port += 1;
  if (kind === "vnc") nextVncPort = port + 1;
  else if (kind === "web") nextWebPort = port + 1;
  else if (kind === "cdp") nextCdpPort = port + 1;
  else nextProxyPort = port + 1;
  return port;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    probe.listen(port, "0.0.0.0");
  });
}

async function assertLegacyVncListenSurface(proc, expected) {
  let sockets = [];
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`x11vnc_exited_before_listen:${proc.exitCode ?? proc.signalCode}`);
    }
    sockets = listeningTcpSocketsForPid(proc.pid);
    if (sockets.length > 0) break;
    await sleep(100);
  }

  if (sockets.length === 0) {
    throw new Error(`x11vnc_listen_surface_missing:${proc.pid}`);
  }

  const unexpected = sockets.filter((socket) => (
    socket.port !== expected.port || socket.host !== expected.host || isIpv6ListenAddress(socket.host)
  ));
  if (unexpected.length > 0) {
    throw new Error(`x11vnc_unexpected_listen_surface:${JSON.stringify(unexpected)}`);
  }
}

function listeningTcpSocketsForPid(pid) {
  const result = spawnSync("ss", ["-ltnpH"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ss_failed:${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes(`pid=${pid},`))
    .map(parseSsListenLine)
    .filter(Boolean);
}

function assertNativeGatewayListenSurface(server, expectedPort) {
  const address = server.address();
  if (!address || typeof address !== "object") {
    throw new Error("native_gateway_listen_surface_missing");
  }
  if (address.port !== expectedPort || address.address !== "0.0.0.0") {
    throw new Error(`native_gateway_unexpected_listen_surface:${JSON.stringify(address)}`);
  }
}

function parseSsListenLine(line) {
  const columns = line.split(/\s+/);
  if (columns.length < 4) return null;
  const local = columns[3];
  const parsed = parseLocalAddress(local);
  if (!parsed) return null;
  return {
    host: parsed.host,
    port: parsed.port,
    raw: local,
  };
}

function parseLocalAddress(local) {
  if (local.startsWith("[")) {
    const end = local.lastIndexOf("]:");
    if (end === -1) return null;
    return {
      host: local.slice(1, end),
      port: Number(local.slice(end + 2)),
    };
  }
  const separator = local.lastIndexOf(":");
  if (separator === -1) return null;
  return {
    host: local.slice(0, separator),
    port: Number(local.slice(separator + 1)),
  };
}

function isIpv6ListenAddress(host) {
  return host.includes(":") || host === "::" || host === "*";
}

function startProcess(command, args, options) {
  const log = fs.createWriteStream(options.logPath, { flags: "a" });
  log.on("error", (error) => {
    console.error(`failed to write process log ${options.logPath}: ${error.message}`);
  });
  const proc = spawn(command, args, {
    cwd: __dirname,
    env: { ...process.env, ...(options.env || {}) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.pipe(log, { end: false });
  proc.stderr.pipe(log, { end: false });
  proc.on("exit", (code, signal) => {
    if (!log.destroyed) {
      log.write(`\n[broker] ${command} exited code=${code} signal=${signal}\n`);
    }
  });
  return proc;
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
  }
}

function acceptWebSocket(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key) throw new Error("websocket_key_missing");
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "Sec-WebSocket-Protocol: binary",
    "\r\n",
  ].join("\r\n"));
  return new WebSocketRfbPeer(socket, head);
}

async function runViewerRfbGateway(lease, ws) {
  let backend = null;
  let backendReader = null;
  const clientRecord = {
    close: (code, reason) => {
      ws.close(code, reason);
      if (backend) backend.socket.destroy();
    },
  };

  try {
    const validation = validateViewerGatewayLease(lease);
    if (!validation.ok) {
      ws.close(closeCodeForGatewayReason(validation.reason), validation.reason);
      return;
    }

    lease.viewerGatewayPending = (lease.viewerGatewayPending || 0) + 1;
    await handshakeRfbClient(ws);
    backend = await connectRfbBackend(lease);
    backendReader = backend.reader;
    await authenticateRfbBackend(backend.socket, backendReader, lease.password);
    const clientInit = await ws.readBytes(1);
    backend.socket.write(clientInit);
    const serverInit = await readRfbServerInit(backendReader);
    ws.send(serverInit);

    lease.viewerGatewayPending = Math.max(0, (lease.viewerGatewayPending || 1) - 1);
    lease.viewerGatewayClients.add(clientRecord);
    lease.connectionEvents.push({ at: Date.now(), type: "viewer_gateway_connect" });
    markBrokerStateDirty();

    const filter = new RfbReadOnlyClientFilter((chunk) => backend.socket.write(chunk), () => {
      ws.close(1002, "rfb_client_protocol_error");
      backend.socket.destroy();
    });
    ws.startStreaming((chunk) => filter.push(chunk));
    backendReader.startStreaming((chunk) => ws.send(filterServerCutText(chunk)));
    backend.socket.on("close", () => ws.close(1011, "rfb_backend_error"));
    backend.socket.on("error", () => ws.close(1011, "rfb_backend_error"));
    ws.onClose = () => {
      backend.socket.destroy();
      lease.viewerGatewayClients.delete(clientRecord);
      lease.connectionEvents.push({ at: Date.now(), type: "viewer_gateway_disconnect" });
      markBrokerStateDirty();
    };
  } catch (error) {
    lease.viewerGatewayPending = Math.max(0, (lease.viewerGatewayPending || 1) - 1);
    lease.viewerGatewayClients.delete(clientRecord);
    if (backend) backend.socket.destroy();
    if (!ws.closed) ws.close(1011, "gateway_error");
    throw error;
  }
}

function closeCodeForGatewayReason(reason) {
  if (reason === "token_invalid") return 4001;
  if (reason === "quota_exhausted") return 4003;
  if (reason === "capacity_exceeded") return 4004;
  return 4002;
}

async function handshakeRfbClient(ws) {
  ws.send(Buffer.from("RFB 003.008\n", "ascii"));
  await ws.readBytes(12);
  ws.send(Buffer.from([1, 1]));
  const selected = await ws.readBytes(1);
  if (selected[0] !== 1) throw new Error("rfb_client_rejected_none_security");
  const securityResult = Buffer.alloc(4);
  securityResult.writeUInt32BE(0, 0);
  ws.send(securityResult);
}

function connectRfbBackend(lease) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(lease.internalVncPort || lease.vncPort, "127.0.0.1");
    const reader = new SocketByteReader(socket);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("rfb_backend_connect_timeout"));
    }, 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve({ socket, reader });
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function authenticateRfbBackend(socket, reader, password) {
  const protocol = await reader.readBytes(12);
  socket.write(protocol);

  if (protocol.includes(Buffer.from("003.003"))) {
    const securityType = (await reader.readBytes(4)).readUInt32BE(0);
    if (securityType !== 2) throw new Error(`rfb_backend_security_unsupported:${securityType}`);
  } else {
    const securityCount = (await reader.readBytes(1))[0];
    if (securityCount === 0) {
      const reasonLength = (await reader.readBytes(4)).readUInt32BE(0);
      const reason = (await reader.readBytes(reasonLength)).toString("utf8");
      throw new Error(`rfb_backend_security_failed:${reason}`);
    }
    const securityTypes = await reader.readBytes(securityCount);
    if (!securityTypes.includes(2)) {
      throw new Error(`rfb_backend_vncauth_unavailable:${[...securityTypes].join(",")}`);
    }
    socket.write(Buffer.from([2]));
  }

  const challenge = await reader.readBytes(16);
  socket.write(vncAuthResponse(password, challenge));
  const authResult = (await reader.readBytes(4)).readUInt32BE(0);
  if (authResult !== 0) throw new Error(`rfb_backend_auth_failed:${authResult}`);

}

async function readRfbServerInit(reader) {
  const serverInitHeader = await reader.readBytes(24);
  const nameLength = serverInitHeader.readUInt32BE(20);
  const name = nameLength > 0 ? await reader.readBytes(nameLength) : Buffer.alloc(0);
  return Buffer.concat([serverInitHeader, name]);
}

function vncAuthResponse(password, challenge) {
  const key = Buffer.alloc(8);
  Buffer.from(String(password).slice(0, 8), "binary").copy(key);
  for (let index = 0; index < key.length; index += 1) {
    key[index] = reverseBits(key[index]);
  }
  const cipher = des.DES.create({ type: "encrypt", key, padding: false });
  return Buffer.from(cipher.update(challenge));
}

function reverseBits(byte) {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    reversed = (reversed << 1) | ((byte >> bit) & 1);
  }
  return reversed;
}

function filterServerCutText(chunk) {
  return chunk;
}

class RfbReadOnlyClientFilter {
  constructor(write, fail) {
    this.write = write;
    this.fail = fail;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length > 0) {
      const message = this.nextMessage();
      if (!message) return;
      this.buffer = this.buffer.subarray(message.length);
      if (message.allowed) this.write(message.data);
    }
  }

  nextMessage() {
    const type = this.buffer[0];
    if (type === 0) return this.fixedMessage(20, true);
    if (type === 2) {
      if (this.buffer.length < 4) return null;
      return this.fixedMessage(4 + this.buffer.readUInt16BE(2) * 4, true);
    }
    if (type === 3) return this.fixedMessage(10, true);
    if (type === 4) return this.fixedMessage(8, false);
    if (type === 5) return this.fixedMessage(6, false);
    if (type === 6) {
      if (this.buffer.length < 8) return null;
      return this.fixedMessage(8 + this.buffer.readUInt32BE(4), false);
    }
    this.fail();
    this.buffer = Buffer.alloc(0);
    return null;
  }

  fixedMessage(length, allowed) {
    if (this.buffer.length < length) return null;
    return {
      length,
      allowed,
      data: this.buffer.subarray(0, length),
    };
  }
}

class SocketByteReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    this.streaming = null;
    this.onData = (chunk) => this.push(chunk);
    socket.on("data", this.onData);
  }

  readBytes(length) {
    if (this.buffer.length >= length) return Promise.resolve(this.take(length));
    return new Promise((resolve, reject) => {
      this.waiters.push({ length, resolve, reject });
    });
  }

  startStreaming(callback) {
    this.streaming = callback;
    if (this.buffer.length > 0) {
      const buffered = this.buffer;
      this.buffer = Buffer.alloc(0);
      callback(buffered);
    }
  }

  push(chunk) {
    if (this.streaming) {
      this.streaming(chunk);
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.flush();
  }

  flush() {
    while (this.waiters.length > 0 && this.buffer.length >= this.waiters[0].length) {
      const waiter = this.waiters.shift();
      waiter.resolve(this.take(waiter.length));
    }
  }

  take(length) {
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return out;
  }
}

class WebSocketRfbPeer {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.dataBuffer = Buffer.alloc(0);
    this.waiters = [];
    this.streaming = null;
    this.closed = false;
    this.onClose = null;
    this.fragmentOpcode = null;
    this.fragments = [];
    socket.on("data", (chunk) => this.parse(chunk));
    socket.on("close", () => this.markClosed());
    socket.on("error", () => this.markClosed());
    if (head?.length) this.parse(head);
  }

  readBytes(length) {
    if (this.dataBuffer.length >= length) return Promise.resolve(this.takeData(length));
    return new Promise((resolve, reject) => {
      this.waiters.push({ length, resolve, reject });
    });
  }

  startStreaming(callback) {
    this.streaming = callback;
    if (this.dataBuffer.length > 0) {
      const buffered = this.dataBuffer;
      this.dataBuffer = Buffer.alloc(0);
      callback(buffered);
    }
  }

  send(data) {
    if (this.closed) return;
    const payload = Buffer.from(data);
    const header = websocketFrameHeader(payload.length, 2);
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000, reason = "normal") {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(String(reason).slice(0, 120));
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.socket.write(Buffer.concat([websocketFrameHeader(payload.length, 8), payload]), () => {
      this.socket.end();
    });
    this.markClosed();
  }

  parse(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        if (high !== 0) {
          this.close(1009, "frame_too_large");
          return;
        }
        length = low;
        offset += 8;
      }
      if (!masked || length > 16 * 1024 * 1024) {
        this.close(1002, "bad_frame");
        return;
      }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      this.buffer = this.buffer.subarray(offset + length);
      this.handleFrame(opcode, fin, payload);
    }
  }

  handleFrame(opcode, fin, payload) {
    if (opcode === 8) {
      this.close(1000, "normal");
      return;
    }
    if (opcode === 9) {
      this.socket.write(Buffer.concat([websocketFrameHeader(payload.length, 10), payload]));
      return;
    }
    if (opcode === 10) return;
    if (opcode === 0) {
      if (!this.fragmentOpcode) {
        this.close(1002, "unexpected_continuation");
        return;
      }
      this.fragments.push(payload);
      if (fin) {
        const data = Buffer.concat(this.fragments);
        const originalOpcode = this.fragmentOpcode;
        this.fragmentOpcode = null;
        this.fragments = [];
        if (originalOpcode === 2) this.pushData(data);
      }
      return;
    }
    if (opcode !== 2) {
      this.close(1003, "binary_required");
      return;
    }
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      return;
    }
    this.pushData(payload);
  }

  pushData(payload) {
    if (this.streaming) {
      this.streaming(payload);
      return;
    }
    this.dataBuffer = Buffer.concat([this.dataBuffer, payload]);
    while (this.waiters.length > 0 && this.dataBuffer.length >= this.waiters[0].length) {
      const waiter = this.waiters.shift();
      waiter.resolve(this.takeData(waiter.length));
    }
  }

  takeData(length) {
    const out = this.dataBuffer.subarray(0, length);
    this.dataBuffer = this.dataBuffer.subarray(length);
    return out;
  }

  markClosed() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error("websocket_closed"));
    }
    if (this.onClose) this.onClose();
  }
}

function websocketFrameHeader(length, opcode) {
  if (length < 126) return Buffer.from([0x80 | opcode, length]);
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(length, 6);
  return header;
}

function publicLease(lease, role = "owner") {
  const macUrl = `vnc://${config.publicHost}:${lease.vncPort}`;
  const webUrl = buildNoVncUrl(lease);
  const result = {
    id: lease.id,
    userId: lease.userId,
    status: lease.status,
    display: lease.display,
    connected: lease.connected,
    connectedCount: lease.connectedCount,
    connectionState: normalizeConnectionState(lease.connectionState),
    transport: publicTransportState(lease, role),
    maxConnections: lease.maxConnections,
    remainingSeconds: Math.floor(lease.remainingSeconds),
    idleDeadline: lease.idleDeadline,
    launchProfile: role === "owner"
      ? {
          ...lease.launchProfile,
          label: launchProfileLabel(lease.launchProfile),
        }
      : {
          id: lease.launchProfile?.id || "fallback-command",
          label: launchProfileLabel(lease.launchProfile),
        },
    networkPlugin: role === "owner"
      ? lease.networkPlugin
      : viewerNetworkPluginState(lease.networkPlugin),
  };
  if (role === "owner") {
    result.vncPort = lease.vncPort;
    result.webPort = lease.webPort;
    result.webUrl = webUrl;
    result.macUrl = macUrl;
    result.password = lease.password;
    result.shareUrl = `http://${config.publicHost}:${config.controlPort}/share/${lease.viewerToken}`;
    result.viewerToken = lease.viewerToken;
    result.warnings = lease.warnings || [];
    result.events = lease.connectionEvents.slice(-20);
  }
  return result;
}

function buildNoVncUrl(lease) {
  const url = new URL(`http://${config.publicHost}:${lease.webPort}/vnc.html`);
  url.searchParams.set("host", config.publicHost);
  url.searchParams.set("port", String(lease.webPort));
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("resize", config.noVncResize);
  url.searchParams.set("quality", String(config.noVncQuality));
  url.searchParams.set("compression", String(config.noVncCompression));
  return url.toString();
}

function viewerNetworkPluginState(plugin) {
  if (!plugin) return null;
  return {
    id: plugin.id,
    label: plugin.label,
    enabled: plugin.enabled,
    status: plugin.status,
  };
}

function hydrateTransportState(rawLease) {
  const rawTransport = rawLease?.transport && typeof rawLease.transport === "object"
    ? rawLease.transport
    : legacyTransportState();
  const transport = {
    ...legacyTransportState(),
    ...rawTransport,
  };
  transport.id = String(transport.id || "legacy-vnc");
  transport.entries = normalizeTransportEntries(transport.entries);
  return transport;
}

function legacyTransportState() {
  return {
    id: "legacy-vnc",
    entries: [
      {
        kind: "native-vnc",
        label: "macOS Screen Sharing",
        viewerSafe: false,
        requiresOwnerAuth: true,
        credentialRef: "vncPassword",
      },
      {
        kind: "web-novnc",
        label: "noVNC",
        viewerSafe: false,
        requiresOwnerAuth: true,
        credentialRef: "vncPassword",
      },
      {
        kind: "web-novnc-readonly",
        label: "noVNC read-only",
        viewerSafe: true,
        requiresOwnerAuth: false,
        credentialRef: null,
      },
    ],
  };
}

function normalizeTransportEntries(entries) {
  const normalized = arrayValue(entries)
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      kind: String(entry.kind || "unknown"),
      label: String(entry.label || entry.kind || "Unknown"),
      viewerSafe: Boolean(entry.viewerSafe),
      requiresOwnerAuth: entry.requiresOwnerAuth !== false,
      credentialRef: entry.credentialRef ? String(entry.credentialRef) : null,
    }));
  return normalized.length > 0 ? normalized : legacyTransportState().entries;
}

function publicTransportState(lease, role) {
  const transport = hydrateTransportState({ transport: lease.transport });
  return {
    id: transport.id,
    entries: transport.entries.map((entry) => publicTransportEntry(lease, entry, role)),
  };
}

function publicTransportEntry(lease, entry, role) {
  const result = {
    kind: entry.kind,
    label: entry.label,
    viewerSafe: entry.viewerSafe,
    requiresOwnerAuth: entry.requiresOwnerAuth,
  };
  if (role !== "owner" && !entry.viewerSafe) return result;

  const url = transportEntryUrl(lease, entry.kind);
  if (url) result.url = url;
  if (role === "owner" && entry.credentialRef) result.credentialRef = entry.credentialRef;
  return result;
}

function transportEntryUrl(lease, kind) {
  if (kind === "native-vnc") return `vnc://${config.publicHost}:${lease.vncPort}`;
  if (kind === "web-novnc") return buildNoVncUrl(lease);
  if (kind === "web-novnc-readonly") return `http://${config.publicHost}:${config.controlPort}/share/${lease.viewerToken}/connect/web`;
  return null;
}

function normalizeConnectionState(state) {
  const raw = state && typeof state === "object" ? state : {};
  return {
    native: normalizeConnectionBucket(raw.native),
    web: normalizeConnectionBucket(raw.web),
    viewer: normalizeConnectionBucket(raw.viewer),
    total: normalizeConnectionBucket(raw.total),
  };
}

function normalizeConnectionBucket(bucket) {
  const raw = bucket && typeof bucket === "object" ? bucket : {};
  const connectedCount = nonNegativeNumber(raw.connectedCount, 0);
  return {
    connected: Boolean(raw.connected || connectedCount > 0),
    connectedCount,
  };
}

function adminAuthRequired() {
  return Boolean(config.adminPassword || config.adminToken);
}

function requireAdmin(req, res) {
  if (isAdminRequest(req)) return true;
  json(res, { error: "auth_required" }, 401);
  return false;
}

function isAdminRequest(req) {
  if (!adminAuthRequired()) return true;
  const authorization = req.headers.authorization || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer && config.adminToken && safeEqual(bearer[1], config.adminToken)) {
    return true;
  }

  const sid = parseCookies(req).admin_sid;
  if (!sid) return false;
  const session = adminSessions.get(sid);
  if (!session) return false;
  if (Date.now() > session.expiresAt) {
    adminSessions.delete(sid);
    return false;
  }
  return true;
}

function loginAdmin(req, res, body = {}) {
  if (!adminAuthRequired()) {
    return json(res, { authenticated: true, authRequired: false });
  }
  const password = String(body.password || "");
  if (!config.adminPassword || !safeEqual(password, config.adminPassword)) {
    return json(res, { error: "invalid_password" }, 401);
  }

  const sid = randomId(24);
  const maxAge = config.adminSessionTtlSeconds;
  adminSessions.set(sid, {
    createdAt: Date.now(),
    expiresAt: Date.now() + maxAge * 1000,
    userAgent: req.headers["user-agent"] || "",
  });
  pruneAdminSessions();
  setCookie(res, "admin_sid", sid, {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge,
  });
  return json(res, { authenticated: true, authRequired: true });
}

function pruneAdminSessions() {
  const now = Date.now();
  for (const [sid, session] of adminSessions.entries()) {
    if (now > session.expiresAt) adminSessions.delete(sid);
  }
}

function parseCookies(req) {
  const result = {};
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey) continue;
    result[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue.join("=") || "");
  }
  return result;
}

function setCookie(res, name, value, options = {}) {
  const attrs = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`];
  if (options.maxAge != null) attrs.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.path) attrs.push(`Path=${options.path}`);
  if (options.sameSite) attrs.push(`SameSite=${options.sameSite}`);
  if (options.httpOnly) attrs.push("HttpOnly");
  if (options.secure) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

function clearAdminCookie(res) {
  setCookie(res, "admin_sid", "", {
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    maxAge: 0,
  });
}

function safeEqual(a, b) {
  const left = crypto.createHash("sha256").update(String(a)).digest();
  const right = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

// Serves the built React app from web/dist with an SPA fallback to index.html.
function serveWeb(res, pathname, headOnly = false) {
  const root = config.webDistDir;
  const requested = path.normalize(path.join(root, decodeURIComponent(pathname)));
  const isFile = requested.startsWith(root) && fs.existsSync(requested) && fs.statSync(requested).isFile();
  const filePath = isFile ? requested : path.join(root, "index.html");
  if (!fs.existsSync(filePath)) {
    return json(res, {
      error: "web_ui_not_built",
      hint: "run: npm --prefix web install && npm --prefix web run build",
    }, 503);
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (headOnly) {
    return res.end();
  }
  fs.createReadStream(filePath).pipe(res);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) reject(new Error("request_too_large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
  });
}

function json(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value, null, 2));
}

function notFound(res) {
  json(res, { error: "not_found" }, 404);
}

function randomId(bytes) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function randomPassword() {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
}

function intEnv(name, fallback) {
  return intValue(process.env[name], fallback);
}

function boundedIntEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  const value = Math.floor(parsed);
  if (value < min || value > max) return fallback;
  return value;
}

function choiceEnv(name, fallback, choices) {
  const value = String(process.env[name] || "").trim();
  return choices.includes(value) ? value : fallback;
}

function argListEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) return [];
  return value.split(/\s+/).filter(Boolean);
}

function resolutionToWindowSize(resolution) {
  const match = String(resolution || "").match(/^(\d+)x(\d+)/);
  if (!match) return "1800,1100";
  return `${match[1]},${match[2]}`;
}

function intValue(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...value };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
