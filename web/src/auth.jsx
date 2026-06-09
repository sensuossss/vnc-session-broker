import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getAuth } from "./api.js";

export function useRequireAuth() {
  const location = useLocation();
  const navigate = useNavigate();
  const [state, setState] = useState({ checking: true, authenticated: false, authRequired: true });

  useEffect(() => {
    let live = true;
    getAuth()
      .then((auth) => {
        if (!live) return;
        setState({ checking: false, ...auth });
        if (auth.authRequired && !auth.authenticated) {
          const next = encodeURIComponent(location.pathname + location.search);
          navigate(`/login?next=${next}`, { replace: true });
        }
      })
      .catch(() => {
        if (!live) return;
        setState({ checking: false, authenticated: false, authRequired: true });
        const next = encodeURIComponent(location.pathname + location.search);
        navigate(`/login?next=${next}`, { replace: true });
      });
    return () => {
      live = false;
    };
  }, [location.pathname, location.search, navigate]);

  return state;
}
