// QA Buddy — background service worker
// Stores captured events per tab in chrome.storage.session, merges repeated
// identical errors, supports "Start fresh" recordings and per-event
// include/exclude, catches failed page resources via webRequest, and shows
// an error count on the extension icon.

const MAX_EVENTS = 50;
const ERROR_TYPES = new Set(["console", "error", "promise", "network"]);

// Same endpoint with different query parameters (offset=0, offset=30…) is one entry
function endpointOf(url) {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
}
const queues = {}; // tabId -> promise chain, so updates never overwrite each other

const keyFor = (tabId) => `tab:${tabId}`;
const emptyState = () => ({ ready: false, url: "", events: [], excluded: [], recordingSince: Date.now(), steps: [] });
const MAX_STEPS = 25;
const ACTION_KINDS = new Set(["click", "submit", "enter", "select", "check"]);

function addStep(state, step) {
  const last = state.steps[state.steps.length - 1];
  if (last && last.label === step.label && step.time - last.time < 1500) return;
  state.steps.push({ id: `${step.time}-${Math.random().toString(36).slice(2, 6)}`, ...step });
  if (state.steps.length > MAX_STEPS) state.steps.splice(0, state.steps.length - MAX_STEPS);
}

function pagePath(url) {
  try { const u = new URL(url); return (u.pathname + u.search).slice(0, 80); } catch { return url; }
}

async function getState(tabId) {
  const key = keyFor(tabId);
  const stored = await chrome.storage.session.get(key);
  return { ...emptyState(), ...(stored[key] || {}) };
}

function updateState(tabId, change) {
  queues[tabId] = (queues[tabId] || Promise.resolve())
    .then(async () => {
      const state = await getState(tabId);
      change(state);
      await chrome.storage.session.set({ [keyFor(tabId)]: state });
      await updateBadge(tabId, state);
    })
    .catch((err) => console.warn("[QA Buddy] state update failed", err));
  return queues[tabId];
}

async function updateBadge(tabId, state) {
  const count = state.events.length;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#c8413a" });
    await chrome.action.setBadgeText({ tabId, text: count ? String(Math.min(count, 99)) : "" });
  } catch {} // tab may be gone
}

// Same error repeated → one entry with a count
const signature = (e) => e.type === "network"
  ? [e.type, e.method, endpointOf(e.url), e.kind === "failed" || !e.kind ? e.status : e.kind].join("|")
  : [e.type, e.message, e.source, e.line].join("|");

// Events are collected in memory and saved once per second per tab, instead of
// rewriting the tab's state on every event (pages that keep failing or polling
// can produce many events per second).
const FLUSH_MS = 1000;
const pending = {};      // tabId -> [events]
const flushTimers = {};  // tabId -> timeout

function mergeEvent(state, event) {
  const sig = signature(event);
  const existing = state.events.find((e) => signature(e) === sig);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.lastTime = event.time;
    if (event.type === "network") {
      // keep the latest example of this endpoint
      const urls = new Set(existing.urls || [existing.url]);
      if (urls.size < 50) urls.add(event.url);
      existing.urls = [...urls];
      existing.variants = urls.size;
      Object.assign(existing, {
        url: event.url, statusText: event.statusText, duration: event.duration,
        requestBody: event.requestBody, responseBody: event.responseBody, frame: event.frame,
      });
    }
    return;
  }
  event.id = `${event.time}-${Math.random().toString(36).slice(2, 8)}`;
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

function flushEvents(tabId) {
  clearTimeout(flushTimers[tabId]);
  delete flushTimers[tabId];
  const batch = pending[tabId];
  delete pending[tabId];
  if (!batch?.length) return queues[tabId] || Promise.resolve();
  return updateState(tabId, (state) => batch.forEach((e) => mergeEvent(state, e)));
}

function addEvent(tabId, event) {
  (pending[tabId] ||= []).push(event);
  if (!flushTimers[tabId]) flushTimers[tabId] = setTimeout(() => flushEvents(tabId), FLUSH_MS);
}

function dropPending(tabId) {
  clearTimeout(flushTimers[tabId]);
  delete flushTimers[tabId];
  delete pending[tabId];
}

function startFresh(tabId) {
  dropPending(tabId);
  return updateState(tabId, (state) => {
    state.events = [];
    state.excluded = [];
    state.scope = undefined;
    state.mainId = null;
    state.steps = [];
    state.recordingSince = Date.now();
  });
}

// ---------- messages from bridge.js and the popup ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.from === "bridge" && sender.tab) {
    const tabId = sender.tab.id;
    if (msg.type === "ready") {
      updateState(tabId, (s) => {
        s.ready = true;
        s.url = sender.tab.url || msg.data?.url || "";
        if (sender.frameId === 0) addStep(s, { kind: "navigate", label: `Opened ${pagePath(s.url)}`, time: msg.data.time });
      });
    } else if (msg.type === "action") {
      updateState(tabId, (s) => {
        addStep(s, { kind: msg.data.kind, label: msg.data.label, time: msg.data.time, frame: msg.data.frame });
        if (ACTION_KINDS.has(msg.data.kind)) s.lastAction = { label: msg.data.label, time: msg.data.time, frame: msg.data.frame };
      });
    } else if (ERROR_TYPES.has(msg.type)) {
      addEvent(tabId, { type: msg.type, ...msg.data });
    }
    return;
  }

  if (msg?.from !== "popup") return;

  // The popup is opening: save events still waiting in memory first
  if (msg.type === "flush") {
    flushEvents(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "isAllowed") {
    captureMatches().then((m) => { allowedPatterns = m; sendResponse({ allowed: matchesAllowed(msg.url) }); });
    return true;
  }

  if (msg.type === "startFresh") {
    startFresh(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }


  // scope: "lastAction" | "all" | "none" | "custom"
  if (msg.type === "setSelection") {
    updateState(msg.tabId, (s) => {
      s.excluded = msg.excluded;
      s.scope = msg.scope;
      if (msg.mainId !== undefined) s.mainId = msg.mainId;
      if (s.mainId && s.excluded.includes(s.mainId)) s.mainId = null; // the main problem must be included
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  // Mark (or unmark) the event that caused the bug; it's always included
  if (msg.type === "setMain") {
    updateState(msg.tabId, (s) => {
      s.mainId = s.mainId === msg.id ? null : msg.id;
      if (s.mainId && s.excluded.includes(s.mainId)) {
        s.excluded = s.excluded.filter((x) => x !== s.mainId);
        s.scope = "custom";
      }
    }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "removeStep") {
    updateState(msg.tabId, (s) => { s.steps = s.steps.filter((x) => x.id !== msg.id); }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "clearSteps") {
    updateState(msg.tabId, (s) => { s.steps = []; }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "toggleEvent") {
    updateState(msg.tabId, (s) => {
      const excluded = new Set(s.excluded);
      msg.include ? excluded.delete(msg.id) : excluded.add(msg.id);
      s.excluded = [...excluded];
      s.scope = "custom";
      if (!msg.include && s.mainId === msg.id) s.mainId = null;
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---------- new page load: start a fresh recording ----------
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    dropPending(tabId);
    // New page: fresh recording, steps included
    updateState(tabId, (state) => Object.assign(state, emptyState()));
    chrome.storage.session.remove(`shot:${tabId}`);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  dropPending(tabId);
  chrome.storage.session.remove([keyFor(tabId), `shot:${tabId}`]);
  delete queues[tabId];
});

// ---------- which sites QA Buddy captures on ----------
// settings.sites = { mode: "all" | "list", list: ["*.example.com", "localhost"] }
// The capture scripts are registered here (not in the manifest), so on other
// sites no QA Buddy code runs at all.
function toMatchPattern(entry) {
  let s = entry.trim().toLowerCase();
  if (!s) return null;
  if (/^[a-z*]+:\/\//.test(s)) {
    try { s = new URL(s.replace("*://", "http://")).hostname; } catch { return null; }
  }
  s = s.replace(/\/.*$/, "").replace(/:\d+$/, "");           // drop path and port
  if (!/^(\*\.)?[a-z0-9.-]+$/.test(s) || s.startsWith(".") || s.includes("..")) return null;
  return `*://${s}/*`;
}

async function captureMatches() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  const sites = settings.sites || { mode: "all" };
  if (sites.mode !== "list") return ["<all_urls>"];
  return [...new Set((sites.list || []).map(toMatchPattern).filter(Boolean))];
}

let allowedPatterns = ["<all_urls>"];
function matchesAllowed(url) {
  if (allowedPatterns.includes("<all_urls>")) return true;
  let host;
  try { host = new URL(url).hostname; } catch { return false; }
  return allowedPatterns.some((p) => {
    const h = p.slice("*://".length, -"/*".length);
    if (h.startsWith("*.")) return host === h.slice(2) || host.endsWith(h.slice(1));
    return host === h;
  });
}

async function registerCapture() {
  const matches = await captureMatches();
  allowedPatterns = matches.length ? matches : [];
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (!matches.length) return; // "only these sites" with an empty list: capture nowhere
  await chrome.scripting.registerContentScripts([
    { id: "qa-injected", matches, js: ["injected.js"], runAt: "document_start", world: "MAIN", allFrames: true, matchOriginAsFallback: true },
    { id: "qa-bridge", matches, js: ["bridge.js"], runAt: "document_start", allFrames: true, matchOriginAsFallback: true },
    { id: "qa-replay", matches, js: ["vendor/rrweb.min.js", "recorder.js"], runAt: "document_idle", allFrames: false },
  ]);
}

chrome.runtime.onInstalled.addListener(() => registerCapture().catch((e) => console.warn("[QA Buddy] register failed", e)));
chrome.runtime.onStartup.addListener(() => registerCapture().catch(() => {}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) {
    const before = JSON.stringify(changes.settings.oldValue?.sites || null);
    const after = JSON.stringify(changes.settings.newValue?.sites || null);
    if (before !== after) registerCapture().catch((e) => console.warn("[QA Buddy] register failed", e));
  }
});
captureMatches().then((m) => (allowedPatterns = m)); // worker restarted: restore the list

// ---------- failed page resources (scripts, images, styles, documents) ----------
// fetch/XHR are captured in the page by injected.js, so they're skipped here.
function shouldSkip(details) {
  if (details.tabId < 0 || details.type === "xmlhttprequest" || /\/favicon\.ico(\?|$)/.test(details.url)) return true;
  const page = details.documentUrl || details.initiator || details.url;
  return !matchesAllowed(page);
}

chrome.webRequest.onCompleted.addListener((d) => {
  if (shouldSkip(d) || d.statusCode < 400) return;
  addEvent(d.tabId, {
    type: "network", source: d.type, method: d.method, url: d.url,
    status: d.statusCode, statusText: d.statusLine || "", time: Date.now(),
  });
}, { urls: ["<all_urls>"] });

chrome.webRequest.onErrorOccurred.addListener((d) => {
  if (shouldSkip(d) || d.error === "net::ERR_ABORTED") return;
  addEvent(d.tabId, {
    type: "network", source: d.type, method: d.method, url: d.url,
    status: 0, statusText: d.error, time: Date.now(),
  });
}, { urls: ["<all_urls>"] });

// =====================================================================
// Jira (REST API v2). Runs here so cross-site rules don't block it.
// credentials: "omit" keeps the browser's Jira login cookies out of the
// request; with cookies Jira applies an XSRF check and rejects the POST.
// =====================================================================
class JiraError extends Error {
  constructor(status, body) {
    super(jiraMessage(status, body));
    this.status = status;
    this.body = body;
  }
}

function jiraDetails(body) {
  if (!body || typeof body !== "object") return "";
  const parts = [...(body.errorMessages || [])];
  for (const [field, text] of Object.entries(body.errors || {})) parts.push(`${field}: ${text}`);
  return parts.join(" ");
}

function jiraMessage(status, body) {
  const details = jiraDetails(body);
  if (status === 0) return "Couldn't reach Jira. Check the site address and your connection.";
  if (status === 401) return "Jira didn't accept the email or API token. Check them in Settings.";
  if (status === 403) return `Your Jira account isn't allowed to do this in that project. ${details}`.trim();
  if (status === 404) return `Jira couldn't find that site or project. Check the site address and project key. ${details}`.trim();
  if (status === 400) return `Jira rejected the issue: ${details || "invalid request"}`;
  return `Jira returned an error (${status}). ${details}`.trim();
}

// The project key is only needed to create new issues, not to add to an existing one
function jiraConfigProblem(cfg, { needProject = true } = {}) {
  const fields = [["baseUrl", "Jira site"], ["email", "email"], ["token", "API token"]];
  if (needProject) fields.push(["projectKey", "project key"]);
  const missing = fields.filter(([k]) => !cfg?.[k]).map(([, label]) => label);
  return missing.length ? `Add your ${missing.join(", ")} in Settings first.` : "";
}

// "PROJ-123" or "https://site.atlassian.net/browse/PROJ-123?..." → "PROJ-123"
function issueKeyFrom(text) {
  const m = String(text || "").trim().toUpperCase().match(/(?:BROWSE\/|SELECTEDISSUE=|^)([A-Z][A-Z0-9_]+-\d+)/);
  return m ? m[1] : null;
}

async function lookupIssue(text) {
  const cfg = await jiraConfig();
  const problem = jiraConfigProblem(cfg, { needProject: false });
  if (problem) return { ok: false, message: problem };
  const key = issueKeyFrom(text);
  if (!key) return { ok: false, message: "That doesn't look like an issue key or link, for example PROJ-123." };
  try {
    const issue = await jiraFetch(cfg, `/rest/api/2/issue/${key}?fields=summary,status`);
    return { ok: true, key: issue.key, summary: issue.fields?.summary || "", status: issue.fields?.status?.name || "" };
  } catch (err) {
    return { ok: false, message: err.status === 404 ? `${key} doesn't exist, or you can't see it.` : err.message };
  }
}

async function listProjects() {
  const cfg = await jiraConfig();
  const problem = jiraConfigProblem(cfg, { needProject: false });
  if (problem) return { ok: false, message: problem };
  try {
    const projects = await jiraFetch(cfg, "/rest/api/2/project");
    return { ok: true, projects: projects.map((p) => ({ key: p.key, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function projectIssueTypes(key) {
  const cfg = await jiraConfig();
  try {
    const project = await jiraFetch(cfg, `/rest/api/2/project/${encodeURIComponent(key)}`);
    return { ok: true, types: (project.issueTypes || []).filter((t) => !t.subtask).map((t) => t.name) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function attachFiles(cfg, key, payload) {
  const form = new FormData();
  if (payload.screenshot) form.append("file", await (await fetch(payload.screenshot)).blob(), "screenshot.png");
  if (payload.html) form.append("file", new Blob([payload.html], { type: "text/html" }), payload.fileName || "qa-report.html");
  if (payload.replayHtml) form.append("file", new Blob([payload.replayHtml], { type: "text/html" }), "session-replay.html");
  if (![...form.keys()].length) return;
  await jiraFetch(cfg, `/rest/api/2/issue/${key}/attachments`, {
    method: "POST",
    headers: { "X-Atlassian-Token": "no-check" },
    body: form,
  });
}

// Add the report to an existing issue: a comment plus the attachments
async function addToJiraIssue(payload) {
  const cfg = await jiraConfig();
  const problem = jiraConfigProblem(cfg, { needProject: false });
  if (problem) return { ok: false, needsSettings: true, message: problem };
  const key = issueKeyFrom(payload.issueKey);
  if (!key) return { ok: false, message: "Enter an issue key or link, for example PROJ-123." };

  const body = `h2. ${payload.summary.replace(/\s+/g, " ").slice(0, 250)}\n\n${payload.description}`;
  try {
    await jiraFetch(cfg, `/rest/api/2/issue/${key}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: body.length > 32000 ? body.slice(0, 32000) + "\n\n_(Shortened. See the attached HTML report.)_" : body }),
    });
  } catch (err) {
    return { ok: false, message: err.status === 404 ? `${key} doesn't exist, or you can't comment on it.` : err.message };
  }
  let warning = "";
  try { await attachFiles(cfg, key, payload); } catch (err) { warning = `The comment was added, but the attachments failed: ${err.message}`; }
  return { ok: true, key, url: `${cfg.baseUrl}/browse/${key}`, warning, added: true };
}

async function jiraFetch(cfg, path, options = {}) {
  let res;
  try {
    res = await fetch(`${cfg.baseUrl}${path}`, {
      ...options,
      credentials: "omit",
      headers: {
        Authorization: "Basic " + btoa(`${cfg.email}:${cfg.token}`),
        Accept: "application/json",
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new JiraError(0, null);
  }
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new JiraError(res.status, body);
  return body;
}

async function jiraConfig(override) {
  if (override) return override;
  const { jira = {} } = await chrome.storage.local.get("jira");
  return jira;
}

async function testJira(cfg) {
  const problem = jiraConfigProblem(cfg, { needProject: false });
  if (problem) return { ok: false, message: problem };
  try {
    const me = await jiraFetch(cfg, "/rest/api/2/myself");
    if (!cfg.projectKey) {
      return { ok: true, message: `Connected as ${me.displayName}. No default project: you'll choose the project for each new issue in the review screen.` };
    }
    const project = await jiraFetch(cfg, `/rest/api/2/project/${encodeURIComponent(cfg.projectKey)}`);
    const types = (project.issueTypes || []).filter((t) => !t.subtask).map((t) => t.name);
    const wanted = cfg.issueType || "Bug";
    const typeOk = !types.length || types.some((t) => t.toLowerCase() === wanted.toLowerCase());
    const who = { default: "assigned by the project's default rule", unassigned: "unassigned", person: `assigned to ${cfg.assigneeName || "the chosen person"}` }[cfg.assigneeMode] || "assigned to you";
    return {
      ok: typeOk,
      message: typeOk
        ? `Connected as ${me.displayName}. Issues will go to ${project.name} (${project.key}) as "${wanted}", ${who}.`
        : `Connected as ${me.displayName}, but ${project.key} has no issue type "${wanted}". Available: ${types.join(", ")}.`,
    };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

// Assignee: "default" (project rule) | "me" | "unassigned" | "person" (cfg.assigneeId)
// override: { mode, id } chosen in the review screen for this one issue
async function assigneeFor(cfg, override) {
  const mode = override?.mode || cfg.assigneeMode || "me"; // default: assigned to you
  if (mode === "person") return (override ? override.id : cfg.assigneeId) ? { accountId: override ? override.id : cfg.assigneeId } : undefined;
  if (mode === "me") {
    const me = await jiraFetch(cfg, "/rest/api/2/myself");
    return { accountId: me.accountId };
  }
  if (mode === "unassigned") return { accountId: null };
  if (mode === "person" && cfg.assigneeId) return { accountId: cfg.assigneeId };
  return undefined; // let the project's default rule decide
}

async function searchAssignable(cfg, query) {
  const problem = jiraConfigProblem(cfg);
  if (problem) return { ok: false, message: problem };
  try {
    const users = await jiraFetch(cfg,
      `/rest/api/2/user/assignable/search?project=${encodeURIComponent(cfg.projectKey)}&query=${encodeURIComponent(query)}&maxResults=10`);
    return { ok: true, users: users.map((u) => ({ accountId: u.accountId, name: u.displayName, email: u.emailAddress || "" })) };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

async function createJiraIssue(payload) {
  const saved = await jiraConfig();
  const cfg = { ...saved, projectKey: payload.projectKey || saved.projectKey, issueType: payload.issueType || saved.issueType };
  const problem = jiraConfigProblem(cfg);
  if (problem) return { ok: false, needsSettings: true, message: problem };

  const labels = (cfg.labels ?? "qa-buddy").split(/[,\s]+/).filter(Boolean);
  const fields = {
    project: { key: cfg.projectKey },
    issuetype: { name: cfg.issueType || "Bug" },
    summary: payload.summary.replace(/\s+/g, " ").slice(0, 250),
    description: payload.description.length > 32000
      ? payload.description.slice(0, 32000) + "\n\n_(Shortened. See the attached HTML report for everything.)_"
      : payload.description,
    ...(labels.length ? { labels } : {}),
  };

  // Set the assignee at creation, so the project's default assignee isn't notified first
  let assignee;
  try { assignee = await assigneeFor(cfg, payload.assignee); } catch (err) { return { ok: false, message: err.message }; }
  if (assignee !== undefined) fields.assignee = assignee;
  let assignAfter = false;

  let created;
  try {
    created = await jiraFetch(cfg, "/rest/api/2/issue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
  } catch (err) {
    // Some projects don't allow labels or assignee on the create screen: retry without them
    const bad = err.body?.errors || {};
    if (err.status === 400 && (bad.labels || bad.assignee)) {
      if (bad.labels) delete fields.labels;
      if (bad.assignee) {
        // Not on the create screen → assign in a second step.
        // Anything else (e.g. the project requires an assignee) is a real refusal.
        const screenProblem = /screen|cannot be set/i.test(bad.assignee);
        if (!screenProblem) {
          const choice = assignee?.accountId === null ? '"Unassigned"' : "that assignee";
          return { ok: false, message: `Jira rejected ${choice}: ${bad.assignee} Choose another assignee in Settings.` };
        }
        delete fields.assignee;
        assignAfter = true;
      }
      try {
        created = await jiraFetch(cfg, "/rest/api/2/issue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fields }),
        });
      } catch (err2) {
        return { ok: false, message: err2.message };
      }
    } else {
      return { ok: false, message: err.message };
    }
  }

  const key = created.key;
  const url = `${cfg.baseUrl}/browse/${key}`;
  let warning = "";

  // Fallback: assign in a second request when the create screen has no assignee field
  if (assignAfter) {
    try {
      await jiraFetch(cfg, `/rest/api/2/issue/${key}/assignee`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assignee),
      });
    } catch (err) {
      warning = `The issue was created, but assigning it failed: ${err.message}`;
    }
  }

  // Attach the screenshot, the full HTML report and the replay
  try {
    await attachFiles(cfg, key, payload);
  } catch (err) {
    warning = [warning, `The attachments failed: ${err.message}`].filter(Boolean).join(" ");
  }

  return { ok: true, key, url, warning };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "jiraTest" && (msg.from === "options" || msg.from === "popup")) {
    jiraConfig(msg.config).then(testJira).then(sendResponse);
    return true;
  }
  if (msg?.type === "jiraUsers" && (msg.from === "options" || msg.from === "popup")) {
    jiraConfig(msg.config)
      .then((cfg) => searchAssignable(msg.projectKey ? { ...cfg, projectKey: msg.projectKey } : cfg, msg.query))
      .then(sendResponse);
    return true;
  }
  if (msg?.type === "jiraProjects" && msg.from === "popup") {
    listProjects().then(sendResponse);
    return true;
  }
  if (msg?.type === "jiraIssueTypes" && msg.from === "popup") {
    projectIssueTypes(msg.key).then(sendResponse);
    return true;
  }
  if (msg?.type === "jiraLookup" && msg.from === "popup") {
    lookupIssue(msg.text).then(sendResponse);
    return true;
  }
  if (msg?.type === "jiraCreate" && msg.from === "popup") {
    const send = msg.payload.issueKey ? addToJiraIssue(msg.payload) : createJiraIssue(msg.payload);
    send.then(async (result) => {
      if (result.ok) {
        // Reported: start a fresh recording so the next bug doesn't include these events or steps
        await updateState(msg.tabId, (s) => {
          s.lastIssue = { key: result.key, url: result.url, time: Date.now(), added: !!result.added };
          Object.assign(s, { events: [], excluded: [], scope: undefined, mainId: null, steps: [], recordingSince: Date.now() });
        });
        if (!result.added && msg.payload.projectKey) {
          const { recentProjects = [] } = await chrome.storage.local.get("recentProjects");
          await chrome.storage.local.set({ recentProjects: [msg.payload.projectKey, ...recentProjects.filter((k) => k !== msg.payload.projectKey)].slice(0, 5) });
        }
        if (result.added) {
          const { recentIssues = [] } = await chrome.storage.local.get("recentIssues");
          await chrome.storage.local.set({ recentIssues: [result.key, ...recentIssues.filter((k) => k !== result.key)].slice(0, 5) });
        }
        const a = msg.payload.issueKey ? null : msg.payload.assignee;
        if (a?.mode === "person" && a.id) {
          const { recentAssignees = [] } = await chrome.storage.local.get("recentAssignees");
          const next = [{ id: a.id, name: a.name }, ...recentAssignees.filter((p) => p.id !== a.id)].slice(0, 5);
          await chrome.storage.local.set({ recentAssignees: next });
        }
      }
      sendResponse(result);
    });
    return true;
  }
});
