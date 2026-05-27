"use strict";

const crypto = require("node:crypto");
const dns = require("node:dns/promises");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { Readable } = require("node:stream");

const ROOT_DIR = __dirname;
const INDEX_FILE = path.join(ROOT_DIR, "quicksearch.html");

const DEFAULT_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 QuickSearchProxy/1.0";

const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade"
]);

const STRIPPED_RESPONSE_HEADERS = new Set([
    "alt-svc",
    "content-encoding",
    "content-length",
    "content-security-policy",
    "content-security-policy-report-only",
    "cross-origin-embedder-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "permissions-policy",
    "set-cookie",
    "strict-transport-security",
    "x-content-security-policy",
    "x-frame-options",
    "x-webkit-csp"
]);

function envFlag(name, fallback = false) {
    const value = process.env[name];
    if (value === undefined) return fallback;
    return /^(1|true|yes|on)$/i.test(value);
}

function envNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function createConfig(overrides = {}) {
    return {
        allowPrivateNetworks: overrides.allowPrivateNetworks ?? envFlag("ALLOW_PRIVATE_NETWORKS", false),
        host: overrides.host || process.env.HOST || "0.0.0.0",
        maxHtmlRewriteBytes: overrides.maxHtmlRewriteBytes || envNumber("MAX_HTML_REWRITE_BYTES", 12 * 1024 * 1024),
        maxRedirects: overrides.maxRedirects || envNumber("MAX_REDIRECTS", 8),
        maxRequestBodyBytes: overrides.maxRequestBodyBytes || envNumber("MAX_REQUEST_BODY_BYTES", 20 * 1024 * 1024),
        port: overrides.port || envNumber("PORT", 3000),
        sessionTtlMs: overrides.sessionTtlMs || envNumber("SESSION_TTL_MS", 6 * 60 * 60 * 1000),
        userAgent: overrides.userAgent || process.env.UPSTREAM_USER_AGENT || DEFAULT_USER_AGENT
    };
}

function createServer(overrides = {}) {
    const config = createConfig(overrides);
    const sessions = new Map();

    const server = http.createServer(async (req, res) => {
        try {
            await routeRequest(req, res, config, sessions);
        } catch (error) {
            sendError(res, error.statusCode || 500, error.publicMessage || "Proxy error");
            if (!error.expose) {
                console.error(error);
            }
        }
    });

    server.config = config;
    return server;
}

async function routeRequest(req, res, config, sessions) {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/healthz") {
        sendJson(res, 200, {
            ok: true,
            name: "quicksearch-proxy",
            privateNetworksAllowed: config.allowPrivateNetworks
        });
        return;
    }

    if (requestUrl.pathname === "/proxy") {
        await handleProxy(req, res, requestUrl, config, sessions);
        return;
    }

    serveStatic(req, res, requestUrl);
}

function serveStatic(req, res, requestUrl) {
    if (req.method !== "GET" && req.method !== "HEAD") {
        sendError(res, 405, "Method not allowed");
        return;
    }

    if (requestUrl.pathname === "/" || requestUrl.pathname === "/quicksearch.html") {
        sendFile(res, INDEX_FILE, "text/html; charset=utf-8", req.method === "HEAD");
        return;
    }

    if (requestUrl.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
    }

    sendError(res, 404, "Not found");
}

function sendFile(res, filePath, contentType, headOnly = false) {
    fs.stat(filePath, (statError, stat) => {
        if (statError || !stat.isFile()) {
            sendError(res, 404, "Not found");
            return;
        }

        res.writeHead(200, {
            "content-length": stat.size,
            "content-type": contentType,
            "cache-control": "no-store"
        });

        if (headOnly) {
            res.end();
            return;
        }

        fs.createReadStream(filePath).pipe(res);
    });
}

async function handleProxy(req, res, requestUrl, config, sessions) {
    const targetUrl = resolveTargetUrl(requestUrl, req.method);
    await validateTargetUrl(targetUrl, config);

    const body = await readIncomingBody(req, config.maxRequestBodyBytes);
    const sessionInfo = getSession(req, sessions, config);
    const proxied = await fetchWithRedirects(req, targetUrl, body, sessionInfo.session, config);

    storeSetCookies(sessionInfo.session, getSetCookieHeaders(proxied.response.headers), proxied.url);
    await sendProxyResponse(req, res, proxied.response, proxied.url, sessionInfo, config);
}

function resolveTargetUrl(requestUrl, method) {
    const rawTarget = requestUrl.searchParams.get("url");
    if (!rawTarget) {
        throw publicError(400, "Missing target URL");
    }

    let targetUrl;
    try {
        targetUrl = new URL(rawTarget);
    } catch (error) {
        throw publicError(400, "Invalid target URL");
    }

    if ((method === "GET" || method === "HEAD") && requestUrl.searchParams.size > 1) {
        const passthrough = new URLSearchParams(requestUrl.search);
        passthrough.delete("url");
        for (const [key, value] of passthrough) {
            targetUrl.searchParams.append(key, value);
        }
    }

    return targetUrl;
}

async function fetchWithRedirects(req, startUrl, body, session, config) {
    let currentUrl = startUrl;
    let method = req.method || "GET";
    let requestBody = body;

    for (let redirectCount = 0; redirectCount <= config.maxRedirects; redirectCount += 1) {
        await validateTargetUrl(currentUrl, config);

        const response = await fetch(currentUrl.href, {
            body: method === "GET" || method === "HEAD" ? undefined : requestBody,
            duplex: method === "GET" || method === "HEAD" ? undefined : "half",
            headers: buildUpstreamHeaders(req, currentUrl, session, config),
            method,
            redirect: "manual"
        });

        if (!isRedirect(response.status)) {
            return { response, url: currentUrl };
        }

        const location = response.headers.get("location");
        if (!location) {
            return { response, url: currentUrl };
        }

        storeSetCookies(session, getSetCookieHeaders(response.headers), currentUrl);
        currentUrl = new URL(location, currentUrl);

        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
            method = "GET";
            requestBody = undefined;
        }
    }

    throw publicError(508, "Too many redirects");
}

function buildUpstreamHeaders(req, targetUrl, session, config) {
    const headers = new Headers();

    for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (
            HOP_BY_HOP_HEADERS.has(lower) ||
            lower === "host" ||
            lower === "content-length" ||
            lower === "cookie" ||
            lower === "referer" ||
            lower === "referrer" ||
            lower.startsWith("sec-fetch-") ||
            lower.startsWith("proxy-")
        ) {
            continue;
        }
        headers.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }

    headers.set("accept-encoding", "identity");
    headers.set("user-agent", headers.get("user-agent") || config.userAgent);

    const cookieHeader = buildCookieHeader(session, targetUrl);
    if (cookieHeader) {
        headers.set("cookie", cookieHeader);
    }

    if (headers.has("origin")) {
        headers.set("origin", targetUrl.origin);
    }

    return headers;
}

async function sendProxyResponse(req, res, upstreamResponse, finalUrl, sessionInfo, config) {
    const headers = sanitizeResponseHeaders(upstreamResponse.headers);
    const contentType = upstreamResponse.headers.get("content-type") || "";

    if (sessionInfo.isNew) {
        headers["set-cookie"] = makeSessionCookie(sessionInfo.id, req);
    }

    headers["x-quicksearch-target"] = finalUrl.href;
    headers["cache-control"] = "private, no-store";

    if (req.method === "HEAD") {
        res.writeHead(upstreamResponse.status, headers);
        res.end();
        return;
    }

    if (isHtmlContent(contentType)) {
        const body = await readResponseText(upstreamResponse, config.maxHtmlRewriteBytes);
        const rewritten = rewriteHtml(body, finalUrl.href, getPublicOrigin(req));
        headers["content-type"] = contentType.includes("charset")
            ? contentType
            : "text/html; charset=utf-8";
        headers["content-length"] = Buffer.byteLength(rewritten);
        res.writeHead(upstreamResponse.status, headers);
        res.end(rewritten);
        return;
    }

    if (isCssContent(contentType)) {
        const body = await readResponseText(upstreamResponse, config.maxHtmlRewriteBytes);
        const rewritten = rewriteCss(body, finalUrl.href, getPublicOrigin(req));
        headers["content-type"] = contentType.includes("charset")
            ? contentType
            : "text/css; charset=utf-8";
        headers["content-length"] = Buffer.byteLength(rewritten);
        res.writeHead(upstreamResponse.status, headers);
        res.end(rewritten);
        return;
    }

    res.writeHead(upstreamResponse.status, headers);
    if (upstreamResponse.body) {
        Readable.fromWeb(upstreamResponse.body).pipe(res);
    } else {
        res.end();
    }
}

function sanitizeResponseHeaders(headers) {
    const output = {};
    for (const [name, value] of headers.entries()) {
        const lower = name.toLowerCase();
        if (HOP_BY_HOP_HEADERS.has(lower) || STRIPPED_RESPONSE_HEADERS.has(lower)) {
            continue;
        }
        output[name] = value;
    }
    return output;
}

function isRedirect(status) {
    return status >= 300 && status < 400;
}

function isHtmlContent(contentType) {
    return /\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(contentType);
}

function isCssContent(contentType) {
    return /\btext\/css\b/i.test(contentType);
}

async function readIncomingBody(req, maxBytes) {
    if (req.method === "GET" || req.method === "HEAD") {
        return undefined;
    }

    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > maxBytes) {
            throw publicError(413, "Request body is too large");
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function readResponseText(response, maxBytes) {
    if (!response.body) return "";

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            throw publicError(413, "Response is too large to rewrite");
        }
        chunks.push(Buffer.from(value));
    }

    return Buffer.concat(chunks).toString("utf8");
}

function rewriteHtml(html, targetUrl, publicOrigin = "") {
    let output = html
        .replace(/<base\b[^>]*>/gi, "")
        .replace(/\s(?:integrity|nonce)=("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
        .replace(/\s(?:crossorigin)=("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

    output = rewriteHtmlAttributes(output, targetUrl, publicOrigin);
    output = output.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (match, open, css, close) => {
        return open + rewriteCss(css, targetUrl, publicOrigin) + close;
    });

    const injection = buildClientInjection(targetUrl, publicOrigin);
    if (/<head\b[^>]*>/i.test(output)) {
        return output.replace(/<head\b[^>]*>/i, match => {
            return `${match}\n<base href="${escapeHtml(targetUrl)}">\n${injection}`;
        });
    }

    return `<base href="${escapeHtml(targetUrl)}">\n${injection}\n${output}`;
}

function rewriteHtmlAttributes(html, targetUrl, publicOrigin = "") {
    let output = html.replace(
        /\s(href|src|action|poster|data|formaction)=("[^"]*"|'[^']*'|[^\s>]+)/gi,
        (match, name, rawValue) => {
            const quote = rawValue[0] === "\"" || rawValue[0] === "'" ? rawValue[0] : "";
            const value = quote ? rawValue.slice(1, -1) : rawValue;
            const rewritten = toProxyUrl(value, targetUrl, publicOrigin);
            const escaped = quote ? escapeAttribute(rewritten, quote) : escapeHtml(rewritten);
            return ` ${name}=${quote}${escaped}${quote}`;
        }
    );

    output = output.replace(/\s(srcset|imagesrcset)=("[^"]*"|'[^']*')/gi, (match, name, rawValue) => {
        const quote = rawValue[0];
        const value = rawValue.slice(1, -1);
        return ` ${name}=${quote}${escapeAttribute(rewriteSrcset(value, targetUrl, publicOrigin), quote)}${quote}`;
    });

    output = output.replace(/\sstyle=("[^"]*"|'[^']*')/gi, (match, rawValue) => {
        const quote = rawValue[0];
        const value = rawValue.slice(1, -1);
        return ` style=${quote}${escapeAttribute(rewriteCss(value, targetUrl, publicOrigin), quote)}${quote}`;
    });

    output = output.replace(
        /(<meta\b[^>]*http-equiv=(?:"refresh"|'refresh'|refresh)[^>]*content=)(["'])([^"']+)(\2[^>]*>)/gi,
        (match, prefix, quote, content, suffix) => {
            const rewritten = content.replace(/url\s*=\s*([^;]+)/i, (urlMatch, url) => {
                return "url=" + toProxyUrl(url.trim(), targetUrl, publicOrigin);
            });
            return prefix + quote + escapeAttribute(rewritten, quote) + suffix;
        }
    );

    return output;
}

function rewriteCss(css, targetUrl, publicOrigin = "") {
    let output = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, quote, rawUrl) => {
        return `url(${quote}${escapeAttribute(toProxyUrl(rawUrl.trim(), targetUrl, publicOrigin), quote || "\"")}${quote})`;
    });

    output = output.replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?/gi, (match, quote, rawUrl) => {
        return `@import ${quote}${escapeAttribute(toProxyUrl(rawUrl.trim(), targetUrl, publicOrigin), quote || "\"")}${quote}`;
    });

    return output;
}

function rewriteSrcset(srcset, targetUrl, publicOrigin = "") {
    return srcset
        .split(",")
        .map(part => {
            const trimmed = part.trim();
            if (!trimmed) return trimmed;
            const pieces = trimmed.split(/\s+/);
            pieces[0] = toProxyUrl(pieces[0], targetUrl, publicOrigin);
            return pieces.join(" ");
        })
        .join(", ");
}

function buildClientInjection(targetUrl, publicOrigin = "") {
    const jsonTarget = JSON.stringify(targetUrl);
    const jsonPublicOrigin = JSON.stringify(publicOrigin);
    return `<script>
(() => {
    const targetUrl = ${jsonTarget};
    const configuredOrigin = ${jsonPublicOrigin};
    const proxyOrigin = configuredOrigin || window.location.origin;
    const proxyPath = proxyOrigin + "/proxy?url=";
    const specialProtocol = /^(?:about:|blob:|data:|javascript:|mailto:|sms:|tel:|#)/i;

    function isAlreadyProxied(value) {
        try {
            const parsed = new URL(String(value), window.location.href);
            return parsed.origin === proxyOrigin && parsed.pathname === "/proxy" && parsed.searchParams.has("url");
        } catch (error) {
            return false;
        }
    }

    function absoluteUrl(value, base = targetUrl) {
        try {
            return new URL(String(value), base).href;
        } catch (error) {
            return String(value || "");
        }
    }

    function toProxy(value, base = targetUrl) {
        if (!value || specialProtocol.test(String(value))) return value;
        if (isAlreadyProxied(value)) return value;
        const absolute = absoluteUrl(value, base);
        if (!/^https?:/i.test(absolute)) return value;
        return proxyPath + encodeURIComponent(absolute);
    }

    function rewriteElement(element) {
        if (!element || element.nodeType !== 1) return;
        ["href", "src", "action", "poster", "data", "formaction"].forEach(attribute => {
            if (element.hasAttribute(attribute)) {
                element.setAttribute(attribute, toProxy(element.getAttribute(attribute)));
            }
        });
        ["srcset", "imagesrcset"].forEach(attribute => {
            if (element.hasAttribute(attribute)) {
                element.setAttribute(attribute, element.getAttribute(attribute).split(",").map(part => {
                    const pieces = part.trim().split(/\\s+/);
                    pieces[0] = toProxy(pieces[0]);
                    return pieces.join(" ");
                }).join(", "));
            }
        });
    }

    window.__QUICKSEARCH_PROXY__ = { targetUrl, toProxy };

    const originalOpen = window.open;
    window.open = function openThroughProxy(url, target, features) {
        if (url) return originalOpen.call(window, toProxy(url), target || "_self", features);
        return originalOpen.apply(window, arguments);
    };

    if (window.fetch) {
        const originalFetch = window.fetch.bind(window);
        window.fetch = function fetchThroughProxy(input, init) {
            try {
                if (typeof input === "string" || input instanceof URL) {
                    input = toProxy(input);
                } else if (input && input.url) {
                    input = new Request(toProxy(input.url), input);
                }
            } catch (error) {}
            return originalFetch(input, init);
        };
    }

    if (window.XMLHttpRequest) {
        const originalOpenXhr = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function openXhrThroughProxy(method, url, ...rest) {
            return originalOpenXhr.call(this, method, toProxy(url), ...rest);
        };
    }

    document.addEventListener("click", event => {
        const anchor = event.target.closest && event.target.closest("a[href]");
        if (!anchor) return;
        const href = anchor.getAttribute("href");
        if (!href || specialProtocol.test(href)) return;
        event.preventDefault();
        window.location.href = toProxy(href);
    }, true);

    document.addEventListener("submit", event => {
        const form = event.target;
        if (!form || !form.action) return;
        form.action = toProxy(form.getAttribute("action") || form.action);
    }, true);

    document.querySelectorAll("[href], [src], [action], [poster], [data], [formaction], [srcset], [imagesrcset]").forEach(rewriteElement);
    new MutationObserver(records => {
        records.forEach(record => {
            record.addedNodes.forEach(node => {
                rewriteElement(node);
                if (node.querySelectorAll) {
                    node.querySelectorAll("[href], [src], [action], [poster], [data], [formaction], [srcset], [imagesrcset]").forEach(rewriteElement);
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });
})();
</script>
`;
}

function toProxyUrl(rawUrl, baseUrl, publicOrigin = "") {
    const value = String(rawUrl || "").trim();
    if (!value || /^(?:about:|blob:|data:|javascript:|mailto:|sms:|tel:|#)/i.test(value)) {
        return rawUrl;
    }

    if (publicOrigin) {
        try {
            const current = new URL(value, publicOrigin);
            if (current.origin === publicOrigin && current.pathname === "/proxy" && current.searchParams.has("url")) {
                return value;
            }
        } catch (error) {}
    }

    let absolute;
    try {
        absolute = new URL(value, baseUrl);
    } catch (error) {
        return rawUrl;
    }

    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") {
        return rawUrl;
    }

    return `${publicOrigin}/proxy?url=${encodeURIComponent(absolute.href)}`;
}

function getPublicOrigin(req) {
    if (process.env.PUBLIC_ORIGIN) {
        return process.env.PUBLIC_ORIGIN.replace(/\/+$/, "");
    }

    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
    const proto = forwardedProto || (req.socket.encrypted ? "https" : "http");
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    return `${proto}://${String(host).split(",")[0].trim()}`;
}

async function validateTargetUrl(targetUrl, config) {
    if (targetUrl.protocol !== "http:" && targetUrl.protocol !== "https:") {
        throw publicError(400, "Only HTTP and HTTPS targets can be proxied");
    }

    if (targetUrl.username || targetUrl.password) {
        throw publicError(400, "Embedded URL credentials are not allowed");
    }

    if (config.allowPrivateNetworks) {
        return;
    }

    const hostname = targetUrl.hostname;
    let addresses;
    if (net.isIP(hostname)) {
        addresses = [{ address: hostname }];
    } else {
        try {
            addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        } catch (error) {
            throw publicError(502, "Target host could not be resolved");
        }
    }

    if (!addresses.length || addresses.some(record => isBlockedIp(record.address))) {
        throw publicError(403, "Private or reserved network targets are blocked");
    }
}

function isBlockedIp(address) {
    if (address.startsWith("::ffff:")) {
        return isBlockedIp(address.slice(7));
    }

    const family = net.isIP(address);
    if (family === 4) {
        const parts = address.split(".").map(Number);
        const [a, b] = parts;
        return (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 192 && b === 0) ||
            (a === 198 && (b === 18 || b === 19)) ||
            (a === 198 && b === 51) ||
            (a === 203 && b === 0)
        );
    }

    if (family === 6) {
        const normalized = address.toLowerCase();
        return (
            normalized === "::" ||
            normalized === "::1" ||
            normalized.startsWith("fc") ||
            normalized.startsWith("fd") ||
            /^fe[89ab]/.test(normalized) ||
            normalized.startsWith("ff") ||
            normalized.startsWith("2001:db8")
        );
    }

    return true;
}

function getSession(req, sessions, config) {
    pruneSessions(sessions, config);

    const cookies = parseCookieHeader(req.headers.cookie || "");
    let id = cookies.qs_proxy_sid;
    let isNew = false;

    if (!id || !sessions.has(id)) {
        id = crypto.randomBytes(24).toString("base64url");
        sessions.set(id, { cookies: [], lastSeen: Date.now() });
        isNew = true;
    }

    const session = sessions.get(id);
    session.lastSeen = Date.now();
    return { id, isNew, session };
}

function pruneSessions(sessions, config) {
    const expiresBefore = Date.now() - config.sessionTtlMs;
    for (const [id, session] of sessions) {
        if (session.lastSeen < expiresBefore) {
            sessions.delete(id);
        }
    }
}

function makeSessionCookie(id, req) {
    const secure = /https/i.test(req.headers["x-forwarded-proto"] || "");
    return [
        `qs_proxy_sid=${id}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        secure ? "Secure" : "",
        "Max-Age=21600"
    ].filter(Boolean).join("; ");
}

function parseCookieHeader(header) {
    const output = {};
    String(header).split(";").forEach(part => {
        const index = part.indexOf("=");
        if (index === -1) return;
        const name = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        if (name) output[name] = value;
    });
    return output;
}

function getSetCookieHeaders(headers) {
    if (typeof headers.getSetCookie === "function") {
        return headers.getSetCookie();
    }

    const combined = headers.get("set-cookie");
    if (!combined) return [];

    return combined.split(/,(?=\s*[^;,=\s]+=[^;,]+)/g).map(value => value.trim());
}

function storeSetCookies(session, setCookieHeaders, responseUrl) {
    const now = Date.now();
    for (const header of setCookieHeaders) {
        const cookie = parseSetCookie(header, responseUrl, now);
        if (!cookie) continue;

        session.cookies = session.cookies.filter(existing => {
            return !(existing.name === cookie.name && existing.domain === cookie.domain && existing.path === cookie.path);
        });

        if (!cookie.expired) {
            session.cookies.push(cookie);
        }
    }
}

function parseSetCookie(header, responseUrl, now) {
    const parts = String(header).split(";").map(part => part.trim());
    const [nameValue, ...attributeParts] = parts;
    const equalsIndex = nameValue.indexOf("=");
    if (equalsIndex <= 0) return null;

    const cookie = {
        domain: responseUrl.hostname.toLowerCase(),
        expires: 0,
        hostOnly: true,
        name: nameValue.slice(0, equalsIndex),
        path: defaultCookiePath(responseUrl.pathname),
        secure: false,
        value: nameValue.slice(equalsIndex + 1)
    };

    for (const attributePart of attributeParts) {
        const [rawName, ...rawValue] = attributePart.split("=");
        const name = rawName.toLowerCase();
        const value = rawValue.join("=");

        if (name === "domain" && value) {
            cookie.domain = value.replace(/^\./, "").toLowerCase();
            cookie.hostOnly = false;
        } else if (name === "path" && value) {
            cookie.path = value.startsWith("/") ? value : "/";
        } else if (name === "max-age") {
            const seconds = Number(value);
            cookie.expires = Number.isFinite(seconds) ? now + seconds * 1000 : cookie.expires;
        } else if (name === "expires") {
            const date = Date.parse(value);
            cookie.expires = Number.isFinite(date) ? date : cookie.expires;
        } else if (name === "secure") {
            cookie.secure = true;
        }
    }

    cookie.expired = cookie.expires > 0 && cookie.expires <= now;
    return cookie;
}

function defaultCookiePath(pathname) {
    if (!pathname || !pathname.startsWith("/")) return "/";
    if (pathname === "/") return "/";
    return pathname.slice(0, pathname.lastIndexOf("/") + 1) || "/";
}

function buildCookieHeader(session, targetUrl) {
    const now = Date.now();
    session.cookies = session.cookies.filter(cookie => !cookie.expires || cookie.expires > now);

    const cookies = session.cookies.filter(cookie => {
        if (cookie.secure && targetUrl.protocol !== "https:") return false;
        if (cookie.hostOnly && cookie.domain !== targetUrl.hostname.toLowerCase()) return false;
        if (!cookie.hostOnly && !domainMatches(targetUrl.hostname, cookie.domain)) return false;
        return targetUrl.pathname.startsWith(cookie.path);
    });

    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
}

function domainMatches(hostname, domain) {
    const host = hostname.toLowerCase();
    const normalizedDomain = domain.toLowerCase();
    return host === normalizedDomain || host.endsWith("." + normalizedDomain);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function escapeAttribute(value, quote) {
    const escaped = escapeHtml(value);
    return quote === "'" ? escaped.replace(/'/g, "&#39;") : escaped;
}

function publicError(statusCode, publicMessage) {
    const error = new Error(publicMessage);
    error.statusCode = statusCode;
    error.publicMessage = publicMessage;
    error.expose = true;
    return error;
}

function sendError(res, statusCode, message) {
    if (res.headersSent) {
        res.end();
        return;
    }

    const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>QuickSearch Proxy Error</title>
<style>
body{margin:0;font-family:Segoe UI,Roboto,Arial,sans-serif;background:#f7f9f8;color:#15201e;display:grid;place-items:center;min-height:100vh}
main{width:min(560px,calc(100% - 32px));padding:24px;border:1px solid #cfd8d6;border-radius:8px;background:#fff;box-shadow:0 14px 36px rgba(22,31,29,.14)}
h1{margin:0 0 8px;font-size:22px}.code{color:#66706d;font-size:13px}
</style>
</head>
<body><main><h1>${escapeHtml(message)}</h1><div class="code">Status ${statusCode}</div></main></body>
</html>`;

    res.writeHead(statusCode, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store"
    });
    res.end(body);
}

function sendJson(res, statusCode, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store"
    });
    res.end(body);
}

if (require.main === module) {
    const server = createServer();
    server.listen(server.config.port, server.config.host, () => {
        console.log(`QuickSearch Proxy listening on http://${server.config.host}:${server.config.port}`);
    });
}

module.exports = {
    createServer,
    isBlockedIp,
    resolveTargetUrl,
    rewriteCss,
    rewriteHtml,
    toProxyUrl
};
