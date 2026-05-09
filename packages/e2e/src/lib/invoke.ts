// ── Generic Soroban contract invoke + simulate-read helper ────────────────────
//
// Uses stellar-sdk v15.  When the signer is the transaction source account
// Soroban uses "source-account credentials" for the entire invocation tree
// (including cross-contract calls like vault→token.transfer).  In that case
// `assembleTransaction` + `tx.sign(kp)` is sufficient.
//
// If, in the future, we need to sign for a different account than the tx source
// (e.g. multi-party auth), use `authorizeEntry` from @stellar/stellar-sdk per
// entry in the simulation result's auth array.

import {
  Contract,
  Keypair,
  TransactionBuilder,
  rpc as SorobanRpc,
  xdr,
} from "@stellar/stellar-sdk";

import { fromScVal } from "./scval.js";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 180_000;
const SEND_TIMEOUT_MS = 30_000;

/** Max retries when RPC returns TRY_AGAIN_LATER before entering the poll loop. */
const SEND_MAX_RETRIES = 8;
const SEND_RETRY_BACKOFF_MS = 4_000;

/**
 * Inclusion fee in stroops added on top of the Soroban resource fee.
 * BASE_FEE (100 stroops) is too low for testnet congestion — transactions
 * get dropped from the mempool before confirmation.  100 000 stroops (0.01 XLM)
 * matches what the frontend executor uses and ensures timely inclusion.
 */
const INCLUSION_FEE = "100000";

export interface NetworkCtx {
  rpcUrl: string;
  passphrase: string;
}

export function makeServer(ctx: NetworkCtx): SorobanRpc.Server {
  return new SorobanRpc.Server(ctx.rpcUrl, { allowHttp: false });
}

/**
 * Submit a contract invocation signed by the given Keypair.
 * The Keypair MUST be the same account that any `require_auth()` calls inside
 * the invocation tree expect — i.e. signer == user for vault/perp/options.
 * Returns the decoded native return value, or undefined for unit-returning fns.
 */
export async function invoke<T = unknown>(
  ctx: NetworkCtx,
  signer: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<T | undefined> {
  const server = makeServer(ctx);
  const account = await server.getAccount(signer.publicKey());
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: ctx.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(600)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(
      `[${method}@${short(contractId)}] simulate failed: ${sim.error}`,
    );
  }

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(signer);

  return _sendAndPoll<T>(server, prepared, method, contractId);
}

/** Simulate-only read: no submission, no signing needed. */
export async function simulateRead<T = unknown>(
  ctx: NetworkCtx,
  sourcePubkey: string,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
): Promise<T> {
  const server = makeServer(ctx);
  const account = await server.getAccount(sourcePubkey);
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: ctx.passphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(
      `[read ${method}@${short(contractId)}] simulate failed: ${sim.error}`,
    );
  }
  const retval = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse)
    .result?.retval;
  if (!retval) {
    throw new Error(`[read ${method}@${short(contractId)}] no retval`);
  }
  return fromScVal<T>(retval);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function _sendAndPoll<T>(
  server: SorobanRpc.Server,
  tx: ReturnType<TransactionBuilder["build"]>,
  method: string,
  contractId: string,
): Promise<T | undefined> {
  // ── Initial send with TRY_AGAIN_LATER backoff ──────────────────────────────
  let send = await _sendWithRetry(server, tx, method, contractId);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    let res: SorobanRpc.Api.GetTransactionResponse;
    try {
      res = await server.getTransaction(send.hash);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Testnet RPC can briefly fail while indexing a submitted transaction.
      if (Date.now() > deadline) {
        throw new Error(
          `[${method}@${short(contractId)}] poll failed hash=${send.hash}: ${msg}`,
        );
      }
      send = await resend(server, tx, send, method, contractId);
      continue;
    }
    if (res.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      console.log(`    ✓ ${method}@${short(contractId)} tx ${send.hash}`);
      const retVal = (res as SorobanRpc.Api.GetSuccessfulTransactionResponse)
        .returnValue;
      if (!retVal) return undefined;
      return fromScVal<T>(retVal);
    }
    if (res.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(
        `[${method}@${short(contractId)}] tx FAILED: ${JSON.stringify(res)}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `[${method}@${short(contractId)}] timeout hash=${send.hash}`,
      );
    }
    if (res.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      send = await resend(server, tx, send, method, contractId);
    }
  }
}

/**
 * Send with exponential backoff on TRY_AGAIN_LATER.
 * Soroban RPC can return TRY_AGAIN_LATER when the node is congested; in that
 * case the TX was NOT forwarded to validators, so polling would time out.
 * We retry the send up to SEND_MAX_RETRIES times before giving up.
 */
async function _sendWithRetry(
  server: SorobanRpc.Server,
  tx: ReturnType<TransactionBuilder["build"]>,
  method: string,
  contractId: string,
): Promise<SorobanRpc.Api.SendTransactionResponse> {
  for (let attempt = 0; attempt <= SEND_MAX_RETRIES; attempt++) {
    let send: SorobanRpc.Api.SendTransactionResponse;
    try {
      send = await sendTransactionWithTimeout(server, tx);
    } catch (err) {
      if (attempt === SEND_MAX_RETRIES) throw err;
      await sleep(SEND_RETRY_BACKOFF_MS * (attempt + 1));
      continue;
    }
    if (send.status === "ERROR") {
      throw new Error(
        `[${method}@${short(contractId)}] send failed: ${JSON.stringify(send.errorResult)}`,
      );
    }
    if (send.status === "TRY_AGAIN_LATER") {
      if (attempt === SEND_MAX_RETRIES) {
        throw new Error(
          `[${method}@${short(contractId)}] send TRY_AGAIN_LATER after ${SEND_MAX_RETRIES} attempts`,
        );
      }
      const delay = SEND_RETRY_BACKOFF_MS * (attempt + 1);
      console.log(
        `    ⚡ TRY_AGAIN_LATER for ${method} — retrying in ${delay}ms (attempt ${attempt + 1}/${SEND_MAX_RETRIES})`,
      );
      await sleep(delay);
      continue;
    }
    return send;
  }
  /* unreachable but TypeScript wants a return */
  throw new Error(`[${method}@${short(contractId)}] send loop exhausted`);
}

async function resend(
  server: SorobanRpc.Server,
  tx: ReturnType<TransactionBuilder["build"]>,
  previous: SorobanRpc.Api.SendTransactionResponse,
  method: string,
  contractId: string,
): Promise<SorobanRpc.Api.SendTransactionResponse> {
  let next: SorobanRpc.Api.SendTransactionResponse;
  try {
    next = await sendTransactionWithTimeout(server, tx);
  } catch {
    return previous;
  }
  if (next.status === "ERROR") {
    const code = next.errorResult?.result().switch().name;
    if (code === "txBadSeq") return previous;
    throw new Error(
      `[${method}@${short(contractId)}] resend failed: ${JSON.stringify(next.errorResult)}`,
    );
  }
  // TRY_AGAIN_LATER in resend: keep the previous handle and try again next poll cycle.
  if (next.status === "TRY_AGAIN_LATER") return previous;
  return next.hash === previous.hash ? previous : next;
}

async function sendTransactionWithTimeout(
  server: SorobanRpc.Server,
  tx: ReturnType<TransactionBuilder["build"]>,
): Promise<SorobanRpc.Api.SendTransactionResponse> {
  return Promise.race([
    server.sendTransaction(tx),
    sleep(SEND_TIMEOUT_MS).then(() => {
      throw new Error("sendTransaction timed out");
    }),
  ]);
}

function short(id: string): string {
  return id.slice(0, 8) + "…";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
