import { useEffect, useRef, useState } from "react";
import { fromFixed } from "@/ui/format";

interface Trade {
  id: number;
  price: number;
  size: number;
  isBuy: boolean;
  time: string;
}

function fmt8(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

function randSize(): number {
  return parseFloat((Math.random() * 2.5 + 0.01).toFixed(4));
}

interface Props {
  markPrice: bigint | undefined;
}

export function RecentTrades({ markPrice }: Props) {
  const mid = markPrice !== undefined ? fromFixed(markPrice) : null;
  const idRef = useRef(0);
  const [trades, setTrades] = useState<Trade[]>([]);

  useEffect(() => {
    if (mid === null || mid <= 0) return;

    const seed: Trade[] = Array.from({ length: 8 }, (_, i) => {
      const delta = (Math.random() - 0.5) * mid * 0.002;
      const t = new Date(Date.now() - (7 - i) * 7_000);
      return {
        id: idRef.current++,
        price: mid + delta,
        size: randSize(),
        isBuy: Math.random() > 0.48,
        time: fmt8(t),
      };
    });
    setTrades(seed);

    const iv = setInterval(() => {
      const delta = (Math.random() - 0.5) * mid * 0.0015;
      setTrades((prev) => [
        {
          id: idRef.current++,
          price: mid + delta,
          size: randSize(),
          isBuy: Math.random() > 0.48,
          time: fmt8(new Date()),
        },
        ...prev.slice(0, 7),
      ]);
    }, 2_100);

    return () => clearInterval(iv);
  }, [mid]);

  return (
    <div>
      <div
        className="flex items-center justify-between px-3 py-2 border-b"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="terminal-panel-title">Recent Trades</span>
      </div>

      <div className="px-2 py-1">
        <div
          className="mb-1 grid grid-cols-3 px-1.5"
          style={{
            fontSize: 9,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--t3)",
          }}
        >
          <span>Price</span>
          <span className="text-right">Size</span>
          <span className="text-right">Time</span>
        </div>

        {trades.map((t) => (
          <div
            key={t.id}
            className="grid grid-cols-3 items-center px-1.5"
            style={{ padding: "3px 6px" }}
          >
            <span
              className="num"
              style={{
                fontSize: 11,
                fontWeight: 500,
                color: t.isBuy ? "var(--green)" : "var(--red)",
              }}
            >
              {t.price.toFixed(2)}
            </span>
            <span
              className="num text-right"
              style={{ fontSize: 11, color: "var(--t2)" }}
            >
              {t.size.toFixed(4)}
            </span>
            <span
              className="num text-right"
              style={{ fontSize: 10, color: "var(--t3)" }}
            >
              {t.time}
            </span>
          </div>
        ))}

        {trades.length === 0 && (
          <div
            className="py-6 text-center"
            style={{ fontSize: 11, color: "var(--t3)" }}
          >
            Waiting for price...
          </div>
        )}
      </div>
    </div>
  );
}
