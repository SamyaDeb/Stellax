/**
 * Black-Scholes European option pricing.
 *
 * All inputs/outputs are plain JS numbers. The caller is responsible for
 * converting on-chain 18-decimal bigints before passing here.
 *
 * Formula reference: Black & Scholes (1973), Merton (1973).
 *
 * Risk-free rate default: 5% p.a. — a reasonable testnet proxy.
 */

const RISK_FREE_RATE = 0.05;
const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * Cumulative standard normal distribution N(x).
 * Abramowitz & Stegun polynomial approximation — max error ~7.5e-8.
 */
function normCdf(x: number): number {
  const t = 1.0 / (1.0 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.319381530 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf = Math.exp(-0.5 * x * x) / SQRT_2PI;
  const approx = 1.0 - pdf * poly;
  return x >= 0 ? approx : 1.0 - approx;
}

/**
 * Black-Scholes price for a European call or put.
 *
 * @param spot      Current underlying price (USD)
 * @param strike    Option strike price (USD)
 * @param timeYears Time to expiry in years (e.g. 7/365 for 7 days)
 * @param vol       Annualised implied volatility as a decimal (e.g. 0.8 for 80%)
 * @param isCall    true = call, false = put
 * @param rate      Risk-free rate as a decimal (defaults to RISK_FREE_RATE)
 * @returns         Option price per unit in USD; 0 if inputs are degenerate
 */
export function bsPrice(
  spot: number,
  strike: number,
  timeYears: number,
  vol: number,
  isCall: boolean,
  rate = RISK_FREE_RATE,
): number {
  if (spot <= 0 || strike <= 0 || timeYears <= 0 || vol <= 0) return 0;

  const sqrtT = Math.sqrt(timeYears);
  const d1 =
    (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * timeYears) /
    (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const discountedStrike = strike * Math.exp(-rate * timeYears);

  if (isCall) {
    return spot * normCdf(d1) - discountedStrike * normCdf(d2);
  } else {
    return discountedStrike * normCdf(-d2) - spot * normCdf(-d1);
  }
}

/**
 * Delta (sensitivity of option price to a $1 move in the underlying).
 * Used to estimate margin requirements.
 */
export function bsDelta(
  spot: number,
  strike: number,
  timeYears: number,
  vol: number,
  isCall: boolean,
  rate = RISK_FREE_RATE,
): number {
  if (spot <= 0 || strike <= 0 || timeYears <= 0 || vol <= 0)
    return isCall ? 0.5 : -0.5;
  const sqrtT = Math.sqrt(timeYears);
  const d1 =
    (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * timeYears) /
    (vol * sqrtT);
  return isCall ? normCdf(d1) : normCdf(d1) - 1;
}
