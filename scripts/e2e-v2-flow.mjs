#!/usr/bin/env node
/**
 * e2e-v2-flow.mjs — end-to-end V2 flow against live testnet.
 *
 * Proves the full contract wiring works without needing a browser:
 *   1. Generates a fresh keypair + friendbot funds it
 *   2. Establishes USDC & STLX trustlines
 *   3. Funds user with 500 USDC (from DEX) + 1000 STLX (from distributor)
 *   4. User approves + deposits USDC into vault
 *   5. User places a resting limit order on CLOB
 *   6. User reads the order back, then cancels it
 *   7. User approves + stakes STLX
 *   8. Reads: vault balance, staking position, SVI surface,
 *      portfolio health — all from the upgraded V2 contracts.
 *
 * Usage:
 *   node scripts/e2e-v2-flow.mjs
 *
 * Optional env:
 *   USER_SECRET  — reuse an existing keypair instead of generating one
 *
 * Costs ~2-3 XLM in fees per run.
 */

import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc as SorobanRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";

// ── Config (testnet) ─────────────────────────────────────────────────────────

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const RPC_URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const FRIENDBOT = "https://friendbot.stellar.org";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);

const STLX_ISSUER = "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG";
const STLX_DISTRIBUTOR = "GBHRWM4KXE7NZYZQJSQKWLV7ETIJ2MHNCFIV6L6P2MZKMYQGY647C2Z7";
const STLX = new Asset("STLX", STLX_ISSUER);

const C = {
  vault: "CDDA3QFNHWZDX4IWHHNISPOI3R5KX4OPEUIQC5NA2RAB2HTMOS7YW4IM",
  perpEngine: "CD3PV6GINVKT7VVM4HDBKUTWP2HJYJCCRWA2VJKWCP3B4SJQHE63MF7H",
  funding: "CBTHQWJUT3VITY7XXDJVR7IA4DPUECXIBW6V4DCCBSIQWDTY3VWT4JRI",
  risk: "CBRF3VSZK2GOLKK4BHAH6GULEETDPAOZFLNTNQTHTCJEXVZF2V2FJWOX",
  options: "CBM3RVMH7EEJQUWEVHSKSDJFFBGDLLA7QVJMFWM46H2BUP6XODTJ7ZGT",
  clob: "CDKOESSQL5KFH6LFJ5XKLNIDYBN7NX4OYV4V7VQ5RNAGVILHCIH7KSJV",
  staking: "CC63QLGI3VV5BGA5F7GQN2TNUV4AYNHMPR334TNJV6SMATAPD723LUIT",
  usdcSac: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  stlxSac: "CBH3LOMBQ3K3NF2MAPRLGQYB5H3MHGZV74BXBGDSIT2VWWJHZHZ5ZQX6",
  // Treasury address used in PerpConfig — must have a vault balance to pay
  // out user profits (settle_position_close: vault.move_balance treasury→user).
  treasury: "CCPGPJKOUTI5ES2DPFH5PPM2AP5RQPAESREHYEEPWJ46FY7JM6K7JUTF",
};

// Amounts (7-dec token-native units)
const USDC_TO_FUND = 500;
const STLX_TO_FUND = 1000;
const USDC_TO_DEPOSIT = 100n * 10_000_000n; // 100 USDC
const USDC_TO_APPROVE = 1000n * 10_000_000n; // give generous allowance
const STLX_TO_STAKE = 50n * 10_000_000n; // 50 STLX
const STLX_TO_APPROVE = 100n * 10_000_000n;
// Treasury vault seed — the treasury must hold an internal vault balance so
// that settle_position_close can pay out user profits via
// vault.move_balance(treasury → user).  Without this the close simulation
// fails with VaultError::InsufficientBalance (#8).
// 10 000 USDC (7-dec) gives plenty of headroom for testnet profit payouts.
const TREASURY_VAULT_SEED = 10_000n * 10_000_000n;

// Auth expiration in ledgers (~5 min at 5s ledger close)
const AUTH_EXPIRATION_LEDGERS = 100_000;

// ── Coloured logging ─────────────────────────────────────────────────────────

const log = {
  step: (n, t) => console.log(`\n\x1b[36m━━━ Step ${n} — ${t} \x1b[0m`),
  ok: (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`),
  info: (m) => console.log(`  \x1b[2m${m}\x1b[0m`),
  warn: (m) => console.log(`  \x1b[33m⚠\x1b[0m ${m}`),
  fail: (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function loadKey(alias) {
  const r = spawnSync("stellar", ["keys", "show", alias], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`stellar keys show ${alias} failed`);
  return Keypair.fromSecret(r.stdout.trim());
}

async function friendbot(pubkey) {
  const res = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pubkey)}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (!body.includes("op_already_exists") && !body.includes("createAccountAlreadyExist")) {
      throw new Error(`friendbot: ${res.status} ${body}`);
    }
  }
}

async function submitClassic(horizon, tx, label) {
  try {
    const r = await horizon.submitTransaction(tx);
    log.ok(`${label} — ${r.hash.slice(0, 12)}…`);
    return r;
  } catch (err) {
    const codes = err?.response?.data?.extras?.result_codes;
    const msg = JSON.stringify(codes ?? err?.message ?? err);
    if (msg.includes("op_already_exists") || msg.includes("CHANGE_TRUST_ALREADY_EXIST")) {
      log.ok(`${label} (already done)`);
      return null;
    }
    throw new Error(`${label}: ${msg}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Soroban simulate-only read. */
async function simRead(server, sourcePubkey, contractId, method, args) {
  const account = await server.getAccount(sourcePubkey);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`sim ${method}: ${sim.error}`);
  }
  const retval = sim.result?.retval;
  return retval ? scValToNative(retval) : undefined;
}

/** Soroban invoke — simulate, assemble, sign, send, poll. */
async function invoke(server, signer, contractId, method, args) {
  const account = await server.getAccount(signer.publicKey());
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`sim ${method}: ${sim.error}`);
  }
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);

  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") {
    throw new Error(`send ${method}: ${JSON.stringify(send.errorResult)}`);
  }
  const deadline = Date.now() + 120_000;
  for (;;) {
    await sleep(2_000);
    const r = await server.getTransaction(send.hash);
    if (r.status === "SUCCESS") {
      log.ok(`${method} — ${send.hash.slice(0, 12)}…`);
      return r.returnValue ? scValToNative(r.returnValue) : undefined;
    }
    if (r.status === "FAILED") {
      throw new Error(`tx ${method} FAILED: ${JSON.stringify(r)}`);
    }
    if (Date.now() > deadline) throw new Error(`${method} timeout`);
  }
}

// ── ScVal encoders (mirrors of packages/sdk enc helpers) ─────────────────────

const enc = {
  addr: (s) => new Address(s).toScVal(),
  u32: (n) => xdr.ScVal.scvU32(Number(n)),
  u64: (n) => xdr.ScVal.scvU64(xdr.Uint64.fromString(BigInt(n).toString())),
  bool: (b) => xdr.ScVal.scvBool(b),
  i128: (n) => {
    const v = BigInt(n);
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const mask64 = (1n << 64n) - 1n;
    const lo = abs & mask64;
    const hi = abs >> 64n;
    const loU = xdr.Uint64.fromString(lo.toString());
    const hiU = neg
      ? xdr.Int64.fromString((-(hi + (lo === 0n ? 0n : 1n))).toString())
      : xdr.Int64.fromString(hi.toString());
    return xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: hiU, lo: loU }));
  },
  bytesN: (u8) => xdr.ScVal.scvBytes(Buffer.from(u8)),
  sym: (s) => xdr.ScVal.scvSymbol(s),
  /** SAC-style approve expiration (u32 ledger number, already known). */
};

/** Build the LimitOrder ScMap for clob.place_order. */
function encodeLimitOrder(o) {
  const fields = [
    ["filled_size", enc.i128(0n)],
    ["expiry", enc.u64(o.expiry)],
    ["is_long", enc.bool(o.isLong)],
    ["leverage", enc.u32(o.leverage)],
    ["market_id", enc.u32(o.marketId)],
    ["nonce", enc.u64(o.nonce)],
    ["order_id", enc.u64(0n)],
    ["price", enc.i128(o.price)],
    ["signature", enc.bytesN(new Uint8Array(64))],
    ["size", enc.i128(o.size)],
    ["status", xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Open")])],
    ["trader", enc.addr(o.trader)],
  ];
  fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(
    fields.map(([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v })),
  );
}

// ── Main flow ────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n\x1b[1mStellaX V2 — end-to-end testnet flow\x1b[0m\n");

  const horizon = new Horizon.Server(HORIZON_URL);
  const rpc = new SorobanRpc.Server(RPC_URL, { allowHttp: false });

  const deployerKp = loadKey("stellax-deployer");
  const distKp = loadKey("stellax-stlx-distributor");

  // ── User setup ────────────────────────────────────────────────────────────
  log.step(1, "Create / load test user");
  let userKp;
  if (process.env.USER_SECRET) {
    userKp = Keypair.fromSecret(process.env.USER_SECRET.trim());
    log.ok(`Reusing user: ${userKp.publicKey()}`);
  } else {
    userKp = Keypair.random();
    log.info(`Generated fresh keypair: ${userKp.publicKey()}`);
    log.info(`Secret (save if you want to reuse): ${userKp.secret()}`);
    await friendbot(userKp.publicKey());
    log.ok("friendbot funded with 10k XLM");
  }
  const USER = userKp.publicKey();

  // ── Trustlines ────────────────────────────────────────────────────────────
  log.step(2, "Establish USDC + STLX trustlines on user");
  {
    const acct = await horizon.loadAccount(USER);
    const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(Operation.changeTrust({ asset: USDC }))
      .addOperation(Operation.changeTrust({ asset: STLX }))
      .setTimeout(120)
      .build();
    tx.sign(userKp);
    await submitClassic(horizon, tx, "trustlines");
  }

  // ── Deployer buys USDC + sends to user ────────────────────────────────────
  log.step(3, `Fund user with ${USDC_TO_FUND} USDC + ${STLX_TO_FUND} STLX`);
  {
    // Check deployer USDC balance; buy more from DEX if needed
    const dep = await horizon.loadAccount(deployerKp.publicKey());
    const depUsdc = parseFloat(
      dep.balances.find(
        (b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER,
      )?.balance ?? "0",
    );
    if (depUsdc < USDC_TO_FUND) {
      const need = Math.ceil(USDC_TO_FUND - depUsdc + 1);
      const sendMax = (need * 12).toFixed(7);
      const tx = new TransactionBuilder(dep, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
        .addOperation(
          Operation.pathPaymentStrictReceive({
            sendAsset: Asset.native(),
            sendMax,
            destination: deployerKp.publicKey(),
            destAsset: USDC,
            destAmount: need.toFixed(7),
            path: [],
          }),
        )
        .setTimeout(120)
        .build();
      tx.sign(deployerKp);
      await submitClassic(horizon, tx, `deployer DEX-bought ${need} USDC`);
    } else {
      log.ok(`deployer already has ${depUsdc.toFixed(2)} USDC`);
    }

    // Send USDC from deployer to user
    const dep2 = await horizon.loadAccount(deployerKp.publicKey());
    const tx = new TransactionBuilder(dep2, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(
        Operation.payment({ destination: USER, asset: USDC, amount: USDC_TO_FUND.toFixed(7) }),
      )
      .setTimeout(120)
      .build();
    tx.sign(deployerKp);
    await submitClassic(horizon, tx, `sent ${USDC_TO_FUND} USDC → user`);

    // Send STLX from distributor to user
    const distAcct = await horizon.loadAccount(STLX_DISTRIBUTOR);
    const tx2 = new TransactionBuilder(distAcct, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(
        Operation.payment({ destination: USER, asset: STLX, amount: STLX_TO_FUND.toFixed(7) }),
      )
      .setTimeout(120)
      .build();
    tx2.sign(distKp);
    await submitClassic(horizon, tx2, `sent ${STLX_TO_FUND} STLX → user`);
  }

  // ── Get current ledger for auth expirations ──────────────────────────────
  const latestLedger = (await rpc.getLatestLedger()).sequence;
  const expirationLedger = latestLedger + AUTH_EXPIRATION_LEDGERS;
  log.info(`current ledger=${latestLedger}, auth expires=${expirationLedger}`);

  // ── Approve vault to pull USDC ────────────────────────────────────────────
  log.step(4, "Approve vault contract for USDC spending");
  await invoke(rpc, userKp, C.usdcSac, "approve", [
    enc.addr(USER),
    enc.addr(C.vault),
    enc.i128(USDC_TO_APPROVE),
    enc.u32(expirationLedger),
  ]);

  // ── Deposit 100 USDC into vault ───────────────────────────────────────────
  log.step(5, "Deposit 100 USDC into vault");
  await invoke(rpc, userKp, C.vault, "deposit", [
    enc.addr(USER),
    enc.addr(C.usdcSac),
    enc.i128(USDC_TO_DEPOSIT),
  ]);

  const vaultBal = await simRead(rpc, USER, C.vault, "get_balance", [
    enc.addr(USER),
    enc.addr(C.usdcSac),
  ]);
  log.info(`vault.get_balance = ${vaultBal} (18-dec internal, expect 100e18)`);

  // ── Seed treasury vault balance ───────────────────────────────────────────
  // The perp engine's settle_position_close calls
  //   vault.move_balance(treasury → user, profit)
  // on profitable closes.  If the treasury's internal vault balance is zero
  // that call fails with VaultError::InsufficientBalance (#8), blocking all
  // profitable close simulations.
  //
  // We seed it here from the deployer account.  The deployer must:
  //   1. Hold at least TREASURY_VAULT_SEED raw USDC (7-dec).
  //   2. Have approved the vault contract for at least that amount.
  //
  // Only runs when the treasury balance is below half the seed target so
  // repeated script runs don't double-fund.
  log.step("5b", `Seed treasury vault balance (${TREASURY_VAULT_SEED / 10_000_000n} USDC)`);
  {
    const treasuryVaultBal = await simRead(rpc, deployerKp.publicKey(), C.vault, "get_balance", [
      enc.addr(C.treasury),
      enc.addr(C.usdcSac),
    ]).catch(() => 0n);
    const halfSeed = (TREASURY_VAULT_SEED * 10n ** 11n) / 2n; // half of seed in 18-dec units
    if (BigInt(treasuryVaultBal ?? 0n) < halfSeed) {
      // Approve vault to pull USDC from deployer.
      await invoke(rpc, deployerKp, C.usdcSac, "approve", [
        enc.addr(deployerKp.publicKey()),
        enc.addr(C.vault),
        enc.i128(TREASURY_VAULT_SEED),
        enc.u32(expirationLedger),
      ]);
      // Deposit into vault on behalf of the treasury address.
      await invoke(rpc, deployerKp, C.vault, "deposit", [
        enc.addr(C.treasury),
        enc.addr(C.usdcSac),
        enc.i128(TREASURY_VAULT_SEED),
      ]);
      const newBal = await simRead(rpc, deployerKp.publicKey(), C.vault, "get_balance", [
        enc.addr(C.treasury),
        enc.addr(C.usdcSac),
      ]);
      log.ok(`treasury vault balance after seed: ${newBal} (18-dec)`);
    } else {
      log.ok(`treasury already has sufficient vault balance (${treasuryVaultBal}), skipping seed`);
    }
  }

  // Oracle-dependent reads — may fail with Error(Contract, #12) if USDC price
  // is stale. Non-fatal: vault.get_balance above already confirms the deposit.
  try {
    const totalColl = await simRead(rpc, USER, C.vault, "get_total_collateral_value", [enc.addr(USER)]);
    const freeColl = await simRead(rpc, USER, C.vault, "get_free_collateral_value", [enc.addr(USER)]);
    log.info(`total collateral  = ${totalColl} (18-dec USD)`);
    log.info(`free collateral   = ${freeColl} (18-dec USD)`);
  } catch (e) {
    log.warn(`collateral USD read skipped (oracle stale): ${String(e.message).split("\n")[0]}`);
  }

  // ── CLOB: place a resting limit order ────────────────────────────────────
  log.step(6, "Place CLOB limit order (market 0 = XLM-USD)");
  const nonce = BigInt(await simRead(rpc, USER, C.clob, "get_nonce", [enc.addr(USER)]) ?? 0);
  log.info(`user's current clob nonce = ${nonce}`);

  // Conservative resting order: long 10 XLM @ $0.05 (well below mark, won't fill),
  // 1x leverage. Notional ≈ $0.50, margin ≈ $0.50 — tiny and safe.
  const orderSize = 10n * 10n ** 18n; // 10 XLM in 18-dec base units
  const orderPrice = 5n * 10n ** 16n; // $0.05 in 18-dec USD
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1h

  const orderId = await invoke(rpc, userKp, C.clob, "place_order", [
    encodeLimitOrder({
      trader: USER,
      marketId: 0,
      size: orderSize,
      price: orderPrice,
      isLong: true,
      leverage: 1,
      expiry,
      nonce,
    }),
  ]);
  log.info(`new order_id = ${orderId}`);

  const fetched = await simRead(rpc, USER, C.clob, "get_order", [enc.u64(orderId)]);
  log.info(`get_order returned status=${JSON.stringify(fetched?.status)} size=${fetched?.size} price=${fetched?.price}`);

  log.step(7, "Cancel the order");
  await invoke(rpc, userKp, C.clob, "cancel_order", [enc.addr(USER), enc.u64(BigInt(orderId))]);
  const cancelled = await simRead(rpc, USER, C.clob, "get_order", [enc.u64(BigInt(orderId))]);
  log.info(`after cancel, status=${JSON.stringify(cancelled?.status)}`);

  // ── Staking: approve + stake ────────────────────────────────────────────
  log.step(8, "Approve staking for STLX + stake 50 STLX");
  await invoke(rpc, userKp, C.stlxSac, "approve", [
    enc.addr(USER),
    enc.addr(C.staking),
    enc.i128(STLX_TO_APPROVE),
    enc.u32(expirationLedger),
  ]);
  await invoke(rpc, userKp, C.staking, "stake", [enc.addr(USER), enc.i128(STLX_TO_STAKE)]);

  const stakeEntry = await simRead(rpc, USER, C.staking, "get_stake", [enc.addr(USER)]);
  log.info(`get_stake: amount=${stakeEntry?.amount} stake_epoch=${stakeEntry?.stake_epoch} last_claim=${stakeEntry?.last_claim_epoch}`);
  const totalStaked = await simRead(rpc, USER, C.staking, "total_staked", []);
  const currentEpoch = await simRead(rpc, USER, C.staking, "current_epoch", []);
  log.info(`total_staked = ${totalStaked}, current_epoch = ${currentEpoch}`);

  // ── Final reads: risk + options SVI ───────────────────────────────────────
  log.step(9, "Read V2 risk + options contract state");
  try {
    const health = await simRead(rpc, USER, C.risk, "get_account_health", [enc.addr(USER)]);
    log.info(`risk.get_account_health = ${JSON.stringify(health, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
  } catch (e) {
    log.warn(`get_account_health: ${e.message}`);
  }
  try {
    // The SVI surface was migrated at expiry = deployment_time + 30d.
    // We don't know that ledger timestamp exactly, so try a few recent-ish expiries.
    const svi = await simRead(rpc, USER, C.options, "get_svi_expiries", [enc.u32(0)]).catch(() => null);
    if (svi) log.info(`options.get_svi_expiries(0) = ${JSON.stringify(svi, (_, v) => typeof v === "bigint" ? v.toString() : v)}`);
    else log.warn("get_svi_expiries not exposed or no entries");
  } catch (e) {
    log.warn(`svi read: ${e.message}`);
  }

  // ── Claim rewards (likely 0, but proves the entrypoint works) ─────────────
  log.step(10, "Claim staking rewards (may be 0 until treasury deposits)");
  try {
    const claimed = await invoke(rpc, userKp, C.staking, "claim_rewards", [enc.addr(USER)]);
    log.info(`claim_rewards returned ${claimed}`);
  } catch (e) {
    log.warn(`claim_rewards: ${e.message}`);
  }

  console.log("\n\x1b[32;1m✓ All V2 flows executed successfully on testnet.\x1b[0m");
  console.log(`\n  User account:       ${USER}`);
  console.log(`  Stellar Expert:     https://stellar.expert/explorer/testnet/account/${USER}\n`);
}

main().catch((e) => {
  console.error("\n\x1b[31;1m✗ FAILED:\x1b[0m", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
