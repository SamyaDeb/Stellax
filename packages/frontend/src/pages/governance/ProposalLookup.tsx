import { useState } from "react";
import clsx from "clsx";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Button } from "@/ui/Button";
import { Input } from "@/ui/Input";
import { shortAddress } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import {
  qk,
  useProposal,
  useProposalApprovals,
} from "@/hooks/queries";

/**
 * Look up a specific proposal by numeric ID.
 * Shows proposer, action, target, approval count, and provides
 * Approve + Execute buttons.
 */
export function ProposalLookup() {
  const { run, pending, connected } = useTx();
  const [idInput, setIdInput] = useState("");

  const idBig = (() => {
    const t = idInput.trim();
    if (t === "" || !/^\d+$/.test(t)) return null;
    try { return BigInt(t); } catch { return null; }
  })();

  const proposalQ = useProposal(idBig);
  const approvalsQ = useProposalApprovals(idBig);

  const p = proposalQ.data;
  const approvals = approvalsQ.data ?? 0;

  async function approve() {
    if (!connected || idBig === null) return;
    await run(
      `Approve proposal #${idBig}`,
      (source) =>
        getClients().governor.approve(source, idBig, { sourceAccount: source }),
      { invalidate: [qk.proposalApprovals(idBig.toString())] },
    );
  }

  async function execute() {
    if (!connected || idBig === null) return;
    await run(
      `Execute proposal #${idBig}`,
      (source) =>
        getClients().governor.execute(idBig, { sourceAccount: source }),
      {
        invalidate: [
          qk.proposal(idBig.toString()),
          qk.governorIsPaused(),
        ],
      },
    );
  }

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Proposal lookup</CardTitle>
        <span className="text-xs text-stella-muted">by ID</span>
      </CardHeader>
      <div className="space-y-4 p-4">
        <Input
          label="Proposal ID"
          inputMode="numeric"
          placeholder="0"
          value={idInput}
          onChange={(e) => setIdInput(e.target.value)}
        />

        {idBig !== null && proposalQ.isError && (
          <p className="text-xs text-stella-short">Proposal not found or RPC error.</p>
        )}

        {p !== undefined && (
          <div className="space-y-3">
            <div className="space-y-1.5 rounded-md bg-stella-bg px-3 py-3 text-xs">
              <Row label="ID" value={`#${p.id.toString()}`} />
              <Row label="Proposer" value={shortAddress(p.proposer)} />
              <Row label="Target" value={shortAddress(p.targetContract)} />
              <Row
                label="Action"
                value={
                  Array.isArray(p.action)
                    ? String((p.action as string[])[0])
                    : String(p.action)
                }
              />
              <Row label="Approvals" value={approvals.toString()} />
              <Row
                label="Created"
                value={new Date(Number(p.createdAt) * 1000).toLocaleString()}
              />
            </div>

            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                className="flex-1"
                disabled={!connected || pending}
                onClick={() => void approve()}
              >
                Approve
              </Button>
              <Button
                variant="long"
                size="sm"
                className="flex-1"
                disabled={!connected || pending}
                onClick={() => void execute()}
              >
                Execute
              </Button>
            </div>

            <p className="text-[10px] text-stella-muted">
              timelock_ledgers=0 — proposals are executable immediately after
              reaching threshold (1 approval on testnet).
            </p>
          </div>
        )}

        {idBig === null && idInput.length > 0 && (
          <p className="text-xs text-stella-short">Enter a numeric proposal ID.</p>
        )}
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-stella-muted">{label}</span>
      <span className={clsx("num text-white")}>{value}</span>
    </div>
  );
}
