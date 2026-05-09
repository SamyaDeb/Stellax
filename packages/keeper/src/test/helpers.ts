import { vi } from "vitest";
import type { StellarClient, InvokeResult, SimulateResult } from "../stellar.js";
import type { Alerter } from "../alert.js";

export function makeMockStellar(overrides: Partial<StellarClient> = {}): StellarClient {
  const base: StellarClient = {
    publicKey: () => "GTEST",
    async getAccountBalanceStroops() {
      return 10_000_000_000n;
    },
    async getLatestLedger() {
      return 1;
    },
    async simulate<T>() {
      return { returnValue: undefined as T, minResourceFee: 0n, latestLedger: 1 } satisfies SimulateResult<T>;
    },
    async invoke<T>() {
      return {
        hash: "deadbeef",
        status: "SUCCESS",
        returnValue: undefined as T,
        latestLedger: 1,
      } satisfies InvokeResult<T>;
    },
    async extendTtl() {
      return { hash: "deadbeef", latestLedger: 1 };
    },
  };
  return { ...base, ...overrides };
}

export function makeMockAlerter(): Alerter & { calls: Array<[string, string, string]> } {
  const calls: Array<[string, string, string]> = [];
  const alerter = {
    async send(sev: string, title: string, msg: string) {
      calls.push([sev, title, msg]);
    },
  } as unknown as Alerter & { calls: Array<[string, string, string]> };
  (alerter as unknown as { calls: Array<[string, string, string]> }).calls = calls;
  return alerter;
}

/** Silence pino during tests. */
export function silenceLogs(): void {
  vi.stubEnv("LOG_LEVEL", "silent");
}
