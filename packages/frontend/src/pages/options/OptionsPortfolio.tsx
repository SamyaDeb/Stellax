import { useMemo } from "react";
import clsx from "clsx";
import { useQueries } from "@tanstack/react-query";
import type { OptionContract } from "@stellax/sdk";
import { Card, CardHeader, CardTitle } from "@/ui/Card";
import { Table } from "@/ui/Table";
import { Button } from "@/ui/Button";
import { formatUsd, shortAddress } from "@/ui/format";
import { useTx } from "@/wallet";
import { getClients } from "@/stellar/clients";
import { qk, usePrice } from "@/hooks/queries";
import { config, hasContract } from "@/config";
import { useSessionStore } from "@/stores/sessionStore";

type Role = "holder" | "writer";

interface Row {
  option: OptionContract;
  role: Role;
  underlying: string;
}

/**
 * Shows the user's option book split by role. Holders can exercise;
 * writers can cancel unsold options. Exercise is gated on expiry and
 * ITM check (displayed, not enforced — contract enforces).
 */
export function OptionsPortfolio() {
  const { run, pending, connected, address } = useTx();

  // Session-local option records (in-memory; resets on page refresh).
  const sessionOptions = useSessionStore((s) => s.options);

  const allIds = useMemo(
    () => sessionOptions.map((o) => ({ id: o.optionId, role: o.role as Role, underlying: o.underlying })),
    [sessionOptions],
  );

  const optionQueries = useQueries({
    queries: allIds.map(({ id }) => ({
      queryKey: qk.option(id.toString()),
      queryFn: () => getClients().options.getOption(id),
      enabled: hasContract(config.contracts.options),
      staleTime: 15_000,
    })),
  });

  const rows: Row[] = useMemo(() => {
    return allIds
      .map((item, i) => {
        const data = optionQueries[i]?.data;
        if (data === undefined) return null;
        return { option: data, role: item.role, underlying: item.underlying };
      })
      .filter((r): r is Row => r !== null);
  }, [allIds, optionQueries]);

  async function exercise(opt: OptionContract) {
    if (!address) return;
    await run(
      `Exercise #${opt.optionId.toString()}`,
      (source) =>
        getClients().options.exercise(source, opt.optionId, {
          sourceAccount: source,
        }),
      {
        invalidate: [
          qk.optionsList(address, "holder"),
          qk.option(opt.optionId.toString()),
          qk.vaultBalance(address),
        ],
      },
    );
  }

  async function buy(opt: OptionContract) {
    if (!address) return;
    await run(
      `Buy #${opt.optionId.toString()}`,
      (source) =>
        getClients().options.buyOption(source, opt.optionId, {
          sourceAccount: source,
        }),
      {
        invalidate: [
          qk.optionsList(address, "holder"),
          qk.option(opt.optionId.toString()),
          qk.vaultBalance(address),
        ],
      },
    );
  }

  return (
    <Card padded={false}>
      <CardHeader>
        <CardTitle>Your options</CardTitle>
        <span className="text-xs text-stella-muted">
          {rows.length} position{rows.length === 1 ? "" : "s"}
        </span>
      </CardHeader>
      <div className="p-4">
        {!connected ? (
          <p className="text-sm text-stella-muted">
            Connect wallet to see your option positions.
          </p>
        ) : (
          <Table
            rows={rows}
            rowKey={(r) => `${r.role}-${r.option.optionId.toString()}`}
            empty="No options. Write or buy an option to get started."
            columns={[
              {
                key: "id",
                header: "#",
                render: (r) => `#${r.option.optionId.toString()}`,
              },
              {
                key: "role",
                header: "Role",
                render: (r) => (
                  <span
                    className={clsx(
                      "rounded px-1.5 py-0.5 text-xs capitalize",
                      r.role === "writer"
                        ? "bg-stella-short/20 text-stella-short"
                        : "bg-stella-long/20 text-stella-long",
                    )}
                  >
                    {r.role}
                  </span>
                ),
              },
              {
                key: "type",
                header: "Type",
                render: (r) => (r.option.isCall ? "CALL" : "PUT"),
              },
              {
                key: "strike",
                header: "Strike",
                render: (r) => formatUsd(r.option.strike),
                align: "right",
              },
              {
                key: "size",
                header: "Size",
                render: (r) => r.option.size.toString(),
                align: "right",
              },
              {
                key: "premium",
                header: "Premium",
                render: (r) => formatUsd(r.option.premium),
                align: "right",
              },
              {
                key: "expiry",
                header: "Expiry",
                render: (r) =>
                  new Date(Number(r.option.expiry) * 1000).toLocaleDateString(),
              },
              {
                key: "counterparty",
                header: "CP",
                render: (r) =>
                  shortAddress(
                    r.role === "holder" ? r.option.writer : r.option.holder,
                  ),
              },
              {
                key: "actions",
                header: "",
                align: "right",
                render: (r) => <ActionCell row={r} pending={pending}
                  onExercise={() => void exercise(r.option)}
                  onBuy={() => void buy(r.option)} />,
              },
            ]}
          />
        )}
      </div>
    </Card>
  );
}

function ActionCell({
  row,
  pending,
  onExercise,
  onBuy,
}: {
  row: Row;
  pending: boolean;
  onExercise: () => void;
  onBuy: () => void;
}) {
  const { option, role, underlying } = row;
  const spot = usePrice(underlying || null).data?.price;
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const expired = option.expiry < nowSec;

  // Zero/unset holder address — option has not been purchased yet.
  const ZERO_ADDRESS =
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const isUnsold = !option.holder || option.holder === ZERO_ADDRESS;

  if (option.isExercised) {
    return <span className="text-xs text-stella-muted">exercised</span>;
  }

  if (role === "writer") {
    if (expired) return <span className="text-xs text-stella-muted">expired</span>;
    return (
      <div className="flex justify-end gap-1.5">
        {/* Writers can buy their own unsold option on testnet (useful for
            single-wallet e2e testing — confirms buy_option contract call). */}
        {isUnsold && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={onBuy}
            title="Buy this option (testnet: writer buying own unsold option)">
            Buy
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={true}
          title="Cancel is not yet available on-chain"
          className="cursor-not-allowed opacity-40"
        >
          Cancel
        </Button>
      </div>
    );
  }

  // Holder
  const itm =
    spot === undefined
      ? false
      : option.isCall
        ? spot > option.strike
        : spot < option.strike;

  if (expired) return <span className="text-xs text-stella-muted">expired</span>;

  return (
    <div className="flex justify-end gap-1.5">
      <Button variant="ghost" size="sm" disabled={pending} onClick={onBuy}>
        Buy
      </Button>
      <Button
        variant={itm ? "long" : "ghost"}
        size="sm"
        disabled={pending}
        onClick={onExercise}
      >
        Exercise
      </Button>
    </div>
  );
}

