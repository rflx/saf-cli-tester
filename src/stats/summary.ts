import type { StatsCollector } from './collector.js';
export function formatSummary(stats: ReturnType<StatsCollector['summary']>) {
  return [
    'Run completed', '', `Requests: ${stats.requests}`, `Successful: ${stats.successful}`,
    `4xx: ${stats.fourXX}`, `5xx: ${stats.fiveXX}`, `HTTP 500: ${stats.http500}`, `Timeouts: ${stats.timeouts}`,
    `Success rate: ${stats.successRate.toFixed(2)} %`, `5xx rate: ${stats.fiveXXRate.toFixed(2)} %`, '',
    'Latency:', ...Object.entries(stats.latency).map(([name,value]) => `${name}: ${value.toFixed(2)} ms`)
  ].join('\n');
}
