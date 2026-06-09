import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const configPath = process.argv[2];
if (!configPath) {
  console.error("usage: node scripts/network-proxy.mjs <config.json>");
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const mappings = Array.isArray(config.mappings) ? config.mappings : [];
const logStream = config.logPath
  ? fs.createWriteStream(config.logPath, { flags: "a" })
  : null;

const server = http.createServer(handleHttpRequest);

process.on("unhandledRejection", (error) => {
  writeLog({ event: "unhandled_rejection", error: error?.message || String(error) });
});

server.on("connect", handleConnect);
server.on("clientError", (error, socket) => {
  writeLog({ event: "client_error", error: error.message });
  socket.destroy();
});

server.listen(config.listenPort, config.listenHost || "127.0.0.1", () => {
  const address = server.address();
  writeLog({
    event: "listening",
    leaseId: config.leaseId,
    host: address.address,
    port: address.port,
    mappings: mappings.length,
  });
});

function handleHttpRequest(req, res) {
  req.on("error", (error) => {
    writeLog({ event: "http_client_error", error: error.message });
  });
  res.on("error", (error) => {
    writeLog({ event: "http_response_error", error: error.message });
  });

  const requestUrl = parseProxyRequestUrl(req);
  if (!requestUrl) {
    res.writeHead(400);
    res.end("invalid proxy request");
    return;
  }

  const originalPort = requestUrl.port
    ? Number(requestUrl.port)
    : requestUrl.protocol === "https:" ? 443 : 80;
  const match = findMapping(requestUrl.hostname, originalPort, `${requestUrl.pathname}${requestUrl.search}`, false);
  const targetProtocol = match?.mapping.toProtocol === "https" ? "https" : requestUrl.protocol.replace(":", "") || "http";
  const targetHost = match?.mapping.toHost || requestUrl.hostname;
  const targetPort = match?.mapping.toPort || originalPort;
  const targetPath = match
    ? rewritePath(`${requestUrl.pathname}${requestUrl.search}`, match.mapping)
    : `${requestUrl.pathname}${requestUrl.search}`;
  const headers = { ...req.headers };

  if (match && match.mapping.preserveHost === false) {
    headers.host = formatHostHeader(targetHost, targetPort, targetProtocol);
  }

  writeLog({
    event: "http_request",
    method: req.method,
    from: `${requestUrl.hostname}:${originalPort}${requestUrl.pathname}`,
    to: `${targetHost}:${targetPort}${targetPath}`,
    mapped: Boolean(match),
  });

  const client = targetProtocol === "https" ? https : http;
  const upstream = client.request({
    host: targetHost,
    port: targetPort,
    method: req.method,
    path: targetPath,
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (error) => {
    writeLog({
      event: "http_error",
      from: `${requestUrl.hostname}:${originalPort}`,
      to: `${targetHost}:${targetPort}`,
      error: error.message,
    });
    if (!res.headersSent) res.writeHead(502);
    res.end("proxy upstream error");
  });

  req.pipe(upstream);
}

function handleConnect(req, clientSocket, head) {
  const [host, rawPort] = String(req.url || "").split(":");
  const originalPort = Number(rawPort || 443);
  const match = findMapping(host, originalPort, "", true);
  const targetHost = match?.mapping.toHost || host;
  const targetPort = match?.mapping.toPort || originalPort;

  writeLog({
    event: "connect",
    from: `${host}:${originalPort}`,
    to: `${targetHost}:${targetPort}`,
    mapped: Boolean(match),
  });

  const upstream = net.connect(targetPort, targetHost, () => {
    safeWrite(clientSocket, "HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) safeWrite(upstream, head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  clientSocket.on("error", (error) => {
    writeLog({
      event: "connect_client_error",
      from: `${host}:${originalPort}`,
      to: `${targetHost}:${targetPort}`,
      error: error.message,
    });
    upstream.destroy();
  });

  upstream.on("error", (error) => {
    writeLog({
      event: "connect_error",
      from: `${host}:${originalPort}`,
      to: `${targetHost}:${targetPort}`,
      error: error.message,
    });
    safeWrite(clientSocket, "HTTP/1.1 502 Bad Gateway\r\n\r\n");
    clientSocket.destroy();
  });

  clientSocket.on("close", () => {
    upstream.destroy();
  });
  upstream.on("close", () => {
    clientSocket.destroy();
  });
}

function parseProxyRequestUrl(req) {
  try {
    return new URL(req.url);
  } catch {
    const host = req.headers.host;
    if (!host) return null;
    try {
      return new URL(`http://${host}${req.url || "/"}`);
    } catch {
      return null;
    }
  }
}

function findMapping(host, port, path, isConnect) {
  const lowerHost = String(host || "").toLowerCase();
  const requestPath = path || "";
  const candidates = [];

  for (const mapping of mappings) {
    if (String(mapping.fromHost || "").toLowerCase() !== lowerHost) continue;
    if (mapping.fromPort && Number(mapping.fromPort) !== Number(port)) continue;
    if (isConnect && mapping.fromPath) continue;
    if (mapping.fromPath && !pathMatches(requestPath, mapping.fromPath)) continue;
    candidates.push(mapping);
  }

  candidates.sort((left, right) => String(right.fromPath || "").length - String(left.fromPath || "").length);
  return candidates.length > 0 ? { mapping: candidates[0] } : null;
}

function pathMatches(path, prefix) {
  if (!prefix) return true;
  return path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`);
}

function rewritePath(path, mapping) {
  const fromPath = mapping.fromPath || "";
  const toPath = mapping.toPath || "";
  if (!fromPath) return mergePath(toPath, path);
  const suffix = path.slice(fromPath.length);
  return mergePath(toPath, suffix || "");
}

function mergePath(prefix, suffix) {
  if (!prefix) return suffix || "/";
  if (!suffix) return prefix;
  if (suffix.startsWith("?")) return `${prefix}${suffix}`;
  return `${prefix.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
}

function formatHostHeader(host, port, protocol) {
  const defaultPort = protocol === "https" ? 443 : 80;
  return Number(port) === defaultPort ? host : `${host}:${port}`;
}

function safeWrite(socket, data) {
  if (!socket || socket.destroyed || !socket.writable) return false;
  try {
    return socket.write(data);
  } catch (error) {
    writeLog({ event: "socket_write_error", error: error.message });
    socket.destroy();
    return false;
  }
}

function writeLog(payload) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...payload })}\n`;
  if (logStream) logStream.write(line);
  else process.stderr.write(line);
}
