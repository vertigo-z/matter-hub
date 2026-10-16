#!/usr/bin/env node
import { Environment, Logger } from "@matter/general";
import "@matter/main/platform";
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
  console.log("\n[matter-hub] shutting down\u2026");
  api.close();
  await hub.close();
  process.exit(0);
});
//# sourceMappingURL=index.js.map
