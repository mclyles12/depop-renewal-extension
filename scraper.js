// scraper.js — injected into a Depop profile page
// Auto-scrolls infinite scroll until all listings are loaded

(async function () {
  const SCROLL_PAUSE = 2500;  // wait 2.5s after each scroll for content to load
  const MAX_ATTEMPTS = 80;    // up to ~200 seconds of scrolling
  const STABLE_ROUNDS = 4;    // stop after 4 consecutive rounds with no new listings

  function getListingUrls() {
    const links = document.querySelectorAll('a[href*="/products/"]');
    const urls = new Set();
    links.forEach(a => {
      const href = a.href;
      if (
        /\/products\/[^/]+\/$/.test(href) &&
        !href.includes('/products/create') &&
        !href.includes('/products/edit')
      ) {
        urls.add(href);
      }
    });
    return Array.from(urls);
  }

  function toEditUrl(productUrl) {
    const match = productUrl.match(/\/products\/([^/]+)\//);
    if (!match) return null;
    return `https://www.depop.com/products/edit/${match[1]}/`;
  }

  // Scroll to top first so we start fresh
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 1000));

  let lastCount = 0;
  let stableRounds = 0;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    // Scroll in increments rather than jumping to bottom
    // This gives Depop's lazy loader time to fire
    const currentHeight = document.body.scrollHeight;
    window.scrollTo(0, currentHeight);

    await new Promise(r => setTimeout(r, SCROLL_PAUSE));

    // Also try scrolling the main content container if it exists
    const scroller = document.querySelector('main') || document.querySelector('[class*="shop"]') || document.body;
    scroller.scrollTop = scroller.scrollHeight;

    const currentCount = getListingUrls().length;

    if (currentCount === lastCount) {
      stableRounds++;
      if (stableRounds >= STABLE_ROUNDS) break;
    } else {
      stableRounds = 0;
      lastCount = currentCount;
    }
  }

  // Scroll back to top
  window.scrollTo(0, 0);

  const productUrls = getListingUrls();
  const editUrls = productUrls.map(toEditUrl).filter(Boolean);

  return { editUrls, productUrls, count: editUrls.length };
})();
