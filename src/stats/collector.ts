export interface Sample { statusCode?: number; durationMs: number; result: string; errorType?: string }
export class StatsCollector {
  private samples: Sample[] = [];
  add(sample: Sample) { this.samples.push(sample); }
  summary() {
    const n = this.samples.length; const durations = this.samples.map(s => s.durationMs).sort((a,b) => a-b);
    const count = (predicate: (s: Sample) => boolean) => this.samples.filter(predicate).length;
    const successful = count(s => s.result === 'success'); const fiveXX = count(s => (s.statusCode ?? 0) >= 500 && (s.statusCode ?? 0) < 600);
    const percentile = (p: number) => durations[Math.max(0, Math.ceil(n*p)-1)] ?? 0;
    return { requests: n, successful, fourXX: count(s => (s.statusCode ?? 0) >= 400 && (s.statusCode ?? 0) < 500), fiveXX,
      http500: count(s => s.statusCode === 500), timeouts: count(s => s.errorType === 'TIMEOUT'),
      successRate: n ? successful/n*100 : 0, fiveXXRate: n ? fiveXX/n*100 : 0,
      latency: { min: durations[0] ?? 0, avg: n ? durations.reduce((a,b) => a+b,0)/n : 0, p50: percentile(.5), p95: percentile(.95), max: durations[n-1] ?? 0 } };
  }
}
