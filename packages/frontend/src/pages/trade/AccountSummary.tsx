import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { formatUsd, shortAddress } from "@/ui/format";
import {
  useAccountEquity,
  useFreeCollateral,
  useMaintenanceMargin,
  useVaultBalance,
} from "@/hooks/queries";

interface Props {
  address: string | null;
}

export function AccountSummary({ address }: Props) {
  const vault = useVaultBalance(address);
  const equity = useAccountEquity(address);
  const free = useFreeCollateral(address);
  const maint = useMaintenanceMargin(address);

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        {address !== null && (
          <span className="num text-xs text-stella-muted">{shortAddress(address)}</span>
        )}
      </CardHeader>
      <div className="grid grid-cols-2 gap-3 p-4 text-sm">
        <Cell label="Equity" value={formatMaybe(equity.data)} />
        <Cell label="Free collateral" value={formatMaybe(free.data)} />
        <Cell label="Vault free" value={formatMaybe(vault.data?.free)} />
        <Cell label="Vault locked" value={formatMaybe(vault.data?.locked)} />
        <Cell label="Maintenance margin" value={formatMaybe(maint.data)} span={2} />
      </div>
      {address === null && (
        <p className="px-4 pb-4 text-xs text-stella-muted">
          Connect a wallet to view your account.
        </p>
      )}
    </Card>
  );
}

function formatMaybe(v: bigint | undefined): string {
  return v === undefined ? "—" : formatUsd(v);
}

function Cell({ label, value, span = 1 }: { label: string; value: string; span?: 1 | 2 }) {
  return (
    <div className={span === 2 ? "col-span-2" : undefined}>
      <div className="text-xs text-stella-muted">{label}</div>
      <div className="num mt-0.5 text-base text-white">{value}</div>
    </div>
  );
}
