// background.js — Depop Listing Renewer v1.4

const ALARM_NAME = "depop-renewal";

const INTERVALS = {
  "4h":  4  * 60,
  "8h":  8  * 60,
  "12h": 12 * 60,
  "24h": 24 * 60,
  "48h": 48 * 60
};

const DEFAULT_INTERVAL = "48h";
const HUMAN_DELAY_MIN = 8000;
const HUMAN_DELAY_MAX = 25000;
const JITTER_MIN = -10;
const JITTER_MAX = 10;

// --- Init ---
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["enabled", "listingUrls", "interval", "listingMeta"]);
  if (existing.enabled === undefined) {
    await chrome.storage.local.set({
      enabled: false,
      listingUrls: [],
      listingMeta: {},
      interval: DEFAULT_INTERVAL,
      lastRun: null,
      nextRun: null,
      log: [],
      progress: null
    });
  }
});

// --- Alarm ---
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await runRenewal();
});

// --- Messages ---
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "runNow") {
    runRenewal().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === "setEnabled") {
    setEnabled(msg.value).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === "setInterval") {
    setIntervalPref(msg.interval).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === "setListings") {
    chrome.storage.local.set({ listingUrls: msg.urls }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === "setListingMeta") {
    chrome.storage.local.set({ listingMeta: msg.meta }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === "scrapeProfile") {
    scrapeProfile(msg.profileUrl).then(sendResponse);
    return true;
  }
  if (msg.action === "getStatus") {
    chrome.storage.local.get(["enabled", "listingUrls", "listingMeta", "lastRun", "nextRun", "log", "interval", "progress"]).then(sendResponse);
    return true;
  }
  if (msg.action === "openLayoutManager") {
    chrome.windows.create({
      url: chrome.runtime.getURL("layout.html"),
      type: "popup",
      width: 900,
      height: 650
    });
    sendResponse({ ok: true });
    return true;
  }
});

// --- Enable/disable ---
async function setEnabled(value) {
  await chrome.storage.local.set({ enabled: value });
  if (value) {
    await scheduleAlarm();
  } else {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.storage.local.set({ nextRun: null });
  }
}

// --- Set interval ---
async function setIntervalPref(interval) {
  if (!INTERVALS[interval]) return;
  await chrome.storage.local.set({ interval });
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled) await scheduleAlarm();
}

// --- Schedule with jitter ---
async function scheduleAlarm() {
  const { interval } = await chrome.storage.local.get("interval");
  const minutes = INTERVALS[interval] || INTERVALS[DEFAULT_INTERVAL];
  const jitter = randomBetween(JITTER_MIN, JITTER_MAX);
  const delayMinutes = Math.max(1, minutes + jitter);

  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: delayMinutes,
    periodInMinutes: minutes
  });

  const nextRun = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  await chrome.storage.local.set({ nextRun });
}

// --- Scrape profile (images grabbed from profile page thumbnails) ---
async function scrapeProfile(profileUrl) {
  try {
    await setProgress({ stage: "scrolling", message: "Loading your profile...", percent: 5 });

    // Get current active tab to restore focus after scraping
    const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Open as ACTIVE tab so IntersectionObserver fires for infinite scroll
    const tab = await openTabActive(profileUrl);
    await sleep(5000);

    await setProgress({ stage: "scrolling", message: "Scrolling to load all listings...", percent: 15 });

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["scraper.js"],
      world: "MAIN"
    });

    // scraper.js stores result in window.__depopScraperResult when done
    // Poll until it's ready (max 3 minutes)
    let data = null;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const poll = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__depopScraperResult || null,
        world: "MAIN"
      });
      data = poll?.[0]?.result;
      if (data) break;
    }
    await chrome.tabs.remove(tab.id);

    // Restore original tab focus
    if (currentTab?.id) {
      chrome.tabs.update(currentTab.id, { active: true }).catch(() => {});
    }

    if (!data || !data.editUrls?.length) {
      await clearProgress();
      return { ok: false, error: "No listings found. Make sure you're using your profile URL." };
    }

    await setProgress({ stage: "saving", message: `Found ${data.editUrls.length} listings. Saving...`, percent: 85 });
    await sleep(400);

    // Merge with existing
    const { listingUrls, listingMeta } = await chrome.storage.local.get(["listingUrls", "listingMeta"]);
    const existing = listingUrls || [];
    const existingMeta = listingMeta || {};
    const merged = Array.from(new Set([...existing, ...data.editUrls]));
    const mergedMeta = { ...existingMeta, ...data.meta };

    await chrome.storage.local.set({ listingUrls: merged, listingMeta: mergedMeta });
    await appendLog(`Scraped ${data.editUrls.length} listing(s). Total: ${merged.length}`);

    await setProgress({ stage: "done", message: `Done! ${data.editUrls.length} listings imported.`, percent: 100 });
    await sleep(1500);
    await clearProgress();

    return { ok: true, found: data.editUrls.length, total: merged.length };
  } catch (e) {
    await clearProgress();
    return { ok: false, error: e.message };
  }
}

// --- Core renewal (reverse order) ---
async function runRenewal() {
  const { listingUrls } = await chrome.storage.local.get("listingUrls");
  if (!listingUrls || listingUrls.length === 0) {
    await appendLog("No listings configured — skipped.");
    return;
  }

  const reversed = [...listingUrls].reverse();
  const total = reversed.length;
  await appendLog(`Starting renewal of ${total} listing(s) in reverse order...`);
  await setProgress({ stage: "renewing", message: `Renewing listing 1 of ${total}...`, percent: 0, current: 0, total });

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < reversed.length; i++) {
    const url = reversed[i];
    const percent = Math.round(((i) / total) * 100);
    await setProgress({
      stage: "renewing",
      message: `Renewing ${i + 1} of ${total}...`,
      percent,
      current: i + 1,
      total
    });

    try {
      const tab = await openTabHidden(url);
      await sleep(4000);

      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: clickSaveButton
      });

      await sleep(randomBetween(2000, 4000));
      await chrome.tabs.remove(tab.id);

      const ok = result?.[0]?.result?.ok;
      if (ok) {
        successCount++;
        await appendLog(`✓ Renewed: ${urlToLabel(url)}`);
      } else {
        failCount++;
        await appendLog(`✗ Save button not found: ${urlToLabel(url)}`);
      }
    } catch (e) {
      failCount++;
      await appendLog(`✗ Error on ${urlToLabel(url)}: ${e.message}`);
    }

    await sleep(randomBetween(HUMAN_DELAY_MIN, HUMAN_DELAY_MAX));
  }

  const now = new Date().toISOString();
  await chrome.storage.local.set({ lastRun: now });

  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled) await scheduleAlarm();

  await appendLog(`Done — ${successCount} renewed, ${failCount} failed.`);
  await setProgress({ stage: "done", message: `Done! ${successCount} renewed, ${failCount} failed.`, percent: 100, current: total, total });
  await sleep(2000);
  await clearProgress();

  if (successCount > 0) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: "Depop Renewer",
      message: `${successCount} listing(s) renewed successfully.`
    });
  }
}

// --- Injected to click Save ---
function clickSaveButton() {
  const allButtons = Array.from(document.querySelectorAll("button"));
  const saveBtn = allButtons.find(b => {
    const cls = b.className || "";
    const text = b.innerText?.toLowerCase().trim();
    const isBlock = cls.includes("_block_") && !cls.includes("_outline_");
    const isSave = text === "save changes" || text === "save" || text === "update";
    return isBlock && isSave && !b.disabled;
  });
  if (saveBtn) { saveBtn.click(); return { ok: true }; }

  const fallback = allButtons.find(b => {
    const text = b.innerText?.toLowerCase().trim();
    return (text === "save changes" || text === "save" || text === "update listing") && !b.disabled;
  });
  if (fallback) { fallback.click(); return { ok: true }; }
  return { ok: false };
}

// --- Open tab as active (for scraping — needed for IntersectionObserver) ---
function openTabActive(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: true }, (tab) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(tab); }, 15000);
    });
  });
}

// --- Open tab in background (for renewals) ---
function openTabHidden(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      const listener = (tabId, changeInfo) => {
        if (tabId === tab.id && changeInfo.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tab);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(tab); }, 12000);
    });
  });
}

// --- Progress helpers ---
async function setProgress(data) {
  await chrome.storage.local.set({ progress: data });
}

async function clearProgress() {
  await chrome.storage.local.set({ progress: null });
}

// --- Helpers ---
function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function urlToLabel(url) {
  try {
    const match = url.match(/\/products\/edit\/([^/]+)\//);
    return match ? match[1] : url;
  } catch { return url; }
}

async function appendLog(msg) {
  const { log } = await chrome.storage.local.get("log");
  const entries = (log || []).slice(-49);
  entries.push({ time: new Date().toLocaleString(), msg });
  await chrome.storage.local.set({ log: entries });
}
