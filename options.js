const capsuleTokenInput = document.getElementById("capsuleToken");
const capsuleWebBaseUrlInput = document.getElementById("capsuleWebBaseUrl");
const intervalSelect = document.getElementById("intervalSelect");
const notifyToggle = document.getElementById("notifyToggle");
const soundToggle = document.getElementById("soundToggle");
const snoozeSelect = document.getElementById("snoozeSelect");
const exportJsonBtn = document.getElementById("exportJson");
const exportCsvBtn = document.getElementById("exportCsv");
const saveBtn = document.getElementById("saveBtn");
const saveStatus = document.getElementById("saveStatus");
const keyInput = document.getElementById("openaiKey");
const summariesToggle = document.getElementById("enableSummaries");
const emailClientSelect = document.getElementById("emailClient");
const notifyPriorityThresholdSelect = document.getElementById("notifyPriorityThreshold");
const showMediumInFeedToggle = document.getElementById("showMediumInFeed");
const hideLowPriorityInFeedToggle = document.getElementById("hideLowPriorityInFeed");
const alwaysShowReplyNeededToggle = document.getElementById("alwaysShowReplyNeeded");
const calendarShortcutModeSelect = document.getElementById("calendarShortcutMode");
const enableDigestAutomationToggle = document.getElementById("enableDigestAutomation");
const morningDigestHourSelect = document.getElementById("morningDigestHour");
const middayDigestHourSelect = document.getElementById("middayDigestHour");
const endOfDayDigestHourSelect = document.getElementById("endOfDayDigestHour");

function applyTheme(theme) {
  document.body.classList.remove("theme-dark", "theme-light");
  document.body.classList.add(theme === "dark" ? "theme-dark" : "theme-light");
}

function showStatus(message, isError = false) {
  saveStatus.textContent = message;
  saveStatus.classList.toggle("error", isError);

  window.clearTimeout(showStatus.timeoutId);
  showStatus.timeoutId = window.setTimeout(() => {
    saveStatus.textContent = "";
    saveStatus.classList.remove("error");
  }, 2500);
}

function getRemainingSnoozeMinutes(snoozeUntil) {
  if (!snoozeUntil || snoozeUntil <= Date.now()) {
    return "0";
  }

  const remainingMinutes = Math.ceil((snoozeUntil - Date.now()) / 60000);
  const allowedValues = [15, 30, 60, 120];
  const selected = allowedValues.find(value => remainingMinutes <= value);
  return String(selected || 120);
}

function escapeCsvCell(value) {
  const stringValue = value == null ? "" : String(value);
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function normalizeCapsuleWebBaseUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch (error) {
    return null;
  }
}

async function loadSettings() {
  const localData = await chrome.storage.local.get([
    "interval",
    "notificationsEnabled",
    "soundEnabled",
    "snoozeUntil",
    "enableSummaries",
    "theme",
    "capsuleToken",
    "capsuleWebBaseUrl",
    "openaiKey",
    "emailClient",
    "notifyPriorityThreshold",
    "showMediumInFeed",
    "hideLowPriorityInFeed",
    "alwaysShowReplyNeeded",
    "calendarShortcutMode",
    "enableDigestAutomation",
    "morningDigestHour",
    "middayDigestHour",
    "endOfDayDigestHour"
  ]);

  applyTheme(localData.theme);
  capsuleTokenInput.value = localData.capsuleToken || "";
  capsuleWebBaseUrlInput.value = localData.capsuleWebBaseUrl || "";
  keyInput.value = localData.openaiKey || "";
  intervalSelect.value = String(localData.interval || 1);
  notifyToggle.checked = localData.notificationsEnabled !== false;
  soundToggle.checked = localData.soundEnabled !== false;
  snoozeSelect.value = getRemainingSnoozeMinutes(localData.snoozeUntil || 0);
  summariesToggle.checked = localData.enableSummaries === true;
  emailClientSelect.value = localData.emailClient || "default";
  notifyPriorityThresholdSelect.value = localData.notifyPriorityThreshold || "high";
  showMediumInFeedToggle.checked = localData.showMediumInFeed !== false;
  hideLowPriorityInFeedToggle.checked = localData.hideLowPriorityInFeed !== false;
  alwaysShowReplyNeededToggle.checked = localData.alwaysShowReplyNeeded !== false;
  calendarShortcutModeSelect.value = localData.calendarShortcutMode === "always" ? "always" : "meeting_only";
  enableDigestAutomationToggle.checked = localData.enableDigestAutomation === true;
  morningDigestHourSelect.value = String(Number.isInteger(localData.morningDigestHour) ? localData.morningDigestHour : 8);
  middayDigestHourSelect.value = String(Number.isInteger(localData.middayDigestHour) ? localData.middayDigestHour : 12);
  endOfDayDigestHourSelect.value = String(Number.isInteger(localData.endOfDayDigestHour) ? localData.endOfDayDigestHour : 17);
}

saveBtn.addEventListener("click", async () => {
  const interval = Number.parseInt(intervalSelect.value, 10);
  const capsuleToken = capsuleTokenInput.value.trim();
  const capsuleWebBaseUrl = normalizeCapsuleWebBaseUrl(capsuleWebBaseUrlInput.value);
  const openaiKey = keyInput.value.trim();
  const notificationsEnabled = notifyToggle.checked;
  const soundEnabled = soundToggle.checked;
  const snoozeMinutes = Number.parseInt(snoozeSelect.value, 10);
  const snoozeUntil = snoozeMinutes > 0 ? Date.now() + snoozeMinutes * 60000 : 0;
  const emailClient = emailClientSelect.value || "default";
  const notifyPriorityThreshold = notifyPriorityThresholdSelect.value || "high";

  if (capsuleWebBaseUrl === null) {
    showStatus("Capsule Web App URL must be a valid URL.", true);
    return;
  }

  capsuleWebBaseUrlInput.value = capsuleWebBaseUrl;

  await chrome.storage.local.set({
    capsuleToken,
    capsuleWebBaseUrl,
    openaiKey,
    interval,
    notificationsEnabled,
    soundEnabled,
    snoozeUntil,
    enableSummaries: summariesToggle.checked,
    emailClient,
    notifyPriorityThreshold,
    showMediumInFeed: showMediumInFeedToggle.checked,
    hideLowPriorityInFeed: hideLowPriorityInFeedToggle.checked,
    alwaysShowReplyNeeded: alwaysShowReplyNeededToggle.checked,
    calendarShortcutMode: calendarShortcutModeSelect.value === "always" ? "always" : "meeting_only",
    enableDigestAutomation: enableDigestAutomationToggle.checked,
    morningDigestHour: Number.parseInt(morningDigestHourSelect.value, 10) || 8,
    middayDigestHour: Number.parseInt(middayDigestHourSelect.value, 10) || 12,
    endOfDayDigestHour: Number.parseInt(endOfDayDigestHourSelect.value, 10) || 17
  });

  await chrome.storage.local.remove(["rssItems", "capsuleTasks", "runtimeStatus"]);

  const response = await chrome.runtime.sendMessage({ type: "settingsUpdated" });
  if (!response?.ok) {
    showStatus(response?.error || "Settings saved, but the background worker did not reload cleanly.", true);
    return;
  }

  showStatus("Settings saved.");
});

summariesToggle.addEventListener("change", async () => {
  await chrome.storage.local.set({ enableSummaries: summariesToggle.checked });
});

keyInput.addEventListener("input", async () => {
  await chrome.storage.local.set({ openaiKey: keyInput.value.trim() });
});

capsuleTokenInput.addEventListener("input", async () => {
  await chrome.storage.local.set({ capsuleToken: capsuleTokenInput.value.trim() });
});

capsuleWebBaseUrlInput.addEventListener("input", async () => {
  const capsuleWebBaseUrl = normalizeCapsuleWebBaseUrl(capsuleWebBaseUrlInput.value);
  if (capsuleWebBaseUrl !== null) {
    await chrome.storage.local.set({ capsuleWebBaseUrl });
  }
});

exportJsonBtn.addEventListener("click", async () => {
  const { rssItems = [] } = await chrome.storage.local.get("rssItems");
  const blob = new Blob([JSON.stringify(rssItems, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  downloadFile(url, "capsule_activity_export.json");
});

exportCsvBtn.addEventListener("click", async () => {
  const { rssItems = [] } = await chrome.storage.local.get("rssItems");
  const rows = [["Title", "Link", "Date", "Read", "Saved", "Deleted", "Summary", "Priority", "Category", "Needs Reply", "Task Needed"]];

  for (const item of rssItems) {
    rows.push([
      item.title,
      item.link,
      item.date,
      item.read,
      item.saved,
      item.deleted,
      item.summary || item.snippet || "",
      item.ai?.priority || "",
      item.ai?.category || "",
      item.ai?.needsReply || false,
      item.ai?.taskNeeded || false
    ]);
  }

  const csv = rows
    .map(row => row.map(escapeCsvCell).join(","))
    .join("\n");

  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  downloadFile(url, "capsule_activity_export.csv");
});

function downloadFile(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

loadSettings();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.theme) {
    applyTheme(changes.theme.newValue);
  }
});
