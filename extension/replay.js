// QA Buddy — builds a self-contained session replay file (player + recording).
(function (global) {
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // JSON inside <script>: escape "<" so "</script>" in recorded content can't end the tag
  const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

  let vendor = null;
  async function loadVendor() {
    if (vendor) return vendor;
    const get = (p) => fetch(chrome.runtime.getURL(p)).then((r) => r.text());
    const [js, css] = await Promise.all([get("vendor/rrweb-player.min.js"), get("vendor/rrweb-player.css")]);
    vendor = { js: js.replace(/<\/script/gi, "<\\/script"), css };
    return vendor;
  }

  // replay: { events, start, end, url }, steps: [{ label, time }]
  async function buildReplayHtml(replay, { title, steps = [] }) {
    const { js, css } = await loadVendor();
    const seconds = Math.max(1, Math.round((replay.end - replay.start) / 1000));
    const inWindow = steps.filter((s) => s.time >= replay.start - 1000 && s.time <= replay.end + 1000);
    const stepItems = inWindow.map((s) => {
      const offset = Math.max(0, s.time - replay.start);
      const mm = Math.floor(offset / 60000), ss = String(Math.floor((offset % 60000) / 1000)).padStart(2, "0");
      return `<li><button data-offset="${offset}"><time>${mm}:${ss}</time> ${esc(s.label)}</button></li>`;
    }).join("");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session replay: ${esc(title)}</title>
<style>${css}</style>
<style>
  :root { --paper:#f6f8f7; --surface:#fff; --ink:#16302b; --muted:#5b6e69; --line:#d5dedb; --marker:#f4c542; color-scheme: light; }
  @media (prefers-color-scheme: dark) { :root { --paper:#13201d; --surface:#1a2a26; --ink:#e6eeeb; --muted:#93a6a0; --line:#2a3b37; color-scheme: dark; } }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 "Segoe UI Variable Text", "SF Pro Text", system-ui, sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 28px 20px 48px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: var(--muted); margin: 0 0 18px; font-size: 14px; word-break: break-all; }
  #player { display: flex; justify-content: center; }
  h2 { font-size: 16px; margin: 28px 0 10px; padding-bottom: 4px; border-bottom: 3px solid var(--marker); display: inline-block; }
  ol { list-style: none; padding: 0; margin: 0; }
  ol button { all: unset; cursor: pointer; display: block; width: 100%; box-sizing: border-box; padding: 7px 12px; margin-bottom: 4px;
              background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
  ol button:hover, ol button:focus-visible { border-color: var(--ink); }
  time { display: inline-block; min-width: 42px; font-variant-numeric: tabular-nums; color: var(--muted); }
  .note { color: var(--muted); font-size: 13px; margin-top: 28px; }
</style>
</head>
<body>
<main>
  <h1>Session replay</h1>
  <p class="meta">${esc(title)}<br>${esc(replay.url)}<br>Last ${seconds} seconds before the report, recorded ${esc(new Date(replay.start).toLocaleString())}</p>
  <div id="player"></div>
  ${stepItems ? `<h2>Steps in this replay</h2><ol>${stepItems}</ol>` : ""}
  <p class="note">Recorded by QA Buddy as page changes, not video. Everything typed into fields is masked as ***.</p>
</main>
<script>${js}</script>
<script>
  const events = ${safeJson(replay.events)};
  const width = Math.min(1060, document.querySelector("main").clientWidth);
  const Player = rrwebPlayer.default || rrwebPlayer.Player || rrwebPlayer;
  const player = new Player({
    target: document.getElementById("player"),
    props: { events, width, height: Math.round(width * 0.56), autoPlay: false, showController: true, mouseTail: true },
  });
  document.querySelectorAll("[data-offset]").forEach((b) =>
    b.addEventListener("click", () => { player.goto(Number(b.dataset.offset), true); window.scrollTo({ top: 0, behavior: "smooth" }); }));
</script>
</body>
</html>`;
  }

  global.QAReplay = { buildReplayHtml };
})(window);
