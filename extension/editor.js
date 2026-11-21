// QA Buddy — screenshot editor. Opened from the popup as editor.html?tab=<tabId>.
// Reads and writes the screenshot in chrome.storage.session under "shot:<tabId>".
const tabId = Number(new URLSearchParams(location.search).get("tab"));
const key = `shot:${tabId}`;
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const img = new Image();
const shapes = []; // { tool, x1, y1, x2, y2 }
let tool = "box";
let drawing = null;
const RED = "#e5322d";

// ---------- drawing ----------
const norm = (s) => ({
  x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2),
  w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1),
});
const lineWidth = () => Math.max(3, Math.round(canvas.width / 360));

function pixelate(s) {
  const { x, y, w, h } = norm(s);
  if (w < 2 || h < 2) return;
  const block = Math.max(8, Math.round(canvas.width / 110));
  const tw = Math.max(1, Math.ceil(w / block)), th = Math.max(1, Math.ceil(h / block));
  const tmp = document.createElement("canvas");
  tmp.width = tw; tmp.height = th;
  tmp.getContext("2d").drawImage(img, x, y, w, h, 0, 0, tw, th);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, tw, th, x, y, w, h);
  ctx.imageSmoothingEnabled = true;
}

function box(s) {
  const { x, y, w, h } = norm(s);
  ctx.strokeStyle = RED;
  ctx.lineWidth = lineWidth();
  ctx.strokeRect(x, y, w, h);
}

function arrow(s) {
  const lw = lineWidth();
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const head = lw * 5;
  ctx.strokeStyle = ctx.fillStyle = RED;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(s.x1, s.y1);
  ctx.lineTo(s.x2 - Math.cos(angle) * head * 0.8, s.y2 - Math.sin(angle) * head * 0.8);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(s.x2, s.y2);
  ctx.lineTo(s.x2 - head * Math.cos(angle - Math.PI / 7), s.y2 - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(s.x2 - head * Math.cos(angle + Math.PI / 7), s.y2 - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

const DRAW = { blur: pixelate, box, arrow };

function redraw() {
  ctx.drawImage(img, 0, 0);
  // Blur first, so boxes and arrows drawn over a blurred area stay sharp
  [...shapes, ...(drawing ? [drawing] : [])]
    .sort((a, b) => (a.tool === "blur" ? 0 : 1) - (b.tool === "blur" ? 0 : 1))
    .forEach((s) => DRAW[s.tool](s));
  document.getElementById("undo").disabled = !shapes.length;
}

// ---------- pointer ----------
function point(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.round((e.clientX - r.left) * (canvas.width / r.width)),
    y: Math.round((e.clientY - r.top) * (canvas.height / r.height)),
  };
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = point(e);
  drawing = { tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
});
canvas.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  const p = point(e);
  drawing.x2 = p.x;
  drawing.y2 = p.y;
  redraw();
});
canvas.addEventListener("pointerup", () => {
  if (!drawing) return;
  const { w, h } = norm(drawing);
  if (Math.max(w, h) > 6) shapes.push(drawing);
  drawing = null;
  redraw();
});

// ---------- toolbar ----------
document.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => {
  tool = b.dataset.tool;
  document.querySelectorAll("[data-tool]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
}));

function undo() { shapes.pop(); redraw(); }
document.getElementById("undo").addEventListener("click", undo);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); }
});

async function backToPage() {
  try { await chrome.tabs.update(tabId, { active: true }); } catch {}
  try { await chrome.action.openPopup(); } catch {} // reopen QA Buddy where supported
  window.close();
}

document.getElementById("cancel").addEventListener("click", backToPage);

document.getElementById("done").addEventListener("click", async () => {
  drawing = null;
  redraw();
  const dataUrl = canvas.toDataURL("image/png");
  await chrome.storage.session.set({ [key]: { dataUrl, edited: true, time: Date.now() } });
  backToPage();
});

// ---------- start ----------
(async () => {
  const stored = (await chrome.storage.session.get(key))[key];
  if (!stored?.dataUrl) {
    document.getElementById("hint").textContent = "No screenshot to edit. Open QA Buddy on the page and take one first.";
    document.getElementById("done").disabled = true;
    return;
  }
  img.onload = () => {
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    redraw();
  };
  img.src = stored.dataUrl;
})();
