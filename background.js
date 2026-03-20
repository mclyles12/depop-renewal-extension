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

let stopRequested = false;


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
  if (msg.action === "stopNow") {
    stopRequested = true;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.action === "runNow") {
    // Open persistent control window so user can see progress and stop
    chrome.windows.create({
      url: chrome.runtime.getURL("control.html"),
      type: "popup",
      width: 380,
      height: 300
    });
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
    await setProgress({ stage: "scraping", message: "Finding your Depop tab...", percent: 10 });

    // Find any open Depop tab — user should already be on their profile page
    const allTabs = await chrome.tabs.query({});
    const tab = allTabs.find(t => t.url && t.url.includes('depop.com') && !t.url.includes('/products/'));

    if (!tab) {
      await clearProgress();
      return { ok: false, error: "No Depop profile tab found. Open your profile page in Chrome, scroll to the bottom, then try again." };
    }

    await setProgress({ stage: "scraping", message: "Reading listings from page...", percent: 40 });

    // Inject scraper inline into the existing tab
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        window.__depopScraperResult = null;

        function getListings() {
          // Find all sold listing URLs so we can exclude them
          const soldUrls = new Set();
          document.querySelectorAll('p, h2, h3').forEach(el => {
            if (el.innerText?.trim() === 'Sold items') {
              // Grab all product links in the sold section (parent section or next sibling container)
              const section = el.closest('section') || el.parentElement;
              section?.querySelectorAll('a[href*="/products/"]').forEach(a => {
                soldUrls.add(a.href);
              });
            }
          });

          const links = document.querySelectorAll('a[href*="/products/"]');
          const seen = new Set();
          const results = [];
          links.forEach(a => {
            const href = a.href;
            if (
              /\/products\/[^/]+\/$/.test(href) &&
              !href.includes('/products/create') &&
              !href.includes('/products/edit') &&
              !seen.has(href) &&
              !soldUrls.has(href)  // exclude sold listings
            ) {
              seen.add(href);
              const img = a.querySelector('img');
              const imageUrl = (img?.src && img.src.startsWith('http') ? img.src : null)
                || img?.dataset?.src || null;
              const price = a.querySelector('[class*="price"],[class*="Price"]')?.innerText?.trim() || "";
              const title = img?.alt?.trim() || "";
              results.push({ productUrl: href, imageUrl, title, price });
            }
          });
          return results;
        }

        function toEditUrl(productUrl) {
          const match = productUrl.match(/\/products\/([^/]+)\//);
          return match ? `https://www.depop.com/products/edit/${match[1]}/` : null;
        }

        const listings = getListings();
        const editUrls = [];
        const meta = {};

        listings.forEach(({ productUrl, imageUrl, title, price }) => {
          const editUrl = toEditUrl(productUrl);
          if (!editUrl) return;
          editUrls.push(editUrl);
          const slug = productUrl.match(/\/products\/([^/]+)\//)?.[1] || "";
          meta[editUrl] = { imageUrl, title, price, slug, productUrl, editUrl };
        });

        window.__depopScraperResult = { editUrls, meta, count: editUrls.length };
      },
      world: "MAIN"
    });

    // Poll for result (max 15 seconds — should be instant)
    let data = null;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const poll = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__depopScraperResult || null,
        world: "MAIN"
      });
      data = poll?.[0]?.result;
      if (data) break;
    }

    if (!data || !data.editUrls?.length) {
      await clearProgress();
      return { ok: false, error: "No listings found on the page. Make sure you've scrolled to the bottom of your profile to load all listings." };
    }

    await setProgress({ stage: "saving", message: `Found ${data.editUrls.length} listings. Saving...`, percent: 85 });
    await sleep(400);

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

  stopRequested = false;
  const reversed = [...listingUrls].reverse();
  const total = reversed.length;
  await appendLog(`Starting renewal of ${total} listing(s) in reverse order...`);
  await setProgress({ stage: "renewing", message: `Renewing listing 1 of ${total}...`, percent: 0, current: 0, total });

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < reversed.length; i++) {
    if (stopRequested) {
      await appendLog(`⏹ Stopped after ${i} listing(s).`);
      await clearProgress();
      return;
    }
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

      const saveResult = result?.[0]?.result;
      if (saveResult?.ok) {
        successCount++;
        await appendLog(`✓ Renewed: ${urlToLabel(url)}`);
      } else if (saveResult?.reason === "validation") {
        failCount++;
        await appendLog(`✗ ${urlToLabel(url)} — has empty required fields (${saveResult.fields}). Update this listing manually.`);
      } else {
        failCount++;
        await appendLog(`✗ ${urlToLabel(url)} — has empty required fields. Update this listing manually.`);
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

// --- Injected to click Save and detect validation errors ---
function clickSaveButton() {
  const allButtons = Array.from(document.querySelectorAll("button"));
  const saveBtn = allButtons.find(b => {
    const cls = b.className || "";
    const text = b.innerText?.toLowerCase().trim();
    const isBlock = cls.includes("_block_") && !cls.includes("_outline_");
    const isSave = text === "save changes" || text === "save" || text === "update";
    return isBlock && isSave && !b.disabled;
  });

  if (!saveBtn) {
    const fallback = allButtons.find(b => {
      const text = b.innerText?.toLowerCase().trim();
      return (text === "save changes" || text === "save" || text === "update listing") && !b.disabled;
    });
    if (!fallback) return { ok: false, reason: "no-button" };
    fallback.click();
  } else {
    saveBtn.click();
  }

  // After clicking, check for validation errors after a short delay
  return new Promise(resolve => {
    setTimeout(() => {
      const invalidFields = Array.from(document.querySelectorAll('[aria-invalid="true"]'));
      if (invalidFields.length > 0) {
        const fieldNames = invalidFields.map(el => {
          return el.id?.replace('-input', '') || el.getAttribute('aria-label') || 'unknown field';
        }).join(', ');
        resolve({ ok: false, reason: "validation", fields: fieldNames });
      } else {
        resolve({ ok: true });
      }
    }, 1500);
  });
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
