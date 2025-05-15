
const capsuleTokenInput = document.getElementById("capsuleToken");

const feedInput = document.getElementById("feedInput");
const addFeedBtn = document.getElementById("addFeedBtn");
const feedListUI = document.getElementById("feedListUI");
const intervalSelect = document.getElementById("intervalSelect");
const notifyToggle = document.getElementById("notifyToggle");
const soundToggle = document.getElementById("soundToggle");
const snoozeSelect = document.getElementById("snoozeSelect");
const exportJsonBtn = document.getElementById("exportJson");
const exportCsvBtn = document.getElementById("exportCsv");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");
const keyInput        = document.getElementById('openaiKey');
const summariesToggle = document.getElementById('enableSummaries');

let feeds = [];

function updateFeedList() {
  feedListUI.innerHTML = "";
  feeds.forEach((feed, index) => {
    const li = document.createElement("li");
    li.textContent = feed;
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✖";
    removeBtn.style.marginLeft = "8px";
    removeBtn.onclick = () => {
      feeds.splice(index, 1);
      updateFeedList();
    };
    li.appendChild(removeBtn);
    feedListUI.appendChild(li);
  });
}

addFeedBtn.addEventListener("click", () => {
  const newFeed = feedInput.value.trim();
  if (newFeed && !feeds.includes(newFeed)) {
    feeds.push(newFeed);
    feedInput.value = "";
    updateFeedList();
  }
});

saveBtn.addEventListener("click", () => {
  const interval = parseInt(intervalSelect.value);
  const capsuleToken = capsuleTokenInput.value.trim();
  const notificationsEnabled = notifyToggle.checked;
  const soundEnabled = soundToggle.checked;
  const snoozeMinutes = parseInt(snoozeSelect.value);
  const snoozeUntil = snoozeMinutes > 0 ? Date.now() + snoozeMinutes * 60000 : 0;

  chrome.storage.local.set({ capsuleToken,
    feeds,
    interval,
    notificationsEnabled,
    soundEnabled,
    snoozeUntil
  }, () => {
    chrome.runtime.sendMessage({ type: "settingsUpdated" });
    saveStatus.textContent = "✅ Settings saved!";
    setTimeout(() => saveStatus.textContent = "", 2000);
  });
});

chrome.storage.local.get(["feeds", "capsuleToken", "interval", "notificationsEnabled", "soundEnabled", "snoozeUntil"], (data) => {
  feeds = data.feeds || [];
  capsuleTokenInput.value = data.capsuleToken || "";
  intervalSelect.value = data.interval || "1";
  notifyToggle.checked = data.notificationsEnabled !== false;
  soundToggle.checked = data.soundEnabled !== false;
  updateFeedList();
});

// Restore saved values
chrome.storage.local.get(
  ['openaiKey','enableSummaries'],
  ({ openaiKey = '', enableSummaries = false }) => {
    keyInput.value = openaiKey;
    summariesToggle.checked = enableSummaries;
  }
);

// Save whenever they change
keyInput.addEventListener('input', () => {
  chrome.storage.local.set({ openaiKey: keyInput.value });
});

summariesToggle.addEventListener('change', () => {
  chrome.storage.local.set({ enableSummaries: summariesToggle.checked });
});

exportJsonBtn.addEventListener("click", () => {
  chrome.storage.local.get(["rssItems"], (data) => {
    const blob = new Blob([JSON.stringify(data.rssItems || [], null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    downloadFile(url, "rss_feed_export.json");
  });
});

exportCsvBtn.addEventListener("click", () => {
  chrome.storage.local.get(["rssItems"], (data) => {
    const rows = [["Title", "Link", "Date", "Read", "Saved"]];
    (data.rssItems || []).forEach(item => {
      rows.push([item.title, item.link, item.date, item.read, item.saved]);
    });
    const csv = rows.map(r => r.map(cell => `"${cell}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    downloadFile(url, "rss_feed_export.csv");
  });
});

function downloadFile(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}