// ── Keypair management + friendbot funding ────────────────────────────────────
//
// e2e tests generate fresh keypairs per run so state is always isolated.
// Friendbot funds each with 10k XLM on testnet.

import { Keypair } from "@stellar/stellar-sdk";
import { spawnSync } from "node:child_process";

const FRIENDBOT_URL = "https://friendbot.stellar.org";

export async function friendbotFund(pubkey: string): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(pubkey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 400 "createAccountAlreadyExist" is fine — account already funded.
    if (body.includes("op_already_exists") || body.includes("createAccountAlreadyExist")) {
      return;
    }
    throw new Error(`friendbot funding failed for ${pubkey}: ${res.status} ${body}`);
  }
}

export async function newFundedKeypair(label = "user"): Promise<Keypair> {
  const kp = Keypair.random();
  await friendbotFund(kp.publicKey());
  // eslint-disable-next-line no-console
  console.log(`  ▸ funded ${label}: ${kp.publicKey()}`);
  return kp;
}

/** Load the deployer's secret key via stellar-cli. */
export function loadDeployerKeypair(identity = "stellax-deployer"): Keypair {
  const r = spawnSync("stellar", ["keys", "show", identity], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`stellar keys show ${identity} failed: ${r.stderr}`);
  }
  const secret = r.stdout.trim();
  if (!/^S[A-Z2-7]{55}$/.test(secret)) {
    throw new Error(`bad secret format from ${identity}: ${secret.slice(0, 8)}…`);
  }
  return Keypair.fromSecret(secret);
}
