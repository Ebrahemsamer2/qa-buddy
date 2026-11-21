// QA Buddy — settings page
// Jira settings → chrome.storage.local "jira"
// Capture settings → chrome.storage.local "settings.capture"
const JIRA_FIELDS = ["baseUrl", "email", "token", "projectKey", "issueType", "labels"];
const DEFAULTS = { cancelMinSeconds: 3, slowSeconds: 5 };
const $ = (id) => document.getElementById(id);

// ---------- assignee ----------
let assignee = { mode: "me", id: "", name: "" };

function renderAssignee() {
  document.querySelectorAll('input[name="assigneeMode"]').forEach((r) => (r.checked = r.value === assignee.mode));
  $("person").hidden = assignee.mode !== "person";
  $("person-selected").textContent = assignee.id ? `Selected: ${assignee.name}` : "Search and choose a person.";
}

document.querySelectorAll('input[name="assigneeMode"]').forEach((r) =>
  r.addEventListener("change", () => { assignee.mode = r.value; renderAssignee(); }));

async function findPeople() {
  const list = $("people");
  list.replaceChildren();
  const query = $("person-query").value.trim();
  if (!query) return;
  $("person-selected").textContent = "Searching…";
  const result = await chrome.runtime.sendMessage({ from: "options", type: "jiraUsers", config: readJira(), query });
  if (!result.ok) { $("person-selected").textContent = result.message; return; }
  if (!result.users.length) { $("person-selected").textContent = "No one found who can be assigned in this project."; return; }
  $("person-selected").textContent = assignee.id ? `Selected: ${assignee.name}` : "Choose a person:";
  result.users.forEach((u) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = u.email ? `${u.name} (${u.email})` : u.name;
    btn.addEventListener("click", () => {
      assignee = { mode: "person", id: u.accountId, name: u.name };
      list.replaceChildren();
      renderAssignee();
    });
    li.append(btn);
    list.append(li);
  });
}
$("person-find").addEventListener("click", findPeople);
$("person-query").addEventListener("keydown", (e) => { if (e.key === "Enter") findPeople(); });

document.querySelectorAll('input[name="sitesMode"]').forEach((r) =>
  r.addEventListener("change", () => ($("sitesList").disabled = r.value !== "list" || !r.checked)));

// Same rules as the background: host names, optional "*." prefix
function validSite(entry) {
  let s = entry.trim().toLowerCase();
  if (/^[a-z*]+:\/\//.test(s)) { try { s = new URL(s.replace("*://", "http://")).hostname; } catch { return false; } }
  s = s.replace(/\/.*$/, "").replace(/:\d+$/, "");
  return /^(\*\.)?[a-z0-9.-]+$/.test(s) && !s.startsWith(".") && !s.includes("..");
}

async function load() {
  const { jira = {}, settings = {} } = await chrome.storage.local.get(["jira", "settings"]);
  JIRA_FIELDS.forEach((f) => ($(f).value = jira[f] || ""));
  if (!jira.issueType) $("issueType").value = "Bug";
  if (jira.labels === undefined) $("labels").value = "qa-buddy";
  assignee = { mode: jira.assigneeMode || "me", id: jira.assigneeId || "", name: jira.assigneeName || "" };
  renderAssignee();

  $("replayEnabled").checked = settings.replay !== false;
  const sites = settings.sites || { mode: "all", list: [] };
  document.querySelectorAll('input[name="sitesMode"]').forEach((r) => (r.checked = r.value === sites.mode));
  $("sitesList").value = (sites.list || []).join("\n");
  $("sitesList").disabled = sites.mode !== "list";

  const capture = { ...DEFAULTS, ...(settings.capture || {}) };
  $("cancelMinSeconds").value = capture.cancelMinSeconds;
  $("slowSeconds").value = capture.slowSeconds;
}

function number(id, fallback, min) {
  const n = parseFloat($(id).value);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function readJira() {
  const jira = {};
  JIRA_FIELDS.forEach((f) => (jira[f] = $(f).value.trim()));
  jira.baseUrl = jira.baseUrl.replace(/\/+$/, ""); // drop trailing slash
  jira.projectKey = jira.projectKey.toUpperCase();
  jira.assigneeMode = assignee.mode;
  jira.assigneeId = assignee.mode === "person" ? assignee.id : "";
  jira.assigneeName = assignee.mode === "person" ? assignee.name : "";
  return jira;
}

// Tests the values currently in the form, saved or not
$("test").addEventListener("click", async () => {
  const out = $("test-result");
  out.className = "test-result";
  out.textContent = "Testing…";
  $("test").disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ from: "options", type: "jiraTest", config: readJira() });
    out.className = `test-result ${result.ok ? "ok" : "fail"}`;
    out.textContent = result.message;
  } catch {
    out.className = "test-result fail";
    out.textContent = "Couldn't run the test. Reload the extension and try again.";
  } finally {
    $("test").disabled = false;
  }
});

$("save").addEventListener("click", async () => {
  const jira = readJira();
  if (jira.assigneeMode === "person" && !jira.assigneeId) {
    $("saved").textContent = "";
    $("person-selected").textContent = "Choose a person before saving, or pick another assignee option.";
    return;
  }

  const { settings = {} } = await chrome.storage.local.get("settings");
  settings.capture = {
    cancelMinSeconds: number("cancelMinSeconds", DEFAULTS.cancelMinSeconds, 0),
    slowSeconds: number("slowSeconds", DEFAULTS.slowSeconds, 1),
  };
  $("cancelMinSeconds").value = settings.capture.cancelMinSeconds;
  $("slowSeconds").value = settings.capture.slowSeconds;

  settings.replay = $("replayEnabled").checked;
  const mode = document.querySelector('input[name="sitesMode"]:checked')?.value || "all";
  const list = $("sitesList").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const invalid = list.filter((s) => !validSite(s));
  if (mode === "list" && (invalid.length || !list.length)) {
    $("sites-hint").className = "hint error";
    $("sites-hint").textContent = invalid.length ? `Not a valid site: ${invalid.join(", ")}` : "Add at least one site, or choose All sites.";
    $("saved").textContent = "";
    return;
  }
  $("sites-hint").className = "hint";
  settings.sites = { mode, list };
  await chrome.storage.local.set({ jira, settings });
  chrome.storage.local.remove("ai"); // clean up keys saved by earlier versions
  $("saved").textContent = "Settings saved";
  setTimeout(() => ($("saved").textContent = ""), 2500);
});

load();
