import { ProtocolStatus } from "./governance/ProtocolStatus";
import { NewProposalForm } from "./governance/NewProposalForm";
import { ProposalLookup } from "./governance/ProposalLookup";
import { WalletRequiredBanner } from "@/ui/WalletRequiredBanner";

/**
 * Governance page — create proposals, approve, execute, and monitor
 * protocol pause status. Covers the full governor e2e test flow:
 *   propose() → approve() → execute() → isPaused()
 */
export function GovernancePage() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6">
      <header>
        <h1 className="text-2xl font-semibold text-white">Governance</h1>
        <p className="text-sm text-stella-muted">
          Multisig governance with timelock. Propose actions, collect approvals,
          then execute. Guardian can emergency-pause without a proposal.
        </p>
      </header>

      <WalletRequiredBanner />

      <div className="grid gap-4 lg:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <ProtocolStatus />
          <NewProposalForm />
        </div>
        <ProposalLookup />
      </div>
    </div>
  );
}
