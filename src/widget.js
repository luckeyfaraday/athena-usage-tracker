const state = {
  usage: [],
  selected: null,
  loading: false,
  updatedAt: null,
};

const els = {
  bestName: document.querySelector("#bestName"),
  refreshUsage: document.querySelector("#refreshUsage"),
  privacyToggle: document.querySelector("#privacyToggle"),
  focusCard: document.querySelector("#focusCard"),
  statusDot: document.querySelector("#statusDot"),
  statusLabel: document.querySelector("#statusLabel"),
  statusEmail: document.querySelector("#statusEmail"),
  primaryLabel: document.querySelector("#primaryLabel"),
  primaryUsage: document.querySelector("#primaryUsage"),
  primaryUnit: document.querySelector("#primaryUnit"),
  primaryMeter: document.querySelector("#primaryMeter"),
  readoutMeta: document.querySelector("#readoutMeta"),
  secondaryLabel: document.querySelector("#secondaryLabel"),
  secondaryMeter: document.querySelector("#secondaryMeter"),
  weeklyUsage: document.querySelector("#weeklyUsage"),
  resetTime: document.querySelector("#resetTime"),
  planType: document.querySelector("#planType"),
  updatedAt: document.querySelector("#updatedAt"),
  accountCount: document.querySelector("#accountCount"),
  accountList: document.querySelector("#accountList"),
  copyLaunch: document.querySelector("#copyLaunch"),
  syncClaude: document.querySelector("#syncClaude"),
  toast: document.querySelector("#toast"),
};

const PRIVACY_KEY = "athena.privacy";
let privacyMode = false;

function looksLikeEmail(value) {
  return typeof value === "string" && value.includes("@") && !value.startsWith("/");
}

function maskEmail(value) {
  if (typeof value !== "string" || !value) return value;
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const lastDot = domain.lastIndexOf(".");
  const domainBody = lastDot > 0 ? domain.slice(0, lastDot) : domain;
  const tld = lastDot > 0 ? domain.slice(lastDot) : "";
  const dots = (n) => "•".repeat(Math.max(n, 3));
  return `${local[0]}${dots(local.length - 1)}@${dots(domainBody.length)}${tld}`;
}

function displayEmail(value) {
  if (!privacyMode || !looksLikeEmail(value)) return value;
  return maskEmail(value);
}

function applyPrivacy(on, { persist = true } = {}) {
  privacyMode = !!on;
  if (persist) {
    if (privacyMode) localStorage.setItem(PRIVACY_KEY, "on");
    else localStorage.removeItem(PRIVACY_KEY);
  }
  document.body.classList.toggle("privacy-on", privacyMode);
  if (els.privacyToggle) {
    els.privacyToggle.setAttribute("aria-pressed", String(privacyMode));
    els.privacyToggle.setAttribute("aria-label", privacyMode ? "Reveal emails" : "Hide emails");
    const eye = els.privacyToggle.querySelector(".icon-eye");
    const eyeOff = els.privacyToggle.querySelector(".icon-eye-off");
    if (eye) eye.hidden = privacyMode;
    if (eyeOff) eyeOff.hidden = !privacyMode;
  }
  render();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

async function refreshUsage() {
  state.loading = true;
  els.refreshUsage.classList.add("is-loading");
  render();
  try {
    const { usage } = await api("/api/usage");
    state.usage = usage;
    state.selected = pickFocus(usage, state.selected);
    state.updatedAt = new Date();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.loading = false;
    els.refreshUsage.classList.remove("is-loading");
    render();
  }
}

function pickFocus(accounts, previous) {
  if (previous) {
    const match = accounts.find((a) => a.id === previous.id);
    if (match) return match;
  }
  const sorted = accounts.slice().sort((a, b) => usageScore(b) - usageScore(a));
  return sorted[0] || null;
}

function render() {
  renderFocus();
  renderLedger();
}

function renderFocus() {
  const account = state.selected;
  const card = els.focusCard;
  card.classList.remove("is-ok", "is-warn", "is-danger", "is-alert", "is-weekly-warn", "is-weekly-danger", "is-loading");

  if (!account) {
    els.bestName.textContent = state.loading ? "Loading" : "No accounts";
    els.statusLabel.textContent = state.loading ? "Polling accounts" : "Add an account";
    els.statusEmail.textContent = "—";
    setLED(els.statusDot, state.loading ? "ok" : "warn");
    els.primaryLabel.textContent = "5h window";
    els.primaryUnit.textContent = "%";
    els.primaryUsage.textContent = "--";
    setBar(els.primaryMeter, null, "");
    els.readoutMeta.textContent = "—";
    els.secondaryLabel.textContent = "Weekly";
    setBar(els.secondaryMeter, null, "");
    els.weeklyUsage.textContent = "--";
    els.resetTime.textContent = "--";
    els.planType.textContent = "--";
    els.updatedAt.textContent = "--";
    els.copyLaunch.disabled = true;
    els.copyLaunch.hidden = false;
    els.syncClaude.hidden = true;
    return;
  }

  const primary = getWindow(account, "primary");
  const secondary = getWindow(account, "secondary");
  const pct = numberOr(primary.usedPercent, null);
  const secondaryPct = numberOr(secondary.usedPercent, null);
  const isOpenRouter = account.provider === "openrouter";
  const isLive = account.status === "ok";
  const primaryTone = isLive ? toneFromPct(pct) : statusTone(account);
  const secondaryTone = isLive ? toneFromPct(secondaryPct) : "ok";
  const worst = worstOf(primaryTone, secondaryTone);
  const weeklyAtLimit = isLive && secondaryPct !== null && secondaryPct >= 100 && secondary.resetsAt;

  card.classList.add(`is-${primaryTone}`);
  if (isLive && worst === "danger") card.classList.add("is-alert");
  if (secondaryTone === "warn") card.classList.add("is-weekly-warn");
  if (secondaryTone === "danger") card.classList.add("is-weekly-danger");

  setLED(els.statusDot, isLive ? worst : primaryTone);
  els.statusLabel.textContent = statusLabel(account);
  els.statusEmail.textContent =
    displayEmail(account.email) ||
    displayEmail(account.expectedEmail) ||
    account.codexHome ||
    account.claudeHome ||
    account.openrouterKeyEnv ||
    "—";

  els.bestName.textContent = account.name || "Account";

  if (isOpenRouter) {
    const day = getOpenRouterPeriod(account, "day");
    const week = getOpenRouterPeriod(account, "week");
    els.primaryLabel.textContent = "Day cost";
    els.primaryUnit.textContent = "";
    els.primaryUsage.textContent = compactCost(day?.costCredits);
    setBar(els.primaryMeter, null, "is-muted");
    els.readoutMeta.textContent = `Week ${formatCost(week?.costCredits)}`;
    els.secondaryLabel.textContent = "Week";
    els.weeklyUsage.textContent = compactCost(week?.costCredits);
    setBar(els.secondaryMeter, null, "is-muted");
    els.resetTime.textContent = "—";
  } else {
    els.primaryLabel.textContent = "5h window";
    els.primaryUnit.textContent = "%";
    els.primaryUsage.textContent = pct === null ? "--" : Math.floor(pct);
    setBar(els.primaryMeter, pct, toneClass(primaryTone, isLive));
    const resetWindow = weeklyAtLimit ? secondary : primary;
    els.readoutMeta.textContent = resetWindow.resetsAt
      ? `${weeklyAtLimit ? "Weekly resets in" : "Resets in"} ${formatDuration(resetWindow.resetsAt * 1000 - Date.now())}`
      : windowLabel(primary);

    els.secondaryLabel.textContent = "Weekly";
    els.weeklyUsage.textContent = secondaryPct === null ? "--" : `${Math.floor(secondaryPct)}%`;
    setBar(els.secondaryMeter, secondaryPct, toneClass(secondaryTone, isLive));

    els.resetTime.textContent = resetWindow.resetsAt
      ? formatDuration(resetWindow.resetsAt * 1000 - Date.now())
      : "—";
  }
  els.planType.textContent = account.planType || (account.provider === "claude" ? "Claude" : account.provider === "openrouter" ? "OpenRouter" : "Codex");
  els.updatedAt.textContent = state.updatedAt ? formatRelative(state.updatedAt) : "—";
  const isClaude = account.provider === "claude";
  els.copyLaunch.hidden = isClaude || isOpenRouter;
  els.copyLaunch.disabled = !isClaude && !isOpenRouter && !account.codexHome;
  els.syncClaude.hidden = !isClaude;
}

function renderLedger() {
  const accounts = state.usage;
  els.accountCount.textContent = `${accounts.length} ${accounts.length === 1 ? "account" : "accounts"}`;
  els.accountList.replaceChildren();

  const sorted = accounts.slice().sort((a, b) => usageScore(b) - usageScore(a));
  for (const account of sorted) {
    const primary = getWindow(account, "primary");
    const secondary = getWindow(account, "secondary");
    const pct = numberOr(primary.usedPercent, null);
    const secondaryPct = numberOr(secondary.usedPercent, null);
    const isOpenRouter = account.provider === "openrouter";
    const isLive = account.status === "ok";
    const primaryTone = isLive ? toneFromPct(pct) : statusTone(account);
    const secondaryTone = isLive ? toneFromPct(secondaryPct) : "ok";
    const worst = worstOf(primaryTone, secondaryTone);

    const row = document.createElement("button");
    row.type = "button";
    row.className = "account-row";
    if (state.selected?.id === account.id) row.classList.add("is-active");
    if (!isLive) row.classList.add("is-disabled");
    if (isLive && worst === "danger") row.classList.add("is-alert");
    else if (isLive && worst === "warn") row.classList.add("is-edge");

    const ledTone = isLive ? worst : primaryTone;
    const pctText = isOpenRouter
      ? compactCost(getOpenRouterPeriod(account, "day")?.costCredits)
      : pct === null ? "—" : `${Math.floor(pct)}%`;
    const barTone = toneClass(worst, isLive);

    row.innerHTML = `
      <span class="led is-${ledTone}"></span>
      <div class="row-body">
        <div class="row-top">
          <span class="row-name">${escapeHtml(account.name || "Account")}</span>
          <span class="row-pct">${escapeHtml(pctText)}</span>
        </div>
        <div class="row-bar">
          <div class="row-bar-fill ${isOpenRouter ? "is-muted" : barTone}" style="--pct: ${isOpenRouter ? 0 : clampPct(pct ?? 0)}%"></div>
        </div>
      </div>
      <span class="row-pct" aria-hidden="true" style="visibility:hidden">—</span>
    `;

    row.addEventListener("click", () => {
      state.selected = account;
      render();
    });
    els.accountList.append(row);
  }
}

function setBar(node, pct, toneClass) {
  node.classList.remove("is-warn", "is-danger", "is-muted");
  if (toneClass) node.classList.add(toneClass);
  node.style.setProperty("--pct", `${pct === null ? 0 : clampPct(pct)}%`);
}

function setLED(node, tone) {
  node.className = `led is-${tone}`;
}

function toneClass(tone, isLive) {
  if (!isLive) return "is-muted";
  if (tone === "danger") return "is-danger";
  if (tone === "warn") return "is-warn";
  return "";
}

function getWindow(account, key) {
  return account.rateLimits?.[key] || {};
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function usageScore(account) {
  if (account.status !== "ok") return -1;
  if (account.provider === "openrouter") {
    const month = getOpenRouterPeriod(account, "month");
    return numberOr(month?.costCredits, 0);
  }
  const primary = numberOr(getWindow(account, "primary").usedPercent, 0);
  const secondary = numberOr(getWindow(account, "secondary").usedPercent, 0);
  return Math.max(primary, secondary);
}

function getOpenRouterPeriods(account) {
  const periods = account.openrouter?.usagePeriods;
  if (Array.isArray(periods) && periods.length) return periods;
  const credits = account.rateLimits?.credits || {};
  return [
    { id: "day", costCredits: credits.usageDaily ?? null },
    { id: "week", costCredits: credits.usageWeekly ?? null },
    { id: "month", costCredits: credits.usageMonthly ?? null },
    { id: "total", costCredits: credits.usage ?? null },
  ];
}

function getOpenRouterPeriod(account, id) {
  return getOpenRouterPeriods(account).find((period) => period.id === id) || null;
}

function formatCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  if (Math.abs(value) < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

function compactCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  if (Math.abs(value) >= 1000) return `$${Math.round(value / 1000)}k`;
  if (Math.abs(value) >= 100) return `$${Math.round(value)}`;
  if (Math.abs(value) >= 10) return `$${value.toFixed(1)}`;
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(4)}`;
}

function toneFromPct(pct) {
  if (pct === null) return "ok";
  if (pct >= 85) return "danger";
  if (pct >= 60) return "warn";
  return "ok";
}

function worstOf(a, b) {
  const rank = { ok: 0, warn: 1, danger: 2 };
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b;
}

function statusTone(account) {
  if (account.rateLimits?.limitReached === true || account.rateLimits?.allowed === false) return "danger";
  if (account.status === "metadata_only") return "warn";
  if (account.status === "missing_home") return "warn";
  return "danger";
}

function statusLabel(account) {
  if (account.status === "ok") {
    if (account.rateLimits?.limitReached === true || account.rateLimits?.allowed === false) return "Limit reached";
    return "Live";
  }
  if (account.status === "metadata_only") return "Profile only";
  if (account.status === "wrong_account") return "Wrong account";
  if (account.status === "not_logged_in") return "Needs login";
  if (account.status === "missing_home") return "Home missing";
  if (account.status === "error") return "Error";
  return account.status || "Pending";
}

function windowLabel(primary) {
  if (!primary.limitWindowSeconds) return "5h window";
  const hours = Math.round(primary.limitWindowSeconds / 3600);
  return `${hours}h window`;
}

function clampPct(value) {
  return Math.max(0, Math.min(100, value));
}

function formatDuration(ms) {
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 60000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatRelative(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message, kind = "") {
  els.toast.textContent = message;
  els.toast.className = `toast is-on ${kind ? `is-${kind}` : ""}`.trim();
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.className = "toast";
  }, 2400);
}

async function syncClaudeUsage() {
  const account = state.selected;
  if (!account || account.provider !== "claude") return;
  els.syncClaude.disabled = true;
  els.syncClaude.classList.add("is-loading");
  try {
    const { usage } = await api(`/api/accounts/${encodeURIComponent(account.id)}/claude/sync`, {
      method: "POST",
    });
    const fresh = Array.isArray(usage) ? usage : usage ? [usage] : [];
    const map = new Map(state.usage.map((item) => [item.id, item]));
    for (const item of fresh) map.set(item.id, item);
    state.usage = Array.from(map.values());
    state.selected = map.get(account.id) || state.selected;
    state.updatedAt = new Date();
    toast(usage.syncWarning || "Claude usage synced", usage.syncWarning ? "warn" : "ok");
    render();
  } catch (error) {
    toast(error.message || "Sync failed", "error");
  } finally {
    els.syncClaude.disabled = false;
    els.syncClaude.classList.remove("is-loading");
  }
}

els.refreshUsage.addEventListener("click", refreshUsage);
els.syncClaude.addEventListener("click", syncClaudeUsage);
els.copyLaunch.addEventListener("click", () => {
  if (!state.selected?.codexHome) return;
  const command = `CODEX_HOME=${shellQuote(state.selected.codexHome)} codex`;
  navigator.clipboard.writeText(command).then(
    () => toast("Launch command copied", "ok"),
    () => toast(command),
  );
});
els.privacyToggle?.addEventListener("click", () => applyPrivacy(!privacyMode));
window.addEventListener("storage", (event) => {
  if (event.key === PRIVACY_KEY) applyPrivacy(event.newValue === "on", { persist: false });
});
window.addEventListener("keydown", (event) => {
  if (event.target.matches?.("input, textarea, select, [contenteditable]")) return;
  if (event.key === "p" || event.key === "P") applyPrivacy(!privacyMode);
});

applyPrivacy(localStorage.getItem(PRIVACY_KEY) === "on", { persist: false });
await refreshUsage();
let refreshTimer = setInterval(refreshUsage, 60_000);
let countdownTimer = setInterval(render, 30_000);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);
    refreshTimer = null;
    countdownTimer = null;
  } else if (!refreshTimer) {
    const stale = !state.updatedAt || Date.now() - state.updatedAt.getTime() > 30_000;
    if (stale) refreshUsage();
    refreshTimer = setInterval(refreshUsage, 60_000);
    countdownTimer = setInterval(render, 30_000);
  }
});
