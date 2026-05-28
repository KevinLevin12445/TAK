import { useEffect, useRef, useCallback, useState } from "react";

const STORAGE_KEY_INSIDER = "ak_seen_insider";
const STORAGE_KEY_NEWS    = "ak_seen_news";
const POLL_INTERVAL_MS    = 60_000;

function getSeenSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function saveSeenSet(key: string, set: Set<string>) {
  try {
    // Keep last 200 IDs to avoid unbounded growth
    const arr = [...set].slice(-200);
    localStorage.setItem(key, JSON.stringify(arr));
  } catch { /* storage full */ }
}

function sendNotification(title: string, body: string, tag?: string) {
  if (typeof window === "undefined") return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag, icon: "/favicon.ico", badge: "/favicon.ico" });
  } catch { /* some browsers block programmatic notifications */ }
}

export function useWebNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(() =>
    typeof window !== "undefined" && "Notification" in window ? Notification.permission : "denied"
  );
  const [newInsiderCount, setNewInsiderCount] = useState(0);
  const [newNewsCount,    setNewNewsCount]    = useState(0);
  const initialized = useRef(false);

  const requestPermission = useCallback(async () => {
    if (!("Notification" in window)) return;
    const p = await Notification.requestPermission();
    setPermission(p);
    return p;
  }, []);

  const checkInsider = useCallback(async () => {
    try {
      const r = await fetch("/api/gold/insider");
      if (!r.ok) return;
      const data = await r.json();
      const txs: { date: string; ticker: string; insider: string; type: string; value: string }[] =
        data.transactions ?? [];

      const seen = getSeenSet(STORAGE_KEY_INSIDER);
      let newCount = 0;

      for (const tx of txs) {
        const id = `${tx.date}-${tx.ticker}-${tx.insider}-${tx.type}`;
        if (!seen.has(id)) {
          seen.add(id);
          newCount++;
          if (initialized.current) {
            sendNotification(
              `🏦 Insider ${tx.type} — ${tx.ticker}`,
              `${tx.insider} · ${tx.value} · ${tx.date}`,
              `insider-${id}`
            );
          }
        }
      }

      saveSeenSet(STORAGE_KEY_INSIDER, seen);
      if (newCount > 0) setNewInsiderCount((n) => n + newCount);
    } catch { /* network error */ }
  }, []);

  const checkNews = useCallback(async () => {
    try {
      const r = await fetch("/api/gold/alerts");
      if (!r.ok) return;
      const data = await r.json();
      const news: { title: string; publishedAt: string; source: string }[] = data.news ?? [];

      const seen = getSeenSet(STORAGE_KEY_NEWS);
      let newCount = 0;

      for (const item of news) {
        const id = `${item.publishedAt}-${item.title.slice(0, 40)}`;
        if (!seen.has(id)) {
          seen.add(id);
          newCount++;
          if (initialized.current) {
            sendNotification(
              `📰 Gold News — ${item.source}`,
              item.title,
              `news-${id}`
            );
          }
        }
      }

      saveSeenSet(STORAGE_KEY_NEWS, seen);
      if (newCount > 0) setNewNewsCount((n) => n + newCount);
    } catch { /* network error */ }
  }, []);

  const clearInsiderBadge = useCallback(() => setNewInsiderCount(0), []);
  const clearNewsBadge    = useCallback(() => setNewNewsCount(0), []);

  useEffect(() => {
    // Initial load — build baseline without firing notifications
    Promise.all([checkInsider(), checkNews()]).then(() => {
      initialized.current = true;
      // Reset counts that accumulated during baseline scan
      setNewInsiderCount(0);
      setNewNewsCount(0);
    });

    const id = setInterval(() => {
      checkInsider();
      checkNews();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(id);
  }, [checkInsider, checkNews]);

  return { permission, requestPermission, newInsiderCount, newNewsCount, clearInsiderBadge, clearNewsBadge };
}
