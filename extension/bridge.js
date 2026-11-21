// QA Buddy — isolated content script.
// Forwards events from injected.js (page world) to the background worker,
// and passes capture settings from the settings page to injected.js.
function hello() {
  window.postMessage({ source: "qa-buddy-bridge", type: "hello" }, "*");
}

async function sendConfig() {
  try {
    const { settings = {} } = await chrome.storage.local.get("settings");
    window.postMessage({ source: "qa-buddy-bridge", type: "config", data: settings.capture || {} }, "*");
  } catch {} // extension reloaded
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "qa-buddy") return;

  if (msg.type === "ping") {
    hello();
    sendConfig();
    return;
  }

  try {
    chrome.runtime.sendMessage({ from: "bridge", type: msg.type, data: msg.data }).catch(() => {});
  } catch {
    // Extension was reloaded; this old content script can no longer talk to it.
  }
});

// Settings changed while the page is open → apply immediately
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) sendConfig();
  });
} catch {}

hello(); // in case injected.js loaded first
sendConfig();
