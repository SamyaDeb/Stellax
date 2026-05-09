/**
 * Phase X / Ω5 — StellaX Telegram bot (live SDK wiring).
 *
 * Long-polls Telegram and answers a small set of read-only commands by
 * calling the StellaX SDK clients against Soroban RPC. The bot never signs
 * a transaction — its `InvocationExecutor` only implements `simulate`.
 *
 * Required env vars:
 *   • TELEGRAM_BOT_TOKEN     token from BotFather.
 *   • SOROBAN_RPC_URL        e.g. https://soroban-testnet.stellar.org
 *   • NETWORK_PASSPHRASE     e.g. "Test SDF Network ; September 2015"
 *   • STELLAX_ORACLE_ADDR    oracle contract address.
 *   • STELLAX_PERP_ADDR      perp engine contract address.
 *   • STELLAX_FUNDING_ADDR   funding contract address.
 *   • STELLAX_RISK_ADDR      risk contract address.
 *
 * Supported commands:
 *   /start                 onboarding hint.
 *   /help                  list commands.
 *   /price <symbol>        oracle spot price for a feed (XLM, BTC, ETH …).
 *   /position <addr>       open perp positions for a Stellar G-address.
 *   /funding <market_id>   current hourly funding rate for a market.
 *   /health <addr>         account health snapshot for an address.
 */

import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import {
  FundingClient,
  OracleClient,
  PerpEngineClient,
  RiskClient,
  type InvocationExecutor,
  type InvokeOptions,
  type InvokeResult,
  type SimulateOptions,
  type SimulateResult,
} from "@stellax/sdk";

interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  from?: { id: number; username?: string };
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

const TOKEN = requireEnv("TELEGRAM_BOT_TOKEN");
const RPC_URL = requireEnv("SOROBAN_RPC_URL");
const NETWORK_PASSPHRASE = requireEnv("NETWORK_PASSPHRASE");
const ORACLE_ADDR = requireEnv("STELLAX_ORACLE_ADDR");
const PERP_ADDR = requireEnv("STELLAX_PERP_ADDR");
const FUNDING_ADDR = requireEnv("STELLAX_FUNDING_ADDR");
const RISK_ADDR = requireEnv("STELLAX_RISK_ADDR");

const POLL_TIMEOUT_S = 25;
const TG_API = `https://api.telegram.org/bot${TOKEN}`;

// Deterministic burn key used as a non-signing simulation source.
const SIMULATION_SOURCE = Keypair.fromRawEd25519Seed(Buffer.alloc(32)).publicKey();

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

/**
 * Read-only `InvocationExecutor`. `simulate` builds an unsigned tx with a
 * burn-address source, asks Soroban RPC to simulate it, and returns the
 * decoded `retval`. `invoke` always rejects — the bot signs nothing.
 */
class ReadOnlyExecutor implements InvocationExecutor {
  private readonly server: rpc.Server;

  constructor(rpcUrl: string) {
    this.server = new rpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith("http://"),
    });
  }

  async simulate(
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    opts: SimulateOptions = {},
  ): Promise<SimulateResult> {
    const sourceKey = opts.sourceAccount ?? SIMULATION_SOURCE;
    // For an arbitrary opt-in source we need a real ledger sequence; for the
    // burn address we just fabricate one — Soroban only inspects sequence
    // for write paths.
    const account = opts.sourceAccount
      ? await this.server.getAccount(sourceKey)
      : new Account(sourceKey, "0");
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call(method, ...args))
      .setTimeout(60)
      .build();
    const sim = await this.server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`simulate(${method}) failed: ${sim.error}`);
    }
    return {
      returnValue: sim.result?.retval,
      minResourceFee: BigInt(sim.minResourceFee ?? "0"),
      latestLedger: sim.latestLedger,
    };
  }

  invoke(
    _contractId: string,
    method: string,
    _args: xdr.ScVal[],
    _opts: InvokeOptions,
  ): Promise<InvokeResult> {
    return Promise.reject(new Error(`invoke(${method}): bot is read-only`));
  }
}

const exec = new ReadOnlyExecutor(RPC_URL);
const oracle = new OracleClient(ORACLE_ADDR, exec);
const perp = new PerpEngineClient(PERP_ADDR, exec);
const funding = new FundingClient(FUNDING_ADDR, exec);
const risk = new RiskClient(RISK_ADDR, exec);

const PRECISION = 10n ** 18n;

function fmtUsd(v: bigint): string {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const whole = abs / PRECISION;
  const frac = ((abs % PRECISION) * 100n) / PRECISION;
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${wholeStr}.${String(frac).padStart(2, "0")}`;
}

function fmtRatePct(v: bigint): string {
  // funding rate is 18-dec (1e18 = 100%). Render as % with 4 decimals.
  const pct = (Number(v) / 1e18) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(4)}%`;
}

async function sendMessage(chatId: number, text: string): Promise<void> {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  }).catch((e) => console.error("[tg] sendMessage failed", e));
}

async function handleCommand(msg: TgMessage): Promise<void> {
  const text = (msg.text ?? "").trim();
  if (!text.startsWith("/")) return;
  const [raw, ...args] = text.split(/\s+/);
  const cmd = (raw ?? "").toLowerCase().split("@")[0];

  try {
    switch (cmd) {
      case "/start":
        await sendMessage(
          msg.chat.id,
          "*StellaX bot* — try `/price XLM`, `/position <G-addr>`, `/funding 0`, `/health <G-addr>`, or `/help`.",
        );
        return;
      case "/help":
        await sendMessage(
          msg.chat.id,
          [
            "Commands:",
            "• `/price <symbol>` — oracle spot price",
            "• `/position <addr>` — open perp positions",
            "• `/funding <market_id>` — hourly funding rate",
            "• `/health <addr>` — account health",
          ].join("\n"),
        );
        return;
      case "/price": {
        const sym = args[0]?.toUpperCase() ?? "XLM";
        const p = await oracle.getPrice(sym);
        const ts = new Date(Number(p.writeTimestamp) * 1000).toISOString();
        await sendMessage(
          msg.chat.id,
          `*${sym}*: ${fmtUsd(p.price)}\n_updated_ ${ts}`,
        );
        return;
      }
      case "/position": {
        const addr = args[0] ?? "";
        if (!/^G[A-Z2-7]{55}$/.test(addr)) {
          await sendMessage(msg.chat.id, "Invalid Stellar G-address.");
          return;
        }
        const positions = await perp.getUserPositions(addr);
        if (positions.length === 0) {
          await sendMessage(
            msg.chat.id,
            "No open positions reported by the SDK (live indexer required for full enumeration).",
          );
          return;
        }
        const lines = positions.slice(0, 10).map((p) => {
          const side = p.isLong ? "LONG" : "SHORT";
          const sizeAbs = p.size < 0n ? -p.size : p.size;
          return `• mkt:${p.marketId} ${side} size=${fmtUsd(sizeAbs)} entry=${fmtUsd(p.entryPrice)}`;
        });
        await sendMessage(
          msg.chat.id,
          `*${positions.length}* open position${positions.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
        );
        return;
      }
      case "/funding": {
        const marketId = Number(args[0] ?? "0");
        if (!Number.isInteger(marketId) || marketId < 0) {
          await sendMessage(msg.chat.id, "Usage: `/funding <market_id>`");
          return;
        }
        const rate = await funding.getCurrentFundingRate(marketId);
        await sendMessage(
          msg.chat.id,
          `Funding rate (mkt ${marketId}): *${fmtRatePct(rate)}* / hr`,
        );
        return;
      }
      case "/health": {
        const addr = args[0] ?? "";
        if (!/^G[A-Z2-7]{55}$/.test(addr)) {
          await sendMessage(msg.chat.id, "Invalid Stellar G-address.");
          return;
        }
        const h = await risk.getAccountHealth(addr);
        await sendMessage(
          msg.chat.id,
          [
            `*Account health* \`${addr.slice(0, 8)}…\``,
            `Equity: ${fmtUsd(h.equity)}`,
            `Margin required: ${fmtUsd(h.totalMarginRequired)}`,
            `Free collateral: ${fmtUsd(h.freeCollateral)}`,
            `Liquidatable: ${h.liquidatable ? "⚠️ yes" : "no"}`,
          ].join("\n"),
        );
        return;
      }
      default:
        await sendMessage(msg.chat.id, `Unknown command: \`${cmd}\`. Try /help.`);
    }
  } catch (e) {
    await sendMessage(
      msg.chat.id,
      `_error_: ${(e as Error).message.slice(0, 180)}`,
    );
  }
}

async function pollLoop(): Promise<void> {
  let offset = 0;
  console.log("[tg] long-polling started");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const url = `${TG_API}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.error("[tg] getUpdates non-200:", res.status);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      const json = (await res.json()) as { ok: boolean; result: TgUpdate[] };
      for (const u of json.result) {
        offset = Math.max(offset, u.update_id + 1);
        if (u.message) await handleCommand(u.message);
      }
    } catch (e) {
      console.error("[tg] poll error", e);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

pollLoop().catch((e) => {
  console.error("[tg] fatal", e);
  process.exit(1);
});
