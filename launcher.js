"use strict";

const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check-only");
const noOpen = args.has("--no-open");

const preferredPort = Number(process.env.QUICKSEARCH_PORT || process.env.PORT) || 3000;
const host = process.env.HOST || "127.0.0.1";
const candidatePorts = uniqueNumbers([
    preferredPort,
    ...Array.from({ length: 21 }, (_, index) => 3000 + index)
]);

main().catch(error => {
    console.error("");
    console.error("QuickSearch could not start.");
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
});

async function main() {
    const existingPort = await findExistingQuickSearch();
    if (existingPort) {
        const url = `http://127.0.0.1:${existingPort}`;
        console.log("QuickSearch is already running.");
        console.log(`Opening ${url}`);
        if (!noOpen) openBrowser(url);
        return;
    }

    const port = await findFreePort();
    if (!port) {
        throw new Error("Ports 3000 through 3020 are busy. Close another local app or set QUICKSEARCH_PORT.");
    }

    process.env.HOST = host;
    process.env.PORT = String(port);
    process.env.MAX_HTML_REWRITE_BYTES = process.env.MAX_HTML_REWRITE_BYTES || String(8 * 1024 * 1024);
    process.env.MAX_REQUEST_BODY_BYTES = process.env.MAX_REQUEST_BODY_BYTES || String(10 * 1024 * 1024);

    const { createServer } = require("./server");
    const server = createServer({ host, port });
    await listen(server, host, port);

    const url = `http://127.0.0.1:${port}`;
    await assertReady(url);

    console.log("");
    console.log("QuickSearch is ready.");
    console.log(`Open address: ${url}`);
    console.log("");

    if (!noOpen) openBrowser(url);

    if (checkOnly) {
        await close(server);
        return;
    }

    console.log("Keep this window open while you use QuickSearch.");
    console.log("Press Enter here when you want to stop it.");
    await waitForEnter();
    await close(server);
    console.log("QuickSearch stopped.");
}

function uniqueNumbers(values) {
    return [...new Set(values.filter(value => Number.isInteger(value) && value > 0 && value < 65536))];
}

async function findExistingQuickSearch() {
    for (const port of candidatePorts) {
        if (await isQuickSearch(port)) return port;
    }
    return 0;
}

async function isQuickSearch(port) {
    try {
        const result = await fetchJson(`http://127.0.0.1:${port}/healthz`, 800);
        return result && result.name === "quicksearch-proxy";
    } catch (error) {
        return false;
    }
}

async function findFreePort() {
    for (const port of candidatePorts) {
        if (await isPortFree(port)) return port;
    }
    return 0;
}

function isPortFree(port) {
    return new Promise(resolve => {
        const tester = net.createServer();
        tester.once("error", () => resolve(false));
        tester.once("listening", () => {
            tester.close(() => resolve(true));
        });
        tester.listen(port, host);
    });
}

function listen(server, listenHost, listenPort) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, listenHost, () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function close(server) {
    return new Promise(resolve => server.close(resolve));
}

async function assertReady(url) {
    const health = await fetchJson(`${url}/healthz`, 2000);
    if (!health || health.name !== "quicksearch-proxy") {
        throw new Error("The local server started but did not report ready.");
    }

    await fetchText(url, 2000);
}

async function fetchJson(url, timeoutMs) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return response.json();
}

async function fetchText(url, timeoutMs) {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Local page check failed with status ${response.status}.`);
    return response.text();
}

function openBrowser(url) {
    const platform = process.platform;
    let command;
    let commandArgs;

    if (platform === "win32") {
        command = "cmd";
        commandArgs = ["/c", "start", "", url];
    } else if (platform === "darwin") {
        command = "open";
        commandArgs = [url];
    } else {
        command = "xdg-open";
        commandArgs = [url];
    }

    const child = spawn(command, commandArgs, {
        detached: true,
        stdio: "ignore"
    });
    child.unref();
}

function waitForEnter() {
    return new Promise(resolve => {
        process.stdin.resume();
        process.stdin.setEncoding("utf8");
        process.stdin.once("data", resolve);
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
    });
}
