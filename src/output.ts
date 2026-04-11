/**
 * Output formatting — JSON and human-readable.
 */

import { jsonMode } from "./cli";

export function emit(data: Record<string, any>, humanText?: string): void {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
  } else if (humanText) {
    console.log(humanText);
  } else {
    for (const [k, v] of Object.entries(data)) {
      console.log(`  ${k}: ${v}`);
    }
  }
}

export function success(message: string, data?: Record<string, any>): void {
  if (jsonMode) {
    console.log(JSON.stringify({ status: "ok", message, ...data }, null, 2));
  } else {
    console.log(message);
  }
}

export function error(message: string): void {
  if (jsonMode) {
    console.error(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
}

export function table(headers: string[], rows: any[][]): void {
  if (jsonMode) {
    const keys = headers.map((h) => h.toLowerCase().replace(/ /g, "_"));
    console.log(JSON.stringify(rows.map((row) => Object.fromEntries(keys.map((k, i) => [k, row[i]]))), null, 2));
    return;
  }

  // Simple text table
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length))
  );
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const fmtRow = (row: any[]) =>
    row.map((v, i) => String(v ?? "").padEnd(widths[i])).join("  ");

  console.log(fmtRow(headers));
  console.log(sep);
  rows.forEach((r) => console.log(fmtRow(r)));
}
