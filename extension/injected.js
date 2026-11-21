// QA Buddy — runs in the page's own JavaScript world (MAIN) at document_start.
// Captures console errors, uncaught errors, unhandled promise rejections and
// failed fetch / XMLHttpRequest calls, then hands them to bridge.js.
(() => {
  if (window.__qaBuddyInjected) return;
  window.__qaBuddyInjected = true;

  // Inside an iframe? Remember its address so reports show where it came from.
  let FRAME = null;
  try { if (window.top !== window) FRAME = location.href; } catch { FRAME = location.href; }

  // ---------- messaging (queue until bridge.js is listening) ----------
  const queue = [];
  let connected = false;
  const post = (msg) => window.postMessage({ source: "qa-buddy", ...msg }, "*");

  function send(type, data = {}) {
    const msg = { type, data: { ...data, time: Date.now(), ...(FRAME ? { frame: FRAME } : {}) } };
    if (connected) post(msg);
    else queue.push(msg);
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.source !== "qa-buddy-bridge") return;
    if (e.data.type === "hello" && !connected) {
      connected = true;
      queue.splice(0).forEach(post);
    }
    if (e.data.type === "config") {
      const c = e.data.data || {};
      if (Number.isFinite(c.cancelMinSeconds) && c.cancelMinSeconds >= 0) CANCEL_MIN_MS = c.cancelMinSeconds * 1000;
      if (Number.isFinite(c.slowSeconds) && c.slowSeconds > 0) SLOW_MS = c.slowSeconds * 1000;
    }
  });
  post({ type: "ping" }); // in case bridge.js loaded first

  // ---------- thresholds ----------
  // Cancelled requests are normal when quick (e.g. a search box cancelling the
  // previous search), so only report cancellations after this long:
  // Both are adjustable in the settings page (sent here by bridge.js).
  let CANCEL_MIN_MS = 3000;
  // Successful requests slower than this are reported as "Slow":
  let SLOW_MS = 5000;
  const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

  // ---------- helpers: truncate, serialize, mask sensitive data ----------
  const SENSITIVE = /pass(word)?|pwd|secret|token|auth|api[-_]?key|session|cookie|credit|card|cvv|ssn/i;
  const MASK = "***";

  const truncate = (s, max = 2000) =>
    typeof s === "string" && s.length > max ? s.slice(0, max) + "… (truncated)" : s;

  function serialize(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try { return JSON.stringify(maskValue(value)); } catch { return String(value); }
  }

  function maskValue(value) {
    if (Array.isArray(value)) return value.map(maskValue);
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = SENSITIVE.test(k) ? MASK : maskValue(v);
      return out;
    }
    return value;
  }

  function maskParams(params) {
    const out = new URLSearchParams();
    for (const [k, v] of params) out.append(k, SENSITIVE.test(k) ? MASK : v);
    return out;
  }

  function maskUrl(url) {
    try {
      const u = new URL(url, location.href);
      u.search = maskParams(u.searchParams).toString();
      return truncate(u.toString(), 500);
    } catch {
      return truncate(String(url), 500);
    }
  }

  function maskBody(body, max = 2000) {
    if (body == null || body === "") return undefined;
    try {
      if (typeof body === "string") {
        try { return truncate(JSON.stringify(maskValue(JSON.parse(body))), max); } catch {}
        if (/^[^\s=&]+=[^&]*(&[^\s=&]+=[^&]*)*$/.test(body)) {
          return truncate(maskParams(new URLSearchParams(body)).toString(), max);
        }
        return truncate(body, max);
      }
      if (body instanceof URLSearchParams) return truncate(maskParams(body).toString(), max);
      if (body instanceof FormData) {
        const obj = {};
        for (const [k, v] of body) obj[k] = SENSITIVE.test(k) ? MASK : v instanceof File ? `[file: ${v.name}]` : v;
        return truncate(JSON.stringify(obj), max);
      }
      if (body instanceof Blob) return `[binary: ${body.size} bytes]`;
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[binary: ${body.byteLength} bytes]`;
    } catch {}
    return "[unreadable body]";
  }

  // ---------- console.error ----------
  const originalError = console.error;
  console.error = function (...args) {
    try {
      const err = args.find((a) => a instanceof Error);
      send("console", {
        message: truncate(args.map((a) => truncate(serialize(a), 500)).join(" ")),
        stack: err?.stack,
      });
    } catch {}
    return originalError.apply(this, args);
  };

  // ---------- uncaught errors (resource 404s are handled by background.js) ----------
  window.addEventListener("error", (e) => {
    if (!(e instanceof ErrorEvent)) return;
    send("error", {
      message: e.message,
      source: e.filename,
      line: e.lineno,
      column: e.colno,
      stack: e.error?.stack,
    });
  }, true);

  // ---------- unhandled promise rejections ----------
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    send("promise", {
      message: truncate(r instanceof Error ? `${r.name}: ${r.message}` : serialize(r), 1000),
      stack: r?.stack,
    });
  });

  // ---------- fetch ----------
  const originalFetch = window.fetch;
  window.fetch = async function (input, init = {}) {
    const started = performance.now();
    const req = input instanceof Request ? input : null;
    const method = (init.method || req?.method || "GET").toUpperCase();
    const url = maskUrl(req ? req.url : String(input));
    const requestBody = maskBody(init.body);

    try {
      const res = await originalFetch.apply(this, arguments);
      const duration = Math.round(performance.now() - started);
      if (!res.ok && res.type !== "opaque") {
        res.clone().text()
          .then((t) => maskBody(t, 1000))
          .catch(() => undefined)
          .then((responseBody) =>
            send("network", { source: "fetch", kind: "failed", method, url, status: res.status, statusText: res.statusText, duration, requestBody, responseBody }));
      } else if (duration >= SLOW_MS) {
        send("network", { source: "fetch", kind: "slow", method, url, status: res.status, statusText: `Slow: took ${secs(duration)}`, duration, requestBody });
      }
      return res;
    } catch (err) {
      const duration = Math.round(performance.now() - started);
      if (err?.name === "AbortError" || err?.name === "TimeoutError") {
        if (duration >= CANCEL_MIN_MS) {
          const timedOut = err.name === "TimeoutError";
          send("network", {
            source: "fetch", kind: timedOut ? "timeout" : "cancelled", method, url, status: 0,
            statusText: `${timedOut ? "Timed out" : "Cancelled"} after ${secs(duration)}`, duration, requestBody,
          });
        }
      } else {
        send("network", {
          source: "fetch", kind: "failed", method, url, status: 0,
          statusText: err?.message || "Network error", duration, requestBody,
        });
      }
      throw err;
    }
  };

  // ---------- XMLHttpRequest ----------
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;

  XHR.open = function (method, url) {
    this.__qaBuddy = { method: String(method).toUpperCase(), url: maskUrl(String(url)) };
    return originalOpen.apply(this, arguments);
  };

  XHR.send = function (body) {
    const info = this.__qaBuddy;
    if (info) {
      info.started = performance.now();
      info.requestBody = maskBody(body);
      this.addEventListener("abort", () => (info.ended = "cancelled"));
      this.addEventListener("timeout", () => (info.ended = "timeout"));
      this.addEventListener("loadend", () => {
        const duration = Math.round(performance.now() - info.started);
        const base = { source: "xhr", method: info.method, url: info.url, status: this.status, duration, requestBody: info.requestBody };

        if (info.ended) {
          if (duration < CANCEL_MIN_MS) return; // quick cancel: normal app behavior
          const label = info.ended === "timeout" ? "Timed out" : "Cancelled";
          send("network", { ...base, kind: info.ended, status: 0, statusText: `${label} after ${secs(duration)}` });
          return;
        }

        if (this.status !== 0 && this.status < 400) {
          if (duration >= SLOW_MS) send("network", { ...base, kind: "slow", statusText: `Slow: took ${secs(duration)}` });
          return;
        }

        let responseBody;
        try {
          if (this.responseType === "" || this.responseType === "text") responseBody = maskBody(this.responseText, 1000);
        } catch {}
        send("network", { ...base, kind: "failed", statusText: this.status ? this.statusText : "Network error", responseBody });
      });
    }
    return originalSend.apply(this, arguments);
  };

  // ---------- steps: what the user did (labels only, never typed text) ----------
  // kind: click | submit | enter | select | check  → also counts as the "last action"
  //       type | navigate                          → steps only
  // Only real user events (isTrusted), so QA Buddy's own form filling isn't recorded here.
  const CLICKABLE = "button, a[href], [role=button], [role=link], [role=menuitem], [role=tab], [role=option], input[type=submit], input[type=button], summary";

  const short = (text, n = 40) => {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > n ? clean.slice(0, n - 1) + "…" : clean;
  };

  function labelOf(el) {
    return short(el.getAttribute("aria-label") || el.innerText || el.value || el.title || el.getAttribute("alt"));
  }

  function fieldName(el) {
    let label = "";
    if (el.id) {
      try { label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText || ""; } catch {}
    }
    if (!label) label = el.closest("label")?.innerText || "";
    return short(label || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || el.id || "a field", 30);
  }

  let lastSent = { label: "", time: 0 };
  function step(kind, label) {
    const now = Date.now();
    if (label === lastSent.label && now - lastSent.time < 1500) return; // one action can fire several events
    lastSent = { label, time: now, kind };
    send("action", { kind, label });
  }

  const ours = (target) => target instanceof Element && target.closest("qa-buddy-toast, qa-buddy-overlay");

  document.addEventListener("click", (e) => {
    if (!e.isTrusted || ours(e.target) || !(e.target instanceof Element)) return;
    const el = e.target.closest(CLICKABLE);
    if (!el) return;
    const label = labelOf(el);
    const kind = el.matches("a, [role=link]") ? "Clicked link" : "Clicked";
    step("click", label ? `${kind} "${label}"` : kind);
  }, true);

  document.addEventListener("submit", (e) => {
    if (!e.isTrusted) return;
    if (Date.now() - lastSent.time < 1000 && lastSent.kind === "click") return; // "Clicked Save" already says it
    const form = e.target;
    const name = form.getAttribute("aria-label") || form.getAttribute("name") || form.id || "";
    step("submit", name ? `Submitted form "${short(name, 30)}"` : "Submitted a form");
  }, true);

  document.addEventListener("keydown", (e) => {
    if (!e.isTrusted || e.key !== "Enter" || !(e.target instanceof Element)) return;
    if (!e.target.matches("input, [contenteditable]")) return;
    step("enter", `Pressed Enter in "${fieldName(e.target)}"`);
  }, true);

  // Typing: one step per field, never the text itself
  let typingIn = null, typingAt = 0;
  document.addEventListener("input", (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const el = e.target;
    if (!el.matches("input, textarea, [contenteditable]") || el.matches("input[type=checkbox], input[type=radio]")) return;
    const now = Date.now();
    if (el === typingIn && now - typingAt < 15000) { typingAt = now; return; }
    typingIn = el;
    typingAt = now;
    step("type", `Typed in "${fieldName(el)}"`);
  }, true);

  document.addEventListener("change", (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const el = e.target;
    if (el.matches("select")) {
      step("select", `Selected "${short(el.selectedOptions[0]?.text, 30)}" in "${fieldName(el)}"`);
    } else if (el.matches("input[type=checkbox]")) {
      step("check", `${el.checked ? "Checked" : "Unchecked"} "${fieldName(el)}"`);
    } else if (el.matches("input[type=radio]")) {
      step("check", `Chose "${fieldName(el)}"`);
    }
  }, true);

  // Single-page app navigation (main page only)
  if (!FRAME) {
    const path = () => location.pathname + location.search;
    const originalPush = history.pushState;
    history.pushState = function () {
      const result = originalPush.apply(this, arguments);
      step("navigate", `Went to ${short(path(), 60)}`);
      return result;
    };
    addEventListener("popstate", () => step("navigate", `Went back to ${short(path(), 60)}`));
  }

  send("ready", { url: location.href });
})();
