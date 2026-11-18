// Runtime secrets. Sourced from env vars when present, otherwise from <DATA_DIR>/secrets.json,
// which is written by the owner bootstrap endpoint (see ops/RUNBOOK.md). This lets the app be
// configured without passing secrets through CI.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

export interface Secrets {
  clientSecret: string;
  appKey: string;
  secretKey: string;
}

let cache: Secrets | null = null;
const file = () => join(config.dataDir, "secrets.json");

export function secrets(): Secrets {
  if (cache) return cache;
  let stored: Partial<Secrets> = {};
  if (existsSync(file())) {
    try {
      stored = JSON.parse(readFileSync(file(), "utf8"));
    } catch {
      stored = {};
    }
  }
  const s: Secrets = {
    clientSecret: config.clientSecret || stored.clientSecret || "",
    appKey: config.appKey || stored.appKey || "",
    secretKey: process.env.SECRET_KEY || stored.secretKey || "",
  };
  if (!s.secretKey) {
    s.secretKey = randomBytes(32).toString("hex");
    saveSecrets({ ...stored, secretKey: s.secretKey });
  }
  cache = s;
  return s;
}

export function saveSecrets(update: Partial<Secrets>) {
  let stored: Partial<Secrets> = {};
  if (existsSync(file())) {
    try {
      stored = JSON.parse(readFileSync(file(), "utf8"));
    } catch {
      stored = {};
    }
  }
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(file(), JSON.stringify({ ...stored, ...update }, null, 2));
  try {
    chmodSync(file(), 0o600);
  } catch {
    /* ignore */
  }
  cache = null;
}

export const signInReady = () => Boolean(config.clientId && secrets().clientSecret);
export const economyReady = () => Boolean(signInReady() && secrets().appKey);
