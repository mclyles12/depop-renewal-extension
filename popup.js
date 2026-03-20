// popup.js — Depop Listing Renewer v1.4

const $ = id => document.getElementById(id);

let listings = [];
let enabled = false;
let currentInterval = "48h";
let progressPoller = null;

// --- Init ---
async function init() {
  const status = await sendMsg({ action: "getStatus" });
  enabled = status.enabled || false;
  listings = status.listingUrls || [];
  currentInterval = status.interval || "48h";

  renderToggle();
  renderListings();
  renderStatus(status);
  renderLog(status.log || []);
  renderIntervalPills();

  // Resume progress display if something was running
  if (status.progress) renderProgress(status.progress);
}

// --- Toggle ---
$("enableToggle").addEventListener("change", async (e) => {
  enabled = e.target.checked;
  await sendMsg({ action: "setEnabled", value: enabled });
  renderToggle();
  const status = await sendMsg({ action: "getStatus" });
  renderStatus(status);
});

function renderToggle() {
  $("enableToggle").checked = enabled;
  $("statusDot").classList.toggle("active", enabled);
}

// --- Interval pills ---
function renderIntervalPills() {
  document.querySelectorAll(".pill").forEach(pill => {
    pill.classList.toggle("active", pill.dataset.interval === currentInterval);
  });
}

document.querySelectorAll(".pill").forEach(pill => {
  pill.addEventListener("click", async () => {
    currentInterval = pill.dataset.interval;
    renderIntervalPills();
    await sendMsg({ action: "setInterval", interval: currentInterval });
    const status = await sendMsg({ action: "getStatus" });
    renderStatus(status);
  });
});

// --- Layout manager ---
$("layoutBtn").addEventListener("click", () => {
  sendMsg({ action: "openLayoutManager" });
});

// --- Scrape ---
$("scrapeBtn").addEventListener("click", async () => {
  hideError();
  showPSA("Reading listings from your open Depop tab...");
  $("scrapeBtn").disabled = true;
  $("scrapeBtn").textContent = "Scraping...";

  startProgressPoller();
  const result = await sendMsg({ action: "scrapeProfile", profileUrl: "" });
  stopProgressPoller();
  clearProgressUI();
  hidePSA();

  $("scrapeBtn").disabled = false;
  $("scrapeBtn").textContent = "⟲ Scrape";

  if (result.ok) {
    const status = await sendMsg({ action: "getStatus" });
    listings = status.listingUrls || [];
    renderListings();
    renderLog(status.log || []);
  } else {
    showError(result.error || "Scrape failed — try again.");
  }
});

// --- Stop ---
$("stopBtn").addEventListener("click", async () => {
  await sendMsg({ action: "stopNow" });
  $("stopBtn").disabled = true;
  $("runBtn").disabled = false;
  $("runBtn").textContent = "⟳ Renew All Now";
  stopProgressPoller();
  clearProgressUI();
  hidePSA();
});

// --- Run Now ---
$("runBtn").addEventListener("click", async () => {
  if (!listings.length) { showError("Scrape your listings first."); return; }
  hideError();
  showPSA("Tabs will open and close automatically. Do not interact with them.");
  $("runBtn").disabled = true;
  $("runBtn").textContent = "Running...";
  $("stopBtn").disabled = false;

  sendMsg({ action: "runNow" });
  startProgressPoller(true);

  // Progress poller will auto-stop when progress clears
});

// --- Progress poller ---
function startProgressPoller(isRenewal = false) {
  if (progressPoller) clearInterval(progressPoller);
  progressPoller = setInterval(async () => {
    const status = await sendMsg({ action: "getStatus" });
    renderLog(status.log || []);
    renderStatus(status);

    if (status.progress) {
      renderProgress(status.progress);
      if (status.progress.stage === "done") {
        setTimeout(() => {
          stopProgressPoller();
          clearProgressUI();
          hidePSA();
          if (isRenewal) {
            $("runBtn").disabled = false;
            $("runBtn").textContent = "⟳ Renew All Now";
            $("stopBtn").disabled = true;
          }
        }, 1800);
      }
    } else if (!status.progress && isRenewal) {
      stopProgressPoller();
      clearProgressUI();
      hidePSA();
      $("runBtn").disabled = false;
      $("runBtn").textContent = "⟳ Renew All Now";
      $("stopBtn").disabled = true;
    }
  }, 800);
}

function stopProgressPoller() {
  if (progressPoller) { clearInterval(progressPoller); progressPoller = null; }
}

function renderProgress(progress) {
  if (!progress) return;
  $("progressWrap").classList.add("visible");
  $("progressMsg").textContent = progress.message || "Working...";
  $("progressPct").textContent = `${progress.percent || 0}%`;
  $("progressBar").style.width = `${progress.percent || 0}%`;
  $("progressBar").classList.toggle("green", progress.stage === "done");
}

function clearProgressUI() {
  $("progressWrap").classList.remove("visible");
  $("progressBar").style.width = "0%";
  $("progressBar").classList.remove("green");
}

// --- PSA ---
function showPSA(msg) {
  const b = $("psaBanner");
  if (msg) b.textContent = "⚠ " + msg;
  b.classList.add("visible");
}
function hidePSA() { $("psaBanner").classList.remove("visible"); }

// --- Listings ---
function removeListing(url) {
  listings = listings.filter(u => u !== url);
  sendMsg({ action: "setListings", urls: listings });
  renderListings();
}

function renderListings() {
  const list = $("listingList");
  const empty = $("emptyState");
  $("listingCount").textContent = listings.length;
  Array.from(list.querySelectorAll(".listing-item")).forEach(el => el.remove());

  if (!listings.length) { empty.style.display = "block"; return; }
  empty.style.display = "none";

  listings.forEach(url => {
    const slug = url.match(/\/products\/edit\/([^/]+)\//)?.[1] || url;
    const item = document.createElement("div");
    item.className = "listing-item";

    const label = document.createElement("span");
    label.className = "listing-slug";
    label.textContent = slug;
    label.title = url;

    const btn = document.createElement("button");
    btn.className = "remove-btn";
    btn.textContent = "×";
    btn.addEventListener("click", () => removeListing(url));

    item.appendChild(label);
    item.appendChild(btn);
    list.appendChild(item);
  });
}

// --- Status ---
function renderStatus(status) {
  $("lastRun").textContent = status.lastRun ? relTime(status.lastRun, false) : "—";
  $("nextRun").textContent = status.nextRun ? relTime(status.nextRun, true) : (enabled ? "Soon" : "—");
}

function relTime(iso, future) {
  try {
    const diff = Math.abs(new Date(iso) - Date.now());
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (future) return h > 0 ? `${h}h ${m}m` : `${m}m`;
    if (h > 0) return `${h}h ago`;
    if (m > 0) return `${m}m ago`;
    return "just now";
  } catch { return "—"; }
}

// --- Log ---
function renderLog(log) {
  const list = $("logList");
  list.innerHTML = "";
  if (!log.length) {
    list.innerHTML = `<div class="log-entry"><span class="log-msg" style="color:var(--muted)">No activity yet</span></div>`;
    return;
  }
  [...log].reverse().forEach(entry => {
    const row = document.createElement("div");
    row.className = "log-entry";
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = shortTime(entry.time);
    const msg = document.createElement("span");
    msg.className = "log-msg";
    if (entry.msg.startsWith("✓")) msg.classList.add("success");
    if (entry.msg.startsWith("✗")) msg.classList.add("error");
    msg.textContent = entry.msg;
    row.appendChild(time);
    row.appendChild(msg);
    list.appendChild(row);
  });
}

function shortTime(t) {
  try { return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return t; }
}

// --- Error ---
function showError(msg) { const b = $("errorBanner"); b.textContent = msg; b.classList.add("visible"); }
function hideError() { $("errorBanner").classList.remove("visible"); }

// --- Footer buttons ---
$("bugBtn").addEventListener("click", () => {
  const subject = encodeURIComponent("Depop Renewer Bug Report");
  const body = encodeURIComponent(
`Hi Maggie,

I found a bug in Depop Renewer. Here's what happened:

What I was doing:
[describe what you were doing]

What I expected:
[describe what should have happened]

What actually happened:
[describe what went wrong]

Extension version: 1.4.0
Chrome version: [your Chrome version]
`);
  chrome.tabs.create({ url: `mailto:lylesmaggie55@gmail.com?subject=${subject}&body=${body}` });
});

$("instructionsBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("instructions.html") });
});

// --- Messaging ---
function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, res => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      resolve(res || {});
    });
  });
}

init();
