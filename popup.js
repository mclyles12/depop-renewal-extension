// popup.js — Depop Listing Renewer v1.3

const $ = id => document.getElementById(id);

let listings = [];
let enabled = false;
let currentInterval = "48h";

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

// --- Interval pills --- (all unlocked)
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

// --- Add listing ---
$("addBtn").addEventListener("click", addListing);
$("urlInput").addEventListener("keydown", e => { if (e.key === "Enter") addListing(); });

function addListing() {
  const raw = $("urlInput").value.trim();
  const url = normalizeUrl(raw);
  if (!url) { showError("Enter a valid Depop listing edit URL."); return; }
  if (!isValidEditUrl(url)) { showError("Must be an edit page.\nExample: depop.com/products/edit/your-slug/"); return; }
  if (listings.includes(url)) { showError("Already in your list."); return; }
  hideError();
  listings.push(url);
  saveListings();
  renderListings();
  $("urlInput").value = "";
}

function normalizeUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const path = u.pathname.endsWith("/") ? u.pathname : u.pathname + "/";
    return `https://www.depop.com${path}`;
  } catch { return null; }
}

function isValidEditUrl(url) {
  return /^https:\/\/www\.depop\.com\/products\/edit\/[^/]+\/$/.test(url);
}

function removeListing(url) {
  listings = listings.filter(u => u !== url);
  saveListings();
  renderListings();
}

function saveListings() {
  sendMsg({ action: "setListings", urls: listings });
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

// --- Scrape ---
$("scrapeBtn").addEventListener("click", async () => {
  const raw = $("profileInput").value.trim();
  if (!raw) { showError("Enter your Depop profile URL first."); return; }

  let profileUrl;
  try {
    const u = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    profileUrl = `https://www.depop.com${u.pathname.endsWith("/") ? u.pathname : u.pathname + "/"}`;
  } catch { showError("Invalid profile URL."); return; }

  hideError();
  showPSA();
  $("scrapeBtn").disabled = true;
  $("scrapeBtn").textContent = "Scraping...";

  const result = await sendMsg({ action: "scrapeProfile", profileUrl });

  $("scrapeBtn").disabled = false;
  $("scrapeBtn").textContent = "⟲ Scrape";
  hidePSA();

  if (result.ok) {
    const status = await sendMsg({ action: "getStatus" });
    listings = status.listingUrls || [];
    renderListings();
    renderLog(status.log || []);
  } else {
    showError(result.error || "Scrape failed — try again.");
  }
});

// --- Run Now ---
$("runBtn").addEventListener("click", async () => {
  if (!listings.length) { showError("Add at least one listing first."); return; }
  hideError();
  showPSA();
  $("runBtn").disabled = true;
  $("runBtn").textContent = "Running...";

  sendMsg({ action: "runNow" });

  let polls = 0;
  const interval = setInterval(async () => {
    const status = await sendMsg({ action: "getStatus" });
    renderLog(status.log || []);
    renderStatus(status);
    polls++;
    if (polls >= 12) {
      clearInterval(interval);
      $("runBtn").disabled = false;
      $("runBtn").textContent = "⟳ Renew All Now";
      hidePSA();
    }
  }, 2500);
});

// --- PSA ---
function showPSA() { $("psaBanner").classList.add("visible"); }
function hidePSA() { $("psaBanner").classList.remove("visible"); }

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

// --- Bug report ---
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

Extension version: 1.3.0
Chrome version: [your Chrome version]
`
  );
  chrome.tabs.create({
    url: `mailto:lylesmaggie55@gmail.com?subject=${subject}&body=${body}`
  });
});

// --- Instructions ---
$("instructionsBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("instructions.html") });
});


function showError(msg) { const b = $("errorBanner"); b.textContent = msg; b.classList.add("visible"); }
function hideError() { $("errorBanner").classList.remove("visible"); }

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
