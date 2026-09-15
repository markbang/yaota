import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, appPath, errorMessage } from "./api.ts";
import type { AppEntry, DashboardState } from "./api.ts";

export function useDashboard() {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [selectedApp, setSelectedApp] = useState(localStorage.getItem("yaota_app_id") || "");
  const [state, setState] = useState<DashboardState | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error" | "signed-out">("loading");
  const [error, setError] = useState("");
  const selected = useRef(selectedApp);
  const request = useRef<AbortController | null>(null);

  const signOut = useCallback(() => {
    request.current?.abort();
    sessionStorage.removeItem("yaota_admin_token");
    setApps([]); setState(null); setError(""); setPhase("signed-out");
  }, []);

  const refresh = useCallback(async (application?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (application !== undefined) { selected.current = application; setSelectedApp(application); }
    setState(null); setError(""); setPhase("loading");
    if (!sessionStorage.getItem("yaota_admin_token")) { signOut(); return; }
    try {
      const result = await api<{ apps: AppEntry[] }>("/api/ota/apps", { signal: controller.signal });
      if (controller.signal.aborted) return;
      const id = result.apps.find(app => app.app_id === selected.current)?.app_id || result.apps[0]?.app_id || "";
      selected.current = id;
      setApps(result.apps); setSelectedApp(id); localStorage.setItem("yaota_app_id", id);
      const next = id ? await api<DashboardState>(appPath("/api/ota/state", id), { signal: controller.signal }) : null;
      if (!controller.signal.aborted) { setState(next); setPhase("ready"); }
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) signOut();
      else { setError(errorMessage(cause)); setPhase("error"); }
    }
  }, [signOut]);

  useEffect(() => { void refresh(); return () => request.current?.abort(); }, [refresh]);
  return { apps, selectedApp, state, phase, error, refresh, signOut };
}
