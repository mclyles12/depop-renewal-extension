# Depop Listing Renewer — Chrome Extension

Automatically "renews" your Depop listings by re-saving them on a schedule, 
pushing their last-modified date forward and refreshing their visibility in search.

---

## How It Works

Depop sorts search results partially by recency. This extension opens each of 
your listing edit pages in a background tab and programmatically clicks the Save 
button — the same action as manually editing and re-saving a listing.

**Schedule:** Every 4 hours (configurable in background.js → `INTERVAL_MINUTES`)

---

## Installation

1. Open Chrome and go to: `chrome://extensions`
2. Enable **Developer Mode** (toggle, top-right)
3. Click **Load unpacked**
4. Select the `depop-renewal-extension` folder
5. The extension icon will appear in your toolbar

---

## Setup

1. Click the extension icon in the toolbar
2. **Add listing URLs** — paste each listing's edit page URL:
   - Format: `https://www.depop.com/products/YOUR-SLUG/edit/`
   - You can also paste just the slug: `depop.com/products/abc123/edit/`
3. Toggle the switch **ON** to enable auto-renewal every 4 hours
4. Hit **Renew Now** to run immediately

---

## Finding Your Edit Page URLs

1. Go to your Depop profile → tap a listing → Edit
2. Copy the URL from your browser's address bar
3. It should look like: `https://www.depop.com/products/username-itemname-abc123/edit/`

---

## Limitations & Notes

- The extension opens each listing in a **background tab** to save it. You'll 
  briefly see tabs open and close — this is normal.
- Depop must be **logged in** in Chrome for this to work.
- If Depop updates their site layout and changes the Save button, the extension 
  may stop working. Check the Activity Log for errors.
- The extension runs the background service worker when Chrome is open. It will 
  not run if Chrome is closed.
- This uses the same action as manually saving — no unofficial APIs or 
  ToS-violating scraping.

---

## Files

```
depop-renewal-extension/
├── manifest.json      — Extension config
├── background.js      — Service worker: scheduling, renewal logic
├── content.js         — Content script (runs on edit pages)
├── popup.html         — Toolbar popup UI
├── popup.js           — Popup logic
└── icons/             — Extension icons
```

---

## Adjusting the Interval

Open `background.js` and change line 4:

```js
const INTERVAL_MINUTES = 4 * 60; // change 4 to any number of hours
```

Then reload the extension in `chrome://extensions`.
