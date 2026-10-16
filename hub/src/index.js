#!/usr/bin/env node
/**
 * MATTER//HUB — standalone Matter controller hub.
 *
 * Pure-JS (ESM, no build step) Matter commissioning + control hub built on the
 * local matter.js clone (0.18 ClientNode controller API). Talks to an OpenThread
 * Border Router REST API for Thread credentials and network status, and serves a
 * self-contained web UI over HTTP + SSE.
 */

import { Environment, Logger } from "@matter/general";

// Registers the Node.js platform implementations (crypto, network, time, storage).
import "@matter/main/platform";

// BLE central support for commissioning Thread/Wi-Fi devices that are not yet
// on an IP network. Installs itself reactively when the "ble.enable" var is set.
import "@matter/nodejs-ble";

import { Hub } from "./Hub.js";
import { HttpApi } from "./HttpApi.js";

const environment = Environment.default;

Logger.level = environment.vars.string("loglevel") ?? "info";

const port = environment.vars.number("port") ?? 8410;
const host = environment.vars.string("host") ?? "0.0.0.0";

const hub = await Hub.create(environment);
const api = new HttpApi(hub, { port, host, publicDir: new URL("../public/", import.meta.url).pathname });

process.on("SIGINT", async () => {
    console.log("\n[matter-hub] shutting down…");
    api.close();
    await hub.close();
    process.exit(0);
});
