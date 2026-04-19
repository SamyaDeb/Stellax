/**
 * Price chart. Seeds an in-memory series and appends one point per
 * oracle poll. In Phase 14+ this will be replaced with indexer-backed
 * historical OHLCV fetch; for now it's a live mini-chart.
 */

import { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { fromFixed } from "@/ui/format";

interface Props {
  price: bigint | undefined;
  timestamp: bigint | undefined;
  title: string;
}

export function PriceChart({ price, timestamp, title }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const seenTsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (containerRef.current === null) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: "#131520" },
        textColor: "#7b7f95",
      },
      grid: {
        vertLines: { color: "#1f2231" },
        horzLines: { color: "#1f2231" },
      },
      rightPriceScale: { borderColor: "#1f2231" },
      timeScale: { borderColor: "#1f2231", timeVisible: true },
      width: containerRef.current.clientWidth,
      height: 360,
    });
    const series = chart.addAreaSeries({
      lineColor: "#5b8cff",
      topColor: "rgba(91, 140, 255, 0.4)",
      bottomColor: "rgba(91, 140, 255, 0)",
      lineWidth: 2,
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (containerRef.current !== null && chartRef.current !== null) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      seenTsRef.current = new Set();
    };
  }, []);

  // Reset series when the title (market) changes.
  useEffect(() => {
    if (seriesRef.current !== null) {
      seriesRef.current.setData([]);
      seenTsRef.current = new Set();
    }
  }, [title]);

  // Append each distinct price sample.
  useEffect(() => {
    if (
      seriesRef.current === null ||
      price === undefined ||
      timestamp === undefined
    ) {
      return;
    }
    const ts = Number(timestamp) as UTCTimestamp;
    if (seenTsRef.current.has(ts)) return;
    seenTsRef.current.add(ts);
    seriesRef.current.update({ time: ts, value: fromFixed(price) });
  }, [price, timestamp]);

  return (
    <div className="space-y-2">
      <div className="text-xs text-stella-muted">{title}</div>
      <div ref={containerRef} className="h-[360px] w-full" />
    </div>
  );
}
