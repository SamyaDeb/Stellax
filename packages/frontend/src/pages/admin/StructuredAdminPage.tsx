/**
 * StructuredAdminPage — internal epoch management for the covered-call
 * structured vault. Not linked in the main nav; accessible only at
 * /admin/structured.
 *
 * The structured vault is an internal protocol mechanism in the unified
 * HLP model. Its premium is swept into the SLP vault by the keeper after
 * each epoch roll. This page lets the team monitor and manually trigger
 * epoch rolls if the keeper is offline.
 */

import { StructuredVaultCard } from "../vaults/StructuredVaultCard";
import { EpochHistory } from "../vaults/EpochHistory";

export function StructuredAdminPage() {
  return (
    <div className="mx-auto max-w-[900px] space-y-8 px-4 py-8">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-white tracking-tight">
            Structured Vault
          </h1>
          <span className="rounded border border-stella-accent/40 bg-stella-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-stella-accent">
            Admin
          </span>
        </div>
        <p className="text-sm text-stella-muted max-w-xl">
          Internal epoch management. Covered-call premium is automatically swept
          into the SLP vault by the keeper after each epoch roll. Use this page
          to monitor epoch state or trigger a manual roll if the keeper is
          offline.
        </p>
        <p className="text-[11px] text-stella-muted/60">
          This page is not linked in the main navigation.
        </p>
      </header>

      <StructuredVaultCard />

      <EpochHistory />
    </div>
  );
}
