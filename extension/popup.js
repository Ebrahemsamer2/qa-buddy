// QA Buddy — popup

// The report data collected so far. Step 3 builds the download from this.
window.qaReport = {
  tab: null,
  screenshot: null,
  env: null,
  state: null,           // { events, excluded, recordingSince, url, ready }
  hideThirdParty: true,
  // Events that go into the report: not unchecked, not hidden as other-site noise
  includedEvents() {
    const s = this.state;
    if (!s) return [];
    const excluded = new Set(s.excluded);
    const list = s.events.filter((e) => !excluded.has(e.id) && !(this.hideThirdParty && isThirdParty(e, s.url)));
    const main = list.find((e) => e.id === s.mainId);
    return main ? [main, ...list.filter((e) => e !== main)] : list;
  },
};

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);

$("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
const isErrorEvent = (e) => e.type !== "network";
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch { return url; }
}

// "app.example.com" and "api.example.com" count as the same site
function baseDomain(host) {
  if (!host || host === "localhost" || /^[\d.]+$/.test(host) || host.includes(":")) return host;
  return host.split(".").slice(-2).join(".");
}

function eventUrl(e) {
  if (e.type === "network") return e.url;
  if (e.source) return e.source;
  const m = (e.stack || "").match(/https?:\/\/[^\s):]+/);
  return m ? m[0] : null; // no URL → treat as the page's own
}

function sameSite(a, b) {
  try { return baseDomain(new URL(a).hostname) === baseDomain(new URL(b).hostname); } catch { return false; }
}

// An event belongs to this page if it matches the page's site, or the site of
// the embedded frame (iframe) it came from.
function isThirdParty(e, pageUrl) {
  const url = eventUrl(e);
  if (!url || !pageUrl) return false;
  if (sameSite(url, pageUrl)) return false;
  if (e.frame && sameSite(url, e.frame)) return false;
  return true;
}

function frameName(e) {
  if (!e.frame) return "";
  try { return new URL(e.frame).pathname.split("/").pop() || e.frame; } catch { return e.frame; }
}

const KIND_LABEL = { cancelled: "Cancelled", timeout: "Timeout", slow: "Slow" };
const networkLabel = (e) => KIND_LABEL[e.kind] || e.status || "ERR";

// When a request started (it's recorded when it ends), or when an error happened
const startOf = (e) => (e.lastTime || e.time) - (e.type === "network" ? e.duration || 0 : 0);
const ACTION_GRACE_MS = 300; // the action's own request can start a moment before the click is recorded
const afterAction = (e, action) => !!action && startOf(e) >= action.time - ACTION_GRACE_MS;

function visibleEvents(state) {
  return state.events.filter((e) => !(qaReport.hideThirdParty && isThirdParty(e, state.url)));
}

function setScope(scope) {
  const state = qaReport.state;
  if (!state) return;
  const visible = visibleEvents(state);
  let excluded = [];
  if (scope === "none") excluded = visible.map((e) => e.id);
  if (scope === "lastAction") excluded = visible.filter((e) => !afterAction(e, state.lastAction)).map((e) => e.id);
  return chrome.runtime.sendMessage({ from: "popup", type: "setSelection", tabId: qaReport.tab.id, excluded, scope });
}

function onlyThis(id) {
  const excluded = visibleEvents(qaReport.state).map((e) => e.id).filter((x) => x !== id);
  chrome.runtime.sendMessage({ from: "popup", type: "setSelection", tabId: qaReport.tab.id, excluded, scope: "custom", mainId: id });
}

const setMain = (id) => chrome.runtime.sendMessage({ from: "popup", type: "setMain", tabId: qaReport.tab.id, id });

function describe(event) {
  if (event.type === "network") {
    return {
      tag: `${networkLabel(event)} ${event.method || ""}`.trim(),
      message: shortUrl(event.url),
      where: [event.statusText, event.variants > 1 ? `${event.variants} different URLs, latest shown` : ""].filter(Boolean).join(". "),
    };
  }
  const labels = { console: "Console", error: "Crash", promise: "Promise" };
  let where = "";
  if (event.source) where = `${shortUrl(event.source)}:${event.line}`;
  else if (event.stack) where = (event.stack.split("\n")[1] || "").trim();
  return { tag: labels[event.type] || event.type, message: event.message, where };
}

// ---------- rendering ----------
function render() {
  const state = qaReport.state;

  // Status
  const status = $("status");
  if (qaReport.siteAllowed === false) {
    status.textContent = "Off on this site";
    status.className = "status off";
    status.title = "This site isn't in Settings → Sites to capture";
  } else if (state?.ready) {
    status.textContent = "Capture on";
    status.className = "status on";
  } else {
    status.textContent = "Reload the page to start";
    status.className = "status off";
  }
  if (!state) return;
  renderIssue();
  renderSteps();
  renderReview();

  $("recording").textContent = `Recording since ${time(state.recordingSince)}`;
  $("report-title").placeholder = QAReport.suggestTitle(qaReport.includedEvents(), qaReport.env);

  // Split visible vs hidden (other-site noise)
  const hidden = qaReport.hideThirdParty ? state.events.filter((e) => isThirdParty(e, state.url)) : [];
  const visible = state.events.filter((e) => !hidden.includes(e));
  const excluded = new Set(state.excluded);

  // Counts reflect what will be in the report
  const included = qaReport.includedEvents();
  $("count-errors").textContent = included.filter(isErrorEvent).length;
  $("count-network").textContent = included.filter((e) => !isErrorEvent(e)).length;

  // Last action and scope buttons
  const action = state.lastAction;
  $("scope").hidden = state.events.length === 0;
  $("last-action").replaceChildren();
  if (action) {
    $("last-action").append("Your last action: ", el("strong", null, action.label), ` at ${time(action.time)}`);
  } else {
    $("last-action").textContent = "No action on the page recorded yet.";
  }
  $("scope-last").disabled = !action;
  document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.scope === state.scope)));

  // List, newest first, with a divider at the last action
  const list = $("events");
  list.replaceChildren();
  let dividerShown = false;
  [...visible]
    .sort((a, b) => startOf(b) - startOf(a))
    .forEach((event) => {
      const before = action && !afterAction(event, action);
      if (before && !dividerShown) {
        list.append(el("li", "divider", `Before your last action`));
        dividerShown = true;
      }
      const d = describe(event);
      const isIncluded = !excluded.has(event.id);

      const isMain = event.id === state.mainId;
      const li = el("li", [isIncluded ? "" : "excluded", before ? "before" : "", isMain ? "main" : ""].join(" ").trim());
      const box = el("input");
      box.type = "checkbox";
      box.checked = isIncluded;
      box.setAttribute("aria-label", `Include in report: ${d.tag} ${d.message}`);
      box.addEventListener("change", () =>
        chrome.runtime.sendMessage({ from: "popup", type: "toggleEvent", tabId: qaReport.tab.id, id: event.id, include: box.checked }));

      const body = el("div", "event-body");
      const top = el("div", "event-top");
      const star = el("button", "star", isMain ? "★" : "☆");
      star.setAttribute("aria-pressed", String(isMain));
      star.setAttribute("aria-label", isMain ? "Main problem. Click to unmark" : "Mark as the main problem");
      star.title = isMain ? "Main problem (click to unmark)" : "Mark as the main problem";
      star.addEventListener("click", () => setMain(event.id));
      top.append(star, el("span", `tag${event.type === "network" ? " network" : ""}`, d.tag));
      if (isMain) top.append(el("span", "main-label", "Main"));
      if (event.count > 1) top.append(el("span", "repeat", `×${event.count}`));
      const only = el("button", "link only", "Only this");
      only.addEventListener("click", () => onlyThis(event.id));
      top.append(only, el("span", "event-time", time(event.lastTime || event.time)));
      body.append(top, el("div", "event-msg", d.message));
      if (d.where) body.append(el("div", "event-where", d.where));
      if (event.frame) body.append(el("div", "event-where", `In embedded frame: ${frameName(event)}`));
      body.title = event.stack || event.message || event.url || "";

      li.append(box, body);
      list.append(li);
    });

  // Other-site note
  const otherSite = state.events.filter((e) => isThirdParty(e, state.url)).length;
  $("hidden-note").hidden = otherSite === 0;
  if (otherSite) {
    $("hidden-text").textContent = qaReport.hideThirdParty
      ? `${otherSite} from other sites hidden.`
      : `Showing ${otherSite} from other sites.`;
    $("btn-third-party").textContent = qaReport.hideThirdParty ? "Show them" : "Hide them";
  }
}

function renderEnv(env) {
  const dl = $("env");
  dl.replaceChildren();
  const rows = [
    ["Page", env.title], ["URL", env.url], ["Browser", env.browser], ["OS", env.os],
    ["Screen", env.screen], ["Window", env.viewport], ["Language", env.language],
    ["Time zone", env.timezone], ["Captured", new Date(env.time).toLocaleString()],
  ];
  rows.forEach(([k, v]) => dl.append(el("dt", null, k), el("dd", null, v || "—")));
}

// ---------- data collection ----------
// The screenshot is kept per tab in session storage, so an edited one survives the popup closing
const shotKey = () => `shot:${qaReport.tab.id}`;

async function loadScreenshot() {
  const stored = (await chrome.storage.session.get(shotKey()))[shotKey()];
  if (stored?.edited && stored.dataUrl) {
    qaReport.screenshot = stored.dataUrl;
    $("shot-img").src = stored.dataUrl;
    $("shot-status").textContent = `Edited screenshot from ${time(stored.time)}`;
    return;
  }
  await captureScreenshot();
}

async function captureScreenshot() {
  const status = $("shot-status");
  status.textContent = "Taking screenshot…";
  chrome.storage.session.remove(shotKey());
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(qaReport.tab.windowId, { format: "png" });
    qaReport.screenshot = dataUrl;
    $("shot-img").src = dataUrl;
    status.textContent = `Screenshot taken at ${time(Date.now())}`;
  } catch (err) {
    status.textContent = "Couldn't take a screenshot of this page";
    console.warn(err);
  }
}

async function collectEnvironment() {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: qaReport.tab.id },
    func: () => ({
      url: location.href,
      title: document.title,
      userAgent: navigator.userAgent,
      platform: navigator.userAgentData?.platform || navigator.platform,
      language: navigator.language,
      screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`,
      viewport: `${innerWidth}×${innerHeight}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      time: new Date().toISOString(),
    }),
  });
  const m = result.userAgent.match(/(Edg|OPR|Chrome|Firefox)\/([\d.]+)/);
  const names = { Edg: "Edge", OPR: "Opera" };
  result.browser = m ? `${names[m[1]] || m[1]} ${m[2]}` : result.userAgent;
  result.os = result.platform;
  qaReport.env = result;
  renderEnv(result);
  render(); // refresh the suggested title with the page name
}

async function loadState() {
  const key = `tab:${qaReport.tab.id}`;
  await chrome.runtime.sendMessage({ from: "popup", type: "flush", tabId: qaReport.tab.id }).catch(() => {});
  const [stored, { settings = {} }] = await Promise.all([
    chrome.storage.session.get(key),
    chrome.storage.local.get("settings"),
  ]);
  qaReport.state = stored[key] || null;
  qaReport.hideThirdParty = settings.hideThirdParty !== false; // on by default

  // First time the popup opens for this recording: focus on what happened after the last action
  const s = qaReport.state;
  if (s && !s.scope && s.lastAction && visibleEvents(s).some((e) => afterAction(e, s.lastAction))) {
    await setScope("lastAction");
    const fresh = await chrome.storage.session.get(key);
    qaReport.state = fresh[key] || qaReport.state;
  }
  render();



  // Live updates while the popup is open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[key]) {
      qaReport.state = changes[key].newValue || null;
      render();
    }
  });
}

// ---------- buttons ----------
$("btn-retake").addEventListener("click", captureScreenshot);
$("btn-edit-shot").addEventListener("click", async () => {
  if (!qaReport.screenshot) return;
  const current = (await chrome.storage.session.get(shotKey()))[shotKey()];
  if (!current?.edited) await chrome.storage.session.set({ [shotKey()]: { dataUrl: qaReport.screenshot, edited: false, time: Date.now() } });
  chrome.tabs.create({ url: `editor.html?tab=${qaReport.tab.id}` });
});
document.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => setScope(c.dataset.scope)));

$("btn-fresh").addEventListener("click", () =>
  chrome.runtime.sendMessage({ from: "popup", type: "startFresh", tabId: qaReport.tab.id }));

$("btn-third-party").addEventListener("click", async () => {
  qaReport.hideThirdParty = !qaReport.hideThirdParty;
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, hideThirdParty: qaReport.hideThirdParty } });
  render();
});

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------- report: build, download, copy ----------
function currentReport(overrides = {}) {
  return QAReport.build({
    title: $("report-title").value,
    description: $("report-desc").value,
    mainId: qaReport.state?.mainId,
    steps: (qaReport.state?.steps || []).map(({ label, time }) => ({ label, time })),
    events: qaReport.includedEvents(),
    env: qaReport.env,
    screenshot: qaReport.screenshot,
    recordingSince: qaReport.state?.recordingSince,
    lastAction: qaReport.state?.scope === "lastAction" ? qaReport.state.lastAction : null,
    ...overrides,
  });
}

function feedback(text, isError = false) {
  const f = $("feedback");
  f.textContent = text;
  f.className = `feedback${isError ? " error" : ""}`;
  clearTimeout(feedback.timer);
  feedback.timer = setTimeout(() => (f.textContent = ""), isError ? 12000 : 5000);
}

$("btn-download").addEventListener("click", () => {
  try {
    const report = currentReport();
    const blob = new Blob([QAReport.toHtml(report)], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = QAReport.fileName(report);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    feedback(`Downloaded ${a.download}`);
  } catch (err) {
    console.error(err);
    feedback("Couldn't create the report. Open the popup again and retry.", true);
  }
});

$("btn-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(QAReport.toText(currentReport()));
    feedback("Report copied as text");
  } catch {
    feedback("Couldn't copy to the clipboard", true);
  }
});

// ---------- Session replay ----------
async function loadReplay() {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: qaReport.tab.id, frameIds: [0] },
      injectImmediately: true,
      func: () => window.__qaReplay?.get() || null,
    });
    qaReport.replay = res?.result || null;
  } catch {
    qaReport.replay = null;
  }
  const { settings = {} } = await chrome.storage.local.get("settings");
  renderReplay(settings.replay === false);
}

const replaySeconds = () => qaReport.replay ? Math.max(1, Math.round((qaReport.replay.end - qaReport.replay.start) / 1000)) : 0;

function renderReplay(off = false) {
  const r = qaReport.replay;
  $("replay-text").textContent = r
    ? `Session replay: last ${replaySeconds()} seconds recorded`
    : off ? "Session replay is off (turn it on in Settings)" : "Session replay: nothing recorded yet. Reload the page to start.";
  $("btn-replay").hidden = !r;
}

async function replayHtml() {
  return QAReplay.buildReplayHtml(qaReport.replay, {
    title: $("report-title").value.trim() || $("report-title").placeholder || "Bug report",
    steps: qaReport.state?.steps || [],
  });
}

$("btn-replay").addEventListener("click", async () => {
  try {
    const html = await replayHtml();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    a.download = QAReport.fileName(currentReport()).replace(/^qa-report-/, "qa-replay-");
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    feedback(`Downloaded ${a.download}`);
  } catch (err) {
    console.error(err);
    feedback("Couldn't build the replay file.", true);
  }
});

// ---------- Steps to reproduce ----------
function renderSteps() {
  const steps = qaReport.state?.steps || [];
  $("steps-box").hidden = !steps.length;
  $("steps-title").textContent = `Steps to reproduce (${steps.length})`;
  const list = $("steps-list");
  list.replaceChildren();
  steps.forEach((s) => {
    const li = el("li", s.kind === "fill" ? "fill" : "");
    const row = el("div", "step-row");
    const remove = el("button", "remove", "×");
    remove.setAttribute("aria-label", `Remove step: ${s.label}`);
    remove.addEventListener("click", () =>
      chrome.runtime.sendMessage({ from: "popup", type: "removeStep", tabId: qaReport.tab.id, id: s.id }));
    row.append(el("span", null, s.label), el("time", null, time(s.time)), remove);
    li.append(row);
    list.append(li);
  });
  list.scrollTop = list.scrollHeight; // newest at the bottom
}

$("btn-clear-steps").addEventListener("click", () =>
  chrome.runtime.sendMessage({ from: "popup", type: "clearSteps", tabId: qaReport.tab.id }));

// ---------- Jira ----------
function renderIssue() {
  const issue = qaReport.state?.lastIssue;
  $("issue").hidden = !issue;
  if (!issue) return;
  $("issue-text").textContent = `${issue.added ? "Added to" : "Created"} ${issue.key} at ${time(issue.time)}`;
  $("btn-jira").textContent = "Create another Jira issue";
}

$("issue-open").addEventListener("click", () => {
  const issue = qaReport.state?.lastIssue;
  if (issue) chrome.tabs.create({ url: issue.url });
});

// ---------- Review before sending to Jira ----------
const review = { open: false, details: {}, assignee: null, dest: "new", issue: null, jira: null, projectsLoaded: false }; // details[id] = { req, res }; assignee = { mode, id, name }

async function jiraSettings() {
  const { jira = {} } = await chrome.storage.local.get("jira");
  return jira;
}

function reviewFeedback(text, isError = false) {
  $("review-feedback").textContent = text;
  $("review-feedback").className = `feedback${isError ? " error" : ""}`;
}

function detailFor(e) {
  if (!review.details[e.id]) review.details[e.id] = { req: true, res: true };
  return review.details[e.id];
}

function reviewItem(e, isMain) {
  const d = describe(e);
  const li = el(isMain ? "div" : "li", `rv${isMain ? " main" : ""}`);
  const top = el("div", "rv-top");
  top.append(el("span", `tag${e.type === "network" ? " network" : ""}`, d.tag));
  if (e.count > 1) top.append(el("span", "repeat", `×${e.count}`));
  const remove = el("button", "link", "Remove");
  remove.setAttribute("aria-label", `Remove ${d.tag} ${d.message} from the issue`);
  remove.addEventListener("click", () =>
    chrome.runtime.sendMessage({ from: "popup", type: "toggleEvent", tabId: qaReport.tab.id, id: e.id, include: false }));
  top.append(remove);
  li.append(top, el("div", "rv-msg", e.type === "network" ? e.url : d.message));

  if (e.type === "network" && (e.requestBody || e.responseBody)) {
    const opts = el("div", "rv-opts");
    const detail = detailFor(e);
    [["req", "requestBody", "Request body"], ["res", "responseBody", "Response body"]].forEach(([k, field, text]) => {
      if (!e[field]) return;
      const label = el("label");
      const box = el("input");
      box.type = "checkbox";
      box.checked = detail[k];
      box.addEventListener("change", () => (detail[k] = box.checked));
      label.append(box, text);
      opts.append(label);
    });
    li.append(opts);
  }
  return li;
}

function renderReview() {
  if (!review.open) return;
  const events = qaReport.includedEvents();
  const main = events.find((e) => e.id === qaReport.state?.mainId);
  const rest = events.filter((e) => e !== main);

  $("review-main").replaceChildren(main
    ? reviewItem(main, true)
    : el("p", "empty-note", "None marked. Use the ☆ next to an event in the list to mark the one that caused the bug."));
  $("review-related-h").textContent = main ? "Also included" : "Included";
  const list = $("review-items");
  list.replaceChildren(...rest.map((e) => reviewItem(e, false)));
  if (!rest.length) list.append(el("li", "empty-note", main ? "Nothing else." : "No errors or request problems selected."));

  $("opt-replay-row").hidden = !qaReport.replay;
  $("opt-replay-text").textContent = `Session replay (last ${replaySeconds()} seconds)`;
  const stepCount = qaReport.state?.steps?.length || 0;
  $("opt-steps-row").hidden = !stepCount;
  $("opt-steps-text").textContent = `Recorded steps (${stepCount})`;
  $("review-send-hint").textContent = `${plural(events.length, "event")} will be sent`;
}

// ---------- assignee for this issue ----------
const OTHER = "__other";

function optionValue(a) {
  return a.mode === "person" ? `person:${a.id}` : a.mode;
}

async function fillAssigneeOptions(jira) {
  const { recentAssignees = [] } = await chrome.storage.local.get("recentAssignees");
  const select = $("review-assignee");
  select.replaceChildren();
  const add = (value, text) => { const o = el("option", null, text); o.value = value; select.append(o); return o; };

  const people = [...recentAssignees];
  if (jira.assigneeMode === "person" && jira.assigneeId && !people.some((p) => p.id === jira.assigneeId)) {
    people.unshift({ id: jira.assigneeId, name: jira.assigneeName || "Default person" });
  }
  if (review.assignee?.mode === "person" && !people.some((p) => p.id === review.assignee.id)) {
    people.unshift({ id: review.assignee.id, name: review.assignee.name });
  }

  add("default", "Project default (Jira's rule)");
  add("me", "Me");
  add("unassigned", "Unassigned");
  if (people.length) {
    const group = el("optgroup");
    group.label = "Recent";
    people.forEach((p) => { const o = el("option", null, p.name); o.value = `person:${p.id}`; o.dataset.name = p.name; group.append(o); });
    select.append(group);
  }
  add(OTHER, "Someone else…");

  // Mark the default from Settings
  const def = { mode: jira.assigneeMode || "me", id: jira.assigneeId, name: jira.assigneeName };
  const defOption = [...select.options].find((o) => o.value === optionValue(def));
  if (defOption) defOption.textContent += " (default)";

  select.value = optionValue(review.assignee || def);
  if (select.selectedIndex < 0) select.value = "default";
  onAssigneeChange();
}

function onAssigneeChange() {
  const select = $("review-assignee");
  const value = select.value;
  $("review-person").hidden = value !== OTHER;
  if (value === OTHER) {
    $("review-person-note").textContent = "Search for the person to assign.";
    $("review-person-query").focus();
    return;
  }
  if (value.startsWith("person:")) {
    review.assignee = { mode: "person", id: value.slice(7), name: select.selectedOptions[0].dataset.name || select.selectedOptions[0].textContent };
  } else {
    review.assignee = { mode: value };
  }
}

async function findReviewPeople() {
  const query = $("review-person-query").value.trim();
  const list = $("review-people");
  list.replaceChildren();
  if (!query) return;
  $("review-person-note").textContent = "Searching…";
  const result = await chrome.runtime.sendMessage({ from: "popup", type: "jiraUsers", query, projectKey: $("review-project").value || undefined });
  if (!result?.ok) { $("review-person-note").textContent = result?.message || "Search failed."; return; }
  if (!result.users.length) { $("review-person-note").textContent = "No one found who can be assigned in this project."; return; }
  $("review-person-note").textContent = "Choose a person:";
  result.users.forEach((u) => {
    const li = el("li");
    const btn = el("button", null, u.email ? `${u.name} (${u.email})` : u.name);
    btn.type = "button";
    btn.addEventListener("click", async () => {
      review.assignee = { mode: "person", id: u.accountId, name: u.name };
      list.replaceChildren();
      await fillAssigneeOptions(await jiraSettings());
    });
    li.append(btn);
    list.append(li);
  });
}

$("review-assignee").addEventListener("change", onAssigneeChange);
$("review-person-find").addEventListener("click", findReviewPeople);
$("review-person-query").addEventListener("keydown", (e) => { if (e.key === "Enter") findReviewPeople(); });

// ---------- new issue or existing issue ----------
function setDest(dest) {
  review.dest = dest;
  document.querySelectorAll('input[name="dest"]').forEach((r) => (r.checked = r.value === dest));
  const existing = dest === "existing";
  $("existing-box").hidden = !existing;
  $("assignee-box").hidden = existing;
  $("project-box").hidden = existing;
  $("summary-label").textContent = existing ? "Comment heading" : "Summary";
  $("review-dest").textContent = existing ? "Adds the report as a comment, with the attachments, to the issue below." : "";
  $("review-send").firstChild.textContent = existing
    ? (review.issue ? `Add to ${review.issue.key}` : "Add to issue")
    : "Create Jira issue";
  if (existing && !review.issue) $("issue-key").focus();
}

async function checkIssue() {
  const text = $("issue-key").value.trim();
  const info = $("issue-info");
  review.issue = null;
  setDest("existing");
  if (!text) { info.className = "empty-note"; info.textContent = ""; return null; }
  info.className = "empty-note";
  info.textContent = "Looking up the issue…";
  const result = await chrome.runtime.sendMessage({ from: "popup", type: "jiraLookup", text });
  if (!result?.ok) {
    info.className = "empty-note error";
    info.textContent = result?.message || "Couldn't find that issue.";
    return null;
  }
  review.issue = result;
  info.className = "empty-note found";
  info.replaceChildren(el("strong", null, result.key), `: ${result.summary}${result.status ? ` (${result.status})` : ""}`);
  setDest("existing");
  return result;
}

// ---------- project and issue type for a new issue ----------
async function loadIssueTypes(key) {
  const select = $("review-type");
  select.replaceChildren(el("option", null, "Loading…"));
  if (!key) { select.replaceChildren(); return; }
  const result = await chrome.runtime.sendMessage({ from: "popup", type: "jiraIssueTypes", key });
  const types = result?.ok && result.types.length ? result.types : [review.jira?.issueType || "Bug"];
  select.replaceChildren(...types.map((t) => { const o = el("option", null, t); o.value = t; return o; }));
  const wanted = [review.jira?.issueType, "Bug", "Task"].find((t) => t && types.some((x) => x.toLowerCase() === t.toLowerCase()));
  if (wanted) select.value = types.find((x) => x.toLowerCase() === wanted.toLowerCase());
}

async function loadProjects() {
  const select = $("review-project");
  const result = await chrome.runtime.sendMessage({ from: "popup", type: "jiraProjects" });
  if (!result?.ok) {
    select.replaceChildren(el("option", null, "Couldn't load projects"));
    reviewFeedback(result?.message || "Couldn't load your Jira projects.", true);
    return;
  }
  const { recentProjects = [] } = await chrome.storage.local.get("recentProjects");
  const byKey = new Map(result.projects.map((p) => [p.key, p]));
  const option = (p) => { const o = el("option", null, `${p.name} (${p.key})`); o.value = p.key; return o; };
  select.replaceChildren();
  const def = review.jira?.projectKey && byKey.get(review.jira.projectKey);
  const recent = recentProjects.map((k) => byKey.get(k)).filter((p) => p && p !== def);
  if (!def) {
    const choose = el("option", null, "Choose a project…");
    choose.value = "";
    select.append(choose);
  }
  if (def || recent.length) {
    const group = el("optgroup");
    group.label = "Default and recent";
    if (def) { const o = option(def); o.textContent += " (default)"; group.append(o); }
    recent.forEach((p) => group.append(option(p)));
    select.append(group);
  }
  const all = el("optgroup");
  all.label = "All projects";
  result.projects.forEach((p) => all.append(option(p)));
  select.append(all);
  select.value = def ? def.key : recent[0]?.key || ""; // default, else the most recent project
  review.projectsLoaded = true;
  await loadIssueTypes(select.value);
}

$("review-project").addEventListener("change", () => loadIssueTypes($("review-project").value));

document.querySelectorAll('input[name="dest"]').forEach((r) => r.addEventListener("change", () => setDest(r.value)));
$("issue-check").addEventListener("click", checkIssue);
$("issue-key").addEventListener("keydown", (e) => { if (e.key === "Enter") checkIssue(); });
$("issue-key").addEventListener("change", checkIssue); // pasting a link and leaving the field checks it
$("issue-key").addEventListener("input", () => {
  if (review.issue) { review.issue = null; $("issue-info").textContent = ""; setDest("existing"); }
});

async function openReview() {
  const jira = await jiraSettings();
  const missing = ["baseUrl", "email", "token"].filter((k) => !jira[k]);
  if (missing.length) {
    feedback("Add your Jira details in Settings first.", true);
    setTimeout(() => chrome.runtime.openOptionsPage(), 1200);
    return;
  }
  review.jira = jira;
  review.issue = null;
  $("issue-key").value = "";
  $("issue-info").textContent = "";
  const { recentIssues = [] } = await chrome.storage.local.get("recentIssues");
  $("recent-issues").replaceChildren(...recentIssues.map((k) => { const o = el("option"); o.value = k; return o; }));
  setDest("new");
  if (!review.projectsLoaded) loadProjects();
  else { loadProjects(); } // refresh so recent projects are up to date
  review.assignee = null; // start from the default each time
  await fillAssigneeOptions(jira);
  $("review-summary").value = $("report-title").value.trim() || currentReport().title;
  reviewFeedback("");
  review.open = true;
  $("panel-bug").hidden = true;
  $("review").hidden = false;
  renderReview();
  $("review-summary").focus();
}

function closeReview() {
  review.open = false;
  $("review").hidden = true;
  $("panel-bug").hidden = false;
}

$("btn-jira").addEventListener("click", openReview);
$("review-back").addEventListener("click", closeReview);
$("review-summary").addEventListener("input", () => ($("report-title").value = $("review-summary").value));

$("review-send").addEventListener("click", async () => {
  if (review.dest === "existing" && !review.issue && !(await checkIssue())) {
    reviewFeedback("Enter an existing issue key or link first, for example PROJ-123.", true);
    return;
  }
  if (review.dest === "new" && !$("review-project").value) {
    reviewFeedback("Choose a project for the new issue.", true);
    $("review-project").focus();
    return;
  }
  if (review.dest === "new" && $("review-assignee").value === OTHER) {
    reviewFeedback("Choose a person to assign, or pick another assignee option.", true);
    return;
  }
  const btn = $("review-send");
  btn.disabled = true;
  reviewFeedback("Sending to Jira…");
  try {
    // Apply the per-request choices to copies of the events
    const events = qaReport.includedEvents().map((e) => {
      const copy = { ...e };
      if (e.type === "network") {
        const d = detailFor(e);
        if (!d.req) delete copy.requestBody;
        if (!d.res) delete copy.responseBody;
      }
      return copy;
    });
    const attach = { screenshot: $("opt-shot").checked, html: $("opt-html").checked, replay: !!qaReport.replay && $("opt-replay").checked };
    const report = currentReport({
      title: $("review-summary").value,
      events,
      ...($("opt-steps").checked ? {} : { steps: null }),
    });
    if (!attach.screenshot) report.screenshot = null;

    const result = await chrome.runtime.sendMessage({
      from: "popup",
      type: "jiraCreate",
      tabId: qaReport.tab.id,
      payload: {
        summary: report.title,
        description: QAReport.toJira(report, attach),
        screenshot: report.screenshot,
        html: attach.html ? QAReport.toHtml(report) : "",
        fileName: QAReport.fileName(report),
        replayHtml: qaReport.replay && $("opt-replay").checked ? await replayHtml() : "",
        assignee: review.dest === "new" ? review.assignee : null,
        issueKey: review.dest === "existing" ? review.issue.key : null,
        projectKey: review.dest === "new" ? $("review-project").value : null,
        issueType: review.dest === "new" ? $("review-type").value : null,
      },
    });

    if (result?.ok) {
      closeReview();
      feedback(result.warning || `${result.added ? `Added to ${result.key}` : `${result.key} created`}. Recording started fresh for the next bug.`, !!result.warning);
      $("report-title").value = "";
      $("report-desc").value = "";
      renderIssue();
    } else {
      reviewFeedback(result?.message || "Couldn't create the issue.", true);
      if (result?.needsSettings) setTimeout(() => chrome.runtime.openOptionsPage(), 1200);
    }
  } catch (err) {
    console.error(err);
    reviewFeedback("Couldn't create the issue. Reload the extension and try again.", true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- first-run tip ----------
chrome.storage.local.get("seenIntro").then(({ seenIntro }) => { $("intro-tip").hidden = !!seenIntro; });
$("intro-close").addEventListener("click", () => {
  $("intro-tip").hidden = true;
  chrome.storage.local.set({ seenIntro: true });
});

// ---------- start ----------
(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  qaReport.tab = tab;

  if (!tab || !/^https?:/.test(tab.url || "")) {
    $("status").textContent = "Not available on this page";
    $("status").className = "status off";
    $("shot-status").textContent = "Open a website to capture it";
    ["btn-download", "btn-copy", "btn-edit-shot", "btn-retake"].forEach((id) => ($(id).disabled = true));
    $("replay-text").textContent = "Session replay: not available on this page";
    return;
  }

  const { allowed } = await chrome.runtime.sendMessage({ from: "popup", type: "isAllowed", url: tab.url }).catch(() => ({ allowed: true }));
  qaReport.siteAllowed = allowed;
  if (!allowed) feedback("QA Buddy is off on this site. Add it in Settings → Sites to capture, then reload the page.", true);

  // Screenshot first, so it shows the page exactly as it was when the popup opened
  // (unless the tester already edited one for this tab)
  await loadScreenshot();
  await Promise.all([loadState(), collectEnvironment().catch((e) => console.warn(e)), loadReplay()]);
})();
