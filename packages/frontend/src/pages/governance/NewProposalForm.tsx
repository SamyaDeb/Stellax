import { useState } from "react";
import clsx from "clsx";
import type { GovernanceActionVariant } from "@stellax/sdk";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Button } from "@/ui/Button";
import { Input, Select } from "@/ui/Input";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { qk } from "@/hooks/queries";
import { config } from "@/config";

const ACTION_VARIANTS: { value: GovernanceActionVariant; label: string }[] = [
  { value: "PauseProtocol", label: "Pause Protocol" },
  { value: "UnpauseProtocol", label: "Unpause Protocol" },
  { value: "UpgradeContract", label: "Upgrade Contract" },
  { value: "TransferAdmin", label: "Transfer Admin" },
  { value: "UpdateMarketParams", label: "Update Market Params" },
];

/** Hex string → Uint8Array. Returns empty array if input is empty/invalid. */
function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "").replace(/\s/g, "");
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 2 !== 0) return new Uint8Array(0);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * New-proposal form. Submits propose() to the on-chain governor.
 * The returned proposal_id appears in the tx toast; copy it to look
 * it up with the ProposalLookup card below.
 */
export function NewProposalForm() {
  const { run, pending, connected } = useTx();
  const [action, setAction] = useState<GovernanceActionVariant>("PauseProtocol");
  const [target, setTarget] = useState(config.contracts.perpEngine);
  const [calldataHex, setCalldataHex] = useState("00");

  const calldataBytes = hexToBytes(calldataHex);
  const calldataValid = calldataHex.replace(/^0x/, "").replace(/\s/g, "").length % 2 === 0;

  const canSubmit = connected && !pending && target.length > 0 && calldataValid;

  async function submit() {
    if (!canSubmit) return;
    await run(
      `Propose ${action}`,
      (source) =>
        getClients().governor.propose(source, action, target, calldataBytes, {
          sourceAccount: source,
        }),
      {
        invalidate: [
          // Refresh the paused flag in case this is a pause/unpause proposal.
          qk.governorIsPaused(),
          // Refresh the governor version (may change on upgrade proposals).
          qk.governorVersion(),
        ],
      },
    );
  }

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>New proposal</CardTitle>
        <span className="text-xs text-stella-muted">Governor · propose()</span>
      </CardHeader>
      <div className="space-y-4 p-4">
        <Select
          label="Action"
          value={action}
          onChange={(e) => setAction(e.target.value as GovernanceActionVariant)}
          options={ACTION_VARIANTS.map((a) => ({ value: a.value, label: a.label }))}
        />

        <Input
          label="Target contract"
          placeholder="C..."
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />

        <Input
          label="Calldata (hex)"
          placeholder="00"
          value={calldataHex}
          onChange={(e) => setCalldataHex(e.target.value)}
        />
        {!calldataValid && (
          <p className="-mt-3 text-xs text-stella-short">
            Calldata must be valid hex (even number of digits).
          </p>
        )}

        <div className="rounded-xl bg-black/30 px-4 py-3 text-xs text-stella-muted border border-white/5">
          After submitting, copy the proposal ID from the toast and use the
          Proposal Lookup card to approve and execute it.
        </div>

        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={!canSubmit}
          onClick={() => void submit()}
        >
          {pending ? "Submitting…" : !connected ? "Connect wallet" : "Submit proposal"}
        </Button>
      </div>
    </Card>
  );
}
