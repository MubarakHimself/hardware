const SEARCH_DURATION_BUCKETS_SECONDS = [
  0.01,
  0.025,
  0.05,
  0.1,
  0.25,
  0.5,
  1,
  2.5,
  5,
] as const;

interface SearchMetricState {
  bucketCounts: number[];
  count: number;
  inFlight: number;
  sum: number;
}

const processState = globalThis as typeof globalThis & {
  __hardwareSearchMetricState?: SearchMetricState;
};

function searchState(): SearchMetricState {
  processState.__hardwareSearchMetricState ??= {
    bucketCounts: SEARCH_DURATION_BUCKETS_SECONDS.map(() => 0),
    count: 0,
    inFlight: 0,
    sum: 0,
  };
  return processState.__hardwareSearchMetricState;
}

export interface QueueDepthMetric {
  count: number;
  state: "queued" | "running";
  type: string;
}

export interface JobDurationMetric {
  count: number;
  p95Seconds: number | null;
  state: "failed" | "succeeded";
  sumSeconds: number;
  type: string;
}

export interface JobFailureMetric {
  code: string;
  count: number;
  type: string;
}

export interface ProviderErrorMetric {
  category: "fetch" | "quota";
  code: string;
  count: number;
}

export interface ChannelSyncMetric {
  channelId: string;
  lastSuccessUnixSeconds: number | null;
  syncAgeSeconds: number | null;
}

export interface DatabaseMetricsSnapshot {
  activeWorkerHeartbeats: number;
  channels: ChannelSyncMetric[];
  jobDurations: JobDurationMetric[];
  jobFailures: JobFailureMetric[];
  providerErrors: ProviderErrorMetric[];
  queueDepth: QueueDepthMetric[];
  workerHeartbeatAgeSeconds: number | null;
}

interface SearchMetricsSnapshot {
  bucketCounts: readonly number[];
  count: number;
  inFlight: number;
  sum: number;
}

export async function measureSearchOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const state = searchState();
  state.inFlight += 1;
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    const durationSeconds = Math.max(0, performance.now() - startedAt) / 1_000;
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.count += 1;
    state.sum += durationSeconds;
    SEARCH_DURATION_BUCKETS_SECONDS.forEach((upperBound, index) => {
      if (durationSeconds <= upperBound) state.bucketCounts[index] += 1;
    });
  }
}

export function getSearchMetricsSnapshot(): SearchMetricsSnapshot {
  const state = searchState();
  return {
    bucketCounts: [...state.bucketCounts],
    count: state.count,
    inFlight: state.inFlight,
    sum: state.sum,
  };
}

export function resetSearchMetricsForTests(): void {
  processState.__hardwareSearchMetricState = undefined;
}

function labelValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function labels(values: Record<string, string>): string {
  const entries = Object.entries(values);
  if (entries.length === 0) return "";
  return `{${entries
    .map(([name, value]) => `${name}="${labelValue(value)}"`)
    .join(",")}}`;
}

function metricValue(value: number | null): string {
  if (value === null || value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  if (Number.isNaN(value)) return "NaN";
  return String(value);
}

function describe(
  output: string[],
  name: string,
  type: "counter" | "gauge" | "histogram" | "summary",
  help: string,
): void {
  output.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
}

export function renderPrometheusMetrics(
  database: DatabaseMetricsSnapshot,
  search: SearchMetricsSnapshot = getSearchMetricsSnapshot(),
): string {
  const output: string[] = [];

  describe(
    output,
    "hardware_ingestion_queue_depth",
    "gauge",
    "Current domain ingestion jobs waiting or running.",
  );
  for (const state of ["queued", "running"] as const) {
    const total = database.queueDepth
      .filter((metric) => metric.state === state)
      .reduce((sum, metric) => sum + metric.count, 0);
    output.push(
      `hardware_ingestion_queue_depth${labels({ state, type: "all" })} ${total}`,
    );
  }
  for (const metric of database.queueDepth) {
    output.push(
      `hardware_ingestion_queue_depth${labels({ state: metric.state, type: metric.type })} ${metricValue(metric.count)}`,
    );
  }

  describe(
    output,
    "hardware_ingestion_job_duration_seconds",
    "summary",
    "Completed ingestion job duration derived from persisted job records.",
  );
  describe(
    output,
    "hardware_ingestion_job_duration_seconds_p95",
    "gauge",
    "Persisted p95 completed ingestion job duration by type and terminal state.",
  );
  for (const metric of database.jobDurations) {
    const metricLabels = labels({ state: metric.state, type: metric.type });
    output.push(
      `hardware_ingestion_job_duration_seconds_sum${metricLabels} ${metricValue(metric.sumSeconds)}`,
      `hardware_ingestion_job_duration_seconds_count${metricLabels} ${metricValue(metric.count)}`,
    );
    if (metric.p95Seconds !== null) {
      output.push(
        `hardware_ingestion_job_duration_seconds_p95${metricLabels} ${metricValue(metric.p95Seconds)}`,
      );
    }
  }

  describe(
    output,
    "hardware_ingestion_job_failure_attempts_total",
    "counter",
    "Persisted ingestion attempt failures grouped by safe error code.",
  );
  for (const metric of database.jobFailures) {
    output.push(
      `hardware_ingestion_job_failure_attempts_total${labels({ code: metric.code, type: metric.type })} ${metricValue(metric.count)}`,
    );
  }

  describe(
    output,
    "hardware_ingestion_provider_errors_total",
    "counter",
    "Persisted provider quota and website fetch errors grouped by safe code.",
  );
  for (const category of ["quota", "fetch"] as const) {
    const total = database.providerErrors
      .filter((metric) => metric.category === category)
      .reduce((sum, metric) => sum + metric.count, 0);
    output.push(
      `hardware_ingestion_provider_errors_total${labels({ category, code: "all" })} ${total}`,
    );
  }
  for (const metric of database.providerErrors) {
    output.push(
      `hardware_ingestion_provider_errors_total${labels({ category: metric.category, code: metric.code })} ${metricValue(metric.count)}`,
    );
  }

  describe(
    output,
    "hardware_worker_active_heartbeats",
    "gauge",
    "Worker heartbeats observed within the last 60 seconds.",
  );
  output.push(
    `hardware_worker_active_heartbeats ${metricValue(database.activeWorkerHeartbeats)}`,
  );
  describe(
    output,
    "hardware_worker_heartbeat_age_seconds",
    "gauge",
    "Age of the newest persisted worker heartbeat, or positive infinity when absent.",
  );
  output.push(
    `hardware_worker_heartbeat_age_seconds ${metricValue(database.workerHeartbeatAgeSeconds)}`,
  );

  describe(
    output,
    "hardware_channel_sync_age_seconds",
    "gauge",
    "Age of each enabled channel's last successful sync, or positive infinity when never synced.",
  );
  describe(
    output,
    "hardware_channel_last_success_unixtime_seconds",
    "gauge",
    "Unix timestamp of each enabled channel's last successful sync, or zero when never synced.",
  );
  for (const metric of database.channels) {
    const channelLabels = labels({ channel_id: metric.channelId });
    output.push(
      `hardware_channel_sync_age_seconds${channelLabels} ${metricValue(metric.syncAgeSeconds)}`,
      `hardware_channel_last_success_unixtime_seconds${channelLabels} ${metricValue(metric.lastSuccessUnixSeconds ?? 0)}`,
    );
  }
  describe(
    output,
    "hardware_channels_never_synced",
    "gauge",
    "Enabled channels without a successful synchronization.",
  );
  output.push(
    `hardware_channels_never_synced ${database.channels.filter((metric) => metric.lastSuccessUnixSeconds === null).length}`,
  );

  describe(
    output,
    "hardware_search_request_duration_seconds",
    "histogram",
    "Process-local inventory search request duration.",
  );
  SEARCH_DURATION_BUCKETS_SECONDS.forEach((upperBound, index) => {
    output.push(
      `hardware_search_request_duration_seconds_bucket${labels({ le: String(upperBound) })} ${metricValue(search.bucketCounts[index] ?? 0)}`,
    );
  });
  output.push(
    `hardware_search_request_duration_seconds_bucket${labels({ le: "+Inf" })} ${metricValue(search.count)}`,
    `hardware_search_request_duration_seconds_sum ${metricValue(search.sum)}`,
    `hardware_search_request_duration_seconds_count ${metricValue(search.count)}`,
  );
  describe(
    output,
    "hardware_search_requests_in_flight",
    "gauge",
    "Inventory search requests currently executing in this web process.",
  );
  output.push(`hardware_search_requests_in_flight ${metricValue(search.inFlight)}`);

  return `${output.join("\n")}\n`;
}

export const emptyDatabaseMetricsSnapshot = (): DatabaseMetricsSnapshot => ({
  activeWorkerHeartbeats: 0,
  channels: [],
  jobDurations: [],
  jobFailures: [],
  providerErrors: [],
  queueDepth: [],
  workerHeartbeatAgeSeconds: null,
});
