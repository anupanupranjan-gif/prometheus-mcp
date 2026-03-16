const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || "http://prometheus-operated.monitoring.svc.cluster.local:9090";
const PORT = process.env.PORT || 3001;

// ── Prometheus query helper ───────────────────────────────────────────────────

async function query(promql) {
  const res = await axios.get(`${PROMETHEUS_URL}/api/v1/query`, {
    params: { query: promql },
    timeout: 5000,
  });
  return res.data.data.result;
}

async function queryRange(promql, start, end, step = "60s") {
  const res = await axios.get(`${PROMETHEUS_URL}/api/v1/query_range`, {
    params: { query: promql, start, end, step },
    timeout: 5000,
  });
  return res.data.data.result;
}

function firstValue(result) {
  if (!result || result.length === 0) return null;
  return parseFloat(result[0].value[1]);
}

function allValues(result) {
  return result.map(r => ({
    labels: r.metric,
    value: parseFloat(r.value[1]),
  }));
}

// ── Tool endpoints ────────────────────────────────────────────────────────────

// GET /tools/search_rate
// Returns current search requests per minute
app.get("/tools/search_rate", async (req, res) => {
  try {
    const result = await query(
      `sum(rate(http_server_requests_seconds_count{job="search-api", uri="/api/v1/search"}[5m])) * 60`
    );
    const rpm = firstValue(result);
    res.json({
      tool: "search_rate",
      value: rpm !== null ? parseFloat(rpm.toFixed(2)) : 0,
      unit: "requests/minute",
      description: rpm !== null
        ? `Search API is handling ${rpm.toFixed(2)} requests per minute`
        : "No search traffic in the last 5 minutes",
    });
  } catch (e) {
    res.status(500).json({ tool: "search_rate", error: e.message });
  }
});

// GET /tools/error_rate
// Returns error rate as a percentage
app.get("/tools/error_rate", async (req, res) => {
  try {
    const [total, errors] = await Promise.all([
      query(`sum(rate(http_server_requests_seconds_count{job="search-api"}[5m]))`),
      query(`sum(rate(http_server_requests_seconds_count{job="search-api", outcome=~"CLIENT_ERROR|SERVER_ERROR"}[5m]))`),
    ]);

    const totalVal = firstValue(total) || 0;
    const errorVal = firstValue(errors) || 0;
    const errorPct = totalVal > 0 ? (errorVal / totalVal) * 100 : 0;

    res.json({
      tool: "error_rate",
      value: parseFloat(errorPct.toFixed(2)),
      unit: "percent",
      description: errorPct < 1
        ? `Error rate is healthy at ${errorPct.toFixed(2)}%`
        : `Elevated error rate detected: ${errorPct.toFixed(2)}%`,
      status: errorPct < 1 ? "healthy" : errorPct < 5 ? "warning" : "critical",
    });
  } catch (e) {
    res.status(500).json({ tool: "error_rate", error: e.message });
  }
});

// GET /tools/latency
// Returns avg and max latency for search endpoint
app.get("/tools/latency", async (req, res) => {
  try {
    const [avgResult, maxResult] = await Promise.all([
      query(`sum(rate(http_server_requests_seconds_sum{job="search-api", uri="/api/v1/search"}[5m])) / sum(rate(http_server_requests_seconds_count{job="search-api", uri="/api/v1/search"}[5m])) * 1000`),
      query(`max(http_server_requests_seconds_max{job="search-api", uri="/api/v1/search"}) * 1000`),
    ]);

    const avgVal = firstValue(avgResult);
    const maxVal = firstValue(maxResult);

    res.json({
      tool: "latency",
      avg_ms: avgVal !== null ? parseFloat(avgVal.toFixed(1)) : null,
      max_ms: maxVal !== null ? parseFloat(maxVal.toFixed(1)) : null,
      unit: "milliseconds",
      description: avgVal !== null
        ? `Search latency: avg=${avgVal.toFixed(0)}ms, max=${maxVal?.toFixed(0)}ms`
        : "No latency data available — no recent search traffic",
      status: maxVal === null ? "unknown" : maxVal < 500 ? "healthy" : maxVal < 1500 ? "warning" : "critical",
    });
  } catch (e) {
    res.status(500).json({ tool: "latency", error: e.message });
  }
});

// GET /tools/pod_health
// Returns status of all search-api pods
app.get("/tools/pod_health", async (req, res) => {
  try {
    const result = await query(`up{job="search-api"}`);
    const pods = allValues(result).map(r => ({
      pod: r.labels.pod,
      instance: r.labels.instance,
      status: r.value === 1 ? "up" : "down",
    }));

    const upCount = pods.filter(p => p.status === "up").length;
    const total = pods.length;

    res.json({
      tool: "pod_health",
      pods,
      up: upCount,
      total,
      description: `${upCount}/${total} search-api pods are healthy`,
      status: upCount === total ? "healthy" : upCount > 0 ? "degraded" : "critical",
    });
  } catch (e) {
    res.status(500).json({ tool: "pod_health", error: e.message });
  }
});

// GET /tools/throughput_trend
// Returns request rate over last 30 minutes as sparkline data
app.get("/tools/throughput_trend", async (req, res) => {
  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 1800; // 30 minutes
    const result = await queryRange(
      `sum(rate(http_server_requests_seconds_count{job="search-api"}[2m])) * 60`,
      start, end, "120s"
    );

    const points = result.length > 0
      ? result[0].values.map(([ts, val]) => ({
          timestamp: new Date(ts * 1000).toISOString(),
          rpm: parseFloat(parseFloat(val).toFixed(2)),
        }))
      : [];

    res.json({
      tool: "throughput_trend",
      points,
      description: `Throughput trend over last 30 minutes (${points.length} data points)`,
    });
  } catch (e) {
    res.status(500).json({ tool: "throughput_trend", error: e.message });
  }
});

// GET /tools/summary
// Returns all metrics in one call — used by Ollama for system prompt context
app.get("/tools/summary", async (req, res) => {
  try {
    const [rateRes, errorRes, latencyRes, podRes] = await Promise.all([
      axios.get(`http://localhost:${PORT}/tools/search_rate`).catch(e => ({ data: { error: e.message } })),
      axios.get(`http://localhost:${PORT}/tools/error_rate`).catch(e => ({ data: { error: e.message } })),
      axios.get(`http://localhost:${PORT}/tools/latency`).catch(e => ({ data: { error: e.message } })),
      axios.get(`http://localhost:${PORT}/tools/pod_health`).catch(e => ({ data: { error: e.message } })),
    ]);

    const summary = {
      tool: "summary",
      timestamp: new Date().toISOString(),
      search_rate: rateRes.data,
      error_rate: errorRes.data,
      latency: latencyRes.data,
      pod_health: podRes.data,
      overall_status: "healthy",
    };

    // Determine overall status
    const statuses = [
      errorRes.data.status,
      latencyRes.data.status,
      podRes.data.status,
    ].filter(Boolean);

    if (statuses.includes("critical")) summary.overall_status = "critical";
    else if (statuses.includes("warning") || statuses.includes("degraded")) summary.overall_status = "warning";

    res.json(summary);
  } catch (e) {
    res.status(500).json({ tool: "summary", error: e.message });
  }
});

// GET /tools
// Lists all available tools
app.get("/tools", (req, res) => {
  res.json({
    tools: [
      { name: "search_rate",       path: "/tools/search_rate",       description: "Current search requests per minute" },
      { name: "error_rate",        path: "/tools/error_rate",        description: "Error rate percentage over last 5 minutes" },
      { name: "latency",           path: "/tools/latency",           description: "p50/p95/p99 latency in milliseconds" },
      { name: "pod_health",        path: "/tools/pod_health",        description: "Health status of search-api pods" },
      { name: "throughput_trend",  path: "/tools/throughput_trend",  description: "Request rate trend over last 30 minutes" },
      { name: "summary",           path: "/tools/summary",           description: "All metrics in one call" },
    ],
  });
});

// GET /health
app.get("/health", (req, res) => {
  res.json({ status: "ok", prometheus: PROMETHEUS_URL });
});

app.listen(PORT, () => {
  console.log(`prometheus-mcp running on port ${PORT}`);
  console.log(`Prometheus: ${PROMETHEUS_URL}`);
});
