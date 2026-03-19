function depopScraper() {
  return new Promise(async (resolve) => {
    const SCROLL_PAUSE = 2500;
    const MAX_ATTEMPTS = 80;
    const STABLE_ROUNDS = 4;

    function getListings() {
      const soldSection = [...document.querySelectorAll('p')]
        .find(p => p.innerText.toLowerCase().includes('sold items'))
        ?.closest('section');

      const links = document.querySelectorAll('a[href*="/products/"]');
      const seen = new Set();
      const results = [];

      links.forEach(a => {
        if (soldSection && soldSection.contains(a)) return;

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

    window.scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 1000));

    let lastCount = 0;
    let stableRounds = 0;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      window.scrollTo(0, document.body.scrollHeight);

      document.querySelectorAll('main, [class*="shop"], [class*="Shop"], [class*="grid"], [class*="list"]').forEach(el => {
        el.scrollTop = el.scrollHeight;
      });

      document.documentElement.scrollTop = document.documentElement.scrollHeight;

      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));

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

window.__depopScraperResult = null;

depopScraper().then(result => {
  window.__depopScraperResult = result;
});