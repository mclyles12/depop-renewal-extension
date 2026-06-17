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
const HUMAN_DELAY_MIN = 5000;
const HUMAN_DELAY_MAX = 15000;
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
      progress: null,
      speedMultiplier: 1.0
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
  if (msg.action === "setSpeedMultiplier") {
    chrome.storage.local.set({ speedMultiplier: msg.multiplier }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.action === "scrapeProfile") {
    scrapeProfile(msg.profileUrl).then(sendResponse);
    return true;
  }
  if (msg.action === "exportListings") {
    exportListings().then(sendResponse);
    return true;
  }
  if (msg.action === "getStatus") {
    chrome.storage.local.get(["enabled", "listingUrls", "listingMeta", "profileInfo", "profileProfiles", "lastRun", "nextRun", "log", "interval", "progress", "speedMultiplier"]).then(sendResponse);
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


// --- Export listing data from edit pages ---
async function exportListings() {
  const { listingUrls, listingMeta, profileInfo, profileProfiles } = await chrome.storage.local.get([
    "listingUrls",
    "listingMeta",
    "profileInfo",
    "profileProfiles"
  ]);

  const urls = listingUrls || [];
  const meta = listingMeta || {};
  if (!urls.length) {
    return { ok: false, error: "No listings saved yet. Scrape your Depop profile first." };
  }

  stopRequested = false;
  const total = urls.length;
  const exported = [];
  const failed = [];

  await appendLog(`Starting export of ${total} listing(s)...`);
  await setProgress({ stage: "exporting", message: `Exporting listing 1 of ${total}...`, percent: 0, current: 0, total });

  for (let i = 0; i < urls.length; i++) {
    if (stopRequested) {
      await clearProgress();
      return { ok: false, error: `Export stopped after ${i} listing(s).`, partial: exported };
    }

    const editUrl = urls[i];
    const percent = Math.round((i / total) * 100);
    await setProgress({
      stage: "exporting",
      message: `Exporting ${i + 1} of ${total}...`,
      percent,
      current: i + 1,
      total
    });

    let tab = null;
    try {
      tab = await openTabHidden(editUrl);
      await sleep(2500);

      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrapeListingEditPage
      });

      const details = result?.[0]?.result || {};
      const base = meta[editUrl] || {};
      exported.push(normalizeExportListing(editUrl, base, details, i));
      await appendLog(`Exported: ${urlToLabel(editUrl)}`);
    } catch (e) {
      failed.push({ editUrl, error: e.message });
      exported.push(normalizeExportListing(editUrl, meta[editUrl] || {}, { scrapeError: e.message }, i));
      await appendLog(`Export failed for ${urlToLabel(editUrl)}: ${e.message}`);
    } finally {
      if (tab?.id) {
        try { await chrome.tabs.remove(tab.id); } catch (_) {}
      }
    }

    await sleep(700);
  }

  const exportData = {
    schema: "depop-shop-export/v1",
    exportedAt: new Date().toISOString(),
    source: "Depop Listing Renewer",
    profile: profileInfo || newestProfile(profileProfiles) || null,
    counts: {
      listings: exported.length,
      failed: failed.length
    },
    listings: exported,
    failed
  };

  await appendLog(`Export ready - ${exported.length} listing(s), ${failed.length} failed.`);
  await setProgress({ stage: "done", message: `Export ready: ${exported.length} listing(s).`, percent: 100, current: total, total });
  await sleep(1200);
  await clearProgress();

  return { ok: true, exportData };
}

function normalizeExportListing(editUrl, base, details, index) {
  const slug = base.slug || editUrl.match(/\/products\/edit\/([^/]+)\//)?.[1] || "";
  const fields = details.fields || {};
  const photos = uniqueStrings([
    ...(details.photos || []),
    base.imageUrl
  ]).map((url, photoIndex) => ({
    url: upgradeExportImageUrl(url),
    sourceUrl: url,
    position: photoIndex + 1
  }));

  const description = firstValue(fields, ["description", "details", "item description", "describe your item"]);
  const title = firstValue(fields, ["title", "item title", "name"]) || base.title || slug;
  const price = firstValue(fields, ["price", "sale price", "item price"]) || base.price || "";
  const colors = collectValues(fields, ["colour", "color", "colours", "colors"]);

  return {
    id: slug,
    slug,
    position: index + 1,
    productUrl: base.productUrl || editUrl.replace("/products/edit/", "/products/"),
    editUrl,
    title,
    description,
    price,
    colors,
    photos,
    attributes: fields,
    raw: details.raw || {},
    scrapeError: details.scrapeError || null
  };
}

function scrapeListingEditPage() {
  const fields = {};
  const raw = {
    title: document.title,
    url: location.href
  };

  function unique(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
  }

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function keyFromElement(el) {
    const labels = [];
    if (el.id) {
      const escapedId = window.CSS?.escape ? CSS.escape(el.id) : el.id.replace(/"/g, '\\"');
      const label = document.querySelector(`label[for="${escapedId}"]`);
      if (label) labels.push(label.innerText);
    }
    const wrappingLabel = el.closest("label");
    if (wrappingLabel) labels.push(wrappingLabel.innerText);
    labels.push(
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.name,
      el.id
    );

    const group = el.closest("[role='group'], fieldset, div");
    const groupLabel = group?.querySelector("legend, label, h2, h3, p")?.innerText;
    labels.push(groupLabel);

    const labelText = clean(labels.find(Boolean) || "");
    return labelText
      .replace(/\*/g, "")
      .replace(/[^a-z0-9]+/gi, " ")
      .trim()
      .toLowerCase();
  }

  function addField(key, value) {
    key = clean(key).toLowerCase();
    value = clean(value);
    if (!key || !value) return;
    if (!fields[key]) fields[key] = value;
    else if (fields[key] !== value) fields[key] = `${fields[key]} | ${value}`;
  }

  document.querySelectorAll("input, textarea, select").forEach(el => {
    if (el.type === "hidden" || el.type === "file" || el.type === "button" || el.type === "submit") return;
    if ((el.type === "checkbox" || el.type === "radio") && !el.checked) return;

    let value = "";
    if (el.tagName === "SELECT") {
      value = Array.from(el.selectedOptions).map(o => o.innerText || o.value).join(", ");
    } else if (el.type === "checkbox" || el.type === "radio") {
      value = el.value || "selected";
    } else {
      value = el.value || el.getAttribute("value") || "";
    }
    addField(keyFromElement(el), value);
  });

  document.querySelectorAll("[contenteditable='true']").forEach(el => {
    addField(keyFromElement(el), el.innerText);
  });

  document.querySelectorAll("[aria-pressed='true'], [aria-selected='true']").forEach(el => {
    const text = clean(el.innerText || el.getAttribute("aria-label"));
    const group = el.closest("[role='group'], fieldset, div");
    const groupLabel = clean(group?.querySelector("legend, label, h2, h3, p")?.innerText || "");
    if (text && groupLabel && text !== groupLabel) addField(groupLabel, text);
  });

  const photos = unique(Array.from(document.querySelectorAll("img"))
    .filter(img => {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      return w >= 80 && h >= 80;
    })
    .map(img => img.currentSrc || img.src || img.getAttribute("src"))
    .filter(src => src && /^https?:\/\//.test(src))
    .filter(src => /depop|cloudinary|image|img|cdn/i.test(src))
  );

  const nextData = document.getElementById("__NEXT_DATA__")?.textContent;
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData);
      raw.nextData = {
        present: true,
        topLevelKeys: Object.keys(parsed),
        buildId: parsed.buildId || null
      };
    } catch (_) {
      raw.nextData = "unparseable";
    }
  }

  return { fields, photos, raw };
}

function firstValue(fields, names) {
  for (const name of names) {
    const exact = fields[name];
    if (exact) return exact;
    const fuzzyKey = Object.keys(fields).find(k => k.includes(name));
    if (fuzzyKey) return fields[fuzzyKey];
  }
  return "";
}

function collectValues(fields, names) {
  const values = [];
  names.forEach(name => {
    Object.keys(fields).forEach(key => {
      if (key.includes(name)) values.push(...String(fields[key]).split("|"));
    });
  });
  return uniqueStrings(values.map(v => v.trim()).filter(Boolean));
}

function uniqueStrings(values) {
  return Array.from(new Set((values || []).filter(Boolean)));
}

function upgradeExportImageUrl(url) {
  if (!url) return url;
  return url.replace(/\/P\d+\.jpg(\?.*)?$/, "/P0.jpg$1");
}

function newestProfile(profileProfiles) {
  const profiles = Object.values(profileProfiles || {});
  if (!profiles.length) return null;
  profiles.sort((a, b) => new Date(b.scrapedAt || 0) - new Date(a.scrapedAt || 0));
  return profiles[0];
}

// --- Core renewal (reverse order) ---
async function runRenewal() {
  const { listingUrls, speedMultiplier } = await chrome.storage.local.get(["listingUrls", "speedMultiplier"]);
  const multiplier = speedMultiplier || 1.0;
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
      await sleep(Math.round(2000 * multiplier));

      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: clickSaveButton
      });

      await sleep(randomBetween(Math.round(3000 * multiplier), Math.round(6000 * multiplier)));
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

    await sleep(randomBetween(Math.round(HUMAN_DELAY_MIN * multiplier), Math.round(HUMAN_DELAY_MAX * multiplier)));
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
