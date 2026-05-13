/**
 * PriceChart — thin wrapper around AdvancedChart.
 *
 * AdvancedChart provides professional-grade charting with:
 *   • Candlestick / Line / Area / Baseline chart types
 *   • EMA(20, 50, 200) + SMA(200) overlays
 *   • Bollinger Bands
 *   • Volume histogram
 *   • RSI panel
 *   • Crosshair tooltip with OHLC + indicator values
 *   • Horizontal price line drawing
 *   • Timeframe selector
 *
 * Works for ALL tokens (crypto via Binance, RWA via oracle/indexer).
 */
import { AdvancedChart } from "@/charting/AdvancedChart";

interface Props {
  price?: bigint | undefined;
  timestamp?: bigint | undefined;
  title: string;
  asset?: string | null | undefined;
}

export function PriceChart(props: Props) {
  return <AdvancedChart {...props} />;
}
