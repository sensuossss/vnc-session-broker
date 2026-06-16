import net from "node:net";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import des from "des.js";

const base = process.env.TEST_BASE_URL || "http://127.0.0.1:7070";
const adminPassword = process.env.TEST_ADMIN_PASSWORD || "";
let cookieHeader = "";

const post = async (path, body = {}) => {
  const response = await fetch(base + path, {
    method: "POST",
    headers: requestHeaders(true),
    body: JSON.stringify(body),
  });
  saveCookie(response);
  const data = await response.json();
  if (!response.ok) throw httpError(path, response.status, data);
  return data;
};

const get = async (path) => {
  const response = await fetch(base + path, {
    headers: requestHeaders(false),
  });
  saveCookie(response);
  const data = await response.json();
  if (!response.ok) throw httpError(path, response.status, data);
  return data;
};

const put = async (path, body = {}) => {
  const response = await fetch(base + path, {
    method: "PUT",
    headers: requestHeaders(true),
    body: JSON.stringify(body),
  });
  saveCookie(response);
  const data = await response.json();
  if (!response.ok) throw httpError(path, response.status, data);
  return data;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const assertX11VncListenSurface = (externalVncPort) => {
  const result = spawnSync("ss", ["-ltnpH"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`ss_failed:${result.stderr || result.stdout || result.status}`);
  }
  const x11vncSockets = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("x11vnc"))
    .map(parseSsListenLine)
    .filter(Boolean);
  if (!x11vncSockets.some((socket) => socket.host === "127.0.0.1" && socket.port !== externalVncPort)) {
    throw new Error("x11vnc_expected_listener_missing");
  }
  const unexpected = x11vncSockets.filter((socket) => (
    socket.port === 5900 || socket.port === externalVncPort || socket.host !== "127.0.0.1" || socket.host.includes(":")
  ));
  if (unexpected.length > 0) {
    throw new Error(`x11vnc_unexpected_listener:${JSON.stringify(unexpected)}`);
  }
};

const parseSsListenLine = (line) => {
  const columns = line.split(/\s+/);
  if (columns.length < 4) return null;
  const local = columns[3];
  if (local.startsWith("[")) {
    const end = local.lastIndexOf("]:");
    if (end === -1) return null;
    return {
      host: local.slice(1, end),
      port: Number(local.slice(end + 2)),
      raw: local,
    };
  }
  const separator = local.lastIndexOf(":");
  if (separator === -1) return null;
  return {
    host: local.slice(0, separator),
    port: Number(local.slice(separator + 1)),
    raw: local,
  };
};

const probeViewerRfbGateway = async (url) => {
  const parsed = new URL(url);
  const socket = net.connect(Number(parsed.port || 80), parsed.hostname);
  const key = crypto.randomBytes(16).toString("base64");
  const ws = new SmokeWebSocket(socket);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    `GET ${parsed.pathname} HTTP/1.1`,
    `Host: ${parsed.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "Sec-WebSocket-Protocol: binary",
    "\r\n",
  ].join("\r\n"));
  await ws.waitForUpgrade();

  const protocol = await ws.readBytes(12);
  if (protocol.toString("ascii") !== "RFB 003.008\n") {
    throw new Error("viewer_gateway_protocol_invalid");
  }
  ws.send(protocol);
  const security = await ws.readBytes(2);
  if (security[0] !== 1 || security[1] !== 1) {
    throw new Error("viewer_gateway_security_not_none");
  }
  ws.send(Buffer.from([1]));
  const securityResult = (await ws.readBytes(4)).readUInt32BE(0);
  if (securityResult !== 0) throw new Error("viewer_gateway_security_failed");
  ws.send(Buffer.from([1]));
  const serverInit = await ws.readBytes(24);
  const width = serverInit.readUInt16BE(0);
  const height = serverInit.readUInt16BE(2);
  const nameLength = serverInit.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error("viewer_gateway_server_init_invalid");
  if (nameLength > 0) await ws.readBytes(nameLength);

  const keyEvent = Buffer.alloc(8);
  keyEvent[0] = 4;
  keyEvent[1] = 1;
  keyEvent.writeUInt32BE(0x41, 4);
  ws.send(keyEvent);
  ws.close();
};

const probeOwnerNativeRfb = async ({ host, port, password }) => {
  const socket = net.connect(port, host);
  const reader = new TcpReader(socket);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const protocol = await reader.readBytes(12);
  if (!protocol.toString("ascii").startsWith("RFB 003.")) {
    throw new Error("owner_native_protocol_invalid");
  }
  socket.write(protocol);
  const securityCount = (await reader.readBytes(1))[0];
  const securityTypes = await reader.readBytes(securityCount);
  if (!securityTypes.includes(2)) throw new Error("owner_native_vncauth_missing");
  socket.write(Buffer.from([2]));
  const challenge = await reader.readBytes(16);
  socket.write(vncAuthResponse(password, challenge));
  const securityResult = (await reader.readBytes(4)).readUInt32BE(0);
  if (securityResult !== 0) throw new Error("owner_native_auth_failed");
  socket.write(Buffer.from([1]));
  const serverInit = await reader.readBytes(24);
  const width = serverInit.readUInt16BE(0);
  const height = serverInit.readUInt16BE(2);
  const nameLength = serverInit.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error("owner_native_server_init_invalid");
  if (nameLength > 0) await reader.readBytes(nameLength);
  socket.end();
};

const vncAuthResponse = (password, challenge) => {
  const key = Buffer.alloc(8);
  Buffer.from(String(password).slice(0, 8), "binary").copy(key);
  for (let index = 0; index < key.length; index += 1) {
    key[index] = reverseBits(key[index]);
  }
  const cipher = des.DES.create({ type: "encrypt", key, padding: false });
  return Buffer.from(cipher.update(challenge));
};

const reverseBits = (byte) => {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit += 1) {
    reversed = (reversed << 1) | ((byte >> bit) & 1);
  }
  return reversed;
};

class TcpReader {
  constructor(socket) {
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
  }

  readBytes(length) {
    if (this.buffer.length >= length) return Promise.resolve(this.take(length));
    return new Promise((resolve) => this.waiters.push({ length, resolve }));
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

class SmokeWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.httpBuffer = Buffer.alloc(0);
    this.upgraded = false;
    this.frameBuffer = Buffer.alloc(0);
    this.dataBuffer = Buffer.alloc(0);
    this.waiters = [];
    this.upgradeWaiters = [];
    socket.on("data", (chunk) => this.onData(chunk));
  }

  waitForUpgrade() {
    if (this.upgraded) return Promise.resolve();
    return new Promise((resolve) => this.upgradeWaiters.push(resolve));
  }

  readBytes(length) {
    if (this.dataBuffer.length >= length) return Promise.resolve(this.take(length));
    return new Promise((resolve) => this.waiters.push({ length, resolve }));
  }

  send(payload) {
    const data = Buffer.from(payload);
    const header = maskedFrameHeader(data.length);
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(data);
    for (let index = 0; index < masked.length; index += 1) {
      masked[index] ^= mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    this.socket.end();
  }

  onData(chunk) {
    if (!this.upgraded) {
      this.httpBuffer = Buffer.concat([this.httpBuffer, chunk]);
      const split = this.httpBuffer.indexOf("\r\n\r\n");
      if (split === -1) return;
      const headers = this.httpBuffer.subarray(0, split).toString("ascii");
      if (!headers.startsWith("HTTP/1.1 101")) throw new Error("viewer_gateway_upgrade_failed");
      this.upgraded = true;
      const rest = this.httpBuffer.subarray(split + 4);
      this.httpBuffer = Buffer.alloc(0);
      for (const resolve of this.upgradeWaiters.splice(0)) resolve();
      if (rest.length > 0) this.onData(rest);
      return;
    }
    this.frameBuffer = Buffer.concat([this.frameBuffer, chunk]);
    while (this.frameBuffer.length >= 2) {
      const opcode = this.frameBuffer[0] & 0x0f;
      let length = this.frameBuffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.frameBuffer.length < 4) return;
        length = this.frameBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.frameBuffer.length < 10) return;
        length = this.frameBuffer.readUInt32BE(6);
        offset = 10;
      }
      if (this.frameBuffer.length < offset + length) return;
      const payload = this.frameBuffer.subarray(offset, offset + length);
      this.frameBuffer = this.frameBuffer.subarray(offset + length);
      if (opcode === 2) this.push(payload);
      if (opcode === 8) this.socket.end();
    }
  }

  push(payload) {
    this.dataBuffer = Buffer.concat([this.dataBuffer, payload]);
    while (this.waiters.length > 0 && this.dataBuffer.length >= this.waiters[0].length) {
      const waiter = this.waiters.shift();
      waiter.resolve(this.take(waiter.length));
    }
  }

  take(length) {
    const out = this.dataBuffer.subarray(0, length);
    this.dataBuffer = this.dataBuffer.subarray(length);
    return out;
  }
}

const maskedFrameHeader = (length) => {
  if (length < 126) return Buffer.from([0x82, 0x80 | length]);
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.alloc(10);
  header[0] = 0x82;
  header[1] = 0x80 | 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(length, 6);
  return header;
};

const requestHeaders = (json = false) => {
  const headers = {};
  if (json) headers["Content-Type"] = "application/json";
  if (cookieHeader) headers.Cookie = cookieHeader;
  return headers;
};

const saveCookie = (response) => {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return;
  cookieHeader = setCookie.split(";")[0];
};

const httpError = (path, status, data) => {
  const error = new Error(`${path}: ${JSON.stringify(data)}`);
  error.status = status;
  return error;
};

if (adminPassword) {
  await post("/api/auth/login", { password: adminPassword });
}

const warningToken = await post("/api/tokens", {
  userId: "smoke-warnings",
  networkProfile: {
    id: "header-proxy",
    headers: {
      "bad key": "1",
      "x-good": "2",
    },
    proxyMappings: [
      { from: "https://example.com/path", to: "localhost:4000/path" },
      { from: "app.example.com/app", to: "localhost:4000/app" },
    ],
  },
});

if (!warningToken.warnings?.some((warning) => warning.code === "invalid_header_key")) {
  throw new Error("invalid_header_warning_missing");
}
if (warningToken.networkProfile.headers["bad key"] || warningToken.networkProfile.headers["x-good"] !== "2") {
  throw new Error("warning_token_headers_not_sanitized");
}
if (warningToken.networkProfile.proxyMappings.length !== 2) {
  throw new Error("warning_token_proxy_mappings_not_sanitized");
}
if (warningToken.networkProfile.proxyMappings[0].fromProtocol !== "https") {
  throw new Error("https_path_mapping_not_preserved");
}

const lease = await post("/api/sessions", {
  userId: "smoke",
  quotaSeconds: 20,
  maxConnections: 1,
  launchProfile: {
    id: "chrome-url",
    url: "about:blank",
  },
  networkProfile: {
    id: "header-proxy",
    headers: {
      "x-example-header": "1",
      "x-vnc-smoke": "1",
    },
    proxyMappings: [
      {
        from: "app.example.com/app",
        to: "localhost:4000/app",
      },
    ],
  },
});

try {
  await delay(1200);
  assertX11VncListenSurface(lease.vncPort);
  const before = await get(`/api/leases/${lease.id}`);

  await new Promise((resolve, reject) => {
    const socket = net.connect(before.vncPort, "127.0.0.1");
    const timer = setTimeout(() => {
      socket.destroy();
      resolve();
    }, 1200);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  await delay(2200);
  const afterPendingConnect = await get(`/api/leases/${lease.id}`);
  const renewed = await post(`/api/leases/${lease.id}/renew`, { extraSeconds: 60 });
  const reduced = await put(`/api/leases/${lease.id}/time`, { remainingSeconds: 12 });
  const ownerState = await get(`/api/leases/${lease.id}`);
  const viewerToken = ownerState.shareUrl.split("/share/")[1];
  const ownerCookie = cookieHeader;
  cookieHeader = "";
  const viewerState = await get(`/api/share/${viewerToken}`);
  const ownerWithoutCookie = await get(`/api/leases/${lease.id}`).catch((error) => error);
  cookieHeader = ownerCookie;

  if (!lease.id) throw new Error("lease_not_created");
  if (lease.maxConnections !== 1 || ownerState.maxConnections !== 1 || viewerState.maxConnections !== 1) {
    throw new Error("max_connections_not_propagated");
  }
  if (ownerState.networkPlugin?.id !== "header-proxy" || !ownerState.networkPlugin?.cdpPort) {
    throw new Error("owner_network_plugin_not_created");
  }
  if (!ownerState.networkPlugin?.proxyPort || ownerState.networkPlugin?.proxyMappings?.[0]?.fromHost !== "app.example.com") {
    throw new Error("owner_proxy_mapping_not_created");
  }
  if (ownerState.launchProfile?.id !== "chrome-url" || ownerState.launchProfile?.url !== "about:blank") {
    throw new Error("owner_launch_profile_not_propagated");
  }
  if (viewerState.launchProfile?.id !== "chrome-url" || viewerState.launchProfile?.url) {
    throw new Error("viewer_launch_profile_state_invalid");
  }
  if (!ownerState.networkPlugin.headerKeys?.includes("x-example-header")) {
    throw new Error("owner_network_plugin_header_keys_missing");
  }
  if (viewerState.networkPlugin?.id !== "header-proxy" || viewerState.networkPlugin?.headerKeys || viewerState.networkPlugin?.proxyMappings) {
    throw new Error("viewer_network_plugin_state_invalid");
  }
  if (ownerState.transport?.id !== "legacy-vnc") {
    throw new Error("owner_transport_id_invalid");
  }
  const ownerEntries = ownerState.transport?.entries || [];
  if (!ownerEntries.some((entry) => entry.kind === "native-vnc" && entry.url?.startsWith("vnc://") && entry.credentialRef === "vncPassword")) {
    throw new Error("owner_native_transport_entry_invalid");
  }
  if (!ownerEntries.some((entry) => entry.kind === "web-novnc" && entry.url?.includes("/vnc.html") && entry.credentialRef === "vncPassword")) {
    throw new Error("owner_web_transport_entry_invalid");
  }
  const viewerEntries = viewerState.transport?.entries || [];
  if (viewerState.transport?.id !== "legacy-vnc" || viewerEntries.length < 3) {
    throw new Error("viewer_transport_state_invalid");
  }
  const viewerSafeEntry = viewerEntries.find((entry) => entry.kind === "web-novnc-readonly");
  if (!viewerSafeEntry?.viewerSafe || !viewerSafeEntry.url?.includes(`/share/${viewerToken}/connect/web`)) {
    throw new Error("viewer_transport_safe_entry_missing");
  }
  if (viewerSafeEntry.credentialRef) {
    throw new Error("viewer_transport_safe_entry_leaks_credential");
  }
  if (viewerEntries.some((entry) => entry.kind !== "web-novnc-readonly" && (entry.url || entry.credentialRef || entry.viewerSafe))) {
    throw new Error("viewer_transport_entry_leaks_connection_capability");
  }
  await probeOwnerNativeRfb({
    host: "127.0.0.1",
    port: ownerState.vncPort,
    password: ownerState.password,
  });
  await delay(500);
  await probeViewerRfbGateway(viewerSafeEntry.url);
  if (!ownerState.connectionState?.total || !viewerState.connectionState?.total) {
    throw new Error("connection_state_missing");
  }
  if (!ownerState.shareUrl) throw new Error("share_url_not_created");
  if (viewerState.events || viewerState.shareUrl) throw new Error("viewer_state_leaks_owner_fields");
  for (const secretField of ["password", "vncPort", "webPort", "macUrl", "webUrl"]) {
    if (Object.prototype.hasOwnProperty.call(viewerState, secretField)) {
      throw new Error(`viewer_state_leaks_${secretField}`);
    }
  }
  if (adminPassword && ownerWithoutCookie.status !== 401) throw new Error("owner_api_allowed_without_cookie");
  if (afterPendingConnect.remainingSeconds < before.remainingSeconds) {
    throw new Error("pending_connection_drained_time_before_auth");
  }
  if (renewed.remainingSeconds <= afterPendingConnect.remainingSeconds) {
    throw new Error("renew_did_not_add_time");
  }
  if (reduced.remainingSeconds !== 12) {
    throw new Error("set_time_did_not_reduce_to_exact_value");
  }

  console.log(JSON.stringify({
    ok: true,
    leaseId: lease.id,
    beforeRemaining: before.remainingSeconds,
    afterPendingConnectRemaining: afterPendingConnect.remainingSeconds,
    renewedRemaining: renewed.remainingSeconds,
    reducedRemaining: reduced.remainingSeconds,
    shareUrl: ownerState.shareUrl,
    networkPlugin: ownerState.networkPlugin,
    webUrl: lease.webUrl,
    macUrl: lease.macUrl,
  }, null, 2));
} finally {
  await post(`/api/leases/${lease.id}/revoke`).catch(() => {});
}
