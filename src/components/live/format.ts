export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function formatPercent(value: number): string {
  return `${clampPercent(value)}%`;
}

export function formatScore(value: number): string {
  return `${Math.round(Math.min(value, 1) * 100)}%`;
}

export function formatDurationMs(startTs: number, endTs: number): string {
  return `${Math.max(0, endTs - startTs)} ms`;
}
