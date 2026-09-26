#!/usr/bin/env node
// wravler = wrangler, у которого вместо API Cloudflare — наша платформа.
// Токен: WRAVLER_TOKEN или ~/.config/wravler/token (создаёт tools/wravler/init-token.sh).
// Адрес API можно переопределить через WRAVLER_API.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DOMAIN = "workers.ava-kk.ru";
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const tokenFile = join(homedir(), ".config", "wravler", "token");

let token = process.env.WRAVLER_TOKEN;
if (!token && existsSync(tokenFile)) token = readFileSync(tokenFile, "utf8").trim();
if (!token) {
  console.error(`wravler: нет токена. Создай его: sh tools/wravler/init-token.sh (файл ${tokenFile})`);
  process.exit(1);
}

const env = {
  ...process.env,
  CLOUDFLARE_API_BASE_URL: process.env.WRAVLER_API ?? `https://api.${ROOT_DOMAIN}/client/v4`,
  CLOUDFLARE_API_TOKEN: token,
  CLOUDFLARE_ACCOUNT_ID: "ava",
  WRANGLER_SEND_METRICS: "false",
};

const args = process.argv.slice(2);

/** Имя воркера для подсказки с адресом: --name или name из wrangler.toml / .json(c). */
function workerName() {
  const flag = args.findIndex((a) => a === "--name");
  if (flag >= 0 && args[flag + 1]) return args[flag + 1];
  const inline = args.find((a) => a.startsWith("--name="));
  if (inline) return inline.slice("--name=".length);
  for (const file of ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]) {
    if (!existsSync(file)) continue;
    const match = readFileSync(file, "utf8").match(/^\s*"?name"?\s*[=:]\s*"([^"]+)"/m);
    if (match) return match[1];
  }
  return null;
}

spawn(process.execPath, [wrangler, ...args], { stdio: "inherit", env }).on("exit", (code, signal) => {
  // wrangler печатает адрес в формате workers.dev (<имя>.ava.workers.dev) — это зашито в нём.
  if (code === 0 && args[0] === "deploy") {
    const name = workerName();
    if (name) console.log(`\nwravler: воркер доступен на https://${name}.${ROOT_DOMAIN}`);
  }
  process.exit(signal ? 1 : (code ?? 1));
});
