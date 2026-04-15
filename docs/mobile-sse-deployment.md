# Reverse Proxy & Mobile Client Experience Guide

## Goal

This document focuses on improving real user experience for mobile clients that connect to `opencode2api-enhanced` through a reverse proxy.

Primary goals:

- fast first token
- stable SSE streaming
- fewer false disconnects on mobile networks
- clearer user-facing errors

---

## Recommended Nginx configuration for SSE

Use a dedicated reverse proxy block for the API path, especially streaming endpoints like `/v1/chat/completions` and `/v1/responses`.

```nginx
location /v1/ {
    proxy_pass http://127.0.0.1:10000;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_buffering off;
    proxy_request_buffering off;
    proxy_cache off;
    gzip off;
    chunked_transfer_encoding on;

    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    send_timeout 600s;

    proxy_set_header Connection "";
}
```

### Why this matters

For SSE, buffering is one of the most common causes of poor mobile experience:

- long delay before first token
- fake streaming (large chunks flushed together)
- unexpected stream interruption

---

## Health endpoints for client readiness checks

Recommended client-side behavior:

- `/health/live`: process is alive
- `/health/ready`: backend is actually ready to serve model traffic

If `live` is OK but `ready` is not, treat it as **warming up**, not as a hard failure.

---

## Mobile-oriented timeout guidance

Mobile networks are less stable than desktop connections. Prefer conservative server-side values.

Recommended starting point:

- `OPENCODE_PROXY_REQUEST_TIMEOUT_MS=180000`
- `OPENCODE_PROXY_SERVER_REQUEST_TIMEOUT_MS=210000`
- `OPENCODE_PROXY_SERVER_HEADERS_TIMEOUT_MS=65000`
- `OPENCODE_PROXY_SERVER_KEEPALIVE_TIMEOUT_MS=5000`
- `OPENCODE_PROXY_SERVER_SOCKET_TIMEOUT_MS=240000`
- `OPENCODE_PROXY_SHUTDOWN_GRACE_MS=10000`

These values should be adjusted only after observing real traffic.

---

## Warmup recommendations

To reduce cold-start perception for mobile users:

- keep backend warmup enabled at service start
- avoid removing backend readiness checks for the sake of simplicity
- prefer readiness signaling over letting clients hit a cold backend blindly

---

## Error message guidance

User-facing errors should answer these questions:

- should the user retry?
- is the backend still warming up?
- is this likely a network issue?
- is the model unavailable?

Recommended categories:

- authentication failure
- backend warming up / not ready
- upstream connection failure
- upstream timeout
- invalid model / invalid request

Avoid exposing raw low-level transport errors directly when a clearer explanation can be provided.

---

## Operational recommendation

For mobile-facing deployments, prioritize:

1. fast first token
2. SSE stability through reverse proxy
3. backend warmup
4. readable errors

This project already has stable smoke verification and modularized runtime helpers. The next improvement focus should be perceived latency and robustness rather than aggressive internal rewrites.
