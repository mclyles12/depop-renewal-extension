// background.js — Depop Listing Renewer v1.3

const ALARM_NAME = "depop-renewal";

const INTERVALS = {
  "4h":  4  * 60,
  "8h":  8  * 60,
  "12h": 12 * 60,
  "24h": 24 * 60,
  "48h": 48 * 60
};

const DEFAULT_INTERVAL = "48h";

// Human-speed delays between listing saves
const HUMAN_DELAY_MIN = 8000;
const HUMAN_DELAY_MAX = 25000;

// Schedule jitter +/- 10 min
const JITTER_MIN = -10;
const JITTER_MAX = 10;

// --- Init ---
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["enabled", "listingUrls", "interval", "listingMeta"]);
  if (existing.enabled === undefined) {
    await chrome.storage.local.set({
      enabled: false,
      listingUrls: [],
      listingMeta: {},  // slug -> { editUrl, productUrl, imageUrl, title }
      interval: DEFAULT_INTERVAL,
      lastRun: null,
      nextRun: null,
      log: []
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
    chrome.storage.local.get(["enabled", "listingUrls", "listingMeta", "lastRun", "nextRun", "log", "interval"]).then(sendResponse);
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

// --- Scrape profile ---
async function scrapeProfile(profileUrl) {
  try {
    const tab = await openTabHidden(profileUrl);
    await sleep(3000);

    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["scraper.js"]
    });

    await chrome.tabs.remove(tab.id);

    const data = result?.[0]?.result;
    if (!data || !data.editUrls?.length) {
      return { ok: false, error: "No listings found. Make sure you're using your profile URL." };
    }

    // Scrape metadata (images, titles) for each listing
    await appendLog(`Found ${data.editUrls.length} listings. Fetching photos...`);
    const meta = await scrapeListingMeta(data.productUrls);

    // Merge with existing
    const { listingUrls, listingMeta } = await chrome.storage.local.get(["listingUrls", "listingMeta"]);
    const existing = listingUrls || [];
    const existingMeta = listingMeta || {};
    const merged = Array.from(new Set([...existing, ...data.editUrls]));
    const mergedMeta = { ...existingMeta, ...meta };

    await chrome.storage.local.set({ listingUrls: merged, listingMeta: mergedMeta });
    await appendLog(`Scraped ${data.editUrls.length} listing(s). Total: ${merged.length}`);

    return { ok: true, found: data.editUrls.length, total: merged.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- Fetch listing images + titles from product pages ---
async function scrapeListingMeta(productUrls) {
  const meta = {};
  // Batch: open up to 3 tabs at once to fetch metadata
  const BATCH = 3;
  for (let i = 0; i < productUrls.length; i += BATCH) {
    const batch = productUrls.slice(i, i + BATCH);
    await Promise.all(batch.map(async (productUrl) => {
      try {
        const slug = productUrl.match(/\/products\/([^/]+)\//)?.[1];
        if (!slug) return;

        const tab = await openTabHidden(productUrl);
        await sleep(2500);

        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: extractListingMeta
        });

        await chrome.tabs.remove(tab.id);

        const info = result?.[0]?.result;
        if (info) {
          const editUrl = `https://www.depop.com/products/edit/${slug}/`;
          meta[editUrl] = { ...info, slug, productUrl, editUrl };
        }
      } catch (e) {
        // Silent fail on individual listings
      }
    }));
    await sleep(1000);
  }
  return meta;
}

// --- Injected into product page to get image + title ---
function extractListingMeta() {
  try {
    // Main listing image
    const img =
      document.querySelector('img[class*="ProductCard"]') ||
      document.querySelector('img[class*="product"]') ||
      document.querySelector('img[class*="carousel"]') ||
      document.querySelector('main img');

    // Title
    const title =
      document.querySelector('h1')?.innerText?.trim() ||
      document.querySelector('[class*="title"]')?.innerText?.trim() ||
      document.title?.replace(' | Depop', '').trim();

    // Price
    const price =
      document.querySelector('[class*="price"]')?.innerText?.trim() ||
      document.querySelector('[class*="Price"]')?.innerText?.trim();

    return {
      imageUrl: img?.src || null,
      title: title || "Untitled",
      price: price || ""
    };
  } catch {
    return { imageUrl: null, title: "Untitled", price: "" };
  }
}

// --- Core renewal (reverse order) ---
async function runRenewal() {
  const { listingUrls } = await chrome.storage.local.get("listingUrls");
  if (!listingUrls || listingUrls.length === 0) {
    await appendLog("No listings configured — skipped.");
    return;
  }

  // Renew in REVERSE order so the first listing ends up on top in search
  const reversed = [...listingUrls].reverse();
  await appendLog(`Starting renewal of ${reversed.length} listing(s) in reverse order...`);

  let successCount = 0;
  let failCount = 0;

  for (const url of reversed) {
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

    // Human-speed random pause
    await sleep(randomBetween(HUMAN_DELAY_MIN, HUMAN_DELAY_MAX));
  }

  const now = new Date().toISOString();
  await chrome.storage.local.set({ lastRun: now });

  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled) await scheduleAlarm();

  await appendLog(`Done — ${successCount} renewed, ${failCount} failed.`);

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

// --- Open tab in background ---
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
