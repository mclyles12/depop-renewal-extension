let listings = [];
let meta = {};
let dragSrc = null;
let progressPoller = null;

async function init() {
  const data = await getStorage(["listingUrls", "listingMeta", "progress"]);
  listings = data.listingUrls || [];
  meta = data.listingMeta || {};

  if (!listings.length) {
    document.getElementById("emptyState").classList.add("visible");
    document.getElementById("statusText").textContent = "No listings loaded";
    return;
  }

  renderGrid();
  updateStatus();

  if (data.progress) renderProgress(data.progress);
}

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

    const pos = document.createElement("div");
    pos.className = "item-position";
    pos.textContent = `#${index + 1}`;
    item.appendChild(pos);

    if (info.imageUrl) {
      const img = document.createElement("img");
      img.className = "item-img";
      img.src = info.imageUrl;
      img.alt = info.title || "";
      img.onerror = () => { img.replaceWith(makePlaceholder()); };
      item.appendChild(img);
    } else {
      item.appendChild(makePlaceholder());
    }

    const infoDiv = document.createElement("div");
    infoDiv.className = "item-info";
    const title = document.createElement("div");
    title.className = "item-title";
    const slug = editUrl.match(/\/products\/edit\/([^/]+)\//)?.[1] || editUrl;
    title.textContent = info.title && info.title !== "Untitled" ? info.title : slug;
    title.title = title.textContent;
    const price = document.createElement("div");
    price.className = "item-price";
    price.textContent = info.price || "";
    infoDiv.appendChild(title);
    infoDiv.appendChild(price);
    item.appendChild(infoDiv);

    item.addEventListener("dragstart", onDragStart);
    item.addEventListener("dragover", onDragOver);
    item.addEventListener("drop", onDrop);
    item.addEventListener("dragend", onDragEnd);

    grid.appendChild(item);
  });
}

function makePlaceholder() {
  const ph = document.createElement("div");
  ph.className = "item-img-placeholder";
  ph.textContent = "🛍";
  return ph;
}

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
  const from = parseInt(dragSrc.dataset.index, 10);
  const to = parseInt(this.dataset.index, 10);
  const moved = listings.splice(from, 1)[0];
  listings.splice(to, 0, moved);
  renderGrid();
  updateStatus();
  setLog("Order updated — hit Save Order to keep it.", "");
}

function onDragEnd() {
  document.querySelectorAll(".grid-item").forEach(el => el.classList.remove("dragging", "drag-over"));
}

document.getElementById("saveOrderBtn").addEventListener("click", async () => {
  await setStorage({ listingUrls: listings });
  chrome.runtime.sendMessage({ action: "setListings", urls: listings });
  setLog("✓ Order saved successfully.", "success");
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  const data = await getStorage(["listingUrls"]);
  listings = data.listingUrls || [];
  renderGrid();
  updateStatus();
  setLog("Order reset.", "");
});

document.getElementById("renewBtn").addEventListener("click", async () => {
  if (!listings.length) return;

  await setStorage({ listingUrls: listings });
  chrome.runtime.sendMessage({ action: "setListings", urls: listings });

  document.getElementById("psaBanner").classList.add("visible");
  document.getElementById("renewBtn").disabled = true;
  document.getElementById("renewBtn").textContent = "Renewing...";
  setLog("Starting renewal...", "");

  chrome.runtime.sendMessage({ action: "runNow" });
  startProgressPoller();
});

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
          document.getElementById("renewBtn").disabled = false;
          document.getElementById("renewBtn").textContent = "⟳ Renew in This Order";
        }, 1800);
      }
    } else {
      stopProgressPoller();
      clearProgressUI();
      document.getElementById("psaBanner").classList.remove("visible");
      document.getElementById("renewBtn").disabled = false;
      document.getElementById("renewBtn").textContent = "⟳ Renew in This Order";
    }

    if (data.log?.length) {
      const last = data.log[data.log.length - 1];
      setLog(last.msg, last.msg.startsWith("✓") || last.msg.includes("Done") ? "success" : last.msg.startsWith("✗") ? "error" : "");
    }
  }, 800);
}

function stopProgressPoller() {
  if (progressPoller) {
    clearInterval(progressPoller);
    progressPoller = null;
  }
}

function renderProgress(progress) {
  document.getElementById("progressSection").classList.add("visible");
  document.getElementById("progressMsg").textContent = progress.message || "Working...";
  document.getElementById("progressPct").textContent = `${progress.percent || 0}%`;
  const bar = document.getElementById("progressBar");
  bar.style.width = `${progress.percent || 0}%`;
  bar.classList.toggle("green", progress.stage === "done");
}

function clearProgressUI() {
  document.getElementById("progressSection").classList.remove("visible");
  document.getElementById("progressBar").style.width = "0%";
  document.getElementById("progressBar").classList.remove("green");
}

function updateStatus() {
  document.getElementById("statusText").textContent = `${listings.length} listing${listings.length !== 1 ? "s" : ""} · drag to reorder`;
  const pill = document.getElementById("statusPill");
  pill.textContent = `${listings.length} total`;
  pill.className = listings.length > 0 ? "status-pill green" : "status-pill";
}

function setLog(msg, type) {
  const el = document.getElementById("logStrip");
  el.textContent = msg;
  el.className = "log-strip" + (type ? ` ${type}` : "");
}

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

function setStorage(data) {
  return new Promise(resolve => chrome.storage.local.set(data, resolve));
}

init();
