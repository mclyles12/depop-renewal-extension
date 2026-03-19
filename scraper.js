// scraper.js — injected into a Depop profile page
// NOTE: Cannot use async IIFE as top level — executeScript won't capture the return value.
// Instead we use a sync wrapper that stores result and returns a Promise via callback pattern.

function depopScraper() {
  return new Promise(async (resolve) => {
    const SCROLL_PAUSE = 2500;
    const MAX_ATTEMPTS = 80;
    const STABLE_ROUNDS = 4;

    function getListings() {
      const links = document.querySelectorAll('a[href*="/products/"]');
      const seen = new Set();
      const results = [];

      links.forEach(a => {
        const href = a.href;
        if (
          /\/products\/[^/]+\/$/.test(href) &&
          !href.includes('/products/create') &&
          !href.includes('/products/edit') &&
          !seen.has(href)
        ) {
          seen.add(href);
          const img = a.querySelector('img');
          const imageUrl = (img?.src && img.src.startsWith('http') ? img.src : null)
            || img?.dataset?.src
            || img?.dataset?.lazySrc
            || null;
          const priceEl = a.querySelector('[class*="price"], [class*="Price"]');
          const price = priceEl?.innerText?.trim() || "";
          const title = img?.alt?.trim() || "";
          results.push({ productUrl: href, imageUrl, title, price });
        }
      });

      return results;
    }

    function toEditUrl(productUrl) {
      const match = productUrl.match(/\/products\/([^/]+)\//);
      if (!match) return null;
      return `https://www.depop.com/products/edit/${match[1]}/`;
    }

    // Wait for images to load
    await new Promise(r => {
      const imgs = document.querySelectorAll('a[href*="/products/"] img');
      if (!imgs.length) { r(); return; }
      let loaded = 0;
      const total = Math.min(imgs.length, 6);
      const done = () => { if (++loaded >= total) r(); };
      imgs.forEach((img, i) => {
        if (i >= total) return;
        if (img.complete && img.naturalWidth > 0) { done(); return; }
        img.addEventListener('load', done);
        img.addEventListener('error', done);
      });
      setTimeout(r, 4000);
    });

    // Scroll to top
    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 1000));

    let lastCount = 0;
    let stableRounds = 0;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // Method 1: scroll window to bottom
      window.scrollTo(0, document.body.scrollHeight);

      // Method 2: scroll any scrollable containers
      document.querySelectorAll('main, [class*="shop"], [class*="Shop"], [class*="grid"], [class*="list"]').forEach(el => {
        el.scrollTop = el.scrollHeight;
      });

      // Method 3: scroll the document element itself
      document.documentElement.scrollTop = document.documentElement.scrollHeight;

      // Method 4: manually dispatch scroll event to trigger IntersectionObserver
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));

      // Method 5: find and click any "load more" button if present
      const loadMore = Array.from(document.querySelectorAll('button')).find(b =>
        b.innerText?.toLowerCase().includes('load more') ||
        b.innerText?.toLowerCase().includes('show more')
      );
      if (loadMore) loadMore.click();

      await new Promise(r => setTimeout(r, SCROLL_PAUSE));

      const currentCount = getListings().length;
      if (currentCount === lastCount) {
        stableRounds++;
        if (stableRounds >= STABLE_ROUNDS) break;
      } else {
        stableRounds = 0;
        lastCount = currentCount;
      }
    }

    window.scrollTo(0, 0);

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

    resolve({ editUrls, meta, count: editUrls.length });
  });
}

// Return the promise — executeScript captures the resolved value
depopScraper();

