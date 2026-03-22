// layout.js — Depop Renewer Layout Manager v1.5

let listings = [];
let meta = {};
let profileInfo = null;
let dragSrc = null;
let progressPoller = null;

async function init() {
  const data = await getStorage(["listingUrls", "listingMeta", "profileInfo", "profileProfiles", "progress"]);
  listings = data.listingUrls || [];
  meta = data.listingMeta || {};

  // Use profileInfo directly, or pick the most recently scraped from profileProfiles
  profileInfo = data.profileInfo || null;
  if (!profileInfo && data.profileProfiles) {
    const profiles = Object.values(data.profileProfiles);
    if (profiles.length) {
      profiles.sort((a, b) => new Date(b.scrapedAt || 0) - new Date(a.scrapedAt || 0));
      profileInfo = profiles[0];
    }
  }

  renderProfile();

  if (!listings.length) {
    document.getElementById("emptyState").classList.add("visible");
    document.getElementById("listingBarCount").textContent = "";
    return;
  }

  renderGrid();
  updateListingBar();

  if (data.progress) renderProgress(data.progress);
}

// ── Profile header ──────────────────────────────────────────────

function renderProfile() {
  const topEl = document.getElementById("profileTop");
  const metaEl = document.getElementById("profileMeta");

  if (!profileInfo || !profileInfo.username) {
    // Keep skeleton — no profile scraped yet
    topEl.innerHTML = `
      <div class="skeleton skeleton-avatar"></div>
      <div class="skeleton-lines">
        <div class="skeleton skeleton-line" style="width:130px"></div>
        <div class="skeleton skeleton-line" style="width:100px"></div>
        <div class="skeleton skeleton-line" style="width:180px"></div>
      </div>
    `;
    metaEl.innerHTML = "";
    return;
  }

  const p = profileInfo;

  // Avatar
  const avatarHtml = p.avatarUrl
    ? `<img class="avatar" src="${upgradeImageUrl(p.avatarUrl)}" alt="${p.username}" onerror="this.replaceWith(makePlaceholderAvatar())">`
    : `<div class="avatar-placeholder">🛍</div>`;

  // Stars
  const rating = typeof p.rating === "number" ? p.rating : 5;
  const starsHtml = [1,2,3,4,5].map(i =>
    `<span class="star${i > rating ? " empty" : ""}">★</span>`
  ).join("");

  // Signals
  const signalParts = [];
  if (p.sold) signalParts.push(`<span>${p.sold}</span>`);
  if (p.activity) signalParts.push(`<span>${p.activity}</span>`);
  const signalsHtml = signalParts.join(`<span class="signal-sep">·</span>`);

  topEl.innerHTML = `
    ${avatarHtml}
    <div class="shop-info">
      <div class="shop-username">${escHtml(p.username)}</div>
      ${p.rating !== null ? `
        <div class="rating-row">
          <div class="stars">${starsHtml}</div>
          ${p.reviewCount ? `<span class="review-count">(${escHtml(p.reviewCount)})</span>` : ""}
        </div>` : ""}
      ${signalsHtml ? `<div class="signals">${signalsHtml}</div>` : ""}
    </div>
  `;

  // Follows + bio below
  const followsHtml = (p.followers || p.following) ? `
    <div class="follows-row">
      ${p.followers ? `<span class="follow-stat"><strong>${escHtml(p.followers)}</strong> Followers</span>` : ""}
      ${p.following ? `<span class="follow-stat"><strong>${escHtml(p.following)}</strong> Following</span>` : ""}
    </div>` : "";

  const bioHtml = (p.shopName || p.bio) ? `
    <div class="shop-bio">
      ${p.shopName ? `<div class="bio-name">${escHtml(p.shopName)}</div>` : ""}
      ${p.bio ? `<div class="bio-text">${escHtml(p.bio)}</div>` : ""}
    </div>` : "";

  metaEl.innerHTML = followsHtml + bioHtml;
}

function makePlaceholderAvatar() {
  const d = document.createElement("div");
  d.className = "avatar-placeholder";
  d.textContent = "🛍";
  return d;
}

// ── Grid ────────────────────────────────────────────────────────

function renderGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";

  listings.forEach((editUrl, index) => {
    const info = meta[editUrl] || {};
    const item = document.createElement("div");
    item.className = "grid-item";
    item.draggable = true;
    item.dataset.index = index;
    item.dataset.url = editUrl;

    // Image wrap
    const imgWrap = document.createElement("div");
    imgWrap.className = "item-img-wrap";

    // Position input
    const posInput = document.createElement("input");
    posInput.type = "number";
    posInput.className = "item-position";
    posInput.value = index + 1;
    posInput.min = 1;
    posInput.max = listings.length;
    posInput.title = "Type a number and press Enter to move";
    posInput.addEventListener("mousedown", e => e.stopPropagation());
    posInput.addEventListener("dragstart", e => e.stopPropagation());
    posInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        const newPos = parseInt(posInput.value);
        if (!newPos || newPos < 1 || newPos > listings.length) { posInput.value = index + 1; return; }
        const toIndex = newPos - 1;
        if (toIndex === index) return;
        const moved = listings.splice(index, 1)[0];
        listings.splice(toIndex, 0, moved);
        renderGrid();
        updateListingBar();
        setLog(`Moved to position #${newPos} — hit Save Order to keep it.`, "");
        setTimeout(() => {
          const inputs = document.querySelectorAll(".item-position");
          if (inputs[toIndex]) inputs[toIndex].focus();
        }, 50);
      }
      if (e.key === "Escape") { posInput.value = index + 1; posInput.blur(); }
    });
    imgWrap.appendChild(posInput);

    // Image
    if (info.imageUrl) {
      const img = document.createElement("img");
      img.className = "item-img";
      img.src = upgradeImageUrl(info.imageUrl);
      img.alt = info.title || "";
      img.loading = "lazy";
      img.onerror = () => img.replaceWith(makePlaceholderImg());
      imgWrap.appendChild(img);
    } else {
      imgWrap.appendChild(makePlaceholderImg());
    }

    item.appendChild(imgWrap);

    // Info below image
    const infoDiv = document.createElement("div");
    infoDiv.className = "item-info";

    if (info.price) {
      const price = document.createElement("div");
      price.className = "item-price";
      price.textContent = info.price;
      infoDiv.appendChild(price);
    }

    const slug = editUrl.match(/\/products\/edit\/([^/]+)\//)?.[1] || editUrl;
    const titleEl = document.createElement("div");
    titleEl.className = "item-title";
    titleEl.textContent = (info.title && info.title !== "item listed by maggiemadethis" && info.title.trim())
      ? info.title
      : slug;
    titleEl.title = titleEl.textContent;
    infoDiv.appendChild(titleEl);

    item.appendChild(infoDiv);

    // Drag events
    item.addEventListener("dragstart", onDragStart);
    item.addEventListener("dragover", onDragOver);
    item.addEventListener("drop", onDrop);
    item.addEventListener("dragend", onDragEnd);

    grid.appendChild(item);
  });
}

function upgradeImageUrl(url) {
  if (!url) return url;
  // Depop CDN: swap low-res placeholder (P10) or any Pn suffix for P5 (320w)
  // which is sharp enough for the grid cards without being huge
  return url.replace(/\/P\d+\.jpg$/, '/P5.jpg');
}

function makePlaceholderImg() {
  const ph = document.createElement("div");
  ph.className = "item-img-placeholder";
  ph.textContent = "🛍";
  return ph;
}

// ── Drag and drop ───────────────────────────────────────────────

function onDragStart(e) {
  dragSrc = this;
  this.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", this.dataset.index);
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  document.querySelectorAll(".grid-item").forEach(el => el.classList.remove("drag-over"));
  this.classList.add("drag-over");
}

function onDrop(e) {
  e.preventDefault();
  if (dragSrc === this) return;
  const from = parseInt(dragSrc.dataset.index);
  const to = parseInt(this.dataset.index);
  const moved = listings.splice(from, 1)[0];
  listings.splice(to, 0, moved);
  renderGrid();
  updateListingBar();
  setLog("Order updated — hit Save Order to keep it.", "");
}

function onDragEnd() {
  document.querySelectorAll(".grid-item").forEach(el => el.classList.remove("dragging", "drag-over"));
}

// ── Buttons ─────────────────────────────────────────────────────

document.getElementById("saveOrderBtn").addEventListener("click", async () => {
  await setStorage({ listingUrls: listings });
  chrome.runtime.sendMessage({ action: "setListings", urls: listings });
  setLog("✓ Order saved successfully.", "success");
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  const data = await getStorage(["listingUrls"]);
  listings = data.listingUrls || [];
  renderGrid();
  updateListingBar();
  setLog("Order reset.", "");
});

document.getElementById("renewBtn").addEventListener("click", async () => {
  if (!listings.length) return;
  await setStorage({ listingUrls: listings });
  chrome.runtime.sendMessage({ action: "setListings", urls: listings });

  document.getElementById("psaBanner").classList.add("visible");
  const btn = document.getElementById("renewBtn");
  btn.disabled = true;
  btn.textContent = "Renewing...";
  setLog("Starting renewal...", "");

  chrome.runtime.sendMessage({ action: "runNow" });
  startProgressPoller();
});

// ── Progress poller ─────────────────────────────────────────────

function startProgressPoller() {
  if (progressPoller) clearInterval(progressPoller);
  progressPoller = setInterval(async () => {
    const data = await getStorage(["progress", "log"]);
    if (data.progress) {
      renderProgress(data.progress);
      if (data.progress.stage === "done") {
        setTimeout(() => {
          stopProgressPoller();
          clearProgressUI();
          document.getElementById("psaBanner").classList.remove("visible");
          const btn = document.getElementById("renewBtn");
          btn.disabled = false;
          btn.textContent = "⟳ Renew in This Order";
        }, 1800);
      }
    } else {
      stopProgressPoller();
      clearProgressUI();
      document.getElementById("psaBanner").classList.remove("visible");
      const btn = document.getElementById("renewBtn");
      btn.disabled = false;
      btn.textContent = "⟳ Renew in This Order";
    }
    if (data.log?.length) {
      const last = data.log[data.log.length - 1];
      const type = last.msg.startsWith("✓") || last.msg.includes("Done") ? "success"
                 : last.msg.startsWith("✗") ? "error" : "";
      setLog(last.msg, type);
    }
  }, 800);
}

function stopProgressPoller() {
  if (progressPoller) { clearInterval(progressPoller); progressPoller = null; }
}

function renderProgress(p) {
  document.getElementById("progressWrap").classList.add("visible");
  document.getElementById("progressMsg").textContent = p.message || "Working...";
  document.getElementById("progressPct").textContent = `${p.percent || 0}%`;
  const bar = document.getElementById("progressBar");
  bar.style.width = `${p.percent || 0}%`;
  bar.classList.toggle("green", p.stage === "done");
}

function clearProgressUI() {
  document.getElementById("progressWrap").classList.remove("visible");
  document.getElementById("progressBar").style.width = "0%";
  document.getElementById("progressBar").classList.remove("green");
}

// ── Helpers ──────────────────────────────────────────────────────

function updateListingBar() {
  const count = listings.length;
  document.getElementById("listingBarCount").textContent =
    count ? `(${count} listing${count !== 1 ? "s" : ""})` : "";
}

function setLog(msg, type) {
  const el = document.getElementById("logStrip");
  el.textContent = msg;
  el.className = "log-strip" + (type ? ` ${type}` : "");
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorage(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

init();
