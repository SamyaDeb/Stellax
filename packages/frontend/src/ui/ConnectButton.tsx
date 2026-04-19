import { useWallet } from "@/wallet";
import { shortAddress } from "./format";
import { Button } from "./Button";

export function ConnectButton() {
  const { status, address, connect, disconnect, error } = useWallet();

  if (status === "connected" && address !== null) {
    return (
      <div className="flex items-center gap-2">
        <span className="num rounded-md bg-stella-surface px-2 py-1 text-xs text-stella-muted">
          {shortAddress(address)}
        </span>
        <Button variant="ghost" size="sm" onClick={disconnect}>
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error !== null && (
        <span className="text-xs text-stella-short" title={error}>
          Wallet error
        </span>
      )}
      <Button
        variant="primary"
        size="sm"
        onClick={() => void connect()}
        disabled={status === "connecting"}
      >
        {status === "connecting" ? "Connecting…" : "Connect Wallet"}
      </Button>
    </div>
  );
}
