# QuickSearch Proxy

QuickSearch Proxy is a lightweight browser-style web app with a Node.js server-side proxy. It serves the QuickSearch interface, fetches remote HTTP/HTTPS pages through `/proxy`, rewrites page links and assets, strips common frame-blocking headers, and keeps upstream cookies in a server-side session.

## Features

- Browser-like interface with tabs, address bar, bookmarks, history, top sites, and dark mode
- Server-side proxy route at `/proxy?url=...`
- HTML and CSS URL rewriting for links, images, scripts, stylesheets, forms, and inline styles
- Basic fetch/XHR/link rewriting injected into proxied pages
- Server-side cookie jar per local session
- Private/reserved network blocking by default for safer public deployments
- No npm dependencies
- Docker-ready

## Requirements

- Node.js 20.11 or newer

## Run Locally

From the repo folder:

```bash
node server.js
```

Open:

```text
http://localhost:3000
```

## Environment Variables

Copy `.env.example` to `.env` for local use, or set these in your deployment host.

```text
HOST=0.0.0.0
PORT=3000
PUBLIC_ORIGIN=https://your-deployed-url.example
ALLOW_PRIVATE_NETWORKS=false
MAX_HTML_REWRITE_BYTES=12582912
MAX_REQUEST_BODY_BYTES=20971520
MAX_REDIRECTS=8
SESSION_TTL_MS=21600000
UPSTREAM_USER_AGENT=
```

Important settings:

- `PUBLIC_ORIGIN`: set this to your deployed app URL when hosting behind a reverse proxy or platform.
- `ALLOW_PRIVATE_NETWORKS`: keep this `false` for public deployments. Only use `true` for trusted local testing.
- `PORT`: many hosts set this automatically.

## Deploy

Deploy this as a Node.js web service. The app is not static-only because `server.js` must run.

Typical start command:

```bash
node server.js
```

Set:

```text
PUBLIC_ORIGIN=https://your-deployed-url.example
ALLOW_PRIVATE_NETWORKS=false
```

Good hosting options include Render, Railway, Fly.io, a VPS, or any platform that runs a Node.js HTTP server.

## Docker

Build:

```bash
docker build -t quicksearch-proxy .
```

Run:

```bash
docker run --rm -p 3000:3000 --env-file .env quicksearch-proxy
```

## Test

Run:

```bash
node --test
```

## Notes

QuickSearch Proxy is a practical web proxy, not a full browser engine. Many normal pages, links, assets, forms, fetch calls, and XHR calls will route through the proxy, but some sites may still resist proxying with advanced client-side checks, service workers, DRM, WebSockets, login protections, or bot protection.
