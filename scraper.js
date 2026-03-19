// scraper.js — injected into a Depop profile page
// Auto-scrolls, collects listing URLs AND thumbnail images in one pass

(async function () {
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

        // Grab thumbnail image from within the link element
        const img = a.querySelector('img');
        const imageUrl = img?.src || img?.dataset?.src || null;

        // Grab price if visible
        const priceEl = a.querySelector('[class*="price"], [class*="Price"]');
        const price = priceEl?.innerText?.trim() || "";

        // Grab title/alt text
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

  // Start from top
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 1000));

  let lastCount = 0;
  let stableRounds = 0;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const currentHeight = document.body.scrollHeight;
    window.scrollTo(0, currentHeight);
    await new Promise(r => setTimeout(r, SCROLL_PAUSE));

    // Also try the main content container
    const scroller = document.querySelector('main') ||
                     document.querySelector('[class*="shop"]') ||
                     document.body;
    scroller.scrollTop = scroller.scrollHeight;

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

  return { editUrls, meta, count: editUrls.length };
})();
