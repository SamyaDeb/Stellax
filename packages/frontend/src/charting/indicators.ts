/**
 * Technical indicator calculations for the advanced chart.
 * All functions operate on { time: number, value: number } arrays
 * and return arrays in the same format.
 */

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface IndicatorPoint {
  time: number;
  value: number;
}

/* ── Moving Averages ──────────────────────────────────────────────────────── */

/** Simple Moving Average */
export function sma(data: Candle[], period: number): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += data[i - j]!.close;
    out.push({ time: data[i]!.time, value: sum / period });
  }
  return out;
}

/** Exponential Moving Average */
export function ema(data: Candle[], period: number): IndicatorPoint[] {
  const k = 2 / (period + 1);
  const out: IndicatorPoint[] = [];
  let prevEma = data[0]!.close;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      prevEma = data[i]!.close * k + prevEma * (1 - k);
      continue;
    }
    prevEma = data[i]!.close * k + prevEma * (1 - k);
    out.push({ time: data[i]!.time, value: prevEma });
  }
  return out;
}

/* ── Bollinger Bands ─────────────────────────────────────────────────────── */

export interface BollingerBands {
  upper: IndicatorPoint[];
  middle: IndicatorPoint[];
  lower: IndicatorPoint[];
}

export function bollinger(data: Candle[], period = 20, multiplier = 2): BollingerBands {
  const upper: IndicatorPoint[] = [];
  const middle: IndicatorPoint[] = [];
  const lower: IndicatorPoint[] = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += data[i - j]!.close;
    const mean = sum / period;
    let variance = 0;
    for (let j = 0; j < period; j++) variance += Math.pow(data[i - j]!.close - mean, 2);
    const std = Math.sqrt(variance / period);
    upper.push({ time: data[i]!.time, value: mean + multiplier * std });
    middle.push({ time: data[i]!.time, value: mean });
    lower.push({ time: data[i]!.time, value: mean - multiplier * std });
  }
  return { upper, middle, lower };
}

/* ── RSI ──────────────────────────────────────────────────────────────────── */

export function rsi(data: Candle[], period = 14): IndicatorPoint[] {
  const out: IndicatorPoint[] = [];
  let gains = 0;
  let losses = 0;
  // Initial average
  for (let i = 1; i <= period; i++) {
    const change = data[i]!.close - data[i - 1]!.close;
    if (change > 0) gains += change;
    else losses += -change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period; i < data.length; i++) {
    const change = data[i]!.close - data[i - 1]!.close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    out.push({ time: data[i]!.time, value: avgLoss === 0 ? 100 : 100 - 100 / (1 + rs) });
  }
  return out;
}

/* ── MACD ────────────────────────────────────────────────────────────────── */

export interface MacdResult {
  macd: IndicatorPoint[];
  signal: IndicatorPoint[];
  histogram: IndicatorPoint[];
}

export function macd(
  data: Candle[],
  fast = 12,
  slow = 26,
  signal = 9,
): MacdResult {
  const closes = data.map((d) => d.close);
  const emaFast = _emaValues(closes, fast);
  const emaSlow = _emaValues(closes, slow);

  const macdLine: IndicatorPoint[] = [];
  for (let i = slow - 1; i < data.length; i++) {
    macdLine.push({ time: data[i]!.time, value: emaFast[i]! - emaSlow[i]! });
  }

  const signalLine = _emaValues(macdLine.map((m) => m.value), signal);
  const hist: IndicatorPoint[] = [];
  for (let i = signal - 1; i < macdLine.length; i++) {
    const idx = i + slow - 1;
    hist.push({
      time: data[idx]!.time,
      value: macdLine[i]!.value - signalLine[i]!,
    });
  }

  const sigOut: IndicatorPoint[] = [];
  for (let i = signal - 1; i < macdLine.length; i++) {
    const idx = i + slow - 1;
    sigOut.push({ time: data[idx]!.time, value: signalLine[i]! });
  }

  return { macd: macdLine, signal: sigOut, histogram: hist };
}

/** Internal EMA on number arrays */
function _emaValues(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (let i = 0; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/* ── VWAP ─────────────────────────────────────────────────────────────────── */

export function vwap(data: Candle[]): IndicatorPoint[] {
  let cumulativeTPV = 0;
  let cumulativeVol = 0;
  const out: IndicatorPoint[] = [];
  for (const c of data) {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume ?? 0;
    cumulativeTPV += tp * vol;
    cumulativeVol += vol;
    out.push({ time: c.time, value: cumulativeVol > 0 ? cumulativeTPV / cumulativeVol : tp });
  }
  return out;
}
