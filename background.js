// background.js

let seenGuids = new Set();
const DEFAULT_INTERVAL = 1;
let lastTabId = null;

// 0) On load, restore lastTabId from storage
chrome.storage.local.get("lastTabId", data => {
  if (data.lastTabId) {
    lastTabId = data.lastTabId;
  }
});

// Apply dock/undock side panel behavior based on stored setting
async function applyDockSetting() {
  const { enableDock = false } = await chrome.storage.local.get("enableDock");
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: enableDock });
  } catch (e) {
    console.warn("[WARN] sidePanel.setPanelBehavior failed", e);
  }
}

// 1) On load, seed seenGuids so we don’t re-notify existing items
chrome.storage.local.get("rssItems", data => {
  (data.rssItems || []).forEach(item => seenGuids.add(item.guid));
});

// 2) Notification click → open/reuse tab
chrome.notifications.onClicked.addListener(notificationId => {
  chrome.storage.local.get("rssItems", data => {
    const item = (data.rssItems || []).find(i => i.guid === notificationId);
    if (item && item.link) {
      openOrUpdateTab(item.link);
    }
  });
});

// 3) Handle popup link clicks to open/reuse a single tab
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "openEntry" && msg.url) {
    openOrUpdateTab(msg.url);
    sendResponse({ ok: true });
    return true;
  }
});

// Helper: open a new tab or update the existing one, and persist its ID
function openOrUpdateTab(url) {
  if (lastTabId !== null) {
    // try updating existing tab
    chrome.tabs.update(lastTabId, { url, active: true }, tab => {
      if (chrome.runtime.lastError || !tab) {
        // tab gone or error → create new
        chrome.tabs.create({ url }, t => {
          lastTabId = t.id;
          chrome.storage.local.set({ lastTabId });
        });
      } else {
        // success
        lastTabId = tab.id;
        chrome.storage.local.set({ lastTabId });
      }
    });
  } else {
    // first time: open new
    chrome.tabs.create({ url }, t => {
      lastTabId = t.id;
      chrome.storage.local.set({ lastTabId });
    });
  }
}


// Fetch entries from Capsule API, include author, snippet, smart title & link
async function fetchCapsuleEntries(token) {
  const res = await fetch("https://api.capsulecrm.com/api/v2/entries", {
    headers: {
      "Authorization": "Bearer " + token,
      "Accept":        "application/json"
    }
  });
  if (!res.ok) throw new Error("Capsule API error: " + res.status);

  const json    = await res.json();
  const baseUrl = "https://msi-products.capsulecrm.com";  // your Capsule domain

  return json.entries.map(entry => {
    // 1) Determine party ID (array or singular)
    const partyId = entry.parties?.[0]?.id
                 || entry.party?.id
                 || null;

    // 2) Build a proper link—fallback to the CRM home page
    const link = partyId
      ? `${baseUrl}/party/${partyId}`
      : `${baseUrl}/`;

    // 3) Extract full body & snippet
    const full    = entry.content || "";
    const snippet = full.split("\n")[0].slice(0, 100);

    // 4) Smart title:
    //    - Use entry.subject if present (emails)
    //    - Otherwise: "<Creator Name> Task"
    let title = entry.subject?.trim();
    if (!title) {
      const actor = entry.creator?.name || "Someone";
      title = `${actor} Task`;
    }

    // 5) Date
    const date = entry.updatedAt
               || entry.createdAt
               || new Date().toISOString();

    return {
      title,
      date,
      link,
      guid:    entry.id.toString(),
      author:  entry.creator?.name || "",
      snippet,
      body:    full
    };
  });
}

// Batch-summarize new entries via OpenAI, with robust handling
async function summarizeBatch(items) {
  const { openaiKey, enableSummaries } = await chrome.storage.local.get(
    ['openaiKey','enableSummaries']
  );
  if (!enableSummaries || !openaiKey) return {};

  // 1) Build the payload
  const entriesPayload = items.map(i => ({ guid: i.guid, body: i.body }));
  console.debug('[AI] entriesPayload →', entriesPayload);

  const systemMsg = {
    role: 'system',
    content: 'You are an assistant that produces concise summaries of CRM entries.'
  };
  const userMsg = {
    role: 'user',
    content:
      `Summarize each of these entries in 20–30 words.\n` +
      `Respond with exactly the JSON array of objects ` +
      `with fields "guid" and "summary", and nothing else.\n\n` +
      JSON.stringify(entriesPayload)
  }

  let text = '';
  try {
    console.debug('[AI] Sending request to OpenAI…');
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${openaiKey}`
      },
      body: JSON.stringify({
        model:       'gpt-3.5-turbo',
        messages:    [systemMsg, userMsg],
        max_tokens:  items.length * 200,
        temperature: 0.5
      })
    });

    // 2) Bail on HTTP errors (500, 429, etc.)
    if (!resp.ok) {
      console.error('[AI] HTTP error', resp.status, resp.statusText);
      return {};
    }

    // 3) Grab the assistant’s raw content
    const data = await resp.json();
    console.debug('[AI] full API response →', data);
    text = data.choices?.[0]?.message?.content?.trim() || '';
    console.debug('[AI] raw assistant content →', text);

  } catch (e) {
    console.error('[AI] request failed', e);
    return {};
  }

  // 4) Nothing returned? bail.
  if (!text) {
    console.warn('[AI] empty assistant content');
    return {};
  }

  // 5) Strip any ``` fences
  text = text
    .replace(/^```(?:json)?\r?\n/, '')
    .replace(/\r?\n```$/, '')
    .trim();
  console.debug('[AI] after fence-strip →', text);

  // 6) Auto-close a missing bracket
  if (text.startsWith('[') && !text.endsWith(']')) {
    console.warn('[AI] auto-closing JSON array');
    text += ']';
  }

  // 7) Extract exactly the JSON array
  const m = text.match(/^\s*(\[[\s\S]*\])\s*$/);
  if (!m) {
    console.error('[AI] no valid JSON array found', text);
    return {};
  }
  const jsonArray = m[1];
  console.debug('[AI] JSON array extracted →', jsonArray);

  // 8) Parse safely
  let parsed;
  try {
    parsed = JSON.parse(jsonArray);
    if (!Array.isArray(parsed)) throw new Error('Not an array');
  } catch (e) {
    console.error('[AI] JSON.parse failed', e, '\nRaw JSON text:', jsonArray);
    return {};
  }

  // 9) Build and return guid→summary map
  return parsed.reduce((map, { guid, summary }) => {
    if (guid && summary) map[guid] = summary;
    return map;
  }, {});
}

// Recompute and update the badge based on unread “Recent” (max 10)
function updateBadgeFromStorage() {
  chrome.storage.local.get("rssItems", data => {
    const items = Array.isArray(data.rssItems) ? data.rssItems : [];
    const recent = items
      .filter(p => !p.deleted)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10);

    const unreadCount = recent.filter(p => !p.read).length;
    chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
    chrome.action.setBadgeText({ text: unreadCount ? unreadCount.toString() : "" });
  });
}

// Process new entries, summarize, store, notify, and play sound
async function checkFeed(_, notificationsEnabled, soundEnabled, capsuleToken) {
  try {
    console.log("[DEBUG] Fetching from Capsule API…");
    const entries = await fetchCapsuleEntries(capsuleToken);
    console.log("[DEBUG] Entries received:", entries.length);

    // Identify only truly new items
    const newItems = entries.filter(item => {
      if (!seenGuids.has(item.guid)) {
        seenGuids.add(item.guid);
        return true;
      }
      return false;
    });

    if (!newItems.length) return;

    // 1) AI summaries
    const summaryMap = await summarizeBatch(newItems);
    newItems.forEach(item => {
      item.summary = summaryMap[item.guid] || item.snippet;
    });

    // 2) Store (no cap)
    chrome.storage.local.get("rssItems", data => {
      const existing = Array.isArray(data.rssItems) ? data.rssItems : [];
      const updated  = [...newItems, ...existing];
      chrome.storage.local.set({ rssItems: updated }, updateBadgeFromStorage);
    });

    // 3) Notifications: aggregate into a single "list"
    if (notificationsEnabled) {
      const notifId = "crm-activity-group";  // fixed ID to replace on update
      const displayItems = newItems.slice(0, 5).map(item => ({
        title:   item.title,
        message: item.summary
      }));

      const options = {
        type:       "list",
        iconUrl:    "icons/icon128.png",
        title:      `You have ${newItems.length} new CRM activit${newItems.length === 1 ? "y" : "ies"}`,
        message:    newItems.length > 5
                     ? `And ${newItems.length - 5} more…`
                     : "",
        items:      displayItems,
        priority:   1
      };

      // Create or update the grouped notification
      chrome.notifications.create(notifId, options, () => {
        // no-op callback
      });
    }

    // 4) Play sound once for the batch
    if (soundEnabled && typeof Audio !== "undefined") {
      const audio = new Audio(chrome.runtime.getURL("ding.mp3"));
      audio.play();
    }

  } catch (err) {
    console.error("[ERROR] Capsule API fetch failed:", err);
  }
}


// Schedule polling interval
function scheduleAlarm(interval) {
  chrome.alarms.clearAll(() =>
    chrome.alarms.create("rssCheck", { periodInMinutes: interval })
  );
}

// Read user settings
async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(
      [
        "feeds",
        "interval",
        "capsuleToken",
        "notificationsEnabled",
        "soundEnabled",
        "snoozeUntil"
      ],
      data => {
        resolve({
          feeds:                data.feeds                || [],
          interval:             data.interval             || DEFAULT_INTERVAL,
          capsuleToken:         data.capsuleToken         || "",
          notificationsEnabled: data.notificationsEnabled !== false,
          soundEnabled:         data.soundEnabled         !== false,
          snoozeUntil:          data.snoozeUntil          || 0
        });
      }
    );
  });
}

// On install: initial load, apply dock, & scheduling
chrome.runtime.onInstalled.addListener(async () => {
  await applyDockSetting();
  const { feeds, capsuleToken } = await getSettings();
  feeds.forEach(url =>
    checkFeed(url, false, false, capsuleToken)
  );
  scheduleAlarm(DEFAULT_INTERVAL);
});

// On startup: apply dock, schedule AND fetch immediately
chrome.runtime.onStartup.addListener(async () => {
  await applyDockSetting();
  const { feeds, notificationsEnabled, soundEnabled, capsuleToken, interval } = await getSettings();

  // schedule the recurring alarm
  scheduleAlarm(interval);

  // do an initial fetch right now (so storage gets seeded immediately)
  feeds.forEach(url =>
    checkFeed(url, notificationsEnabled, soundEnabled, capsuleToken)
  );
});

// Polling alarm
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === "rssCheck") {
    const { feeds, notificationsEnabled, soundEnabled, capsuleToken, snoozeUntil } = await getSettings();
    if (Date.now() < snoozeUntil) return;
    feeds.forEach(url =>
      checkFeed(url, notificationsEnabled, soundEnabled, capsuleToken)
    );
  }
});

// Manual refresh from popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "manualRefresh") {
    getSettings().then(async ({ feeds, notificationsEnabled, soundEnabled, capsuleToken }) => {
      feeds.forEach(url =>
        checkFeed(url, notificationsEnabled, soundEnabled, capsuleToken)
      );
      sendResponse({ ok: true });
    });
    return true;
  }
});

// Recompute badge and dock on storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.rssItems) updateBadgeFromStorage();
    if (changes.enableDock) applyDockSetting();
  }
});

// Initial badge & dock computation
updateBadgeFromStorage();
applyDockSetting();
