// background.js

let seenGuids = new Set();
const DEFAULT_INTERVAL = 1;

// 1) On load, seed seenGuids so we don’t re‑notify existing items
chrome.storage.local.get("rssItems", data => {
  (data.rssItems || []).forEach(item => seenGuids.add(item.guid));
});

// 2) Single notification click handler: open exactly one tab per click
chrome.notifications.onClicked.addListener(notificationId => {
  chrome.storage.local.get("rssItems", data => {
    const item = (data.rssItems || []).find(i => i.guid === notificationId);
    if (item && item.link) {
      chrome.tabs.create({ url: item.link });
    }
  });
});

// Fetch entries from Capsule API, include author & snippet + full body
async function fetchCapsuleEntries(token) {
  const res = await fetch("https://api.capsulecrm.com/api/v2/entries", {
    headers: {
      "Authorization": "Bearer " + token,
      "Accept":        "application/json"
    }
  });
  if (!res.ok) throw new Error("Capsule API error: " + res.status);

  const json = await res.json();
  return json.entries.map(entry => {
    const partyId = entry.parties?.[0]?.id;
    const link    = partyId
      ? `https://msi-products.capsulecrm.com/party/${partyId}`
      : "#";

    const full    = entry.content || "";
    const snippet = full.split("\n")[0].slice(0, 100);

    return {
      title:   entry.subject || "No subject",
      date:    entry.updatedAt || entry.createdAt || new Date().toISOString(),
      link,
      guid:    entry.id.toString(),
      author:  entry.creator?.name || "",
      snippet,
      body:    full
    };
  });
}

// Batch‑summarize new entries via OpenAI, cleaning markdown fences
async function summarizeBatch(items) {
  const { openaiKey, enableSummaries } = await chrome.storage.local.get(
    ['openaiKey','enableSummaries']
  );
  if (!enableSummaries || !openaiKey) return {};

  const entriesPayload = items.map(i => ({ guid: i.guid, body: i.body }));
  const systemMsg = {
    role: 'system',
    content: 'You are an assistant that produces concise summaries of CRM entries.'
  };
  const userMsg = {
    role: 'user',
    content: `Summarize each of these entries in 20–30 words.\nOutput a JSON array of objects with fields "guid" and "summary":\n\n${JSON.stringify(entriesPayload)}`
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${openaiKey}`
    },
    body: JSON.stringify({
      model:       'gpt-3.5-turbo',
      messages:    [systemMsg, userMsg],
      max_tokens:  items.length * 60,
      temperature: 0.5
    })
  });
  const { choices } = await resp.json();

  let text = choices?.[0]?.message?.content || '';
  // strip triple-backtick fences if present
  text = text.trim().replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    console.error('AI summary parse error', e, '\nResponse:', text);
    return {};
  }

  return parsed.reduce((map, { guid, summary }) => {
    map[guid] = summary;
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

    const newItems = entries.filter(item => {
      if (!seenGuids.has(item.guid)) {
        seenGuids.add(item.guid);
        return true;
      }
      return false;
    });

    if (newItems.length) {
      const summaryMap = await summarizeBatch(newItems);
      newItems.forEach(item => {
        item.summary = summaryMap[item.guid] || item.snippet;
      });

      chrome.storage.local.get("rssItems", data => {
        const existing = Array.isArray(data.rssItems) ? data.rssItems : [];
        const updated  = [...newItems, ...existing].slice(0, 100);
        chrome.storage.local.set({ rssItems: updated }, updateBadgeFromStorage);
      });

      newItems.forEach(item => {
        if (notificationsEnabled) {
          chrome.notifications.create(
            item.guid,
            {
              type:           "basic",
              iconUrl:        "icons/icon128.png",
              title:          item.title,
              message:        item.summary,
              contextMessage: `By ${item.author}`,
              priority:       1
            }
          );
        }
        if (soundEnabled && typeof Audio !== "undefined") {
          const audio = new Audio(chrome.runtime.getURL("ding.mp3"));
          audio.play();
        }
      });
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

// On install: initial load & scheduling
chrome.runtime.onInstalled.addListener(async () => {
  const { feeds, capsuleToken } = await getSettings();
  feeds.forEach(url =>
    checkFeed(url, false, false, capsuleToken)
  );
  scheduleAlarm(DEFAULT_INTERVAL);
});

// On startup: schedule only
chrome.runtime.onStartup.addListener(async () => {
  const { interval } = await getSettings();
  scheduleAlarm(interval);
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
    getSettings().then(({ feeds, notificationsEnabled, soundEnabled, capsuleToken }) => {
      feeds.forEach(url =>
        checkFeed(url, notificationsEnabled, soundEnabled, capsuleToken)
      );
      sendResponse({ ok: true });
    });
    return true;
  }
});

// Recompute badge when storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.rssItems) {
    updateBadgeFromStorage();
  }
});

// Initial badge computation
updateBadgeFromStorage();
