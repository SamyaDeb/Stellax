import { useEffect, useState } from "react";
import { config } from "@/config";

interface FeedRow {
  feed: string;
  price: string | null;
  ageMs: number | null;
  fresh: boolean;
  source: string | null;
}

interface FeedsHealth {
  ok: boolean;
  ts: number;
  freshnessMs: number;
  feeds: FeedRow[];
}

/**
 * Tier 4: small status dot in the navbar that polls
 * `GET {indexer}/health/feeds` every 10s and reflects per-feed freshness.
 *
 * Green  – all feeds fresh
 * Amber  – at least one feed stale (ageMs >= freshnessMs)
 * Red    – endpoint unreachable / no rows yet
 */
export function FeedHealthDot(): JSX.Element | null {
  const [health, setHealth] = useState<FeedsHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!config.indexer.enabled || config.indexer.url.length === 0) return;
    const base = config.indexer.url.replace(/\/$/, "");
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await fetch(`${base}/health/feeds`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as FeedsHealth;
        if (!cancelled) {
          setHealth(body);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setHealth(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void tick();
    const handle = window.setInterval(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);

  if (!config.indexer.enabled) return null;

  let color = "bg-stella-short";
  let label = "Feeds offline";
  if (error !== null) {
    color = "bg-stella-short";
    label = `Feeds: ${error}`;
  } else if (health) {
    if (health.ok) {
      color = "bg-stella-long";
      label = "All price feeds fresh";
    } else {
      color = "bg-stella-accent";
      const stale = health.feeds.filter((f) => !f.fresh).map((f) => f.feed);
      label = stale.length > 0 ? `Stale: ${stale.join(", ")}` : "Some feeds stale";
    }
  }

  const tooltip = health
    ? health.feeds
        .map((f) => {
          if (f.price === null) return `${f.feed}: no data`;
          const age = f.ageMs !== null ? formatAge(f.ageMs) : "?";
          return `${f.feed}: ${age}${f.fresh ? "" : " · stale"}`;
        })
        .join("\n")
    : label;

  return (
    <span
      className="flex items-center gap-1.5 text-xs text-stella-muted"
      title={tooltip}
      aria-label={label}
    >
      <span className={`h-2 w-2 rounded-full ${color} shadow-[0_0_6px_currentColor]`} />
      <span className="hidden md:inline">Feeds</span>
    </span>
  );
}

function formatAge(ms: number): string {
  if (ms < 0) return "future";
  if (ms < 1_000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs}s`;
}
