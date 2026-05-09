import { createServer, type Server } from "node:http";
import type { BaseWorker, WorkerStatus } from "./worker.js";
import type { StellarClient } from "./stellar.js";
import { getLogger } from "./logger.js";
import { RwaNavPusher } from "./workers/rwa-nav-pusher.js";

export interface HealthDeps {
  port: number;
  workers: BaseWorker[];
  stellar: StellarClient;
  minBalanceStroops: bigint;
  oracleStalenessMs: number;
  oracleWorkerName: string;
}

interface HealthReport {
  ok: boolean;
  now: number;
  keeperPublicKey: string;
  keeperBalanceStroops: string;
  workers: WorkerStatus[];
  issues: string[];
}

/**
 * HTTP server exposing /health and /metrics endpoints.
 *
 *  - `/health` → 200 when all critical invariants hold, 503 otherwise.
 *  - `/metrics` → plain-text Prometheus-style counters (best-effort).
 *
 * The server never blocks on long-running operations: the balance check
 * is awaited with a 2s timeout and falls back to "unknown" on failure.
 */
export class HealthServer {
  private server: Server | null = null;
  private readonly log = getLogger("health");

  constructor(private readonly deps: HealthDeps) {}

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = createServer(async (req, res) => {
        try {
          if (!req.url) {
            res.statusCode = 400;
            res.end("bad request");
            return;
          }
          if (req.url === "/health") {
            const report = await this.buildReport();
            res.statusCode = report.ok ? 200 : 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(report, null, 2));
            return;
          }
          if (req.url === "/metrics") {
            const body = await this.buildMetrics();
            res.statusCode = 200;
            res.setHeader("content-type", "text/plain; version=0.0.4");
            res.end(body);
            return;
          }
          res.statusCode = 404;
          res.end("not found");
        } catch (err) {
          this.log.error({ err: (err as Error).message }, "health handler failed");
          res.statusCode = 500;
          res.end("internal error");
        }
      });
      this.server.listen(this.deps.port, () => {
        this.log.info({ port: this.deps.port }, "health server listening");
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async buildReport(): Promise<HealthReport> {
    const balance = await this.safeBalance();
    const workers = this.deps.workers.map((w) => w.getStatus());
    const issues: string[] = [];

    // Balance below threshold?
    if (balance !== null && balance < this.deps.minBalanceStroops) {
      issues.push(
        `keeper balance ${balance} stroops below threshold ${this.deps.minBalanceStroops}`,
      );
    }

    // Oracle staleness?
    const oracle = workers.find((w) => w.name === this.deps.oracleWorkerName);
    if (oracle) {
      const lastOk = oracle.lastSuccessAt;
      if (lastOk === null) {
        if (oracle.runCount > 0) {
          issues.push("oracle worker has never succeeded");
        }
      } else if (Date.now() - lastOk > this.deps.oracleStalenessMs) {
        issues.push(
          `oracle stale: ${(Date.now() - lastOk) / 1000}s since last success`,
        );
      }
    }

    // Any worker in a long error streak?
    for (const w of workers) {
      if (
        w.running &&
        w.errorCount > 0 &&
        w.lastError !== null &&
        w.lastSuccessAt === null &&
        w.runCount >= 3
      ) {
        issues.push(`${w.name} has ${w.errorCount} consecutive failures`);
      }
    }

    return {
      ok: issues.length === 0,
      now: Date.now(),
      keeperPublicKey: this.deps.stellar.publicKey(),
      keeperBalanceStroops: balance !== null ? balance.toString() : "unknown",
      workers,
      issues,
    };
  }

  private async buildMetrics(): Promise<string> {
    const workers = this.deps.workers.map((w) => w.getStatus());
    const lines: string[] = [];
    lines.push("# HELP stellax_keeper_worker_runs_total Total worker tick invocations.");
    lines.push("# TYPE stellax_keeper_worker_runs_total counter");
    for (const w of workers) {
      lines.push(`stellax_keeper_worker_runs_total{worker="${w.name}"} ${w.runCount}`);
    }
    lines.push("# HELP stellax_keeper_worker_errors_total Total worker tick errors.");
    lines.push("# TYPE stellax_keeper_worker_errors_total counter");
    for (const w of workers) {
      lines.push(`stellax_keeper_worker_errors_total{worker="${w.name}"} ${w.errorCount}`);
    }
    lines.push("# HELP stellax_keeper_worker_last_success_seconds Seconds since last success.");
    lines.push("# TYPE stellax_keeper_worker_last_success_seconds gauge");
    const now = Date.now();
    for (const w of workers) {
      const delta = w.lastSuccessAt ? (now - w.lastSuccessAt) / 1000 : -1;
      lines.push(
        `stellax_keeper_worker_last_success_seconds{worker="${w.name}"} ${delta}`,
      );
    }

    // ─── Tier 1 — RWA price metrics ────────────────────────────────────────
    const rwaPusher = this.deps.workers.find(
      (w): w is RwaNavPusher => w instanceof RwaNavPusher,
    );
    if (rwaPusher) {
      const m = rwaPusher.getMetrics();
      lines.push("# HELP rwa_price_last_push_age_seconds Seconds since last on-chain push per RWA symbol.");
      lines.push("# TYPE rwa_price_last_push_age_seconds gauge");
      for (const f of m.feeds) {
        const age = f.lastPushTs ? (now - f.lastPushTs) / 1000 : -1;
        lines.push(`rwa_price_last_push_age_seconds{symbol="${f.feedId}"} ${age}`);
      }
      lines.push("# HELP rwa_price_consecutive_failures Consecutive tick failures per RWA symbol.");
      lines.push("# TYPE rwa_price_consecutive_failures gauge");
      for (const f of m.feeds) {
        lines.push(
          `rwa_price_consecutive_failures{symbol="${f.feedId}"} ${f.consecutiveFailures}`,
        );
      }
      lines.push("# HELP rwa_price_pushes_total Total successful pushes per RWA symbol.");
      lines.push("# TYPE rwa_price_pushes_total counter");
      for (const f of m.feeds) {
        lines.push(`rwa_price_pushes_total{symbol="${f.feedId}"} ${f.totalSuccesses}`);
      }
      lines.push("# HELP rwa_price_failures_total Total tick failures per RWA symbol.");
      lines.push("# TYPE rwa_price_failures_total counter");
      for (const f of m.feeds) {
        lines.push(`rwa_price_failures_total{symbol="${f.feedId}"} ${f.totalFailures}`);
      }
      lines.push("# HELP rwa_price_skips_total Pushes skipped because deviation < min and not yet stale.");
      lines.push("# TYPE rwa_price_skips_total counter");
      for (const f of m.feeds) {
        lines.push(
          `rwa_price_skips_total{symbol="${f.feedId}"} ${f.totalSkippedNoChange}`,
        );
      }
      lines.push("# HELP rwa_price_last_pushed_usd Last on-chain price (USD) per RWA symbol.");
      lines.push("# TYPE rwa_price_last_pushed_usd gauge");
      for (const f of m.feeds) {
        const v = f.lastPushedPriceUsd ?? -1;
        lines.push(`rwa_price_last_pushed_usd{symbol="${f.feedId}"} ${v}`);
      }
    }

    return lines.join("\n") + "\n";
  }

  private async safeBalance(): Promise<bigint | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      try {
        return await this.deps.stellar.getAccountBalanceStroops();
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }
}
