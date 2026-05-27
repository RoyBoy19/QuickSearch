# QuickSearch Proxy

QuickSearch is now a browser-style web UI backed by a server-side HTTP/HTTPS proxy. The backend fetches target pages, removes frame-blocking headers, rewrites links/assets/forms through `/proxy`, and keeps upstream cookies in a server-side session jar instead of exposing target cookies to the browser.

## Run Locally

### Easiest On Windows

Double-click:

```text
Start QuickSearch.cmd
```

It starts QuickSearch in a low-memory mode, opens your browser automatically, and shows the local address. Keep that small window open while you use QuickSearch. Press Enter in it when you want to stop.

If Node.js is not installed, the launcher will tell you. Install the Node.js LTS version, then double-click the launcher again.

### Command Line

```bash
node server.js
```

Open:

```text
http://localhost:3000
```

To use the low-memory launcher from a terminal:

```bash
node --max-old-space-size=128 launcher.js
```

By default, private and reserved network targets are blocked to reduce SSRF risk. For trusted local testing only:

```bash
ALLOW_PRIVATE_NETWORKS=true node server.js
```

## Deploy With Docker

```bash
docker build -t quicksearch-proxy .
docker run --rm -p 3000:3000 --env-file .env quicksearch-proxy
```

If you deploy behind a reverse proxy or hosted platform, set `PUBLIC_ORIGIN` to the external origin, for example:

```text
PUBLIC_ORIGIN=https://quicksearch.example.com
```

## Configuration

Copy `.env.example` to `.env` and adjust:

- `PORT`: server port, default `3000`
- `PUBLIC_ORIGIN`: external app origin used when rewriting proxied pages
- `ALLOW_PRIVATE_NETWORKS`: keep `false` for public deployments
- `MAX_HTML_REWRITE_BYTES`: max HTML/CSS response size that will be buffered and rewritten
- `MAX_REQUEST_BODY_BYTES`: max upload/form body size forwarded through the proxy
- `MAX_REDIRECTS`: redirect limit
- `SESSION_TTL_MS`: server-side proxy cookie session lifetime
- `UPSTREAM_USER_AGENT`: optional user agent sent to target sites

## Notes

This is a practical web proxy, not a full browser engine. Most normal pages, links, assets, forms, fetch calls, and XHR calls are routed through the proxy, but some sites can still resist proxying through strict client-side checks, advanced service-worker flows, DRM, WebSockets, or bot protection.
