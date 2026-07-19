#!/usr/bin/env node
import { startStdio } from "./mcp/server.js";

const baseUrl = process.env.JUSTDROP_BASE_URL || "https://justdrop.ai";
const root = process.env.JUSTDROP_ROOT || process.cwd();
const defaultExpiryMinutes = Number(process.env.JUSTDROP_DEFAULT_EXPIRY_MINUTES || 60);

startStdio({
  baseUrl,
  root,
  defaultExpiryMinutes:
    Number.isFinite(defaultExpiryMinutes) && defaultExpiryMinutes >= 1
      ? Math.min(defaultExpiryMinutes, 1440)
      : 60,
}).catch((err) => {
  console.error("[justdrop-mcp] fatal:", err);
  process.exit(1);
});
