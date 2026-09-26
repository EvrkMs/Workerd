#!/usr/bin/env node
// wravler = wrangler, у которого вместо API Cloudflare — наша платформа.
// Переопределить можно через WRAVLER_API и WRAVLER_TOKEN.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

const env = {
  ...process.env,
  CLOUDFLARE_API_BASE_URL: process.env.WRAVLER_API ?? "https://api.workers.ava-kk.ru/client/v4",
  CLOUDFLARE_API_TOKEN: process.env.WRAVLER_TOKEN ?? "dev",
  CLOUDFLARE_ACCOUNT_ID: "ava",
  WRANGLER_SEND_METRICS: "false",
};

spawn(process.execPath, [wrangler, ...process.argv.slice(2)], { stdio: "inherit", env })
  .on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
