import net from "node:net";

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
