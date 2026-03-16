# prometheus-mcp

A lightweight MCP (Model Context Protocol) server that wraps the Prometheus query API as structured tool endpoints, making real-time observability data available to AI assistants.

Built as part of the SearchX platform — a full-stack AI-powered eCommerce search system running on Kubernetes.

---

## What It Does

prometheus-mcp sits between Prometheus and an AI assistant. It queries Prometheus on demand and returns clean, structured JSON that an LLM can reason about directly. The pattern mirrors the Dynatrace MCP integration used in enterprise observability workflows, but runs entirely on local infrastructure.

```
AI Assistant (Ollama)
      │
      ▼
prometheus-mcp  ──►  Prometheus  ──►  search-api (Spring Boot)
      │
      ▼
 Structured JSON
 (rate, latency, errors, pod health)
```

---

## Tool Endpoints

| Endpoint | Description |
|---|---|
| `GET /tools/search_rate` | Current search requests per minute |
| `GET /tools/latency` | Average and max latency in milliseconds |
| `GET /tools/error_rate` | Error rate percentage over last 5 minutes |
| `GET /tools/pod_health` | Health status of all search-api pods |
| `GET /tools/throughput_trend` | Request rate over last 30 minutes (sparkline data) |
| `GET /tools/summary` | All metrics in a single call |
| `GET /tools` | Lists all available tools |
| `GET /health` | Server health check |

---

## Example Response

```json
GET /tools/summary

{
  "tool": "summary",
  "timestamp": "2026-03-16T03:41:17.324Z",
  "overall_status": "healthy",
  "search_rate": {
    "value": 10.4,
    "unit": "requests/minute",
    "description": "Search API is handling 10.40 requests per minute"
  },
  "latency": {
    "avg_ms": 75,
    "max_ms": 640,
    "status": "healthy"
  },
  "error_rate": {
    "value": 0,
    "unit": "percent",
    "status": "healthy"
  },
  "pod_health": {
    "up": 2,
    "total": 2,
    "description": "2/2 search-api pods are healthy",
    "status": "healthy"
  }
}
```

---

## Stack

- **Runtime**: Node.js 20
- **Framework**: Express
- **Metrics source**: Prometheus (via HTTP query API)
- **Deployment**: Kubernetes (Kind), Docker
- **Consumer**: observability-console (Ollama/gemma3:1b)

---

## Local Development

```bash
npm install

# Requires Prometheus accessible (port-forward or in-cluster)
kubectl port-forward svc/prometheus-operated -n monitoring 9090:9090 &

PROMETHEUS_URL=http://localhost:9090 node server.js
```

Test a tool:

```bash
curl http://localhost:3001/tools/summary | jq
```

---

## Kubernetes Deployment

The server runs as a pod in the `default` namespace and reaches Prometheus via in-cluster DNS:

```
http://prometheus-operated.monitoring.svc.cluster.local:9090
```

Manifests are managed in the [search-infra](https://github.com/anupanupranjan-gif/search-infra) repo under `k8s-configs/prometheus-mcp/`.

```bash
kubectl apply -f k8s-configs/prometheus-mcp/deployment.yaml
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROMETHEUS_URL` | `http://prometheus-operated.monitoring.svc.cluster.local:9090` | Prometheus base URL |
| `PORT` | `3001` | Server port |

---

## Part of SearchX

This repo is one component of the SearchX platform:

- [search-api](https://github.com/anupanupranjan-gif/search-api) — Spring Boot hybrid search service (BM25 + vector)
- [search-ui](https://github.com/anupanupranjan-gif/search-ui) — React eCommerce search frontend
- [search-catalog-indexer](https://github.com/anupanupranjan-gif/search-catalog-indexer) — Product indexing pipeline
- [observability-console](https://github.com/anupanupranjan-gif/observability-console) — AI observability UI (consumes this server)
- [search-infra](https://github.com/anupanupranjan-gif/search-infra) — Kubernetes manifests, Helm charts, ArgoCD, Terraform
