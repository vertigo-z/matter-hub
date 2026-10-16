/**
 * HTTP API + SSE + static file server. Zero runtime dependencies.
 *
 * REST endpoints (all JSON):
 *   GET  /api/health
 *   GET  /api/state                     nodes + settings + log tail
 *   GET  /api/nodes/:nodeId             node detail (endpoints, clusters, thread diag)
 *   POST /api/command                   { nodeId, endpointId, action, value }
 *   POST /api/commission                { pairingCode | qrCode | discriminator/shortDiscriminator
 *                                          + passcode | discoveredId, useThread, threadDataset,
 *                                          useWifi, wifiSsid, wifiPass, useBle }
 *   POST /api/scan                      { seconds }
 *   POST /api/nodes/:nodeId/rename      { label }
 *   POST /api/nodes/:nodeId/decommission { force }
 *   POST /api/nodes/:nodeId/window      { timeoutSeconds }
 *   POST /api/nodes/:nodeId/identify    { seconds }
 *   GET  /api/thread/status             refresh + return OTBR snapshot
 *   POST /api/settings                  { otbrHost, otbrPort, bleEnabled }
 *   GET  /api/groups                    list groups
 *   POST /api/groups                    { name, entityKeys[] }
 *   PATCH  /api/groups/:id              { name?, entityKeys? }
 *   DELETE /api/groups/:id
 *   POST /api/groups/:id/command        { action, value }
 *   GET  /api/automations               list automations
 *   POST /api/automations               { name, trigger {key,field,op,value} | {type:"time",time,days[]}, action {key,action,value} }
 *   PATCH  /api/automations/:id         { name?, enabled?, trigger?, action? }
 *   DELETE /api/automations/:id
 *   POST /api/automations/:id/run       execute the action now
 *
 * SSE (GET /api/events): events `nodes`, `entities`, `commissioning`, `discovered`,
 * `scan`, `thread`, `log`, `groups`, `automations`.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { jsonReplacer } from "./Entities.js";

const MAX_BODY_BYTES = 65536;
const KEEPALIVE_MS = 15000;

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json",
};

export class HttpApi {
    #hub;
    #options;
    #server;
    #sseClients = new Set();
    #keepalive;

    constructor(hub, options) {
        this.#hub = hub;
        this.#options = options;

        // Every hub broadcast fans out to all connected UIs.
        hub.onBroadcast((event, data) => this.#broadcast(event, data));

        this.#server = createServer((req, res) => {
            this.#handle(req, res).catch(error => {
                this.#sendJson(res, 500, { error: error.message });
            });
        });

        this.#server.listen(options.port, options.host, () => {
            const shownHost = options.host === "0.0.0.0" ? "localhost" : options.host;
            console.log(`\n  MATTER//HUB`);
            console.log(`  ─────────────────────────────────────────`);
            console.log(`  UI        http://${shownHost}:${options.port}`);
            console.log(`  API       http://${shownHost}:${options.port}/api/state`);
            console.log(`  SSE       http://${shownHost}:${options.port}/api/events`);
            console.log(`  ─────────────────────────────────────────\n`);
        });

        this.#keepalive = setInterval(() => {
            for (const res of this.#sseClients) {
                try {
                    res.write(": ping\n\n");
                } catch {
                    this.#sseClients.delete(res);
                }
            }
        }, KEEPALIVE_MS);
        this.#keepalive.unref?.();
    }

    close() {
        clearInterval(this.#keepalive);
        for (const res of this.#sseClients) {
            try {
                res.end();
            } catch {}
        }
        this.#sseClients.clear();
        this.#server.close();
    }

    // ------------------------------------------------------------------ SSE

    #broadcast(event, data) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data, jsonReplacer)}\n\n`;
        for (const res of this.#sseClients) {
            try {
                res.write(payload);
            } catch {
                this.#sseClients.delete(res);
            }
        }
    }

    #attachSse(res) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.write("retry: 2000\n\n");
        this.#sseClients.add(res);
        reqCleanup(res, this.#sseClients);

        // Initial snapshot so a fresh page render has data immediately.
        this.#sendTo(res, "nodes", { nodes: this.#hub.nodeSummaries() });
        for (const line of this.#hub.log.entries.slice(-100)) {
            this.#sendTo(res, "log", line);
        }
        this.#hub.pushSnapshot();
        void this.#hub.refreshThreadStatus();
    }

    #sendTo(res, event, data) {
        try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data, jsonReplacer)}\n\n`);
        } catch {}
    }

    // ------------------------------------------------------------------ routing

    async #handle(req, res) {
        const url = new URL(req.url ?? "/", "http://local");
        const path = url.pathname;

        if (path === "/api/events" && req.method === "GET") {
            this.#attachSse(res);
            return;
        }

        if (path.startsWith("/api/")) {
            try {
                await this.#api(req, res, path);
            } catch (error) {
                this.#sendJson(res, error.status ?? 400, { error: error.message });
            }
            return;
        }

        if (req.method === "GET") {
            await this.#serveStatic(res, path);
            return;
        }

        this.#sendJson(res, 404, { error: "not found" });
    }

    async #api(req, res, path) {
        const hub = this.#hub;

        if (req.method === "GET" && path === "/api/health") {
            return this.#sendJson(res, 200, { ok: true });
        }

        if (req.method === "GET" && path === "/api/state") {
            return this.#sendJson(res, 200, {
                nodes: hub.nodeSummaries(),
                groups: hub.listGroups(),
                automations: hub.listAutomations(),
                settings: await hub.getSettings(),
                log: hub.log.entries.slice(-200),
            });
        }

        if (req.method === "GET" && path === "/api/thread/status") {
            return this.#sendJson(res, 200, { thread: await hub.refreshThreadStatus() });
        }

        const nodeMatch = path.match(/^\/api\/nodes\/([^/]+)(?:\/(rename|decommission|window|identify))?$/);
        if (nodeMatch !== null) {
            const nodeId = decodeURIComponent(nodeMatch[1]);
            const op = nodeMatch[2];

            if (op === undefined && req.method === "GET") {
                const detail = await hub.nodeDetail(nodeId);
                if (detail === undefined) throw httpError(404, `node ${nodeId} not commissioned`);
                return this.#sendJson(res, 200, detail);
            }
            if (op === "rename" && req.method === "POST") {
                const body = await readJson(req);
                if (typeof body.label !== "string" || body.label.length === 0) throw httpError(400, "label required");
                return this.#sendJson(res, 200, await hub.renameNode(nodeId, body.label));
            }
            if (op === "decommission" && req.method === "POST") {
                const body = await readJson(req);
                return this.#sendJson(res, 200, await hub.decommissionNode(nodeId, body.force === true));
            }
            if (op === "window" && req.method === "POST") {
                const body = await readJson(req);
                return this.#sendJson(res, 200, await hub.openWindow(nodeId, body.timeoutSeconds ?? 900));
            }
            if (op === "identify" && req.method === "POST") {
                const body = await readJson(req);
                return this.#sendJson(res, 200, await hub.identify(nodeId, body.seconds ?? 10));
            }
            throw httpError(405, "method not allowed");
        }

        if (req.method === "POST" && path === "/api/command") {
            const body = await readJson(req);
            if (body.nodeId === undefined || body.endpointId === undefined || body.action === undefined) {
                throw httpError(400, "nodeId, endpointId and action are required");
            }
            return this.#sendJson(res, 200, await hub.command(body));
        }

        if (req.method === "POST" && path === "/api/commission") {
            const body = await readJson(req);
            return this.#sendJson(res, 200, await hub.commission(body));
        }

        if (req.method === "POST" && path === "/api/scan") {
            const body = await readJson(req);
            return this.#sendJson(res, 200, await hub.scan(body.seconds ?? 20));
        }

        if (req.method === "POST" && path === "/api/settings") {
            const body = await readJson(req);
            return this.#sendJson(res, 200, await hub.updateSettings(body));
        }

        const groupCommandMatch = path.match(/^\/api\/groups\/([^/]+)\/command$/);
        if (groupCommandMatch !== null && req.method === "POST") {
            const body = await readJson(req);
            if (body.action === undefined) throw httpError(400, "action required");
            return this.#sendJson(
                res,
                200,
                await hub.groupCommand(decodeURIComponent(groupCommandMatch[1]), body.action, body.value),
            );
        }

        const groupMatch = path.match(/^\/api\/groups(?:\/([^/]+))?$/);
        if (groupMatch !== null) {
            const id = groupMatch[1] === undefined ? undefined : decodeURIComponent(groupMatch[1]);
            if (id === undefined && req.method === "GET") {
                return this.#sendJson(res, 200, { groups: hub.listGroups() });
            }
            if (id === undefined && req.method === "POST") {
                const body = await readJson(req);
                return this.#sendJson(res, 200, await hub.createGroup(body.name, body.entityKeys));
            }
            if (id !== undefined && req.method === "PATCH") {
                const body = await readJson(req);
                return this.#sendJson(res, 200, await hub.updateGroup(id, body));
            }
            if (id !== undefined && req.method === "DELETE") {
                return this.#sendJson(res, 200, await hub.deleteGroup(id));
            }
            throw httpError(405, "method not allowed");
        }

        const automationRunMatch = path.match(/^\/api\/automations\/([^/]+)\/run$/);
        if (automationRunMatch !== null && req.method === "POST") {
            return this.#sendJson(res, 200, await hub.runAutomation(decodeURIComponent(automationRunMatch[1])));
        }

        const automationMatch = path.match(/^\/api\/automations(?:\/([^/]+))?$/);
        if (automationMatch !== null) {
            const id = automationMatch[1] === undefined ? undefined : decodeURIComponent(automationMatch[1]);
            if (id === undefined && req.method === "GET") {
                return this.#sendJson(res, 200, { automations: hub.listAutomations() });
            }
            if (id === undefined && req.method === "POST") {
                const body = await readJson(req);
                return this.#sendJson(res, 200, await hub.createAutomation(body));
            }
            if (id !== undefined && req.method === "PATCH") {
                const body = await readJson(req);
                return this.#sendJson(res, 200, await hub.updateAutomation(id, body));
            }
            if (id !== undefined && req.method === "DELETE") {
                return this.#sendJson(res, 200, await hub.deleteAutomation(id));
            }
            throw httpError(405, "method not allowed");
        }

        throw httpError(404, `no such API endpoint: ${req.method} ${path}`);
    }

    // ------------------------------------------------------------------ static

    async #serveStatic(res, path) {
        let relative = path === "/" ? "index.html" : path.slice(1);
        relative = normalize(relative).replace(/^(\.\.[/\\])+/, "");
        const file = join(this.#options.publicDir, relative);
        if (!file.startsWith(this.#options.publicDir)) {
            return this.#sendJson(res, 403, { error: "forbidden" });
        }
        try {
            const content = await readFile(file);
            res.writeHead(200, {
                "Content-Type": MIME_TYPES[extname(file)] ?? "application/octet-stream",
                "Cache-Control": "no-cache",
            });
            res.end(content);
        } catch {
            this.#sendJson(res, 404, { error: "not found" });
        }
    }

    #sendJson(res, status, payload) {
        const body = JSON.stringify(payload, jsonReplacer);
        res.writeHead(status, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
    }
}

function reqCleanup(res, set) {
    res.on("close", () => set.delete(res));
}

function httpError(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw httpError(413, "request body too large");
        chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw httpError(400, "invalid JSON body");
    }
}
