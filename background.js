// background.js — Depop Listing Renewer v1.5

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
      profileInfo: null,
      profileProfiles: {},
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
    chrome.storage.local.get(["enabled", "listingUrls", "listingMeta", "profileInfo", "profileProfiles", "lastRun", "nextRun", "log", "interval", "progress"]).then(sendResponse);
    return true;
  }
  if (msg.action === "openLayoutManager") {
    chrome.windows.create({
      url: chrome.runtime.getURL("layout.html"),
      type: "popup",
      width: 900,
      height: 700
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

// --- Scrape profile (listings + profile info) ---
async function scrapeProfile(profileUrl) {
  try {
    await setProgress({ stage: "scraping", message: "Finding your Depop tab...", percent: 10 });

    const allTabs = await chrome.tabs.query({});
    const EXCLUDED = ['/products/edit', '/products/create', '/search', '/checkout', '/login', '/signup', '/settings', '/bag', '/sell'];
    let tab = allTabs.find(t =>
      t.url &&
      t.url.includes('depop.com') &&
      !EXCLUDED.some(x => t.url.includes(x)) &&
      /depop\.com\/[a-z0-9_]+\/?/i.test(t.url)
    );
    if (!tab) {
      tab = allTabs.find(t =>
        t.url && t.url.includes('depop.com') &&
        !t.url.includes('/products/edit') && !t.url.includes('/products/create')
      );
    }
    if (!tab) {
      await clearProgress();
      return { ok: false, error: "No Depop profile tab found. Open your profile page (depop.com/yourusername/), scroll to the bottom to load all listings, then try again." };
    }

    await setProgress({ stage: "scraping", message: "Reading listings and profile info...", percent: 40 });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        window.__depopScraperResult = null;

        function getListings() {
          const soldUrls = new Set();
          document.querySelectorAll('p, h2, h3').forEach(el => {
            if (el.innerText?.trim() === 'Sold items') {
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
              /\/products\/[^/]+\/?$/.test(href) &&
              !href.includes('/products/create') &&
              !href.includes('/products/edit') &&
              !seen.has(href) &&
              !soldUrls.has(href)
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
          const match = productUrl.match(/\/products\/([^/?#]+)/);
          return match ? `https://www.depop.com/products/edit/${match[1]}/` : null;
        }

        // --- Scrape profile info ---
        function scrapeProfileInfo() {
          // Avatar
          const avatarImg = document.querySelector('[data-testid="avatar"] img, [class*="avatarContainer"] img, [class*="userImage"]');
          const avatarUrl = avatarImg?.src || null;

          // Username (h1)
          const usernameEl = document.querySelector('h1[class*="username"], h1');
          const username = usernameEl?.innerText?.trim() || "";

          // Shop name / display name
          const shopNameEl = document.querySelector('[class*="sellerName"], [class*="shopName"]');
          const shopName = shopNameEl?.innerText?.trim() || "";

          // Bio
          const bioEl = document.querySelector('[class*="shopBio"] p:last-child, [class*="bio"] p');
          const bio = bioEl?.innerText?.trim() || "";

          // Stars / rating
          const ratingEl = document.querySelector('[aria-label*="shop rating"]');
          const ratingLabel = ratingEl?.getAttribute('aria-label') || "";
          const ratingMatch = ratingLabel.match(/(\d+(\.\d+)?)\s*star/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

          // Review count
          const reviewCountEl = document.querySelector('[class*="feedbackButton"] p');
          const reviewCountText = reviewCountEl?.innerText?.trim() || "";
          const reviewCount = reviewCountText.replace(/[()]/g, "").trim();

          // Sold count + activity
          const signalEls = document.querySelectorAll('[class*="signal"] p');
          let sold = "";
          let activity = "";
          signalEls.forEach(el => {
            const t = el.innerText?.trim();
            if (t?.includes("sold")) sold = t;
            else if (t?.includes("Active") || t?.includes("ago")) activity = t;
          });

          // Followers / Following
          const followBtns = document.querySelectorAll('[class*="followCount"]');
          let followers = "";
          let following = "";
          followBtns.forEach(btn => {
            const label = btn.getAttribute('aria-label') || "";
            const bold = btn.querySelector('[class*="bold"], b, strong');
            const val = bold?.innerText?.trim() || "";
            if (label.includes("followers")) followers = val;
            else if (label.includes("following")) following = val;
          });

          return { avatarUrl, username, shopName, bio, rating, reviewCount, sold, activity, followers, following };
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

        const profileInfo = scrapeProfileInfo();

        // Collect diagnostics for debugging if listings come back empty
        const allLinks = document.querySelectorAll('a[href*="/products/"]');
        const sampleHrefs = Array.from(allLinks).slice(0, 5).map(a => a.href);
        const testedRegex = /\/products\/[^/?#]+\/?$/.source;
        const matchCount = Array.from(allLinks).filter(a => /\/products\/[^/?#]+\/?$/.test(a.href) && !a.href.includes('/edit') && !a.href.includes('/create')).length;
        const pageUrl = window.location.href;
        const diagnostics = [
          `URL: ${pageUrl}`,
          `Total /products/ links found: ${allLinks.length}`,
          `Links passing regex filter: ${matchCount}`,
          `Regex used: ${testedRegex}`,
          `Sample hrefs: ${JSON.stringify(sampleHrefs, null, 2)}`
        ].join("\n");

        window.__depopScraperResult = { editUrls, meta, count: editUrls.length, profileInfo, diagnostics };
      },
      world: "MAIN"
    });

    // Poll for result
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
      // Return diagnostic info so the user can report exactly what went wrong
      const diagInfo = data?.diagnostics || "No diagnostic info captured.";
      return {
        ok: false,
        error: `No listings found. Paste this when reporting:\n\n${diagInfo}`
      };
    }

    await setProgress({ stage: "saving", message: `Found ${data.editUrls.length} listings. Saving...`, percent: 85 });
    await sleep(400);

    const { listingUrls, listingMeta, profileProfiles } = await chrome.storage.local.get(["listingUrls", "listingMeta", "profileProfiles"]);
    const existing = listingUrls || [];
    const existingMeta = listingMeta || {};
    const existingSet = new Set(existing);
    // New listings = ones not already in the saved order
    const brandNew = data.editUrls.filter(u => !existingSet.has(u));
    // Prepend new listings so they appear at position #1+ and get renewed last
    // (renewal runs in reverse, so position #1 = renewed last = top of search)
    const merged = Array.from(new Set([...brandNew, ...existing]));
    const mergedMeta = { ...existingMeta, ...data.meta };

    // Always save profile info — merge into per-username map so multi-account
    // users don't lose data, and re-scraping always refreshes the relevant entry.
    const profiles = profileProfiles || {};
    if (data.profileInfo) {
      const key = data.profileInfo.username || tab.url?.match(/depop\.com\/([^/]+)\//)?.[1] || "default";
      profiles[key] = { ...data.profileInfo, scrapedAt: new Date().toISOString() };
    }

    const saveData = {
      listingUrls: merged,
      listingMeta: mergedMeta,
      profileProfiles: profiles,
      // Keep profileInfo as the most-recently-scraped one for backward compat
      profileInfo: data.profileInfo || null
    };

    await chrome.storage.local.set(saveData);
    await appendLog(`Scraped ${data.editUrls.length} listing(s) — ${brandNew.length} new, added to top. Total: ${merged.length}${data.profileInfo?.username ? ` · Updated profile: ${data.profileInfo.username}` : ""}.`);

    await setProgress({ stage: "done", message: `Done! ${data.editUrls.length} listings imported.`, percent: 100 });
    await sleep(1500);
    await clearProgress();

    return { ok: true, found: data.editUrls.length, total: merged.length, profileInfo: data.profileInfo };
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

      await sleep(randomBetween(6000, 9000));
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
