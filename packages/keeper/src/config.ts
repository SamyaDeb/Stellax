import { config as loadDotenv } from "dotenv";

loadDotenv();

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function optNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name} is not a number: ${v}`);
  }
  return n;
}

function optBigInt(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`Env var ${name} is not an integer: ${v}`);
  }
}

function optBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v.toLowerCase() === "true" || v === "1";
}

function optList(name: string, fallback: string[] = []): string[] {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function optNumList(name: string, fallback: number[] = []): number[] {
  return optList(name).map((s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) {
      throw new Error(`Env var ${name} contains non-numeric: ${s}`);
    }
    return n;
  }).concat(optList(name).length === 0 ? fallback : []);
}

export interface KeeperConfig {
  rpcUrl: string;
  networkPassphrase: string;
  keeperSecretKey: string;
  contracts: {
    oracle: string;
    funding: string;
    perpEngine: string;
    risk: string;
    options: string;
    structured: string;
  };
  redstone: {
    gatewayUrl: string;
    feeds: string[];
    dataServiceId: string;
    uniqueSigners: number;
  };
  intervals: {
    oraclePushMs: number;
    fundingUpdateMs: number;
    liquidationScanMs: number;
    optionSettleMs: number;
    vaultRollMs: number;
  };
  workers: {
    oracle: boolean;
    funding: boolean;
    liquidation: boolean;
    options: boolean;
    vault: boolean;
  };
  perpMarketIds: number[];
  structuredVaultIds: string[];
  monitoring: {
    healthPort: number;
    logLevel: string;
    discordWebhook: string | null;
    telegramBotToken: string | null;
    telegramChatId: string | null;
  };
  thresholds: {
    minKeeperBalanceStroops: bigint;
    oracleStalenessAlertMs: number;
  };
}

export function loadConfig(): KeeperConfig {
  return {
    rpcUrl: opt("STELLAR_RPC_URL", "https://soroban-testnet.stellar.org"),
    networkPassphrase: opt(
      "STELLAR_NETWORK_PASSPHRASE",
      "Test SDF Network ; September 2015",
    ),
    keeperSecretKey: req("KEEPER_SECRET_KEY"),
    contracts: {
      oracle: req("ORACLE_CONTRACT_ID"),
      funding: req("FUNDING_CONTRACT_ID"),
      perpEngine: req("PERP_ENGINE_CONTRACT_ID"),
      risk: req("RISK_CONTRACT_ID"),
      options: opt("OPTIONS_CONTRACT_ID", ""),
      structured: opt("STRUCTURED_CONTRACT_ID", ""),
    },
    redstone: {
      gatewayUrl: opt(
        "REDSTONE_GATEWAY_URL",
        "https://oracle-gateway-1.a.redstone.finance",
      ),
      feeds: optList("REDSTONE_FEEDS", ["BTC", "ETH", "XLM"]),
      dataServiceId: opt("REDSTONE_DATA_SERVICE_ID", "redstone-primary-prod"),
      uniqueSigners: optNum("REDSTONE_UNIQUE_SIGNERS", 3),
    },
    intervals: {
      oraclePushMs: optNum("ORACLE_PUSH_INTERVAL_MS", 10_000),
      fundingUpdateMs: optNum("FUNDING_UPDATE_INTERVAL_MS", 3_600_000),
      liquidationScanMs: optNum("LIQUIDATION_SCAN_INTERVAL_MS", 5_000),
      optionSettleMs: optNum("OPTION_SETTLE_INTERVAL_MS", 3_600_000),
      vaultRollMs: optNum("VAULT_ROLL_INTERVAL_MS", 60_000),
    },
    workers: {
      oracle: optBool("WORKER_ORACLE_ENABLED", true),
      funding: optBool("WORKER_FUNDING_ENABLED", true),
      liquidation: optBool("WORKER_LIQUIDATION_ENABLED", true),
      options: optBool("WORKER_OPTIONS_ENABLED", true),
      vault: optBool("WORKER_VAULT_ENABLED", true),
    },
    perpMarketIds: optNumList("PERP_MARKET_IDS", [1]),
    structuredVaultIds: optList("STRUCTURED_VAULT_IDS"),
    monitoring: {
      healthPort: optNum("HEALTH_PORT", 9090),
      logLevel: opt("LOG_LEVEL", "info"),
      discordWebhook: process.env.ALERT_DISCORD_WEBHOOK || null,
      telegramBotToken: process.env.ALERT_TELEGRAM_BOT_TOKEN || null,
      telegramChatId: process.env.ALERT_TELEGRAM_CHAT_ID || null,
    },
    thresholds: {
      minKeeperBalanceStroops: optBigInt(
        "MIN_KEEPER_BALANCE_STROOPS",
        1_000_000_000n,
      ),
      oracleStalenessAlertMs: optNum("ORACLE_STALENESS_ALERT_MS", 60_000),
    },
  };
}
