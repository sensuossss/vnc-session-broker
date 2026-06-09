async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export const getAuth = () => request("/api/auth/me");
export const loginAdmin = (password) => request("/api/auth/login", { method: "POST", body: { password } });
export const logoutAdmin = () => request("/api/auth/logout", { method: "POST" });
export const issueToken = (body) => request("/api/tokens", { method: "POST", body });
export const createSession = (body) => request("/api/sessions", { method: "POST", body });
export const getLeases = () => request("/api/leases");
export const getPluginSchemas = () => request("/api/plugin-schemas");
export const getSessionDefaults = (userId) => request(`/api/session-defaults/${encodeURIComponent(userId)}`);
export const saveSessionDefaults = (userId, body) =>
  request(`/api/session-defaults/${encodeURIComponent(userId)}`, { method: "PUT", body });
export const tokenStatus = (token) => request(`/api/tokens/${encodeURIComponent(token)}`);
export const redeemToken = (token, body) =>
  request(`/api/tokens/${encodeURIComponent(token)}/redeem`, { method: "POST", body });
export const getLease = (id) => request(`/api/leases/${encodeURIComponent(id)}`);
export const getShare = (viewerToken) => request(`/api/share/${encodeURIComponent(viewerToken)}`);
export const renewLease = (id, extraSeconds) =>
  request(`/api/leases/${encodeURIComponent(id)}/renew`, { method: "POST", body: { extraSeconds } });
export const setLeaseTime = (id, remainingSeconds) =>
  request(`/api/leases/${encodeURIComponent(id)}/time`, { method: "PUT", body: { remainingSeconds } });
export const revokeLease = (id) =>
  request(`/api/leases/${encodeURIComponent(id)}/revoke`, { method: "POST" });
