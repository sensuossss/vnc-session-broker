# VNC Session Broker

Prototype control plane for a dual-entry VNC desktop:

- Web entry: noVNC through `websockify`
- macOS entry: native `vnc://host:port` for Screen Sharing.app
- One-time access tokens
- Connection-duration quota
- Renewal and revocation
- Watchdog that deducts quota only while `x11vnc` reports active clients

The control-plane UI is a React SPA in `web/` (Vite + React Router), served by
the broker from `web/dist`. The Node server itself stays dependency-free and
only exposes the JSON API plus static hosting.

The UI is bilingual (English / 简体中文) via `react-i18next`: language is
auto-detected from the browser, switchable from the topbar, and persisted in
`localStorage` (`broker-lang`). Dictionaries live in `web/src/locales/`.

## Requirements

The current prototype uses system binaries:

- `node >= 20`
- `x11vnc`
- `websockify`
- `Xvfb` only if `VNC_DESKTOP_MODE=xvfb`
- noVNC static files, default `/usr/share/novnc`

## Run

Build the web UI once (and after changing `web/src`):

```bash
npm run web:install
npm run web:build
```

Then start the broker:

```bash
npm start
```

Open:

```text
http://<host>:7070
```

For frontend development with hot reload (proxies `/api` to :7070):

```bash
npm run web:dev
```

By default the broker attaches each lease to the existing X display `:1`.
That matches the current workspace environment and makes it easy to test
against the already-running desktop.

Useful environment variables:

```bash
CONTROL_PORT=7070
PUBLIC_HOST=<host-visible-to-users>
VNC_ATTACH_DISPLAY=:1
VNC_DESKTOP_MODE=attach
VNC_SESSION_COMMAND=
CHROME_PROFILE_TEMPLATE_DIR=
CHROME_WINDOW_SIZE=<derived from VNC_RESOLUTION, for example 2560,1440>
MAP_SUPER_TO_CONTROL=true
VNC_PORT_BASE=6101
WEB_PORT_BASE=7101
CDP_PORT_BASE=9101
PROXY_PORT_BASE=9201
DEFAULT_QUOTA_SECONDS=1800
DEFAULT_MAX_CONNECTIONS=1
SESSION_DEFAULTS_FILE=./session-defaults.json
BROKER_STATE_FILE=./broker-state.json
IDLE_TTL_SECONDS=600
ADMIN_PASSWORD=
ADMIN_TOKEN=
ADMIN_SESSION_TTL_SECONDS=43200
```

Set `ADMIN_PASSWORD` to require login for the root dashboard and owner APIs.
`ADMIN_TOKEN` can also be used for script/API access with
`Authorization: Bearer <token>`. If neither is set, owner authentication is
disabled for local development.

`BROKER_STATE_FILE` persists issued tokens and leases across broker restarts.
Only broker-managed sessions are restored; orphaned VNC processes without a
lease record are intentionally not adopted. The state file contains temporary
VNC passwords, so keep it local and out of source control.

`CHROME_PROFILE_TEMPLATE_DIR` is used by the built-in `chrome-url` and
`blank-chrome` launch profiles. When set, the broker copies that Chrome profile
directory into each session runtime directory and launches Chrome with the copy
as `--user-data-dir`. The per-session copy is deleted when the lease is revoked
or expires.

`CHROME_WINDOW_SIZE` controls the built-in Chrome launch window size. If unset,
the broker derives it from `VNC_RESOLUTION`, so a `2560x1440x24` framebuffer
launches Chrome as `--window-size=2560,1440`.

For an isolated virtual framebuffer per lease:

```bash
VNC_DESKTOP_MODE=xvfb VNC_RESOLUTION=2560x1440x24 VNC_DPI=144 npm start
```

The xvfb mode creates a 2K framebuffer. If `VNC_SESSION_COMMAND` is set, the
broker starts that command inside the new display before exposing VNC.

Example with a visible test window:

```bash
VNC_DESKTOP_MODE=xvfb \
VNC_RESOLUTION=2560x1440x24 \
VNC_DPI=144 \
VNC_SESSION_COMMAND='xmessage -geometry 900x240+120+120 "2K VNC session ready"' \
npm start
```

Example with Chrome:

```bash
VNC_DESKTOP_MODE=xvfb \
VNC_RESOLUTION=2560x1440x24 \
VNC_DPI=144 \
CHROME_PROFILE_TEMPLATE_DIR=/path/to/chrome-profile \
npm start
```

There is no full window manager in the current machine image, so Chrome may not
behave like a normal desktop window until a window manager such as Openbox or
Xfce is added.

## Flow

1. Open the root dashboard.
2. Create one or more sessions directly.
3. The broker creates a lease for each session with:
   - a temporary VNC password
   - a max concurrent connection limit
   - a native VNC port
   - a web noVNC port
   - an owner page at `/leases/<leaseId>`
   - a viewer share page at `/share/<viewerToken>`
4. Connection quota starts draining after `x11vnc` logs a client connection.
5. Disconnecting pauses quota drain.
6. Renewal adds seconds to `remainingSeconds`.
7. Quota exhaustion, idle timeout, or revoke stops the session processes.
8. Extra VNC clients above `maxConnections` are rejected by x11vnc's
   per-session admission hook.
9. If a network profile is selected, the broker injects per-session Chrome
   launch wrappers and starts the plugin sidecar processes.
10. If a launch profile is selected, the broker generates the session startup
    command from a safe template instead of exposing raw shell input.

The one-time token flow still exists as a compatibility API, but it is not the
main owner workflow.

## Launch Profiles

`launchProfile` decides what appears inside the user's desktop when the lease
starts. It is separate from `networkProfile`.

Current profiles:

- `chrome-url`: open Chrome at a specified URL
- `blank-chrome`: open Chrome at `about:blank`
- `fallback-command`: use global `VNC_SESSION_COMMAND`

Example:

```json
{
  "launchProfile": {
    "id": "chrome-url",
    "url": "https://example.com/"
  }
}
```

Only `http:`, `https:`, `file:`, and `about:` launch URLs are accepted.

User-specific defaults can be provided through `SESSION_DEFAULTS_FILE`:

```json
{
  "users": {
    "A": {
      "launchProfile": {
        "id": "chrome-url",
        "url": "https://example.com/"
      },
      "networkProfile": {
        "id": "header-proxy",
        "headers": {
          "x-example-header": "1"
        }
      },
      "quotaSeconds": 3600,
      "maxConnections": 1
    }
  }
}
```

The root dashboard can load these defaults by user ID before creating a
session.

## Session Plugins

The broker supports server-side session plugins via the `networkProfile` field.
Plugins are owned by the broker, not by Chrome extension installation. They can
append Chrome launch args, start per-session sidecars, expose owner-only state,
and clean up with the session processes.

Current profile:

- `none`: no plugin
- `header-proxy`: starts Chrome with a per-session CDP port and runs
  `scripts/cdp-sidecar.mjs` to apply configured headers with
  `Network.setExtraHTTPHeaders`. It can also start a per-session local HTTP
  proxy for host/path route mappings.

Example:

```json
{
  "networkProfile": {
    "id": "header-proxy",
    "headers": {
      "x-example-header": "1"
    },
    "proxyMappings": [
      {
        "from": "10.0.0.1:8080",
        "to": "10.0.0.2:8080"
      },
      {
        "from": "app.example.com/app",
        "to": "localhost:4000/app",
        "preserveHost": true
      }
    ]
  }
}
```

`from` and `to` accept `host:port`, `host/path`, or full `http(s)://...`
values. HTTP requests are routed by the per-session local proxy. HTTPS
host:port CONNECT traffic is also tunneled by the proxy. HTTPS path-level
requests are handled by the CDP sidecar with `Fetch.requestPaused` and
`Fetch.continueRequest({ url })`, so mappings such as
`https://app.example.com/path -> localhost:4000/path` can be rewritten without
installing a browser extension.

When Chrome is launched through `VNC_SESSION_COMMAND`, the broker writes a
temporary `google-chrome`/`chromium` wrapper in the session runtime directory
and prepends that directory to `PATH`. This keeps the command string stable
while still injecting session-specific CDP/proxy args.

## Owner vs Viewer Pages

When `ADMIN_PASSWORD` or `ADMIN_TOKEN` is configured, the root dashboard and
owner page require admin authentication:

```text
http://<host>:7070/
http://<host>:7070/leases/<leaseId>
```

The owner page is for the person who created/redeemed the token:

```text
http://<host>:7070/leases/<leaseId>
```

It shows renewal/revoke controls, debug events, and a share URL.

The viewer page is for distribution to other users:

```text
http://<host>:7070/share/<viewerToken>
```

It is read-only. Viewers can see countdown/connection state and open Web or
macOS VNC, but they cannot renew or revoke the lease from the page.

## Shortcut Mapping

When the broker serves noVNC from `novnc-patched`, macOS Command/Super is
mapped to remote Control so common shortcuts like Cmd+C, Cmd+V, Cmd+A, Cmd+X,
and Cmd+Z behave like Ctrl shortcuts inside Linux.

For native macOS Screen Sharing, xvfb sessions also run an X11 `xmodmap`
attempt to move `Super_L`/`Super_R` into the Control modifier group. This is a
best-effort compatibility layer because native VNC clients differ in how they
send Command keys.

## API Examples

If owner authentication is enabled, login first and reuse the cookie:

```bash
curl -c /tmp/vnc-broker.cookies \
  -X POST http://127.0.0.1:7070/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"<admin-password>"}'
```

Then pass `-b /tmp/vnc-broker.cookies` to owner API calls. Alternatively, use
`-H 'Authorization: Bearer <admin-token>'` when `ADMIN_TOKEN` is configured.

Issue a one-time token:

```bash
curl -b /tmp/vnc-broker.cookies -X POST http://127.0.0.1:7070/api/tokens \
  -H 'Content-Type: application/json' \
  -d '{"userId":"demo","quotaSeconds":1800,"ttlSeconds":900,"maxConnections":1,"launchProfile":{"id":"chrome-url","url":"https://example.com/"},"networkProfile":{"id":"header-proxy","headers":{"x-example-header":"1"}}}'
```

Create a session directly from the owner control plane:

```bash
curl -b /tmp/vnc-broker.cookies -X POST http://127.0.0.1:7070/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"userId":"owner","quotaSeconds":3600,"maxConnections":1,"launchProfile":{"id":"chrome-url","url":"https://example.com/"},"networkProfile":{"id":"header-proxy","headers":{"x-example-header":"1"}}}'
```

Redeem the token once:

```bash
curl -X POST http://127.0.0.1:7070/api/tokens/<token>/redeem \
  -H 'Content-Type: application/json' \
  -d '{"clientLabel":"browser-or-client"}'
```

Get lease status:

```bash
curl -b /tmp/vnc-broker.cookies http://127.0.0.1:7070/api/leases/<leaseId>
```

Get viewer status:

```bash
curl http://127.0.0.1:7070/api/share/<viewerToken>
```

Renew connection quota:

```bash
curl -b /tmp/vnc-broker.cookies -X POST http://127.0.0.1:7070/api/leases/<leaseId>/renew \
  -H 'Content-Type: application/json' \
  -d '{"extraSeconds":900}'
```

Revoke and stop the session:

```bash
curl -b /tmp/vnc-broker.cookies -X POST http://127.0.0.1:7070/api/leases/<leaseId>/revoke
```

List leases:

```bash
curl -b /tmp/vnc-broker.cookies http://127.0.0.1:7070/api/leases
```

## Verified Locally

In the current workspace, the broker was verified against `DISPLAY=:1`:

- token issue succeeds
- token redeem starts an `x11vnc` port and a `websockify` port
- no-client idle time does not drain connection quota
- a short TCP client connection is detected from the `x11vnc` log
- remaining connection seconds drain only while connected
- max connection limit is propagated to owner and viewer state
- renew adds seconds to `remainingSeconds`
- revoke stops the session processes and releases ports

## Security Notes

This prototype assumes internal or otherwise controlled access. Do not expose
raw VNC ports to the public internet.

Admin authentication protects the HTTP control plane, not the raw VNC protocol.
Native macOS Screen Sharing cannot send the admin cookie, so VNC access is
still bounded by per-session random passwords, lease expiration, and revoke.

Do not embed the VNC password in `vnc://` URLs. The page displays the temporary
password separately so it does not land in browser history or logs.

`broker-state.json` also contains temporary VNC passwords so the broker can
restore active sessions after restart. Treat it as local runtime state.
