import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { shortAddress } from "@/ui/format";
import { useBridgeValidators } from "@/hooks/queries";

/**
 * Static list of the bridge's validator set. Read-only; admin updates
 * happen via governance.
 */
export function ValidatorList() {
  const q = useBridgeValidators();
  const vals = q.data ?? [];

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Validator set</CardTitle>
        <span className="text-xs text-stella-muted">
          {vals.length} active
        </span>
      </CardHeader>
      <div className="p-4">
        {q.isLoading ? (
          <p className="text-sm text-stella-muted">Loading…</p>
        ) : vals.length === 0 ? (
          <p className="text-sm text-stella-muted">
            No validators registered.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {vals.map((addr) => (
              <li
                key={addr}
                className="flex items-center justify-between rounded-md bg-stella-bg px-3 py-2 text-sm"
              >
                <span className="text-stella-muted">Validator</span>
                <span className="num text-white">{shortAddress(addr)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
