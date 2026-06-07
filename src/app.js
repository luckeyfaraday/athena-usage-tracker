const state = {
  accounts: [],
  usage: [],
  selectedId: null,
  loading: false,
  lastRefresh: null,
  notifications: {
    supported: false,
    subscribed: false,
    permission: "default",
    publicKey: null,
    subscriptions: 0,
  },
};

const els = {
  vitalAccounts: document.querySelector("#vitalAccounts"),
  vitalStatus: document.querySelector("#vitalStatus"),
  vitalClock: document.querySelector("#vitalClock"),
  ledgerMeta: document.querySelector("#ledgerMeta"),
  focusPanel: document.querySelector("#focusPanel"),
  accountList: document.querySelector("#accountList"),
  refreshUsage: document.querySelector("#refreshUsage"),
  openAddDialog: document.querySelector("#openAddDialog"),
  privacyToggle: document.querySelector("#privacyToggle"),
  notificationToggle: document.querySelector("#notificationToggle"),
  dialog: document.querySelector("#accountDialog"),
  form: document.querySelector("#accountForm"),
  closeDialog: document.querySelector("#closeDialog"),
  cancelDialog: document.querySelector("#cancelDialog"),
  accountName: document.querySelector("#accountName"),
  codexHome: document.querySelector("#codexHome"),
  codexHomeField: document.querySelector("#codexHomeField"),
  claudeHome: document.querySelector("#claudeHome"),
  claudeHomeField: document.querySelector("#claudeHomeField"),
  openrouterKeyEnv: document.querySelector("#openrouterKeyEnv"),
  openrouterKeyEnvField: document.querySelector("#openrouterKeyEnvField"),
  openrouterUsageLog: document.querySelector("#openrouterUsageLog"),
  openrouterUsageLogField: document.querySelector("#openrouterUsageLogField"),
  expectedEmail: document.querySelector("#expectedEmail"),
  toast: document.querySelector("#toast"),
};

const PRIVACY_KEY = "athena.privacy";
let privacyMode = false;

const icons = {
  plus: '<svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M12 5v14M5 12h14"/></svg>',
  refresh:
    '<svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M21 12a9 9 0 0 1-15.2 6.5"/><path d="M3 12A9 9 0 0 1 18.2 5.5"/><path d="M18 2v4h-4"/><path d="M6 22v-4h4"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  eye: '<svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff:
    '<svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M3 3l18 18"/><path d="M10.7 5.1A9.5 9.5 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.7 6.7C3.6 8.5 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.4 5.1-1.3"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  bell:
    '<svg viewBox="0 0 24 24" stroke-width="1.5"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>',
};

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
  return privacyMode ? maskEmail(value) : value;
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
    const iconHost = els.privacyToggle.querySelector("[data-icon]");
    if (iconHost) iconHost.innerHTML = privacyMode ? icons.eyeOff : icons.eye;
    const label = els.privacyToggle.querySelector(".privacy-label");
    if (label) label.textContent = privacyMode ? "Reveal" : "Privacy";
  }
  render();
}

function hydrateIcons() {
  document.querySelectorAll("[data-icon]").forEach((node) => {
    const name = node.dataset.icon;
    if (icons[name]) node.innerHTML = icons[name];
  });
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

async function loadAccounts() {
  const { accounts } = await api("/api/accounts");
  state.accounts = accounts;
  if (!state.selectedId && accounts.length) state.selectedId = accounts[0].id;
  render();
}

async function refreshUsage() {
  state.loading = true;
  els.refreshUsage.classList.add("is-loading");
  render();
  try {
    const { usage } = await api("/api/usage");
    state.usage = usage;
    state.lastRefresh = new Date();
    if (!state.selectedId && usage.length) state.selectedId = usage[0].id;
  } catch (error) {
    state.usage = state.accounts.map((account) => ({
      ...account,
      status: "error",
      error: error.message,
    }));
    toast(error.message, "error");
  } finally {
    state.loading = false;
    els.refreshUsage.classList.remove("is-loading");
    render();
  }
}

function render() {
  const merged = getMergedAccounts();
  renderVitals(merged);
  renderFocus(merged);
  renderLedger(merged);
  renderNotificationButton();
}

function getMergedAccounts() {
  return state.accounts.map((account) => {
    const live = state.usage.find((item) => item.id === account.id);
    return live || account;
  });
}

/* ── VITALS ─────────────────────────────────────────────── */

function renderVitals(accounts) {
  els.vitalAccounts.textContent = String(accounts.length);
  els.vitalStatus.textContent = state.loading
    ? "Polling…"
    : state.lastRefresh
      ? `Refreshed ${formatRelativeShort(state.lastRefresh)}`
      : "Idle";
}

function startClock() {
  const tick = () => {
    const now = new Date();
    els.vitalClock.textContent = now.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  };
  tick();
  setInterval(tick, 1000);
}

/* ── FOCUS PANEL ────────────────────────────────────────── */

function renderFocus(accounts) {
  els.focusPanel.replaceChildren();

  if (!accounts.length) {
    els.focusPanel.innerHTML = `
      <div class="focus-empty">
        <h2><em>Nothing on the bench yet.</em></h2>
        <p>Register a subscription to begin reading its rate-limit telemetry. The first entry sets the tone.</p>
      </div>
    `;
    return;
  }

  const account = accounts.find((item) => item.id === state.selectedId) || accounts[0];
  state.selectedId = account.id;

  const status = statusMeta(account);
  const path = providerPath(account);
  if (account.provider === "openrouter") {
    renderOpenRouterFocus(account, status, path);
    return;
  }

  const primary = getWindow(account, "primary");
  const secondary = getWindow(account, "secondary");
  const primaryPct = typeof primary.usedPercent === "number" ? primary.usedPercent : null;
  const secondaryPct = typeof secondary.usedPercent === "number" ? secondary.usedPercent : null;

  const intPart = primaryPct !== null ? Math.floor(primaryPct) : null;
  const decPart = primaryPct !== null ? Math.round((primaryPct - intPart) * 10) : null;
  const remainingMs = primary.resetsAt ? primary.resetsAt * 1000 - Date.now() : null;

  const wrapper = document.createElement("div");
  wrapper.className = "focus-grid";

  wrapper.innerHTML = `
    <div class="focus-main">
      <div class="focus-status">
        <span class="led ${ledClass(status.tone)}"></span>
        <span>${escapeHtml(status.label)}</span>
        <span class="sep">/</span>
        <span>${escapeHtml(account.provider === "claude" ? "Claude Code" : account.provider === "openrouter" ? "OpenRouter" : "Codex · ChatGPT")}</span>
        ${account.usageSource ? `<span class="sep">/</span><span>${escapeHtml(account.usageSource)}</span>` : ""}
      </div>

      <div class="focus-title">
        <h2 class="focus-name">${escapeHtml(account.name)}</h2>
      </div>

      <div class="focus-tagline">
        ${account.planType ? `<span class="tag">${escapeHtml(account.planType)}</span>` : ""}
        ${account.email ? `<span class="focus-handle">${escapeHtml(displayEmail(account.email))}</span>` : ""}
      </div>

      ${renderPrimaryReadout(intPart, decPart, primary, toneFromPct(primaryPct))}

      ${
        secondary && typeof secondaryPct === "number"
          ? `
            <div class="secondary-row">
              <span class="label">Weekly window</span>
              <div class="bar"><div class="bar-fill ${toneFromPct(secondaryPct) === "danger" ? "is-danger" : ""}" style="--pct: ${clampPct(secondaryPct)}%"></div></div>
              <div class="value">${secondaryPct.toFixed(0)}<em>% · ${formatResetShort(secondary.resetsAt)}</em></div>
            </div>
          `
          : ""
      }

      ${renderAlert(account)}
      ${renderAccountHandoff(account)}
    </div>

    ${renderAside(account, primary, remainingMs, status)}

    <div class="focus-footer" style="grid-column: 1 / -1;">
      <dl class="focus-stats">
        <div>
          <dt>Source</dt>
          <dd class="strong">${escapeHtml(account.usageSource || (account.provider === "claude" ? "claude-cli" : account.provider === "openrouter" ? "openrouter-key-api" : "not refreshed"))}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>${account.updatedAt ? new Date(account.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</dd>
        </div>
        <div>
          <dt>${escapeHtml(path.label)}</dt>
          <dd title="${escapeHtml(path.value)}">${escapeHtml(path.value)}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd class="strong">${escapeHtml(account.planType || "—")}</dd>
        </div>
      </dl>
      <div class="focus-actions">
        ${
          account.provider === "claude"
            ? `<button class="btn ghost" data-action="sync-claude">Sync usage</button>`
            : ""
        }
        <button class="btn ghost" data-action="test">Run test</button>
        <button class="btn ghost" data-action="delete">Remove</button>
      </div>
    </div>
  `;

  els.focusPanel.append(wrapper);

  const syncClaude = wrapper.querySelector('[data-action="sync-claude"]');
  if (syncClaude) syncClaude.addEventListener("click", () => syncClaudeUsage(account));
  wrapper.querySelector('[data-action="test"]').addEventListener("click", () => testAccount(account));
  wrapper.querySelector('[data-action="delete"]').addEventListener("click", () => deleteAccount(account));
  wrapper.querySelectorAll("[data-copy]").forEach((node) => {
    node.addEventListener("click", () => {
      navigator.clipboard.writeText(node.dataset.copy || "").catch(() => {});
      const original = node.textContent;
      node.textContent = "Copied";
      setTimeout(() => {
        node.textContent = original;
      }, 1200);
    });
  });
}

function renderOpenRouterFocus(account, status, path) {
  const wrapper = document.createElement("div");
  wrapper.className = "focus-grid openrouter-focus";
  const periods = getOpenRouterPeriods(account);
  const activePeriod = periods.find((period) => period.id === "month") || periods[0];
  const models = activePeriod?.models?.length ? activePeriod.models : account.openrouter?.models || [];
  const totals = account.openrouter?.totals || {};
  const keyLabel = account.openrouter?.keyLabel || account.rateLimits?.limitName || account.name;
  const creditLimit = account.rateLimits?.credits?.limit;
  const creditRemaining = account.rateLimits?.credits?.limitRemaining;
  const creditUsed = typeof creditLimit === "number" && typeof creditRemaining === "number"
    ? Math.max(0, creditLimit - creditRemaining)
    : totals.costCredits;

  wrapper.innerHTML = `
    <div class="focus-main">
      <div class="focus-status">
        <span class="led ${ledClass(status.tone)}"></span>
        <span>${escapeHtml(status.label)}</span>
        <span class="sep">/</span>
        <span>OpenRouter</span>
        ${account.usageSource ? `<span class="sep">/</span><span>${escapeHtml(account.usageSource)}</span>` : ""}
      </div>

      <div class="focus-title">
        <h2 class="focus-name">${escapeHtml(account.name)}</h2>
      </div>

      <div class="focus-tagline">
        ${account.planType ? `<span class="tag">${escapeHtml(account.planType)}</span>` : ""}
        <span class="focus-handle">${escapeHtml(keyLabel)}</span>
      </div>

      <div class="openrouter-summary">
        <div>
          <span class="summary-label">Total cost</span>
          <strong>${formatCost(creditUsed)}</strong>
        </div>
        <div>
          <span class="summary-label">Total tokens</span>
          <strong>${formatTokens(totals.tokens)}</strong>
        </div>
        <div>
          <span class="summary-label">Models</span>
          <strong>${models.length ? models.length : "—"}</strong>
        </div>
      </div>

      ${renderOpenRouterPeriodCards(periods)}
      ${renderOpenRouterModelTable(models, activePeriod)}
      ${renderAlert(account)}
    </div>

    <aside class="focus-aside ${status.tone === "danger" ? "is-danger" : status.tone === "warn" ? "is-warn" : ""}">
      <div class="openrouter-credit-block">
        <span class="credit-label">Credit balance</span>
        <strong>${formatCost(creditRemaining)}</strong>
        <div class="credit-meta">
          <span>Limit</span>
          <span>${formatCost(creditLimit)}</span>
        </div>
        <div class="credit-meta">
          <span>Reset</span>
          <span>${escapeHtml(account.rateLimits?.credits?.limitReset || "none")}</span>
        </div>
        <div class="credit-meta">
          <span>BYOK</span>
          <span>${formatCost(account.rateLimits?.credits?.byokUsage)}</span>
        </div>
      </div>
    </aside>

    <div class="focus-footer" style="grid-column: 1 / -1;">
      <dl class="focus-stats">
        <div>
          <dt>Source</dt>
          <dd class="strong">${escapeHtml(account.usageSource || "openrouter-key-api")}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>${account.updatedAt ? new Date(account.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</dd>
        </div>
        <div>
          <dt>${escapeHtml(path.label)}</dt>
          <dd title="${escapeHtml(path.value)}">${escapeHtml(path.value)}</dd>
        </div>
        <div>
          <dt>Key</dt>
          <dd class="strong">${escapeHtml(keyLabel)}</dd>
        </div>
      </dl>
      <div class="focus-actions">
        <button class="btn ghost" data-action="test">Run test</button>
        <button class="btn ghost" data-action="delete">Remove</button>
      </div>
    </div>
  `;

  els.focusPanel.append(wrapper);
  wrapper.querySelector('[data-action="test"]').addEventListener("click", () => testAccount(account));
  wrapper.querySelector('[data-action="delete"]').addEventListener("click", () => deleteAccount(account));
}

function renderOpenRouterPeriodCards(periods) {
  return `
    <div class="openrouter-periods">
      ${periods.map((period) => `
        <section class="openrouter-period">
          <span>${escapeHtml(period.label)}</span>
          <strong>${formatCost(period.costCredits)}</strong>
          <em>${formatTokens(period.tokens)} tokens</em>
        </section>
      `).join("")}
    </div>
  `;
}

function renderOpenRouterModelTable(models, period) {
  const rows = models.length
    ? models.map((model) => `
        <tr>
          <td>${escapeHtml(model.model || model.name || "unknown")}</td>
          <td>${formatTokens(model.tokens)}</td>
          <td>${formatCost(model.costCredits ?? model.cost)}</td>
        </tr>
      `).join("")
    : `
        <tr>
          <td>—</td>
          <td>—</td>
          <td>${formatCost(period?.costCredits)}</td>
        </tr>
      `;

  return `
    <div class="openrouter-models">
      <div class="openrouter-models-head">
        <h3>Models</h3>
        <span>${escapeHtml(period?.label || "Past month")}</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Tokens</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderPrimaryReadout(intPart, decPart, primary, tone) {
  if (intPart === null) {
    return `
      <div class="readout">
        <div class="readout-label"><span>5-hour window · used</span><span>Awaiting first read</span></div>
        <div class="readout-figure">
          <span class="integer">—</span>
        </div>
        <div class="readout-bar"><div class="readout-bar-fill" style="--pct: 0%"></div></div>
        <div class="readout-foot"><span>Refresh after login.</span><span></span></div>
      </div>
    `;
  }
  const remaining = Math.max(0, 100 - intPart);
  const resetCopy = primary.resetsAt
    ? `Resets ${formatAbsoluteReset(primary.resetsAt, true)} · in ${formatDuration(primary.resetsAt * 1000 - Date.now())}`
    : "Reset time unknown";
  const toneClass = tone === "danger" ? "is-danger" : tone === "warn" ? "is-warn" : "";

  return `
    <div class="readout">
      <div class="readout-label">
        <span>5-hour window · used</span>
        <span>${primary.windowDurationMins ? `${primary.windowDurationMins / 60}h cycle` : ""}</span>
      </div>
      <div class="readout-figure">
        <span class="integer">${intPart}</span>${decPart ? `<span class="decimal">.${decPart}</span>` : ""}<span class="unit">%</span>
      </div>
      <div class="readout-bar"><div class="readout-bar-fill ${toneClass}" style="--pct: ${clampPct(intPart)}%"></div></div>
      <div class="readout-foot"><span>${remaining}% available</span><span>${escapeHtml(resetCopy)}</span></div>
    </div>
  `;
}

function renderAside(account, primary, remainingMs, status) {
  const toneClass = status.tone === "danger" ? "is-danger" : status.tone === "warn" ? "is-warn" : "";

  if (account.provider === "claude" && typeof primary.usedPercent !== "number") {
    const expires = account.claude?.expiresAt ? new Date(account.claude.expiresAt) : null;
    const authMethod = account.claude?.authMethod || "—";
    const tier = account.claude?.rateLimitTier || account.planType || "—";
    return `
      <aside class="focus-aside ${toneClass}">
        <div class="dial-block">
          <div class="dial" aria-hidden="true">
            ${renderDial(null, "INDEX")}
            <div class="dial-center">
              <span class="label">Auth method</span>
              <strong class="time" style="font-size: 32px;">${escapeHtml(authMethod.slice(0, 14))}</strong>
              <span class="foot">${escapeHtml(tier)}</span>
            </div>
          </div>
          <div class="dial-caption">
            Profile-only · sync usage to read limits
            <strong>${expires ? `expires ${formatAbsoluteReset(expires.getTime() / 1000)}` : "no expiry recorded"}</strong>
          </div>
        </div>
      </aside>
    `;
  }

  if (remainingMs === null || remainingMs <= 0 || !primary.resetsAt) {
    return `
      <aside class="focus-aside ${toneClass}">
        <div class="dial-block">
          <div class="dial">
            ${renderDial(0, "—")}
            <div class="dial-center">
              <span class="label">Next reset</span>
              <strong class="time">—</strong>
              <span class="foot">No data yet</span>
            </div>
          </div>
          <div class="dial-caption">
            ${account.status === "ok" ? "Window resetting" : status.label}
            <strong>${escapeHtml(account.provider === "openrouter" ? account.openrouterKeyEnv || "" : account.codexHome || "")}</strong>
          </div>
        </div>
      </aside>
    `;
  }

  const cycleMs = (primary.windowDurationMins || 300) * 60 * 1000;
  const elapsed = Math.max(0, cycleMs - remainingMs);
  const progressFrac = Math.min(1, elapsed / cycleMs);
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.floor((remainingMs % 3_600_000) / 60_000);
  const timeText = hours > 0 ? `${hours}h ${minutes.toString().padStart(2, "0")}m` : `${minutes}m`;

  return `
    <aside class="focus-aside ${toneClass}">
      <div class="dial-block">
        <div class="dial">
          ${renderDial(progressFrac, formatAbsoluteReset(primary.resetsAt, true))}
          <div class="dial-center">
            <span class="label">Resets in</span>
            <strong class="time">${timeText}</strong>
            <span class="foot">${formatAbsoluteReset(primary.resetsAt, true)}</span>
          </div>
        </div>
        <div class="dial-caption">
          Cycle elapsed
          <strong>${Math.round(progressFrac * 100)}% &middot; ${primary.windowDurationMins ? primary.windowDurationMins / 60 + "h window" : "window"}</strong>
        </div>
      </div>
    </aside>
  `;
}

function renderDial(progress, _label) {
  const size = 240;
  const cx = size / 2;
  const cy = size / 2;
  const r = 102;
  const circumference = 2 * Math.PI * r;
  const dashOffset = progress === null ? circumference : circumference * (1 - progress);

  const ticks = [];
  for (let i = 0; i < 60; i++) {
    const angle = (i / 60) * 2 * Math.PI;
    const isMajor = i % 5 === 0;
    const inner = isMajor ? r + 8 : r + 10;
    const outer = r + 14;
    const x1 = cx + Math.cos(angle) * inner;
    const y1 = cy + Math.sin(angle) * inner;
    const x2 = cx + Math.cos(angle) * outer;
    const y2 = cy + Math.sin(angle) * outer;
    ticks.push(`<line class="${isMajor ? "major" : ""}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`);
  }

  return `
    <svg viewBox="0 0 ${size} ${size}">
      <g class="dial-ticks">${ticks.join("")}</g>
      <circle class="dial-track" cx="${cx}" cy="${cy}" r="${r}" />
      ${
        progress !== null
          ? `<circle class="dial-progress" cx="${cx}" cy="${cy}" r="${r}"
              stroke-dasharray="${circumference}"
              stroke-dashoffset="${dashOffset}" />`
          : ""
      }
    </svg>
  `;
}

function renderAlert(account) {
  if (account.status === "ok" && account.sourceWarning) {
    return `
      <div class="alert is-warn">
        <div class="alert-head">
          <h3 class="alert-title">Usage log</h3>
        </div>
        <p class="alert-msg">${escapeHtml(account.sourceWarning)}</p>
      </div>
    `;
  }
  if (!account.status || account.status === "ok") return "";

  if (account.status === "manual_lockout" && account.manualOverride) {
    return `
      <div class="alert is-warn">
        <div class="alert-head">
          <h3 class="alert-title">Manual lockout</h3>
        </div>
        <p class="alert-msg">${escapeHtml(account.manualOverride.reason)} — clears ${formatDateTime(account.manualOverride.unavailableUntil)}.</p>
      </div>
    `;
  }

  if (account.status === "metadata_only") {
    return `
      <div class="alert">
        <div class="alert-head">
          <h3 class="alert-title">Profile only</h3>
        </div>
        <p class="alert-msg">${escapeHtml(account.sourceWarning || "Click Sync usage to run a tiny Claude Code turn and read subscription windows.")}</p>
      </div>
    `;
  }

  if (!account.loginCommand) {
    return `
      <div class="alert is-danger">
        <div class="alert-head">
          <h3 class="alert-title">Issue</h3>
        </div>
        <p class="alert-msg">${escapeHtml(account.error || "Unknown error")}</p>
      </div>
    `;
  }

  return `
    <div class="alert ${account.status === "wrong_account" || account.status === "error" ? "is-danger" : "is-warn"}">
      <div class="alert-head">
        <h3 class="alert-title">Action required</h3>
        <span style="font-family: var(--font-mono); font-size: 10px; color: var(--ink-mute); letter-spacing: 0.18em; text-transform: uppercase;">${escapeHtml(account.status.replace(/_/g, " "))}</span>
      </div>
      ${account.error ? `<p class="alert-msg">${escapeHtml(account.error)}</p>` : ""}
      <div class="command">
        <code>${escapeHtml(account.loginCommand)}</code>
        <button class="command-copy" type="button" data-copy="${escapeHtml(account.loginCommand)}">Copy</button>
      </div>
    </div>
  `;
}

function renderAccountHandoff(account) {
  if (account.provider !== "codex" || !account.codexHome) return "";
  if (account.status === "shared_home" || looksLikeSharedCodexHome(account.codexHome)) return "";

  const launchCommand = `CODEX_HOME=${shellQuote(account.codexHome)} codex`;
  return `
    <div class="handoff">
      <div class="handoff-head">
        <h3 class="handoff-title">Use this Codex account</h3>
        <span>No logout needed</span>
      </div>
      <p class="handoff-msg">Start Codex with this account-specific home instead of logging out of another subscription.</p>
      <div class="command">
        <code>${escapeHtml(launchCommand)}</code>
        <button class="command-copy" type="button" data-copy="${escapeHtml(launchCommand)}">Copy</button>
      </div>
    </div>
  `;
}

/* ── LEDGER ─────────────────────────────────────────────── */

function renderLedger(accounts) {
  els.accountList.replaceChildren();

  els.ledgerMeta.textContent = accounts.length
    ? `${accounts.length} entries · sorted by lowest usage`
    : "Empty";

  const sorted = accounts.slice().sort((a, b) => usageScore(a) - usageScore(b));

  sorted.forEach((account, index) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `account-card ${account.id === state.selectedId ? "is-active" : ""}`;
    card.style.animationDelay = `${index * 60}ms`;
    card.dataset.id = account.id;

    const status = statusMeta(account);
    const primary = getWindow(account, "primary");
    const secondary = getWindow(account, "secondary");
    const pct = typeof primary.usedPercent === "number" ? primary.usedPercent : null;
    const secondaryPct = typeof secondary.usedPercent === "number" ? secondary.usedPercent : null;
    const primaryTone = toneFromPct(pct);
    const secondaryTone = toneFromPct(secondaryPct);
    const worstTone = worstOf(primaryTone, secondaryTone);
    const isLive = account.status === "ok";
    const isOpenRouter = account.provider === "openrouter";
    const openrouterSummary = isOpenRouter ? openRouterCardSummary(account) : null;
    const toneClass =
      !isLive ? "is-muted" : primaryTone === "danger" ? "is-danger" : primaryTone === "warn" ? "is-warn" : "";
    const secondaryToneClass =
      !isLive ? "is-muted" : secondaryTone === "danger" ? "is-danger" : secondaryTone === "warn" ? "is-warn" : "";

    if (isLive && worstTone === "danger") card.classList.add("is-alert");
    else if (isLive && worstTone === "warn") card.classList.add("is-edge");

    card.innerHTML = `
      <div class="card-head">
        <div class="left">
          <span class="led ${ledClass(isLive && worstTone === "danger" ? "danger" : isLive && worstTone === "warn" ? "warn" : status.tone)}"></span>
          <span>${escapeHtml(status.label)}</span>
        </div>
        <span class="tag">${escapeHtml(account.planType || (account.provider === "claude" ? "Claude" : account.provider === "openrouter" ? "OpenRouter" : "Codex"))}</span>
      </div>
      <h3 class="card-name">${escapeHtml(account.name)}</h3>
      <p class="card-email">${escapeHtml(isOpenRouter ? account.openrouterKeyEnv || "—" : displayEmail(account.email || account.expectedEmail) || "—")}</p>
      <div class="card-meter">
        ${isOpenRouter
          ? `
            <div class="card-meter-top">
              <span class="card-meter-pct">${escapeHtml(openrouterSummary.cost)}</span>
              <span class="card-meter-label">Month cost</span>
            </div>
            <div class="openrouter-card-lines">
              <span>Day ${escapeHtml(openrouterSummary.day)}</span>
              <span>Week ${escapeHtml(openrouterSummary.week)}</span>
              <span>Tokens ${escapeHtml(openrouterSummary.tokens)}</span>
            </div>
          `
          : `
            <div class="card-meter-top">
              <span class="card-meter-pct">${pct !== null ? Math.floor(pct) : "—"}<em>%</em></span>
              <span class="card-meter-label">5h window</span>
            </div>
            <div class="card-meter-bar">
              <div class="card-meter-fill ${toneClass}" style="--pct: ${pct !== null ? clampPct(pct) : 0}%"></div>
            </div>
            ${
              secondaryPct !== null
                ? `
                  <div class="card-meter-row">
                    <span class="label">Weekly</span>
                    <div class="bar"><div class="fill ${secondaryToneClass}" style="--pct: ${clampPct(secondaryPct)}%"></div></div>
                    <span class="pct">${Math.floor(secondaryPct)}%</span>
                  </div>
                `
                : ""
            }
          `}
      </div>
      <footer class="card-foot">
        <span>${escapeHtml(cardFootLeft(account))}</span>
        <span class="reset-time">${escapeHtml(cardFootRight(account))}</span>
      </footer>
    `;

    card.addEventListener("click", () => {
      state.selectedId = account.id;
      render();
    });

    els.accountList.append(card);
  });

  const adder = document.createElement("button");
  adder.type = "button";
  adder.className = "account-add";
  adder.style.animationDelay = `${sorted.length * 60}ms`;
  adder.innerHTML = `
    <span class="add-eyebrow">N° ${String(sorted.length + 1).padStart(2, "0")}</span>
    <h3>Register a new<br/>subscription</h3>
    <span class="add-action">Add account ${icons.arrow}</span>
  `;
  adder.addEventListener("click", openAddDialog);
  els.accountList.append(adder);
}

function cardFootLeft(account) {
  if (account.status === "ok") return "Live";
  if (account.status === "metadata_only") return "Profile";
  if (account.status === "manual_lockout") return "Locked";
  if (account.status === "shared_home") return "Shared home";
  if (account.status === "not_logged_in") return "Needs login";
  if (account.status === "missing_home") return "Missing home";
  if (account.status === "wrong_account") return "Wrong account";
  if (account.status === "error") return "Error";
  return "Pending";
}

function cardFootRight(account) {
  if (account.provider === "openrouter") {
    return `total ${formatCost(getOpenRouterPeriod(account, "total")?.costCredits)}`;
  }
  if (account.status === "ok") {
    const primary = getWindow(account, "primary");
    if (primary.resetsAt) return `resets ${formatAbsoluteReset(primary.resetsAt, true)}`;
    return "—";
  }
  if (account.status === "manual_lockout" && account.manualOverride) {
    return `until ${formatAbsoluteReset(new Date(account.manualOverride.unavailableUntil).getTime() / 1000, true)}`;
  }
  if (account.provider === "claude" && account.claude?.expiresAt) {
    return `exp ${formatAbsoluteReset(new Date(account.claude.expiresAt).getTime() / 1000, true)}`;
  }
  return "—";
}

/* ── HELPERS ────────────────────────────────────────────── */

function getWindow(account, key) {
  return account.rateLimits?.[key] || {};
}

function usageScore(account) {
  if (account.status === "manual_lockout") return Number.POSITIVE_INFINITY;
  if (account.status !== "ok" && account.status !== "metadata_only") return Number.POSITIVE_INFINITY;
  if (account.provider === "openrouter") {
    const month = getOpenRouterPeriod(account, "month");
    return typeof month?.costCredits === "number" ? month.costCredits : 0;
  }
  const primary = getWindow(account, "primary");
  if (typeof primary.usedPercent !== "number") return Number.POSITIVE_INFINITY;
  return primary.usedPercent;
}

function getOpenRouterPeriods(account) {
  const periods = account.openrouter?.usagePeriods;
  if (Array.isArray(periods) && periods.length) return periods;
  const credits = account.rateLimits?.credits || {};
  return [
    { id: "30m", label: "Past 30 minutes", costCredits: null, tokens: null, models: [] },
    { id: "day", label: "Past day", costCredits: credits.usageDaily ?? null, tokens: null, models: [] },
    { id: "week", label: "Past Week", costCredits: credits.usageWeekly ?? null, tokens: null, models: [] },
    { id: "month", label: "Past Month", costCredits: credits.usageMonthly ?? null, tokens: null, models: [] },
    { id: "total", label: "Total", costCredits: credits.usage ?? null, tokens: null, models: [] },
  ];
}

function getOpenRouterPeriod(account, id) {
  return getOpenRouterPeriods(account).find((period) => period.id === id) || null;
}

function openRouterCardSummary(account) {
  return {
    cost: formatCost(getOpenRouterPeriod(account, "month")?.costCredits),
    day: formatCost(getOpenRouterPeriod(account, "day")?.costCredits),
    week: formatCost(getOpenRouterPeriod(account, "week")?.costCredits),
    tokens: formatTokens(account.openrouter?.totals?.tokens),
  };
}

function formatCost(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  if (Math.abs(value) < 100) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

function clampPct(value) {
  return Math.max(0, Math.min(100, value));
}

function toneFromPct(pct) {
  if (pct === null || pct === undefined) return "ok";
  if (pct >= 85) return "danger";
  if (pct >= 60) return "warn";
  return "ok";
}

function worstOf(a, b) {
  const rank = { ok: 0, warn: 1, danger: 2 };
  return (rank[a] ?? 0) >= (rank[b] ?? 0) ? a : b;
}

function ledClass(tone) {
  if (tone === "ok") return "is-ok";
  if (tone === "warn") return "is-warn";
  if (tone === "danger") return "is-danger";
  if (tone === "info") return "is-info";
  return "";
}

function statusMeta(account) {
  if (account.status === "ok") {
    if (account.rateLimits?.limitReached === true || account.rateLimits?.allowed === false) {
      return { label: "Limit reached", tone: "danger" };
    }
    return { label: "Live", tone: "ok" };
  }
  if (account.status === "manual_lockout") return { label: "Manually offline", tone: "warn" };
  if (account.status === "metadata_only") return { label: "Profile only", tone: "info" };
  if (account.status === "shared_home") return { label: "Shared home", tone: "danger" };
  if (account.status === "wrong_account") return { label: "Wrong account", tone: "danger" };
  if (account.status === "not_logged_in") return { label: "Awaiting login", tone: "warn" };
  if (account.status === "missing_home") return { label: "Home missing", tone: "warn" };
  if (account.status === "error") return { label: "Error", tone: "danger" };
  return { label: "Pending", tone: "" };
}

function providerPath(account) {
  if (account.provider === "claude") {
    return { label: "Claude home", value: account.claudeHome || "~/.claude" };
  }
  if (account.provider === "openrouter") {
    return { label: "API key env var", value: account.openrouterKeyEnv || "—" };
  }
  return { label: "Codex home", value: account.codexHome || "" };
}

function formatAbsoluteReset(seconds, includeTimeOnly = false) {
  if (!seconds) return "—";
  const date = new Date(seconds * 1000);
  const time = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  if (includeTimeOnly && Math.abs(date.getTime() - Date.now()) < 24 * 60 * 60 * 1000) {
    return time;
  }
  const day = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
  return `${day} ${time}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
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

function formatResetShort(seconds) {
  if (!seconds) return "—";
  const remaining = seconds * 1000 - Date.now();
  if (remaining <= 0) return "now";
  return `resets in ${formatDuration(remaining)}`;
}

function formatRelativeShort(date) {
  const diffMs = Date.now() - date.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function looksLikeSharedCodexHome(value) {
  const path = String(value || "").replace(/\/+$/, "");
  return path === "~/.codex" || path.endsWith("/.codex");
}

/* ── NOTIFICATIONS ──────────────────────────────────────── */

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
}

async function initNotifications() {
  state.notifications.supported = pushSupported();
  state.notifications.permission = "Notification" in window ? Notification.permission : "default";
  renderNotificationButton();
  if (!state.notifications.supported) return;

  try {
    const config = await api("/api/notifications");
    state.notifications.publicKey = config.publicKey;
    state.notifications.subscriptions = config.subscriptions || 0;
    const registration = await navigator.serviceWorker.register("/sw.js");
    const subscription = await registration.pushManager.getSubscription();
    state.notifications.subscribed = Boolean(subscription);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    renderNotificationButton();
  }
}

function renderNotificationButton() {
  if (!els.notificationToggle) return;
  const label = els.notificationToggle.querySelector(".notification-label");
  const { supported, subscribed, permission } = state.notifications;
  els.notificationToggle.disabled = !supported || permission === "denied";
  els.notificationToggle.setAttribute("aria-pressed", String(subscribed));
  els.notificationToggle.title = !supported
    ? "Alerts require HTTPS or localhost"
    : permission === "denied"
      ? "Alerts blocked by browser"
      : subscribed
        ? "Disable mobile alerts"
        : "Enable mobile alerts";
  if (label) {
    label.textContent = !supported
      ? "No alerts"
      : permission === "denied"
        ? "Blocked"
        : subscribed
          ? "Alerting"
          : "Alerts";
  }
}

async function toggleNotifications() {
  if (!state.notifications.supported) {
    toast("Open over HTTPS or localhost to enable alerts", "error");
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    await api("/api/notifications/subscribe", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: existing.endpoint }),
    });
    await existing.unsubscribe();
    state.notifications.subscribed = false;
    toast("Mobile alerts disabled", "ok");
    renderNotificationButton();
    return;
  }

  const permission = await Notification.requestPermission();
  state.notifications.permission = permission;
  if (permission !== "granted") {
    renderNotificationButton();
    toast("Alerts were not granted", "error");
    return;
  }

  if (!state.notifications.publicKey) {
    const config = await api("/api/notifications");
    state.notifications.publicKey = config.publicKey;
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(state.notifications.publicKey),
  });
  await api("/api/notifications/subscribe", {
    method: "POST",
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  state.notifications.subscribed = true;
  renderNotificationButton();
  toast("Mobile alerts enabled", "ok");
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/* ── ACTIONS ────────────────────────────────────────────── */

async function testAccount(account) {
  const button = els.focusPanel.querySelector('[data-action="test"]');
  if (!button) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Testing…";
  try {
    const result = await api(`/api/accounts/${encodeURIComponent(account.id)}/test`, { method: "POST" });
    toast(result.stdout || "Account responded", "ok");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
    await refreshUsage();
  }
}

async function syncClaudeUsage(account) {
  const button = els.focusPanel.querySelector('[data-action="sync-claude"]');
  if (!button) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Syncing…";
  try {
    const { usage } = await api(`/api/accounts/${encodeURIComponent(account.id)}/claude/sync`, {
      method: "POST",
    });
    state.usage = state.usage.filter((item) => item.id !== account.id).concat(usage);
    state.lastRefresh = new Date();
    toast(usage.syncWarning || "Claude usage synced", usage.syncWarning ? "warn" : "ok");
    render();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function deleteAccount(account) {
  if (!window.confirm(`Remove ${account.name} from the tracker?`)) return;
  try {
    await api(`/api/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
    state.selectedId = null;
    state.usage = [];
    await loadAccounts();
    await refreshUsage();
    toast(`${account.name} removed`, "ok");
  } catch (error) {
    toast(error.message, "error");
  }
}

function openAddDialog() {
  els.form.reset();
  els.codexHome.value = "~/.codex-accounts/account2";
  els.claudeHome.value = "";
  els.openrouterKeyEnv.value = "";
  els.openrouterUsageLog.value = "";
  els.expectedEmail.value = "";
  syncProviderFields();
  els.dialog.showModal();
}

function syncProviderFields() {
  const provider = els.form.querySelector('input[name="provider"]:checked').value;
  els.codexHomeField.hidden = provider !== "codex";
  els.claudeHomeField.hidden = provider !== "claude";
  els.openrouterKeyEnvField.hidden = provider !== "openrouter";
  els.openrouterUsageLogField.hidden = provider !== "openrouter";
  els.codexHome.required = provider === "codex";
  els.openrouterKeyEnv.required = provider === "openrouter";
}

function toast(message, tone = "") {
  els.toast.textContent = message;
  els.toast.className = `toast is-on ${tone === "error" ? "is-error" : tone === "ok" ? "is-ok" : ""}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    els.toast.className = "toast";
  }, 3200);
}

/* ── BOOT ───────────────────────────────────────────────── */

els.refreshUsage.addEventListener("click", refreshUsage);
els.openAddDialog.addEventListener("click", openAddDialog);
els.privacyToggle?.addEventListener("click", () => applyPrivacy(!privacyMode));
els.notificationToggle?.addEventListener("click", () => {
  toggleNotifications().catch((error) => toast(error.message, "error"));
});
window.addEventListener("storage", (event) => {
  if (event.key === PRIVACY_KEY) applyPrivacy(event.newValue === "on", { persist: false });
});
window.addEventListener("keydown", (event) => {
  if (event.target.matches?.("input, textarea, select, [contenteditable]")) return;
  if (event.key === "p" || event.key === "P") applyPrivacy(!privacyMode);
});
els.closeDialog.addEventListener("click", () => els.dialog.close());
els.cancelDialog.addEventListener("click", () => els.dialog.close());
els.form.querySelectorAll('input[name="provider"]').forEach((node) => {
  node.addEventListener("change", syncProviderFields);
});

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const provider = els.form.querySelector('input[name="provider"]:checked').value;
  try {
    await api("/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        name: els.accountName.value,
        provider,
        codexHome: els.codexHome.value,
        claudeHome: els.claudeHome.value,
        openrouterKeyEnv: els.openrouterKeyEnv.value,
        openrouterUsageLog: els.openrouterUsageLog.value,
        expectedEmail: els.expectedEmail.value,
      }),
    });
    els.dialog.close();
    toast("Account registered", "ok");
    await loadAccounts();
    await refreshUsage();
  } catch (error) {
    toast(error.message, "error");
  }
});

hydrateIcons();
applyPrivacy(localStorage.getItem(PRIVACY_KEY) === "on", { persist: false });
startClock();
await loadAccounts();
await initNotifications();
await refreshUsage();
let refreshTimer = setInterval(refreshUsage, 60_000);
let countdownTimer = setInterval(render, 30_000); // re-render countdowns

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);
    refreshTimer = null;
    countdownTimer = null;
  } else if (!refreshTimer) {
    const stale = !state.lastRefresh || Date.now() - state.lastRefresh.getTime() > 30_000;
    if (stale) refreshUsage();
    refreshTimer = setInterval(refreshUsage, 60_000);
    countdownTimer = setInterval(render, 30_000);
  }
});
