import { useCallback, useEffect, useState } from "react";
import { CLOUD_PULL_EVENT } from "@/lib/cloud-keys";

/** Liga/desliga salvo no navegador (e sincronizado na nuvem via CloudSync). */
export function usePersistedToggle(key: string, defaultValue: boolean) {
  const [value, setRaw] = useState(defaultValue);
  useEffect(() => {
    const read = () => {
      const v = localStorage.getItem(key);
      setRaw(v == null ? defaultValue : v === "true");
    };
    read();
    const onPull = (e: Event) => { if ((e as CustomEvent<string>).detail === key) read(); };
    window.addEventListener(CLOUD_PULL_EVENT, onPull);
    return () => window.removeEventListener(CLOUD_PULL_EVENT, onPull);
  }, [key, defaultValue]);
  const set = useCallback((v: boolean | ((p: boolean) => boolean)) => {
    setRaw((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      localStorage.setItem(key, String(next));
      return next;
    });
  }, [key]);
  return [value, set] as const;
}
