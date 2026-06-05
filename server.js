import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

loadEnvFiles([
  path.join(os.homedir(), ".config", "athena-usage-tracker", "env"),
  ".env",
  ".env.local",
]);

const PORT = Number(process.env.PORT || 8080);
// Binds to loopback by default so credentials never leave the machine. Set
// HOST (e.g. 0.0.0.0 or a Tailscale IP) to opt into remote access over a
// trusted private network. See "Remote access with Tailscale" in the README.
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const CLAUDE_STATUSLINE_CAPTURE = path.join(__dirname, "scripts", "claude-statusline-capture.js");
const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/codex/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/keys";
const OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const PUBLIC_FILES = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/widget.html": { file: "widget.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/widget.css": { file: "widget.css", type: "text/css; charset=utf-8" },
  "/src/app.js": { file: "src/app.js", type: "text/javascript; charset=utf-8" },
  "/src/widget.js": { file: "src/widget.js", type: "text/javascript; charset=utf-8" },
};
const NO_STORE_HEADERS = {
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  expires: "0",
};

function loadEnvFiles(files) {
  const shellEnv = new Set(Object.keys(process.env));
  for (const name of files) {
    const file = path.isAbsolute(name) ? name : path.join(__dirname, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
      if (!match || shellEnv.has(match[1])) continue;
      process.env[match[1]] = parseEnvValue(match[2] || "");
    }
  }
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+#.*$/, "");
}

class ClaudeSyncUnavailableError extends Error {
  constructor(message, code = "claude_sync_unavailable") {
    super(message);
    this.name = "ClaudeSyncUnavailableError";
    this.code = code;
  }
}

async function ensureAccountsFile() {
  await mkdir(DATA_DIR, { recursive: true });
  if (existsSync(ACCOUNTS_FILE)) return;
  const defaultAccounts = [
    {
      id: "default",
      name: "Default Codex",
      provider: "codex",
      codexHome: path.join(os.homedir(), ".codex-accounts", "account1"),
      expectedEmail: null,
      enabled: true,
    },
  ];
  await writeJson(ACCOUNTS_FILE, { accounts: defaultAccounts });
}

async function readAccounts() {
  await ensureAccountsFile();
  const raw = await readFile(ACCOUNTS_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  if (await stabilizeSharedCodexHomes(accounts)) {
    await writeAccounts(accounts);
  }
  return accounts;
}

async function writeAccounts(accounts) {
  await writeJson(ACCOUNTS_FILE, { accounts });
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeCodexHome(input) {
  if (!input || typeof input !== "string") return "";
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

function isSharedCodexHome(input) {
  const codexHome = normalizeCodexHome(input);
  return codexHome === path.join(os.homedir(), ".codex");
}

function normalizeProvider(input) {
  return ["codex", "claude", "openrouter"].includes(input) ? input : "codex";
}

function normalizeEnvVarName(input) {
  const name = String(input || "").trim();
  if (!name) return "";
  if (/^sk-or-/i.test(name)) {
    throw new Error("Store the OpenRouter key in an environment variable, not in account config");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error("OpenRouter key environment variable must be a valid env var name");
  }
  return name;
}

function dedicatedCodexHomeFor(account) {
  const slug = String(account.name || account.id || "account")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "account";
  const suffix = String(account.id || randomUUID()).slice(0, 8);
  return path.join(os.homedir(), ".codex-accounts", `${slug}-${suffix}`);
}

function codexLoginCommand(codexHome) {
  if (process.platform === "win32") {
    return `set "CODEX_HOME=${codexHome}" && codex login --device-auth`;
  }
  return `CODEX_HOME=${shellQuote(codexHome)} codex login --device-auth`;
}

async function copySharedCodexLogin(sourceHome, targetHome) {
  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  const sourceAuth = path.join(sourceHome, "auth.json");
  const targetAuth = path.join(targetHome, "auth.json");
  if (existsSync(sourceAuth) && !existsSync(targetAuth)) {
    await copyFile(sourceAuth, targetAuth);
  }
}

async function stabilizeSharedCodexHomes(accounts) {
  let changed = false;
  for (const account of accounts) {
    if (account.provider !== "codex" || !isSharedCodexHome(account.codexHome)) continue;
    const sourceHome = normalizeCodexHome(account.codexHome);
    const targetHome = dedicatedCodexHomeFor(account);
    await copySharedCodexLogin(sourceHome, targetHome);
    account.codexHome = targetHome;
    account.importedFromSharedCodexHome = true;
    changed = true;
  }
  return changed;
}

function createAccount(input) {
  const name = String(input.name || "").trim();
  const provider = normalizeProvider(input.provider);
  const id = randomUUID();
  let codexHome = normalizeCodexHome(input.codexHome);
  const claudeHome = normalizeCodexHome(input.claudeHome || path.join(os.homedir(), ".claude"));
  const openrouterKeyEnv = normalizeEnvVarName(input.openrouterKeyEnv || input.openrouterApiKeyEnv);
  const openrouterUsageLog = input.openrouterUsageLog ? normalizeCodexHome(input.openrouterUsageLog) : "";
  const expectedEmail = String(input.expectedEmail || "").trim();
  if (!name) throw new Error("Account name is required");
  if (provider === "codex" && !codexHome) throw new Error("CODEX_HOME path is required");
  if (provider === "openrouter" && !openrouterKeyEnv) {
    throw new Error("OpenRouter API key environment variable is required");
  }
  if (provider === "codex" && isSharedCodexHome(codexHome)) {
    codexHome = dedicatedCodexHomeFor({ id, name });
  }
  return {
    id,
    name,
    provider,
    ...(provider === "codex" ? { codexHome } : {}),
    ...(provider === "claude" ? { claudeHome } : {}),
    ...(provider === "openrouter" ? { openrouterKeyEnv, ...(openrouterUsageLog ? { openrouterUsageLog } : {}) } : {}),
    expectedEmail: expectedEmail || null,
    enabled: input.enabled !== false,
  };
}

async function queryAccount(account) {
  if (account.provider === "claude") return queryClaudeAccount(account);
  if (account.provider === "openrouter") return queryOpenRouterAccount(account);
  return queryCodexAccount(account);
}

async function queryCodexAccount(account) {
  const manualOnly = applyManualOverride(account);
  if (manualOnly.status === "manual_lockout") {
    return manualOnly;
  }
  const codexHome = normalizeCodexHome(account.codexHome);
  if (!existsSync(codexHome)) {
    return applyManualOverride({
      ...account,
      provider: "codex",
      codexHome,
      status: "missing_home",
      error: `CODEX_HOME does not exist: ${codexHome}`,
      loginCommand: codexLoginCommand(codexHome),
    });
  }
  if (!existsSync(path.join(codexHome, "auth.json"))) {
    return applyManualOverride({
      ...account,
      provider: "codex",
      codexHome,
      status: "not_logged_in",
      error: `No auth.json found in ${codexHome}`,
      loginCommand: codexLoginCommand(codexHome),
    });
  }

  try {
    const result = await queryDirectUsage(codexHome);
    const actualEmail = result.account?.email || null;
    if (account.expectedEmail && actualEmail && account.expectedEmail !== actualEmail) {
      return applyManualOverride({
        ...account,
        provider: "codex",
        codexHome,
        status: "wrong_account",
        email: actualEmail,
        expectedEmail: account.expectedEmail,
        error: `Expected ${account.expectedEmail}, but ${codexHome} is logged in as ${actualEmail}`,
        usageSource: result.usageSource || "direct",
        loginCommand: codexLoginCommand(codexHome),
        updatedAt: new Date().toISOString(),
      });
    }
    return applyManualOverride({
      ...account,
      provider: "codex",
      codexHome,
      status: result.account ? "ok" : "not_logged_in",
      email: result.account?.email || null,
      planType: result.account?.planType || result.rateLimits?.planType || null,
      rateLimits: result.rateLimits || null,
      rateLimitsByLimitId: result.rateLimitsByLimitId || null,
      usageSource: result.usageSource || "direct",
      rawUsage: result.rawUsage || null,
      loginCommand: codexLoginCommand(codexHome),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    try {
      const fallback = await queryAppServer(codexHome);
      const actualEmail = fallback.account?.email || null;
      if (account.expectedEmail && actualEmail && account.expectedEmail !== actualEmail) {
        return applyManualOverride({
          ...account,
          provider: "codex",
          codexHome,
          status: "wrong_account",
          email: actualEmail,
          expectedEmail: account.expectedEmail,
          error: `Expected ${account.expectedEmail}, but ${codexHome} is logged in as ${actualEmail}`,
          usageSource: "app-server-fallback",
          sourceWarning: error.message,
          loginCommand: codexLoginCommand(codexHome),
          updatedAt: new Date().toISOString(),
        });
      }
      return applyManualOverride({
        ...account,
        provider: "codex",
        codexHome,
        status: fallback.account ? "ok" : "not_logged_in",
        email: fallback.account?.email || null,
        planType: fallback.account?.planType || fallback.rateLimits?.planType || null,
        rateLimits: fallback.rateLimits || null,
        rateLimitsByLimitId: fallback.rateLimitsByLimitId || null,
        usageSource: "app-server-fallback",
        sourceWarning: error.message,
        loginCommand: codexLoginCommand(codexHome),
        updatedAt: new Date().toISOString(),
      });
    } catch (fallbackError) {
      return applyManualOverride({
        ...account,
        provider: "codex",
        codexHome,
        status: "error",
        error: `${error.message}; fallback failed: ${fallbackError.message}`,
        loginCommand: codexLoginCommand(codexHome),
      });
    }
  }
}

async function queryClaudeAccount(account) {
  const claudeHome = normalizeCodexHome(account.claudeHome || path.join(os.homedir(), ".claude"));
  const credentialsPath = path.join(claudeHome, ".credentials.json");
  const loginCommand = "claude auth login";

  if (!existsSync(claudeHome)) {
    return {
      ...account,
      provider: "claude",
      claudeHome,
      status: "missing_home",
      error: `Claude config directory does not exist: ${claudeHome}`,
      loginCommand,
    };
  }
  if (!existsSync(credentialsPath)) {
    return {
      ...account,
      provider: "claude",
      claudeHome,
      status: "not_logged_in",
      error: `No Claude credentials found in ${claudeHome}`,
      loginCommand,
    };
  }

  try {
    const [credentials, status] = await Promise.all([readClaudeCredentials(credentialsPath), readClaudeAuthStatus()]);
    const email = status.email || account.expectedEmail || null;
    if (account.expectedEmail && email && account.expectedEmail !== email) {
      return {
        ...account,
        provider: "claude",
        claudeHome,
        status: "wrong_account",
        email,
        expectedEmail: account.expectedEmail,
        error: `Expected ${account.expectedEmail}, but Claude is logged in as ${email}`,
        loginCommand,
        updatedAt: new Date().toISOString(),
      };
    }
    return buildClaudeUsageAccount(account, claudeHome, credentials, status, account.claudeUsage || null);
  } catch (error) {
    return {
      ...account,
      provider: "claude",
      claudeHome,
      status: "error",
      error: error.message,
      loginCommand,
    };
  }
}

function buildClaudeUsageAccount(account, claudeHome, credentials, status, usage) {
  const email = status.email || account.expectedEmail || null;
  const base = {
    ...account,
    provider: "claude",
    claudeHome,
    email,
    planType: status.subscriptionType || credentials.subscriptionType || null,
    claude: {
      authMethod: status.authMethod || null,
      apiProvider: status.apiProvider || null,
      orgName: status.orgName || null,
      rateLimitTier: credentials.rateLimitTier || null,
      expiresAt: credentials.expiresAt || null,
      ...(usage?.model ? { model: usage.model } : {}),
      ...(usage?.contextWindow ? { contextWindow: usage.contextWindow } : {}),
    },
    loginCommand: "claude auth login",
  };

  const rateLimits = usage?.rateLimits || null;
  if (!rateLimits) {
    return {
      ...base,
      status: "metadata_only",
      usageSource: "claude-auth-status",
      sourceWarning: "Click Sync usage to run a tiny Claude Code turn and read subscription windows from its status-line payload.",
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    ...base,
    status: "ok",
    rateLimits,
    rateLimitsByLimitId: { "claude-code": rateLimits },
    usageSource: "claude-statusline",
    rawUsage: usage.rawUsage || null,
    updatedAt: usage.updatedAt || new Date().toISOString(),
  };
}

async function syncClaudeUsageAccount(account) {
  if (account.provider !== "claude") throw new Error("Account is not a Claude Code account");

  const claudeHome = normalizeCodexHome(account.claudeHome || path.join(os.homedir(), ".claude"));
  const credentialsPath = path.join(claudeHome, ".credentials.json");
  if (!existsSync(credentialsPath)) throw new Error(`No Claude credentials found in ${claudeHome}`);

  const [credentials, status] = await Promise.all([
    readClaudeCredentials(credentialsPath),
    readClaudeAuthStatus(),
  ]);

  const email = status.email || account.expectedEmail || null;
  if (account.expectedEmail && email && account.expectedEmail !== email) {
    throw new Error(`Expected ${account.expectedEmail}, but Claude is logged in as ${email}`);
  }

  let usage;
  try {
    usage = await runClaudeStatuslineProbe();
  } catch (error) {
    if (!(error instanceof ClaudeSyncUnavailableError)) throw error;
    const fallback = account.claudeUsage || null;
    return {
      ...buildClaudeUsageAccount(account, claudeHome, credentials, status, fallback),
      sourceWarning: fallback
        ? `${error.message} Showing last synced Claude usage.`
        : error.message,
      syncWarning: fallback
        ? `${error.message} Showing last synced Claude usage.`
        : error.message,
      syncStatus: error.code,
      updatedAt: new Date().toISOString(),
    };
  }

  const nextAccount = { ...account, claudeUsage: usage };
  return buildClaudeUsageAccount(nextAccount, claudeHome, credentials, status, usage);
}

async function queryOpenRouterAccount(account) {
  let openrouterKeyEnv = "";
  try {
    openrouterKeyEnv = normalizeEnvVarName(account.openrouterKeyEnv || account.openrouterApiKeyEnv);
  } catch (error) {
    return {
      ...account,
      provider: "openrouter",
      status: "error",
      error: error.message,
      updatedAt: new Date().toISOString(),
    };
  }

  if (!openrouterKeyEnv) {
    return {
      ...account,
      provider: "openrouter",
      status: "not_logged_in",
      error: "OpenRouter API key environment variable is not configured",
      updatedAt: new Date().toISOString(),
    };
  }

  const apiKey = process.env[openrouterKeyEnv];
  if (!apiKey) {
    return {
      ...account,
      provider: "openrouter",
      openrouterKeyEnv,
      status: "not_logged_in",
      error: `Missing environment variable: ${openrouterKeyEnv}`,
      usageSource: "openrouter-key-api",
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const [usageInfo, usageLog] = await Promise.all([
      fetchOpenRouterAccountUsage(apiKey),
      readOpenRouterUsageLog(account.openrouterUsageLog),
    ]);
    return buildOpenRouterUsageAccount(account, openrouterKeyEnv, usageInfo, usageLog);
  } catch (error) {
    return {
      ...account,
      provider: "openrouter",
      openrouterKeyEnv,
      status: error.status === 401 || error.status === 403 ? "not_logged_in" : "error",
      error: error.message,
      usageSource: "openrouter-key-api",
      updatedAt: new Date().toISOString(),
    };
  }
}

async function fetchOpenRouterAccountUsage(apiKey) {
  const [currentKey, credits, managedKeys] = await Promise.all([
    fetchOpenRouterKeyInfo(apiKey),
    fetchOpenRouterCredits(apiKey).catch((error) => ({ error })),
    fetchOpenRouterManagedKeys(apiKey).catch((error) => ({ error })),
  ]);
  const keys = Array.isArray(managedKeys.keys) && managedKeys.keys.length ? managedKeys.keys : [currentKey];
  return {
    currentKey,
    credits: credits.error ? null : credits,
    keys,
    source: Array.isArray(managedKeys.keys) && managedKeys.keys.length
      ? "openrouter-management-api"
      : "openrouter-key-api",
    warning: managedKeys.error
      ? `OpenRouter management key list unavailable; showing current key only (${managedKeys.error.message})`
      : null,
  };
}

async function fetchOpenRouterKeyInfo(apiKey) {
  const response = await fetch(OPENROUTER_KEY_URL, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "user-agent": "Athena Usage Tracker/0.2.0",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`OpenRouter key endpoint failed: ${response.status} ${body.slice(0, 160)}`);
    error.status = response.status;
    throw error;
  }
  const raw = await response.json();
  if (!raw || typeof raw !== "object" || !raw.data) {
    throw new Error("OpenRouter key endpoint returned invalid JSON");
  }
  return raw.data;
}

async function fetchOpenRouterCredits(apiKey) {
  const response = await fetch(OPENROUTER_CREDITS_URL, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      "user-agent": "Athena Usage Tracker/0.2.0",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    const error = new Error(`OpenRouter credits endpoint failed: ${response.status} ${body.slice(0, 160)}`);
    error.status = response.status;
    throw error;
  }
  const raw = await response.json();
  if (!raw || typeof raw !== "object" || !raw.data) {
    throw new Error("OpenRouter credits endpoint returned invalid JSON");
  }
  return raw.data;
}

async function fetchOpenRouterManagedKeys(apiKey) {
  const keys = [];
  const pageSize = 100;
  for (let offset = 0; offset < 10000; offset += pageSize) {
    const url = new URL(OPENROUTER_KEYS_URL);
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "user-agent": "Athena Usage Tracker/0.2.0",
      },
    });
    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`OpenRouter keys endpoint failed: ${response.status} ${body.slice(0, 160)}`);
      error.status = response.status;
      throw error;
    }
    const raw = await response.json();
    const page = Array.isArray(raw?.data) ? raw.data : [];
    keys.push(...page);
    if (page.length < pageSize) break;
  }
  return { keys };
}

function buildOpenRouterUsageAccount(account, openrouterKeyEnv, usageInfo, usageLog = { records: [], warning: null }) {
  const keyInfo = buildOpenRouterAccountKeyInfo(usageInfo);
  const usedPercent = openRouterUsedPercent(keyInfo);
  const limitRemaining = numberOrNull(keyInfo.limit_remaining);
  const usagePeriods = buildOpenRouterUsagePeriods(keyInfo, usageLog.records);
  const models = aggregateOpenRouterModels(usageLog.records);
  const totalFromLog = aggregateOpenRouterRecords(usageLog.records);
  const sourceWarning = [usageInfo.warning, usageLog.warning].filter(Boolean).join(" ");
  const rateLimits = {
    limitId: "openrouter",
    limitName: keyInfo.label || "OpenRouter",
    primary: usedPercent === null
      ? null
      : {
          usedPercent,
          windowDurationMins: openRouterResetWindowMins(keyInfo.limit_reset),
          resetsAt: openRouterNextReset(keyInfo.limit_reset),
        },
    secondary: numberOrNull(keyInfo.usage_weekly) === null
      ? null
      : {
          usedPercent: null,
          windowDurationMins: 10080,
          resetsAt: null,
          usedCredits: numberOrNull(keyInfo.usage_weekly),
        },
    credits: {
      limit: numberOrNull(keyInfo.limit),
      limitRemaining: numberOrNull(keyInfo.limit_remaining),
      limitReset: keyInfo.limit_reset || null,
      includeByokInLimit: keyInfo.include_byok_in_limit ?? null,
      usage: numberOrNull(keyInfo.usage),
      usageDaily: numberOrNull(keyInfo.usage_daily),
      usageWeekly: numberOrNull(keyInfo.usage_weekly),
      usageMonthly: numberOrNull(keyInfo.usage_monthly),
      byokUsage: numberOrNull(keyInfo.byok_usage),
      byokUsageDaily: numberOrNull(keyInfo.byok_usage_daily),
      byokUsageWeekly: numberOrNull(keyInfo.byok_usage_weekly),
      byokUsageMonthly: numberOrNull(keyInfo.byok_usage_monthly),
      totalCredits: numberOrNull(usageInfo.credits?.total_credits),
      totalUsage: numberOrNull(usageInfo.credits?.total_usage),
    },
    planType: keyInfo.is_free_tier ? "Free tier" : "OpenRouter credits",
    allowed: limitRemaining === null || limitRemaining > 0,
    limitReached: limitRemaining !== null && limitRemaining <= 0,
  };

  return {
    ...account,
    provider: "openrouter",
    openrouterKeyEnv,
    status: "ok",
    email: null,
    planType: rateLimits.planType,
    openrouter: {
      keyLabel: keyInfo.label || null,
      usagePeriods,
      usageLog: account.openrouterUsageLog || null,
      models,
      totals: {
        costCredits: totalFromLog.count ? totalFromLog.costCredits : numberOrNull(keyInfo.usage),
        tokens: totalFromLog.count ? totalFromLog.tokens : null,
      },
    },
    rateLimits,
    rateLimitsByLimitId: { openrouter: rateLimits },
    usageSource: usageInfo.source,
    ...(sourceWarning ? { sourceWarning } : {}),
    rawUsage: {
      label: keyInfo.label || null,
      limitReset: keyInfo.limit_reset || null,
      isFreeTier: keyInfo.is_free_tier ?? null,
      isManagementKey: keyInfo.is_management_key ?? null,
      isProvisioningKey: keyInfo.is_provisioning_key ?? null,
      keyCount: keyInfo.key_count ?? null,
      activeKeyCount: keyInfo.active_key_count ?? null,
      accountCredits: usageInfo.credits || null,
      expiresAt: keyInfo.expires_at || null,
      rateLimit: keyInfo.rate_limit || null,
    },
    updatedAt: new Date().toISOString(),
  };
}

function buildOpenRouterAccountKeyInfo(usageInfo) {
  const keys = Array.isArray(usageInfo.keys) ? usageInfo.keys : [];
  const activeKeys = keys.filter((key) => key?.disabled !== true);
  const totals = sumOpenRouterKeys(keys);
  const limit = sumNullable(keys, "limit");
  const limitRemaining = sumNullable(keys, "limit_remaining");
  return {
    ...(usageInfo.currentKey || {}),
    label: keys.length > 1 ? "All OpenRouter keys" : usageInfo.currentKey?.label || "OpenRouter",
    limit,
    limit_remaining: limitRemaining,
    limit_reset: null,
    usage: numberOrNull(usageInfo.credits?.total_usage) ?? totals.usage,
    usage_daily: totals.usage_daily,
    usage_weekly: totals.usage_weekly,
    usage_monthly: totals.usage_monthly,
    byok_usage: totals.byok_usage,
    byok_usage_daily: totals.byok_usage_daily,
    byok_usage_weekly: totals.byok_usage_weekly,
    byok_usage_monthly: totals.byok_usage_monthly,
    key_count: keys.length,
    active_key_count: activeKeys.length,
  };
}

function sumOpenRouterKeys(keys) {
  return {
    usage: sumNumbers(keys, "usage"),
    usage_daily: sumNumbers(keys, "usage_daily"),
    usage_weekly: sumNumbers(keys, "usage_weekly"),
    usage_monthly: sumNumbers(keys, "usage_monthly"),
    byok_usage: sumNumbers(keys, "byok_usage"),
    byok_usage_daily: sumNumbers(keys, "byok_usage_daily"),
    byok_usage_weekly: sumNumbers(keys, "byok_usage_weekly"),
    byok_usage_monthly: sumNumbers(keys, "byok_usage_monthly"),
  };
}

function sumNumbers(items, key) {
  return items.reduce((sum, item) => sum + (numberOrNull(item?.[key]) ?? 0), 0);
}

function sumNullable(items, key) {
  let found = false;
  const sum = items.reduce((total, item) => {
    const value = numberOrNull(item?.[key]);
    if (value === null) return total;
    found = true;
    return total + value;
  }, 0);
  return found ? sum : null;
}

async function readOpenRouterUsageLog(input) {
  const usageLog = input ? normalizeCodexHome(input) : "";
  if (!usageLog) return { records: [], warning: null };
  if (!existsSync(usageLog)) {
    return { records: [], warning: `OpenRouter usage log does not exist: ${usageLog}` };
  }
  try {
    const raw = await readFile(usageLog, "utf8");
    const records = parseOpenRouterUsageLog(raw);
    return { records, warning: null };
  } catch (error) {
    return { records: [], warning: `Could not read OpenRouter usage log: ${error.message}` };
  }
}

function parseOpenRouterUsageLog(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.map(normalizeOpenRouterUsageRecord).filter(Boolean) : [];
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeOpenRouterUsageRecord(JSON.parse(line)))
    .filter(Boolean);
}

function normalizeOpenRouterUsageRecord(raw) {
  const data = raw?.data && typeof raw.data === "object" ? raw.data : raw;
  if (!data || typeof data !== "object") return null;
  const createdAt = data.createdAt || data.created_at || data.timestamp || data.ts || null;
  const createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
  if (!Number.isFinite(createdMs)) return null;
  const promptTokens = numberOrNull(data.native_tokens_prompt)
    ?? numberOrNull(data.tokens_prompt)
    ?? numberOrNull(data.prompt_tokens)
    ?? numberOrNull(data.usage?.prompt_tokens)
    ?? 0;
  const completionTokens = numberOrNull(data.native_tokens_completion)
    ?? numberOrNull(data.tokens_completion)
    ?? numberOrNull(data.completion_tokens)
    ?? numberOrNull(data.usage?.completion_tokens)
    ?? 0;
  const reasoningTokens = numberOrNull(data.native_tokens_reasoning)
    ?? numberOrNull(data.reasoning_tokens)
    ?? 0;
  const totalTokens = numberOrNull(data.total_tokens)
    ?? numberOrNull(data.usage?.total_tokens)
    ?? promptTokens + completionTokens + reasoningTokens;
  const costCredits = numberOrNull(data.total_cost)
    ?? (typeof data.usage === "number" ? numberOrNull(data.usage) : null)
    ?? numberOrNull(data.costCredits)
    ?? numberOrNull(data.cost);

  return {
    id: data.id || null,
    createdAt: new Date(createdMs).toISOString(),
    createdMs,
    model: data.model || data.router || "unknown",
    providerName: data.provider_name || data.providerName || null,
    promptTokens,
    completionTokens,
    reasoningTokens,
    tokens: totalTokens,
    costCredits,
  };
}

function buildOpenRouterUsagePeriods(keyInfo, records = []) {
  const now = Date.now();
  const windows = [
    {
      id: "30m",
      label: "Past 30 minutes",
      sinceMs: now - 30 * 60 * 1000,
      fallbackCostCredits: null,
    },
    {
      id: "day",
      label: "Past day",
      sinceMs: now - 24 * 60 * 60 * 1000,
      fallbackCostCredits: numberOrNull(keyInfo.usage_daily),
    },
    {
      id: "week",
      label: "Past Week",
      sinceMs: now - 7 * 24 * 60 * 60 * 1000,
      fallbackCostCredits: numberOrNull(keyInfo.usage_weekly),
    },
    {
      id: "month",
      label: "Past Month",
      sinceMs: now - 30 * 24 * 60 * 60 * 1000,
      fallbackCostCredits: numberOrNull(keyInfo.usage_monthly),
    },
    {
      id: "total",
      label: "Total",
      sinceMs: 0,
      fallbackCostCredits: numberOrNull(keyInfo.usage),
    },
  ];

  return windows.map((window) => {
    const matching = records.filter((record) => record.createdMs >= window.sinceMs);
    const aggregate = aggregateOpenRouterRecords(matching);
    return {
      id: window.id,
      label: window.label,
      costCredits: aggregate.count ? aggregate.costCredits : window.fallbackCostCredits,
      tokens: aggregate.count ? aggregate.tokens : null,
      models: aggregateOpenRouterModels(matching),
    };
  });
}

function aggregateOpenRouterRecords(records) {
  return records.reduce(
    (total, record) => ({
      count: total.count + 1,
      tokens: total.tokens + (numberOrNull(record.tokens) ?? 0),
      costCredits: total.costCredits + (numberOrNull(record.costCredits) ?? 0),
    }),
    { count: 0, tokens: 0, costCredits: 0 },
  );
}

function aggregateOpenRouterModels(records) {
  const byModel = new Map();
  for (const record of records) {
    const key = record.model || "unknown";
    const current = byModel.get(key) || { model: key, tokens: 0, costCredits: 0, requests: 0 };
    current.tokens += numberOrNull(record.tokens) ?? 0;
    current.costCredits += numberOrNull(record.costCredits) ?? 0;
    current.requests += 1;
    byModel.set(key, current);
  }
  return Array.from(byModel.values()).sort((a, b) => b.costCredits - a.costCredits || b.tokens - a.tokens);
}

function openRouterUsedPercent(keyInfo) {
  const limit = numberOrNull(keyInfo.limit);
  if (!limit || limit <= 0) return null;
  const remaining = numberOrNull(keyInfo.limit_remaining);
  if (remaining !== null) return ((limit - remaining) / limit) * 100;
  const usage = numberOrNull(keyInfo.usage);
  if (usage !== null) return (usage / limit) * 100;
  return null;
}

function openRouterResetWindowMins(limitReset) {
  if (limitReset === "daily") return 1440;
  if (limitReset === "weekly") return 10080;
  if (limitReset === "monthly") return 43200;
  return null;
}

function openRouterNextReset(limitReset) {
  if (!["daily", "weekly", "monthly"].includes(limitReset)) return null;
  const now = new Date();
  if (limitReset === "daily") {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000;
  }
  if (limitReset === "weekly") {
    const day = now.getUTCDay() || 7;
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (8 - day)) / 1000;
  }
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000;
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function runClaudeStatuslineProbe() {
  if (!existsSync(CLAUDE_STATUSLINE_CAPTURE)) {
    throw new Error(`Claude status-line capture helper is missing: ${CLAUDE_STATUSLINE_CAPTURE}`);
  }

  const tempDir = path.join(os.tmpdir(), `athena-usage-tracker-claude-${randomUUID()}`);
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const capturePath = path.join(tempDir, "statusline.json");
  const settingsPath = path.join(tempDir, "settings.json");
  await writeJson(settingsPath, {
    statusLine: {
      type: "command",
      command: statuslineCaptureCommand(capturePath),
    },
  });

  const probe = spawnClaudeStatuslineProbe(settingsPath);
  const child = probe.child;

  let stdout = "";
  let stderr = "";
  let settled = false;
  let promptSent = false;
  const deadlineMs = 90_000;
  const firstPayloadDeadlineMs = 30_000;

  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      finish(new ClaudeSyncUnavailableError("Timed out waiting for Claude Code status-line usage"));
    }, deadlineMs);
    const firstPayloadDeadline = setTimeout(() => {
      finish(new ClaudeSyncUnavailableError("Claude Code did not emit status-line usage. It may be rate limited."));
    }, firstPayloadDeadlineMs);

    const promptTimer = setTimeout(() => {
      if (!probe.sendsInput) return;
      promptSent = true;
      safeWrite("Reply with only: ok\r");
    }, 1500);

    const pollTimer = setInterval(async () => {
      try {
        const usage = await readCapturedUsage();
        if (usage) finish(null, usage);
      } catch {
        // Status-line command may be rewriting the file while we poll it.
      }
    }, 500);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const rateLimitError = detectClaudeRateLimit(stdout);
      if (rateLimitError) finish(rateLimitError);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      const rateLimitError = detectClaudeRateLimit(stderr);
      if (rateLimitError) finish(rateLimitError);
    });
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", async (code) => {
      if (!settled) {
        const usage = await readCapturedUsage().catch(() => null);
        if (usage) {
          finish(null, usage);
          return;
        }
        const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        finish(detectClaudeRateLimit(output) || new Error(output || `Claude status-line probe exited with code ${code}`));
      }
    });

    async function readCapturedUsage() {
      if (!existsSync(capturePath)) return null;
      const raw = JSON.parse(await readFile(capturePath, "utf8"));
      if (!raw.rate_limits?.five_hour && !raw.rate_limits?.seven_day) return null;
      return normalizeClaudeStatuslineUsage(raw);
    }

    function safeWrite(input) {
      if (child.stdin.destroyed || child.stdin.writableEnded) return;
      try {
        child.stdin.write(input, () => {});
      } catch {
        // The PTY may close while we are already settling the probe.
      }
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(firstPayloadDeadline);
      clearTimeout(promptTimer);
      clearInterval(pollTimer);
      if (probe.sendsInput && !child.killed) {
        if (promptSent) safeWrite("/exit\r");
        setTimeout(() => child.kill("SIGTERM"), 1000);
      }
      if (error) reject(error);
      else resolve(value);
    }
  });
}

function detectClaudeRateLimit(output) {
  const text = String(output || "");
  if (!/(rate limit|usage limit|limit reached|too many requests|429)/i.test(text)) return null;
  const resetMatch = text.match(/\b(?:try again|resets?|reset|available)\s+(?:at|after|in)?\s*([^\n\r.]+)/i);
  const suffix = resetMatch ? ` (${resetMatch[1].trim()})` : "";
  return new ClaudeSyncUnavailableError(
    `Claude Code is rate limited${suffix} and did not emit fresh status-line usage.`,
    "claude_rate_limited",
  );
}

function statuslineCaptureCommand(capturePath) {
  if (process.platform === "win32") {
    return `${windowsShellQuote(process.execPath)} ${windowsShellQuote(CLAUDE_STATUSLINE_CAPTURE)} ${windowsShellQuote(capturePath)}`;
  }
  return `${shellQuote(process.execPath)} ${shellQuote(CLAUDE_STATUSLINE_CAPTURE)} ${shellQuote(capturePath)}`;
}

function spawnClaudeStatuslineProbe(settingsPath) {
  if (process.platform === "win32") {
    const args = ["--settings", settingsPath, "--model", "haiku", "--effort", "low", "Reply with only: ok"];
    const claude = resolveClaudeCommand(args);
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", startProcessCommand(claude.command, claude.args)], {
      cwd: __dirname,
      env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { child, sendsInput: false, exitIsFatal: true };
  }

  const args = ["--settings", settingsPath, "--model", "haiku", "--effort", "low"];
  const command = `claude --settings ${shellQuote(settingsPath)} --model haiku --effort low`;
  const child = spawn("script", ["-qfec", command, "/dev/null"], {
    cwd: __dirname,
    env: { ...process.env, TERM: process.env.TERM || "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, sendsInput: true, exitIsFatal: true };
}

function startProcessCommand(command, args) {
  const quotedArgs = args.map(powershellSingleQuote).join(", ");
  return `Start-Process -FilePath ${powershellSingleQuote(command)} -WindowStyle Minimized -ArgumentList @(${quotedArgs})`;
}

function powershellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function normalizeClaudeStatuslineUsage(raw) {
  const fiveHour = raw.rate_limits?.five_hour || null;
  const sevenDay = raw.rate_limits?.seven_day || null;
  const rateLimits = {
    limitId: "claude-code",
    limitName: "Claude Code",
    primary: fiveHour
      ? {
          usedPercent: fiveHour.used_percentage,
          windowDurationMins: 300,
          resetsAt: fiveHour.resets_at || null,
        }
      : null,
    secondary: sevenDay
      ? {
          usedPercent: sevenDay.used_percentage,
          windowDurationMins: 10080,
          resetsAt: sevenDay.resets_at || null,
        }
      : null,
    planType: null,
    allowed: null,
    limitReached: null,
  };

  return {
    rateLimits,
    model: raw.model || null,
    contextWindow: raw.context_window
      ? {
          usedPercentage: raw.context_window.used_percentage ?? null,
          remainingPercentage: raw.context_window.remaining_percentage ?? null,
          contextWindowSize: raw.context_window.context_window_size ?? null,
        }
      : null,
    rawUsage: {
      rateLimits: raw.rate_limits || null,
      cost: raw.cost
        ? {
            totalCostUsd: raw.cost.total_cost_usd ?? null,
            totalDurationMs: raw.cost.total_duration_ms ?? null,
            totalApiDurationMs: raw.cost.total_api_duration_ms ?? null,
          }
        : null,
      fastMode: raw.fast_mode ?? null,
    },
    updatedAt: new Date().toISOString(),
  };
}

async function readClaudeCredentials(credentialsPath) {
  const raw = JSON.parse(await readFile(credentialsPath, "utf8"));
  const oauth = raw.claudeAiOauth || {};
  return {
    expiresAt: oauth.expiresAt || null,
    subscriptionType: oauth.subscriptionType || null,
    rateLimitTier: oauth.rateLimitTier || null,
  };
}

function resolveClaudeCommand(args) {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(os.homedir(), "scoop", "shims", "claude.cmd"),
    path.join(os.homedir(), "AppData", "Roaming", "npm", "claude.cmd"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (candidate.toLowerCase().endsWith(".cmd")) {
      return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", `"${candidate}" ${args.map(windowsShellQuote).join(" ")}`],
      };
    }
    return { command: candidate, args };
  }

  return { command: "claude", args };
}

function resolveCodexCommand(args) {
  const codexJs = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (existsSync(codexJs)) {
    return { command: process.execPath, args: [codexJs, ...args] };
  }

  const candidates = [
    process.env.CODEX_BIN,
    path.join(os.homedir(), "AppData", "Roaming", "npm", "codex.cmd"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (candidate.toLowerCase().endsWith(".cmd")) {
      return {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", `"${candidate}" ${args.map(windowsShellQuote).join(" ")}`],
      };
    }
    return { command: candidate, args };
  }

  return { command: "codex", args };
}

function windowsShellQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function readClaudeAuthStatus() {
  return new Promise((resolve, reject) => {
    const claude = resolveClaudeCommand(["auth", "status", "--json"]);
    const child = spawn(claude.command, claude.args, {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out reading Claude auth status"));
    }, 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude auth status exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Claude auth status returned invalid JSON"));
      }
    });
  });
}

function applyManualOverride(account) {
  const until = account.manualUnavailableUntil ? new Date(account.manualUnavailableUntil) : null;
  if (!until || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
    return account;
  }
  return {
    ...account,
    status: "manual_lockout",
    manualOverride: {
      unavailableUntil: until.toISOString(),
      reason: account.manualUnavailableReason || "Marked unavailable by user",
    },
  };
}

async function queryDirectUsage(codexHome) {
  const authPath = path.join(codexHome, "auth.json");
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  const tokens = auth.tokens || {};
  let accessToken = tokens.access_token;
  const accountId = tokens.account_id;
  if (!accessToken) throw new Error("No access token in auth.json");
  if (!accountId) throw new Error("No account_id in auth.json");

  let response = await fetchUsage(accessToken, accountId);
  if (response.status === 401 || response.status === 403) {
    accessToken = await refreshAccessToken(auth);
    auth.tokens.access_token = accessToken;
    await writeFile(authPath, `${JSON.stringify(auth, null, 2)}\n`);
    response = await fetchUsage(accessToken, accountId);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Direct usage endpoint failed: ${response.status} ${body.slice(0, 160)}`);
  }

  const raw = await response.json();
  const primary = raw.rate_limit?.primary_window || null;
  const secondary = raw.rate_limit?.secondary_window || null;
  const rateLimits = {
    limitId: "codex",
    limitName: null,
    primary: primary
      ? {
          usedPercent: primary.used_percent,
          windowDurationMins: primary.limit_window_seconds
            ? Math.round(primary.limit_window_seconds / 60)
            : null,
          resetsAt: primary.reset_at || null,
        }
      : null,
    secondary: secondary
      ? {
          usedPercent: secondary.used_percent,
          windowDurationMins: secondary.limit_window_seconds
            ? Math.round(secondary.limit_window_seconds / 60)
            : null,
          resetsAt: secondary.reset_at || null,
        }
      : null,
    credits: raw.credits || null,
    planType: raw.plan_type || null,
    rateLimitReachedType: raw.rate_limit_reached_type || null,
    allowed: raw.rate_limit?.allowed ?? null,
    limitReached: raw.rate_limit?.limit_reached ?? null,
  };

  return {
    account: {
      email: raw.email || null,
      planType: raw.plan_type || null,
    },
    rateLimits,
    rateLimitsByLimitId: { codex: rateLimits },
    usageSource: "chatgpt-usage-api",
    rawUsage: {
      allowed: raw.rate_limit?.allowed ?? null,
      limitReached: raw.rate_limit?.limit_reached ?? null,
      resetAfterSeconds: {
        primary: primary?.reset_after_seconds ?? null,
        secondary: secondary?.reset_after_seconds ?? null,
      },
      codeReviewRateLimit: raw.code_review_rate_limit || null,
      additionalRateLimits: raw.additional_rate_limits || null,
    },
  };
}

function fetchUsage(accessToken, accountId) {
  return fetch(CHATGPT_USAGE_URL, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      "chatgpt-account-id": accountId,
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
      accept: "application/json",
    },
  });
}

async function refreshAccessToken(auth) {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) throw new Error("No refresh token in auth.json");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }
  const result = await response.json();
  return result.access_token;
}

function queryAppServer(codexHome) {
  return new Promise((resolve, reject) => {
    const codex = resolveCodexCommand(["app-server", "--listen", "stdio://"]);
    const child = spawn(codex.command, codex.args, {
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    let stderr = "";
    let initialized = false;
    let account = null;
    let limits = null;
    let gotAccount = false;
    let gotLimits = false;
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out querying Codex app-server"));
    }, 30000);

    function cleanup() {
      clearTimeout(timer);
      child.kill("SIGTERM");
    }

    function finish(error, value) {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(error);
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error(`Codex app-server sent non-JSON output: ${line.slice(0, 120)}`));
          return;
        }
        if (message.id === 1 && message.result && !initialized) {
          initialized = true;
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: { refreshToken: true } });
          send({ id: 3, method: "account/rateLimits/read" });
        }
        if (message.id === 2) {
          account = message.result?.account || null;
          gotAccount = true;
        }
        if (message.id === 3) {
          limits = message.result || null;
          gotLimits = true;
        }
        if (gotAccount && gotLimits) {
          finish(null, { account, ...limits });
        }
        if (message.error) {
          finish(new Error(message.error.message || "Codex app-server returned an error"));
        }
      }
    });

    child.on("close", (code) => {
      if (!settled) {
        finish(new Error(stderr.trim() || `Codex app-server exited with code ${code}`));
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "athena-usage-tracker",
          title: "Athena Usage Tracker",
          version: "0.2.0",
        },
        capabilities: { experimentalApi: false },
      },
    });
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

const USAGE_CACHE_TTL_MS = 30_000;
const usageCache = new Map();

function cachedQueryAccount(account, { fresh } = {}) {
  const key = account.id;
  const now = Date.now();
  const entry = usageCache.get(key);
  if (!fresh && entry && entry.value && now - entry.storedAt < USAGE_CACHE_TTL_MS) {
    return entry.value;
  }
  if (!fresh && entry?.inflight) return entry.inflight;
  const inflight = Promise.resolve()
    .then(() => queryAccount(account))
    .then((value) => {
      usageCache.set(key, { value, storedAt: Date.now() });
      return value;
    })
    .catch((error) => {
      usageCache.delete(key);
      throw error;
    });
  usageCache.set(key, { ...(entry || {}), inflight });
  return inflight;
}

function invalidateUsageCache(id) {
  if (id) usageCache.delete(id);
  else usageCache.clear();
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/accounts") {
    const accounts = await readAccounts();
    sendJson(res, 200, { accounts });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/usage") {
    const fresh = url.searchParams.get("fresh") === "1";
    const accounts = (await readAccounts()).filter((account) => account.enabled !== false);
    const usage = await Promise.all(accounts.map((account) => cachedQueryAccount(account, { fresh })));
    sendJson(res, 200, { usage });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const input = await readBody(req);
    const accounts = await readAccounts();
    const sourceCodexHome = input.provider === "claude" ? "" : normalizeCodexHome(input.codexHome);
    const account = createAccount(input);
    accounts.push(account);
    if (account.provider === "codex") {
      await mkdir(account.codexHome, { recursive: true, mode: 0o700 });
      if (isSharedCodexHome(sourceCodexHome)) {
        await copySharedCodexLogin(sourceCodexHome, account.codexHome);
        account.importedFromSharedCodexHome = true;
      }
    }
    await writeAccounts(accounts);
    invalidateUsageCache();
    sendJson(res, 201, { account });
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/accounts/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const accounts = (await readAccounts()).filter((account) => account.id !== id);
    await writeAccounts(accounts);
    invalidateUsageCache(id);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname.endsWith("/test")) {
    const id = decodeURIComponent(url.pathname.split("/").at(-2) || "");
    const account = (await readAccounts()).find((item) => item.id === id);
    if (!account) {
      sendJson(res, 404, { error: "Account not found" });
      return;
    }
    const result = account.provider === "claude"
      ? await testClaudeAccount()
      : account.provider === "openrouter"
        ? await testOpenRouterAccount(account)
        : await testCodexAccount(account);
    sendJson(res, result.ok ? 200 : 500, result);
    return;
  }

  if (req.method === "POST" && url.pathname.endsWith("/claude/sync")) {
    const id = decodeURIComponent(url.pathname.split("/").at(-3) || "");
    const accounts = await readAccounts();
    const index = accounts.findIndex((item) => item.id === id);
    if (index === -1) {
      sendJson(res, 404, { error: "Account not found" });
      return;
    }
    if (accounts[index].provider !== "claude") {
      sendJson(res, 400, { error: "Account is not a Claude Code account" });
      return;
    }
    const usage = await syncClaudeUsageAccount(accounts[index]);
    accounts[index] = {
      ...accounts[index],
      claudeUsage: usage.claudeUsage || accounts[index].claudeUsage,
      ...(usage.rateLimits
        ? {
            claudeUsage: {
              rateLimits: usage.rateLimits,
              rawUsage: usage.rawUsage || null,
              model: usage.claude?.model || null,
              contextWindow: usage.claude?.contextWindow || null,
              updatedAt: usage.updatedAt,
            },
          }
        : {}),
    };
    await writeAccounts(accounts);
    invalidateUsageCache(id);
    sendJson(res, 200, { usage });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

async function testClaudeAccount() {
  try {
    const status = await readClaudeAuthStatus();
    return {
      ok: Boolean(status.loggedIn),
      stdout: status.loggedIn
        ? `Claude logged in as ${status.email || "unknown"} (${status.subscriptionType || "unknown plan"})`
        : "Claude is not logged in",
    };
  } catch (error) {
    return { ok: false, error: error.message, stdout: "", stderr: "" };
  }
}

async function testOpenRouterAccount(account) {
  let openrouterKeyEnv = "";
  try {
    openrouterKeyEnv = normalizeEnvVarName(account.openrouterKeyEnv || account.openrouterApiKeyEnv);
  } catch (error) {
    return { ok: false, error: error.message, stdout: "", stderr: "" };
  }
  if (!openrouterKeyEnv) {
    return { ok: false, error: "OpenRouter API key environment variable is not configured", stdout: "", stderr: "" };
  }
  const apiKey = process.env[openrouterKeyEnv];
  if (!apiKey) {
    return { ok: false, error: `Missing environment variable: ${openrouterKeyEnv}`, stdout: "", stderr: "" };
  }

  try {
    const usageInfo = await fetchOpenRouterAccountUsage(apiKey);
    const keyInfo = buildOpenRouterAccountKeyInfo(usageInfo);
    const label = usageInfo.source === "openrouter-management-api"
      ? `${keyInfo.key_count || 0} OpenRouter keys`
      : keyInfo.label || "OpenRouter key";
    const remaining = numberOrNull(keyInfo.limit_remaining);
    return {
      ok: true,
      stdout: remaining === null
        ? `${label}: ${numberOrNull(keyInfo.usage) ?? 0} credits used`
        : `${label}: ${remaining} credits remaining`,
      stderr: "",
    };
  } catch (error) {
    return { ok: false, error: error.message, stdout: "", stderr: "" };
  }
}

function testCodexAccount(account) {
  return new Promise((resolve) => {
    const codexHome = normalizeCodexHome(account.codexHome);
    const codex = resolveCodexCommand([
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--ephemeral",
      "Reply with only: tracker-account-ok",
    ]);
    const child = spawn(
      codex.command,
      codex.args,
      {
        env: { ...process.env, CODEX_HOME: codexHome },
        cwd: __dirname,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        ok: false,
        error: "Timed out running Codex test request",
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    }, 30000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && stdout.includes("tracker-account-ok"),
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204, NO_STORE_HEADERS);
    res.end();
    return;
  }
  const match = PUBLIC_FILES[url.pathname];
  if (!match) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...NO_STORE_HEADERS });
    res.end("Not found");
    return;
  }
  const file = path.join(__dirname, match.file);
  const content = await readFile(file);
  res.writeHead(200, { "content-type": match.type, ...NO_STORE_HEADERS });
  res.end(content);
}

await ensureAccountsFile();

createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/api/")) {
      await handleApi(req, res);
    } else {
      await serveStatic(req, res);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}).listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "127.0.0.1" : HOST;
  console.log(`Athena Usage Tracker running at http://${displayHost}:${PORT}/`);
  if (HOST !== "127.0.0.1" && HOST !== "::1" && HOST !== "localhost") {
    console.log(`Listening on ${HOST}:${PORT} — reachable from other devices on this network. Only do this on a trusted network (e.g. Tailscale).`);
  }
});
