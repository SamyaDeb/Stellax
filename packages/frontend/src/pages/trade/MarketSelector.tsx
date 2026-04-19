import { Select } from "@/ui/Input";
import type { Market } from "@stellax/sdk";

interface Props {
  markets: readonly Market[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

export function MarketSelector({ markets, selectedId, onSelect }: Props) {
  const options = markets.map((m) => ({
    value: String(m.marketId),
    label: `${m.baseAsset}-${m.quoteAsset} · ${m.maxLeverage}x`,
  }));

  if (markets.length === 0) {
    return (
      <div className="text-xs text-stella-muted">No markets available</div>
    );
  }

  return (
    <Select
      label="Market"
      options={options}
      value={selectedId !== null ? String(selectedId) : ""}
      onChange={(e) => onSelect(Number(e.target.value))}
    />
  );
}
