/**
 * Shared runtime constants that mirror on-chain contract parameters.
 *
 * Update these values here if the corresponding Rust constants in the
 * deployed contracts change, so all UI estimates stay consistent.
 */

/**
 * Maintenance margin ratio used for client-side liquidation price estimates.
 *
 * Mirrors `MAINTENANCE_MARGIN_RATIO` in the `risk` Rust contract (0.5 %).
 * The contract does not currently expose this value through a query endpoint.
 * When `useRiskParams()` is available this constant should be replaced with
 * the live on-chain value.
 */
export const MAINTENANCE_MARGIN_RATIO = 0.005;
