import { appendFileSync } from "node:fs";
import { createRequire, register, syncBuiltinESMExports } from "node:module";

register("./loader.mjs", import.meta.url);

const marker = process.env.ENQUIRE_BENCH_NETWORK_MARKER;
const trip = (surface, target) => {
  if (marker) appendFileSync(marker, `${surface}: ${String(target).slice(0, 160)}\n`);
  throw new Error(`BENCH NETWORK TRIPWIRE: ${surface}`);
};

globalThis.fetch = (input) => trip("fetch", input);

const require = createRequire(import.meta.url);
const http = require("node:http");
const https = require("node:https");
http.request = (...args) => trip("http.request", args[0]);
http.get = (...args) => trip("http.get", args[0]);
https.request = (...args) => trip("https.request", args[0]);
https.get = (...args) => trip("https.get", args[0]);
syncBuiltinESMExports();
