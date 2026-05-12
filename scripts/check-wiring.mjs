import * as sdk from "@stellar/stellar-sdk";
import * as SorobanRpcModule from "@stellar/stellar-sdk/rpc";

const { Contract, scValToNative, TransactionBuilder } = sdk;
const { Server } = SorobanRpcModule;

const rpc = new Server("https://soroban-testnet.stellar.org");
const SLP  = "CATD6NCR3DB2FWAH4NGAJURYWOOSS6YTGD62SQRA42YARTI36TNZFTW4";
const PERP = "CDK7LFB334FDFEB5VHFAPTDJGDMTAVXTJQDCCHC2SUMEYLR7ZDQEYYYZ";
const RISK = "CBL3YLKRHLSNIHGRACTXRDXIYKWA7CAANE3TA7YJUVQTLWHSI7KKADCF";
const DEPLOYER = "GAVFAXLV54GY7M4WZYIZQGP5NFRAJOUQA2LA4UDDUWVJCOIEPEMKYNQG";
const NET = "Test SDF Network ; September 2015";

async function simRead(contractId, method, args=[]) {
  const acct = await rpc.getAccount(DEPLOYER);
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(acct, { fee:"100", networkPassphrase: NET })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30).build();
  const sim = await rpc.simulateTransaction(tx);
  if ("error" in sim) return { error: sim.error };
  return { val: scValToNative(sim.result?.retval) };
}

const [cfg, perpSlp, riskSlp, authCallers] = await Promise.all([
  simRead(SLP,  "get_config"),
  simRead(PERP, "get_slp_vault"),
  simRead(RISK, "get_slp_vault"),
  simRead(SLP,  "get_authorized_callers"),
]);
const replacer = (_, v) => typeof v === "bigint" ? v.toString() : v;
console.log("SLP get_config:",           JSON.stringify(cfg, replacer, 2));
console.log("PERP get_slp_vault:",       JSON.stringify(perpSlp, replacer, 2));
console.log("RISK get_slp_vault:",       JSON.stringify(riskSlp, replacer, 2));
console.log("SLP authorized_callers:",   JSON.stringify(authCallers, replacer, 2));

// Summarise wiring issues
const slpCfg = cfg.val ?? {};
if (slpCfg.perp_engine !== PERP)
  console.error(`\n⚠ SLP config.perp_engine mismatch!\n  stored : ${slpCfg.perp_engine}\n  current: ${PERP}`);
const callers = authCallers.val ?? [];
if (!callers.includes(PERP))
  console.error(`\n⚠ New perp engine NOT in SLP authorized_callers!\n  callers: ${JSON.stringify(callers)}`);
