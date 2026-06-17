import { useEffect, useRef } from "react";
import RFB from "@novnc/novnc";

// Converts the broker's http(s) gateway URL into the ws(s) URL noVNC's RFB
// client expects. Relative URLs resolve against the current page origin.
function toWsUrl(httpUrl) {
  try {
    const u = new URL(httpUrl, window.location.origin);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  } catch {
    return String(httpUrl).replace(/^http/, "ws");
  }
}

// Embeds a read-only noVNC session pointed at the broker's per-share gateway
// WebSocket. The gateway already terminated RFB auth (security type None) and
// drops viewer input server-side; `viewOnly` here is defense-in-depth.
export default function VncScreen({ url, mode = "actual", onState }) {
  const screenRef = useRef(null);
  const rfbRef = useRef(null);
  const stateRef = useRef(onState);
  stateRef.current = onState;

  useEffect(() => {
    if (!rfbRef.current) return;
    rfbRef.current.scaleViewport = mode === "fit";
    rfbRef.current.clipViewport = false;
  }, [mode]);

  useEffect(() => {
    if (!url || !screenRef.current) return undefined;
    let disposed = false;
    const emit = (s) => !disposed && stateRef.current?.(s);
    emit("connecting");

    let rfb;
    try {
      rfb = new RFB(screenRef.current, toWsUrl(url), {});
    } catch {
      emit("error");
      return undefined;
    }
    rfbRef.current = rfb;
    rfb.viewOnly = true;
    rfb.scaleViewport = mode === "fit";
    rfb.clipViewport = false;
    rfb.resizeSession = false;
    rfb.qualityLevel = 9;
    rfb.compressionLevel = 2;
    rfb.background = "transparent";

    const onConnect = () => emit("connected");
    const onDisconnect = (event) => emit(event?.detail?.clean ? "closed" : "dropped");
    rfb.addEventListener("connect", onConnect);
    rfb.addEventListener("disconnect", onDisconnect);

    return () => {
      disposed = true;
      rfb.removeEventListener("connect", onConnect);
      rfb.removeEventListener("disconnect", onDisconnect);
      try {
        rfb.disconnect();
      } catch {
        // already torn down
      }
      if (rfbRef.current === rfb) rfbRef.current = null;
    };
  }, [url]);

  return <div className={`vnc-screen is-${mode}`} ref={screenRef} />;
}
