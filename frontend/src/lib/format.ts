export function formatAddress(addr: string): string {
  if (typeof addr !== "string" || addr.length === 0) return "";
  return addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-6)}` : addr;
}

export function fmtAmount(amount: bigint | number): string {
  // Amounts are stored in base units (1 token = 10^7).
  return (Number(amount) / 1e7).toLocaleString("en-US", {
    maximumFractionDigits: 7,
  });
}

export function wholeToBaseUnits(whole: number): bigint {
  // The demo asset (SAC) uses 7 decimals, matching the fmtAmount divisor.
  return BigInt(Math.round(whole * 1e7));
}

export function escrowProgress(current: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const clamped = Math.max(0, Math.min(total, current));
  return Math.round((clamped / total) * 100);
}
