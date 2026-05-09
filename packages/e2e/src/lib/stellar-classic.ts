// ── Classic Stellar operations helper ────────────────────────────────────────
//
// Provides `fundWithUsdc` which:
//   1. Establishes a USDC trustline on a fresh keypair via changeTrust
//   2. Acquires USDC by buying it from the DEX with XLM via pathPaymentStrictReceive
//
// This uses the classic Stellar Horizon API (not Soroban RPC) since trustlines
// and DEX operations are still classic protocol features on Stellar.

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const USDC_ASSET = new Asset("USDC", USDC_ISSUER);
export const XLM_ASSET = Asset.native();

interface StrictReceivePathRecord {
  source_asset_type: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  source_amount: string;
  path?: {
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
  }[];
}

type HorizonPathAsset = NonNullable<StrictReceivePathRecord["path"]>[number];

interface StrictReceivePathResponse {
  _embedded: {
    records: StrictReceivePathRecord[];
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function submitWithRetry(
  server: Horizon.Server,
  tx: ReturnType<TransactionBuilder["build"]>,
  label: string,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await server.submitTransaction(tx);
      return;
    } catch (err: unknown) {
      lastErr = err;
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status !== undefined && status >= 500 && attempt < 2) {
        await sleep((attempt + 1) * 2_000);
        continue;
      }
      break;
    }
  }
  throw lastErr ?? new Error(`${label} failed`);
}

function assetFromPathRecord(p: HorizonPathAsset): Asset {
  if (p.asset_type === "native") return Asset.native();
  if (!p.asset_code || !p.asset_issuer) {
    throw new Error(`Invalid Horizon path asset: ${JSON.stringify(p)}`);
  }
  return new Asset(p.asset_code, p.asset_issuer);
}

async function findXlmToUsdcPath(
  server: Horizon.Server,
  sourceAccount: string,
  amountUsdc: number,
): Promise<{ sendMaxXlm: string; path: Asset[] }> {
  const destAmount = amountUsdc.toFixed(7);
  const url = new URL("/paths/strict-receive", HORIZON_URL);
  url.searchParams.set("destination_asset_type", "credit_alphanum4");
  url.searchParams.set("destination_asset_code", "USDC");
  url.searchParams.set("destination_asset_issuer", USDC_ISSUER);
  url.searchParams.set("destination_amount", destAmount);
  url.searchParams.set("source_account", sourceAccount);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Horizon path lookup failed: HTTP ${res.status}`);
  const json = (await res.json()) as StrictReceivePathResponse;
  const match = json._embedded.records
    .filter((r) => r.source_asset_type === "native")
    .sort((a, b) => Number(a.source_amount) - Number(b.source_amount))[0];
  if (!match) throw new Error(`No XLM→USDC path for ${destAmount} USDC`);

  const sourceAmount = Number(match.source_amount);
  if (!Number.isFinite(sourceAmount) || sourceAmount <= 0) {
    throw new Error(`Invalid Horizon source amount: ${match.source_amount}`);
  }

  // Use generous slippage on testnet because liquidity is thin and changes often.
  const sendMaxXlm = Math.min(sourceAmount * 3, amountUsdc * 2).toFixed(7);
  const path = (match.path ?? []).map(assetFromPathRecord);

  // Ensure the account can still meet the reserve after paying sendMax.
  const account = await server.loadAccount(sourceAccount);
  const native = account.balances.find((b) => b.asset_type === "native");
  const xlmBalance = native ? Number(native.balance) : 0;
  if (Number(sendMaxXlm) > Math.max(0, xlmBalance - 2)) {
    throw new Error(
      `Insufficient XLM for USDC path: need up to ${sendMaxXlm}, available ${xlmBalance.toFixed(7)}`,
    );
  }

  return { sendMaxXlm, path };
}

/**
 * Acquire `amountUsdc` USDC for the given keypair.
 *
 * Sequence:
 *   1. `changeTrust` — creates USDC trustline (noop if already exists)
 *   2. `pathPaymentStrictReceive` — buy exactly `amountUsdc` USDC paying XLM
 *
 * DEX conditions on Stellar testnet (Circle USDC issuer, auth_required=false):
 *   - Asks exist at ~0.15 XLM / USDC.
 *   - We allow up to 0.30 XLM per USDC as sendMax.
 *   - The account must hold at least `amountUsdc * 0.30` XLM.
 */
export async function fundWithUsdc(
  kp: Keypair,
  amountUsdc: number,
): Promise<void> {
  const server = new Horizon.Server(HORIZON_URL, { allowHttp: false });

  // ── Step 1: establish USDC trustline ──────────────────────────────────────
  const account1 = await server.loadAccount(kp.publicKey());
  const trustTx = new TransactionBuilder(account1, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: USDC_ASSET,
        // default limit = max (922337203685.4775807 USDC)
      }),
    )
    .setTimeout(120)
    .build();
  trustTx.sign(kp);

  try {
    await submitWithRetry(server, trustTx, "USDC trustline transaction");
    // eslint-disable-next-line no-console
    console.log(`    ✓ USDC trustline established for ${kp.publicKey().slice(0, 8)}…`);
  } catch (err: unknown) {
    // Trustline already exists — safe to ignore.
    const msg = String(err);
    if (!msg.includes("op_already_exists") && !msg.includes("CHANGE_TRUST_ALREADY_EXIST")) {
      throw err;
    }
  }

  // ── Step 2: buy USDC with XLM ─────────────────────────────────────────────
  // Testnet liquidity is thin, so discover the best strict-receive path instead
  // of assuming direct XLM→USDC offers exist at a fixed rate.
  const { sendMaxXlm, path } = await findXlmToUsdcPath(
    server,
    kp.publicKey(),
    amountUsdc,
  );
  const destAmountStr = amountUsdc.toFixed(7);

  const account2 = await server.loadAccount(kp.publicKey());
  const buyTx = new TransactionBuilder(account2, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: XLM_ASSET,
        sendMax: sendMaxXlm,
        destination: kp.publicKey(),
        destAsset: USDC_ASSET,
        destAmount: destAmountStr,
        path,
      }),
    )
    .setTimeout(120)
    .build();
  buyTx.sign(kp);

  try {
    await submitWithRetry(server, buyTx, "USDC path payment transaction");
  } catch (err: unknown) {
    // Extract Horizon result codes from the AxiosError response body
    const horizonErr = err as {
      response?: { data?: { extras?: { result_codes?: unknown } } };
    };
    const codes = horizonErr?.response?.data?.extras?.result_codes;
    throw new Error(
      `fundWithUsdc path payment failed for ${kp.publicKey().slice(0, 8)}…\n` +
        `  sendMax=${sendMaxXlm} XLM, destAmount=${destAmountStr} USDC, pathHops=${path.length}\n` +
        `  Horizon result codes: ${JSON.stringify(codes)}\n` +
        `  Original: ${String(err)}`,
    );
  }

  // eslint-disable-next-line no-console
  console.log(
    `    ✓ acquired ${amountUsdc} USDC for ${kp.publicKey().slice(0, 8)}… (sendMax=${sendMaxXlm} XLM, pathHops=${path.length})`,
  );
}

/**
 * Query the classic USDC balance (in decimal, e.g. "10.0000000") for an account.
 * Returns "0.0000000" if the trustline or balance does not exist.
 */
export async function classicUsdcBalance(pubkey: string): Promise<string> {
  const server = new Horizon.Server(HORIZON_URL, { allowHttp: false });
  const account = await server.loadAccount(pubkey);
  for (const b of account.balances) {
    if (b.asset_type !== "native" && b.asset_type !== "liquidity_pool_shares") {
      const bal = b as Horizon.HorizonApi.BalanceLine<"credit_alphanum4" | "credit_alphanum12">;
      if (bal.asset_code === "USDC" && bal.asset_issuer === USDC_ISSUER) {
        return bal.balance;
      }
    }
  }
  return "0.0000000";
}
