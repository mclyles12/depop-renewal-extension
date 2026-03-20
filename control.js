// control.js — persistent renewal control window

let poller = null;
let lastLogCount = 0;
let isDone = false;

async function init() {
  poller = setInterval(poll, 800);
}

async function poll() {
  const data = await getStorage(["progress", "log"]);

  if (data.progress) {
    renderProgress(data.progress);
    if (data.progress.stage === "done") {
      markDone();
    }
  } else if (!data.progress && isDone) {
    clearInterval(poller);
  }

  if (data.log) renderLog(data.log);
}

function renderProgress(p) {
  document.getElementById("progressMsg").textContent = p.message || "Working...";
  document.getElementById("progressPct").textContent = `${p.percent || 0}%`;
  const bar = document.getElementById("progressBar");
  bar.style.width = `${p.percent || 0}%`;
  bar.classList.toggle("green", p.stage === "done");
}

function renderLog(log) {
  if (log.length === lastLogCount) return;
  lastLogCount = log.length;

  const section = document.getElementById("logSection");
  section.innerHTML = "";

  [...log].reverse().forEach(entry => {
    const row = document.createElement("div");
    row.className = "log-entry";

    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = shortTime(entry.time);

    const msg = document.createElement("span");
    msg.className = "log-msg";
    if (entry.msg.startsWith("✓")) msg.classList.add("success");
    if (entry.msg.startsWith("✗") || entry.msg.startsWith("⏹")) msg.classList.add("error");
    msg.textContent = entry.msg;

    row.appendChild(time);
    row.appendChild(msg);
    section.appendChild(row);
  });
}

function markDone() {
  isDone = true;
  document.getElementById("dot").classList.add("done");
  document.getElementById("headerTitle").textContent = "Renewal Complete";
  document.getElementById("stopBtn").disabled = true;
  document.getElementById("closeBtn").classList.add("visible");
  clearInterval(poller);
}

document.getElementById("stopBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "stopNow" });
  document.getElementById("stopBtn").disabled = true;
  document.getElementById("progressMsg").textContent = "Stopping after current listing...";
  markDone();
});

document.getElementById("closeBtn").addEventListener("click", () => {
  window.close();
});

function shortTime(t) {
  try { return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

init();
