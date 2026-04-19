import type { Logger } from "pino";
import { getLogger } from "./logger.js";

export interface WorkerStatus {
  name: string;
  running: boolean;
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  runCount: number;
  errorCount: number;
}

/**
 * Base class for periodic keeper workers.
 *
 * Subclasses override `tick()` and optionally `onStart()` / `onStop()`.
 * The scheduler drives `start()` / `stop()` and calls `tick()` on an interval.
 * A single instance of a worker never runs `tick()` concurrently — if a tick
 * overruns the interval the next one is skipped (warning logged).
 */
export abstract class BaseWorker {
  abstract readonly name: string;
  protected log: Logger;

  protected running = false;
  protected timer: NodeJS.Timeout | null = null;
  protected inFlight = false;

  protected status: WorkerStatus;

  constructor() {
    this.log = getLogger("worker");
    this.status = {
      name: this.constructor.name,
      running: false,
      lastRunAt: null,
      lastSuccessAt: null,
      lastError: null,
      runCount: 0,
      errorCount: 0,
    };
  }

  abstract tick(): Promise<void>;
  protected async onStart(): Promise<void> {}
  protected async onStop(): Promise<void> {}

  getStatus(): WorkerStatus {
    return { ...this.status, name: this.name, running: this.running };
  }

  async start(intervalMs: number): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.status.running = true;
    this.log.info({ worker: this.name, intervalMs }, "worker starting");
    await this.onStart();
    const run = async () => {
      if (!this.running) return;
      if (this.inFlight) {
        this.log.warn({ worker: this.name }, "previous tick still running; skip");
        return;
      }
      this.inFlight = true;
      this.status.lastRunAt = Date.now();
      this.status.runCount += 1;
      try {
        await this.tick();
        this.status.lastSuccessAt = Date.now();
        this.status.lastError = null;
      } catch (err) {
        this.status.errorCount += 1;
        this.status.lastError = (err as Error).message;
        this.log.error(
          { worker: this.name, err: (err as Error).message },
          "tick failed",
        );
      } finally {
        this.inFlight = false;
      }
    };
    // Run once immediately, then on interval.
    void run();
    this.timer = setInterval(run, intervalMs);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.status.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.onStop();
    this.log.info({ worker: this.name }, "worker stopped");
  }
}
