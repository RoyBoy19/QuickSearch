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

## Run on MacOS/Linux

From the repo, run:

、、、
Start QuickSearch.sh
、、、

## Run on Windows

From the repo, run:

、、、
Start QuickSearch.cmd
、、、
