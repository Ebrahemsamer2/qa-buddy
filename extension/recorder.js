// QA Buddy — session replay recorder (main page only, isolated world).
// Uses rrweb to record page changes (not video) and keeps a rolling window of
// roughly the last 30 seconds in memory. Nothing leaves the page until the
// tester includes the replay in a report.
//
// Performance: it records only while the tab is visible. Background tabs stop
// recording (no snapshots, no observers) and resume with a fresh snapshot when
// the tester comes back, so many open tabs don't slow the browser down.
(() => {
  if (window.__qaReplay || typeof rrweb === "undefined") return;

  const SEGMENT_MS = 15000;   // a full snapshot every 15 s…
  const KEEP_SEGMENTS = 2;    // …keeping the last two segments (15–30 s)
  const segments = [];
  let stop = null;

  function newSegment() {
    segments.push([]);
    while (segments.length > KEEP_SEGMENTS) segments.shift();
  }

  function startRecording() {
    if (stop) return;
    newSegment(); // rrweb starts with a full snapshot, so a new segment begins here
    stop = rrweb.record({
      emit(event, isCheckout) {
        if (isCheckout) newSegment();
        segments[segments.length - 1].push(event);
      },
      checkoutEveryNms: SEGMENT_MS,
      maskAllInputs: true,            // typed values are replaced with ***
      blockSelector: "qa-buddy-toast, qa-buddy-overlay",
      sampling: { mousemove: 50, scroll: 150, input: "last" },
      recordCanvas: false,
      collectFonts: false,
    });
  }

  function stopRecording() {
    if (!stop) return;
    try { stop(); } catch {}
    stop = null;
  }

  window.__qaReplay = {
    get() {
      const events = segments.flat();
      if (!events.length) return null;
      return { events, start: events[0].timestamp, end: events[events.length - 1].timestamp, url: location.href };
    },
    get recording() { return !!stop; },
  };

  chrome.storage.local.get("settings").then(({ settings = {} }) => {
    if (settings.replay === false) return; // turned off in Settings
    const sync = () => (document.visibilityState === "visible" ? startRecording() : stopRecording());
    document.addEventListener("visibilitychange", sync);
    sync();
  }).catch(() => {});
})();
