import type { Logger } from "pino";
import { getLogger } from "./logger.js";
import type { KeeperConfig } from "./config.js";

export type Severity = "info" | "warn" | "critical";

/**
 * Dispatches alerts to configured channels (Discord, Telegram).
 *
 * Designed to be fire-and-forget: failures in alert delivery never throw
 * back into worker logic. All errors are logged and ignored.
 */
export class Alerter {
  private readonly log: Logger;
  constructor(private readonly cfg: KeeperConfig["monitoring"]) {
    this.log = getLogger("alert");
  }

  async send(severity: Severity, title: string, message: string): Promise<void> {
    const line = `[${severity.toUpperCase()}] ${title} — ${message}`;
    if (severity === "critical") this.log.error(line);
    else if (severity === "warn") this.log.warn(line);
    else this.log.info(line);

    const targets: Promise<void>[] = [];
    if (this.cfg.discordWebhook) {
      targets.push(this.sendDiscord(severity, title, message));
    }
    if (this.cfg.telegramBotToken && this.cfg.telegramChatId) {
      targets.push(this.sendTelegram(severity, title, message));
    }
    // Fail-silent: we only log errors.
    await Promise.allSettled(targets);
  }

  private async sendDiscord(
    severity: Severity,
    title: string,
    message: string,
  ): Promise<void> {
    if (!this.cfg.discordWebhook) return;
    try {
      const res = await fetch(this.cfg.discordWebhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content: `**[${severity}]** **${title}**\n${message}`,
        }),
      });
      if (!res.ok) {
        this.log.warn(
          { status: res.status },
          "discord webhook returned non-2xx",
        );
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "discord alert failed");
    }
  }

  private async sendTelegram(
    severity: Severity,
    title: string,
    message: string,
  ): Promise<void> {
    const token = this.cfg.telegramBotToken;
    const chat = this.cfg.telegramChatId;
    if (!token || !chat) return;
    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: `[${severity.toUpperCase()}] ${title}\n${message}`,
        }),
      });
      if (!res.ok) {
        this.log.warn(
          { status: res.status },
          "telegram api returned non-2xx",
        );
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "telegram alert failed");
    }
  }
}
