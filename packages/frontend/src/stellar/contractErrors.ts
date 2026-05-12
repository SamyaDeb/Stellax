/**
 * Friendly error messages for on-chain contract errors.
 *
 * Soroban surfaces contract panics as `Error(Contract, #N)` in the
 * transaction diagnostic events / result XDR.  This module maps the numeric
 * code for each contract to a human-readable string so toasts can surface
 * actionable information instead of raw `InvokeHostFunction…` names.
 *
 * Error code enums are sourced directly from the Rust contracts:
 *   • PerpError  — contracts/stellax-perp-engine/src/lib.rs
 *   • RiskError  — contracts/stellax-risk/src/lib.rs
 *   • SlpError   — contracts/stellax-slp-vault/src/lib.rs
 */

// ─── Perp-engine error codes ─────────────────────────────────────────────────
const PERP_ERRORS: Record<number, string> = {
  1:  "Already initialized",
  2:  "Unauthorized",
  3:  "Invalid configuration",
  4:  "Market already exists",
  5:  "Market not found",
  6:  "Market is inactive",
  7:  "Invalid leverage",
  8:  "Invalid position size",
  9:  "Slippage tolerance exceeded — try raising slippage or retrying",
  10: "Open interest limit reached for this market",
  11: "Position not found",
  12: "Not the position owner",
  13: "Insufficient margin",
  14: "Invalid action",
  15: "Math overflow",
  16: "Order not found",
  17: "Order expired",
  18: "Order condition not met",
  19: "Bracket order not found",
  20: "TWAP not found",
  21: "Iceberg order not found",
  22: "Invalid trailing-stop parameters",
  23: "Invalid order plan",
  24: "Order plan complete",
  25: "Insufficient liquidity in the SLP vault",
  26: "Trading is paused",
  27: "Too many open positions",
  28: "Oracle price is too old — the keeper may be down; retry in a moment",
  29: "Invalid oracle price",
  30: "SLP vault not configured — contact the protocol admin",
};

// ─── Risk-engine error codes ──────────────────────────────────────────────────
const RISK_ERRORS: Record<number, string> = {
  1:  "Already initialized",
  2:  "Unauthorized",
  3:  "Invalid configuration",
  4:  "Invalid position",
  5:  "Margin too low",
  6:  "Withdraw invalid",
  7:  "Position is not liquidatable",
  8:  "Math overflow",
  9:  "ADL unavailable",
  10: "Cooldown is still active",
  11: "Liquidations are paused",
};

// ─── SLP-vault error codes ────────────────────────────────────────────────────
const SLP_ERRORS: Record<number, string> = {
  1:  "Already initialized",
  2:  "Unauthorized",
  3:  "Invalid SLP vault configuration",
  4:  "Invalid amount",
  5:  "Insufficient shares",
  6:  "Math overflow",
  7:  "Vault cap exceeded — the SLP vault is full",
  8:  "Withdrawal cooldown has not elapsed yet",
  9:  "Skew cap exceeded — too much open interest relative to NAV",
  10: "Insufficient allowance",
  11: "Insufficient liquidity in the SLP vault",
  12: "Unauthorized HLP caller — contact the protocol admin",
};

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Which contract produced the error — used to select the right code map.
 * Callers that don't know the contract can pass "unknown" and all maps
 * will be searched in priority order (perp → risk → slp).
 */
export type ContractKind = "perpEngine" | "risk" | "slpVault" | "unknown";

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Extract a contract-error code from a Soroban diagnostic string.
 *
 * Soroban surfaces contract errors in several forms:
 *   "Error(Contract, #28)"
 *   "HostError: Value(Contract, #28)"
 *   "WasmVm: Error(Contract, #9)"
 * This function extracts the numeric code from any of those forms.
 */
export function parseContractErrorCode(raw: string): number | null {
  const m =
    /Error\(Contract,\s*#(\d+)\)/i.exec(raw) ??
    /\bContract\b.*?#(\d+)/i.exec(raw);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return isNaN(n) ? null : n;
}

/**
 * Return a friendly, user-facing message for a contract error.
 *
 * @param kind  Which contract threw the error.
 * @param raw   The raw error string from the RPC / executor.
 * @returns     A friendly string, or `null` if the error is unrecognised.
 */
export function decodeContractError(
  kind: ContractKind,
  raw: string,
): string | null {
  const code = parseContractErrorCode(raw);
  if (code === null) return null;

  if (kind === "perpEngine") return PERP_ERRORS[code] ?? null;
  if (kind === "risk")       return RISK_ERRORS[code] ?? null;
  if (kind === "slpVault")   return SLP_ERRORS[code]  ?? null;

  // "unknown" — search all maps in priority order
  return (
    PERP_ERRORS[code] ??
    RISK_ERRORS[code] ??
    SLP_ERRORS[code]  ??
    null
  );
}

/**
 * Wrap any thrown error into a user-facing message.
 *
 * Checks for a contract-error code first; falls back to the raw message.
 * This is the function to call in `catch` blocks inside page components.
 */
export function friendlyError(
  e: unknown,
  kind: ContractKind = "unknown",
): string {
  const raw = e instanceof Error ? e.message : String(e);
  return decodeContractError(kind, raw) ?? raw;
}
