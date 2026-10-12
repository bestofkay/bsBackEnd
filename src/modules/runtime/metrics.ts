/**
 * Lightweight in-memory metrics (no high-cardinality / PII labels).
 */

type Counters = Record<string, number>;

const counters: Counters = Object.create(null);

export function incMetric(name: string, by = 1): void {
  counters[name] = (counters[name] ?? 0) + by;
}

export function getMetricsSnapshot(): {
  counters: Counters;
  collected_at: string;
} {
  return {
    counters: { ...counters },
    collected_at: new Date().toISOString(),
  };
}

export function resetMetrics(): void {
  for (const key of Object.keys(counters)) delete counters[key];
}
