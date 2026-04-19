import clsx from "clsx";
import type { ReactNode } from "react";

interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  width?: string;
}

interface TableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  empty?: ReactNode;
  dense?: boolean;
}

export function Table<T>({ columns, rows, rowKey, empty, dense = false }: TableProps<T>) {
  const pad = dense ? "py-1.5" : "py-2.5";
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-stella-border text-xs uppercase tracking-wide text-stella-muted">
            {columns.map((c) => (
              <th
                key={c.key}
                style={c.width !== undefined ? { width: c.width } : undefined}
                className={clsx("px-3 font-medium", pad, alignClass(c.align))}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                className="px-3 py-6 text-center text-sm text-stella-muted"
              >
                {empty ?? "No data"}
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-b border-stella-border/50 hover:bg-stella-border/20"
            >
              {columns.map((c) => (
                <td key={c.key} className={clsx("px-3", pad, alignClass(c.align), "num")}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function alignClass(align: Column<unknown>["align"]): string {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}
