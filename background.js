const DEFAULT_INTERVAL = 1;
const MAX_RECENT_THREADS = 10;
const MAX_STORED_ITEMS = 500;
const MAX_AI_CACHE_ITEMS = 250;
const MAX_DRAFT_CACHE_ITEMS = 150;
const MAX_DIGEST_ITEMS = 60;
const GROUPED_NOTIFICATION_ID = "crm-activity-group";
const DIGEST_ALARM_NAME = "digestCheck";
const CAPSULE_ENTRIES_URL = "https://api.capsulecrm.com/api/v2/entries";
const AI_MODEL = "gpt-4o-mini";
const HEURISTIC_MODEL = "local-heuristic";
const AI_ANALYSIS_VERSION = 1;
const DRAFT_REPLY_VERSION = 2;
const CAPSULE_TASK_META_PREFIX = "Capsule RSS";
const PRIORITY_LEVELS = ["low", "medium", "high", "critical"];
const REPLY_URGENCY_LEVELS = ["none", "today", "soon", "urgent"];
const PRIORITY_RANK = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4
};

let seenGuids = new Set();
let refreshInFlight = null;
let configuredCapsuleWebBaseUrl = "";
const digestGenerationLocks = new Map();
const taskCreationLocks = new Map();

async function setRuntimeStatus(status = {}) {
  const nextStatus = {
    level: status.level || "info",
    source: status.source || "runtime",
    message: status.message || "",
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ runtimeStatus: nextStatus });
  return nextStatus;
}

function getMissingRequiredSettings(settings = {}) {
  const missing = [];

  if (!String(settings.capsuleToken || "").trim()) {
    missing.push("Capsule API Token");
  }

  if (!String(settings.capsuleWebBaseUrl || "").trim()) {
    missing.push("Capsule Web App URL");
  }

  return missing;
}

async function ensureRequiredSettings(settings, source = "runtime") {
  const missing = getMissingRequiredSettings(settings);
  if (!missing.length) {
    return { ok: true };
  }

  const message = `Complete setup in Settings before continuing: ${missing.join(", ")}.`;
  await setRuntimeStatus({
    level: "warn",
    source,
    message
  });
  return {
    ok: false,
    error: message,
    missing
  };
}

function runLocked(lockMap, key, task) {
  const existing = lockMap.get(key);
  if (existing) {
    return existing;
  }

  const pending = (async () => task())().finally(() => {
    if (lockMap.get(key) === pending) {
      lockMap.delete(key);
    }
  });
  lockMap.set(key, pending);
  return pending;
}

async function applyDockSetting() {
  const { enableDock = false } = await chrome.storage.local.get("enableDock");

  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: enableDock });
  } catch (error) {
    console.warn("[WARN] sidePanel.setPanelBehavior failed", error);
  }
}

async function seedSeenGuids() {
  const { rssItems = [] } = await chrome.storage.local.get("rssItems");
  seenGuids = new Set(
    rssItems
      .map(item => item.guid)
      .filter(Boolean)
  );
}

function getThreadKey(item) {
  const title = typeof item?.title === "string" ? item.title : "";
  const subject = title.replace(/^(?:\s*(?:re|fwd)\s*[:\-]\s*)+/i, "").trim().toLowerCase();
  let participantKey = "participant:unknown";

  if (item?.partyId) {
    participantKey = `party:${String(item.partyId).trim().toLowerCase()}`;
  } else if (Array.isArray(item?.recipients) && item.recipients.length) {
    const recipients = [...new Set(
      item.recipients
        .map(value => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    )].sort();
    if (recipients.length) {
      participantKey = `recipients:${recipients.join("|")}`;
    }
  } else if (item?.recipientText) {
    const recipientText = String(item.recipientText).trim().toLowerCase();
    if (recipientText) {
      participantKey = `recipient:${recipientText}`;
    }
  } else if (item?.author) {
    const author = String(item.author).trim().toLowerCase();
    if (author) {
      participantKey = `author:${author}`;
    }
  }

  return subject ? `${subject}__${participantKey}` : item?.guid || participantKey;
}

function getRecentThreads(items, maxThreads = MAX_RECENT_THREADS) {
  const sorted = [...items].sort((a, b) => new Date(b.date) - new Date(a.date));
  const threadMap = new Map();

  for (const item of sorted) {
    if (item.deleted) {
      continue;
    }

    const key = getThreadKey(item) || item.guid;
    const thread = threadMap.get(key);

    if (thread) {
      thread.items.push(item);
      if (new Date(item.date) > new Date(thread.latest.date)) {
        thread.latest = item;
      }
      continue;
    }

    threadMap.set(key, { key, latest: item, items: [item] });

    if (threadMap.size >= maxThreads) {
      break;
    }
  }

  return [...threadMap.values()];
}

async function updateBadgeFromStorage() {
  const { rssItems = [] } = await chrome.storage.local.get("rssItems");
  const unreadCount = getRecentThreads(rssItems)
    .filter(thread => thread.items.some(item => !item.read))
    .length;

  await chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
  await chrome.action.setBadgeText({ text: unreadCount ? String(unreadCount) : "" });
}

async function openOrUpdateTab(url) {
  const { lastTabId } = await chrome.storage.local.get("lastTabId");

  if (lastTabId != null) {
    try {
      await chrome.tabs.get(lastTabId);
      await chrome.tabs.update(lastTabId, { url, active: true });
      await chrome.storage.local.set({ lastTabId });
      return;
    } catch (error) {
      console.warn("[WARN] Unable to reuse tab, opening a new one", error);
    }
  }

  const newTab = await chrome.tabs.create({ url });
  await chrome.storage.local.set({ lastTabId: newTab.id });
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
    return "";
  }
}

function buildCapsuleWebUrl(baseUrl, path = "/") {
  const normalizedBaseUrl = normalizeCapsuleWebBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return "";
  }

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

async function fetchCapsuleEntries(token, capsuleWebBaseUrl) {
  if (!token) {
    throw new Error("Capsule API token is missing");
  }

  const response = await fetch(CAPSULE_ENTRIES_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Capsule API error: ${response.status}`);
  }

  const json = await response.json();
  const entries = Array.isArray(json.entries) ? json.entries : [];

  return entries.map(entry => {
    const parties = Array.isArray(entry.parties) ? entry.parties : [];
    const singleParty = entry.party ? [entry.party] : [];
    const relatedParties = [...parties, ...singleParty].filter(Boolean);
    const uniqueRecipients = [...new Set(
      relatedParties
        .map(party => party.name || party.fullName || party.title || "")
        .filter(Boolean)
    )];
    const partyId = relatedParties[0]?.id || null;
    const link = partyId
      ? buildCapsuleWebUrl(capsuleWebBaseUrl, `/party/${partyId}`)
      : buildCapsuleWebUrl(capsuleWebBaseUrl, "/");
    const body = entry.content || "";
    const snippet = body.split("\n")[0].slice(0, 100);
    const title = entry.subject?.trim() || `${entry.creator?.name || "Someone"} Task`;
    const date = entry.updatedAt || entry.createdAt || new Date().toISOString();

    return {
      title,
      date,
      link,
      guid: String(entry.id),
      author: entry.creator?.name || "",
      partyId,
      recipients: uniqueRecipients,
      recipientText: uniqueRecipients.join(", "),
      snippet,
      body,
      read: false,
      saved: false,
      deleted: false,
      snoozedUntil: 0
    };
  });
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildAnalysisFingerprint(item) {
  return [
    normalizeWhitespace(item.title).toLowerCase(),
    normalizeWhitespace(item.author).toLowerCase(),
    normalizeWhitespace(item.recipientText).toLowerCase(),
    normalizeWhitespace(item.body)
  ].join("\n");
}

function getAnalysisTuningFingerprint(settings = {}) {
  return JSON.stringify({
    noiseFilterStrength: settings.noiseFilterStrength || "balanced",
    deprioritizeInvoiceEmails: settings.deprioritizeInvoiceEmails !== false,
    deprioritizeOrderAcknowledgements: settings.deprioritizeOrderAcknowledgements !== false,
    deprioritizeQuoteAcknowledgements: settings.deprioritizeQuoteAcknowledgements !== false
  });
}

async function hashAnalysisFingerprint(fingerprint) {
  const encoded = new TextEncoder().encode(fingerprint);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function cleanStringArray(values) {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values
    .map(value => normalizeWhitespace(value))
    .filter(Boolean))];
}

function getPriorityRank(priority) {
  return PRIORITY_RANK[priority] || PRIORITY_RANK.medium;
}

function isReplySubject(title = "") {
  return /^(?:\s*(?:re|fwd)\s*[:\-]\s*)+/i.test(title);
}

function detectHeuristicSignals(item, settings = {}) {
  const subject = normalizeWhitespace(item.title).toLowerCase();
  const body = normalizeWhitespace(item.body).toLowerCase();
  const author = normalizeWhitespace(item.author).toLowerCase();
  const combined = `${subject}\n${body}`;
  const automationCues = [
    "order acknowledgment",
    "order acknowledgement",
    "order confirmation",
    "automated message",
    "auto-generated",
    "auto generated",
    "do not reply",
    "noreply",
    "no-reply",
    "receipt confirmation",
    "shipment notification"
  ];
  const invoiceCues = [
    "invoice",
    "billing notice",
    "payment receipt",
    "remittance",
    "statement attached"
  ];
  const orderAcknowledgementCues = [
    "quote acknowledgment",
    "quote acknowledgement",
    "quote received",
    "quote receipt",
    "request for quote received",
    "rfq received",
    "order received",
    "shipping update"
  ];
  if (settings.deprioritizeInvoiceEmails !== false) {
    automationCues.push(...invoiceCues);
  }
  if (settings.deprioritizeOrderAcknowledgements !== false || settings.deprioritizeQuoteAcknowledgements !== false) {
    automationCues.push(...orderAcknowledgementCues.filter(cue => {
      if (cue.includes("quote") || cue.includes("rfq")) {
        return settings.deprioritizeQuoteAcknowledgements !== false;
      }
      return settings.deprioritizeOrderAcknowledgements !== false;
    }));
  }
  const actionCues = [
    "?",
    "can you",
    "could you",
    "please update",
    "please change",
    "need to",
    "needs to",
    "follow up",
    "reschedule",
    "schedule",
    "meeting",
    "call",
    "change order",
    "change request",
    "customer asked",
    "let me know"
  ];
  const noiseFilterStrength = settings.noiseFilterStrength || "balanced";
  if (noiseFilterStrength === "strict" || noiseFilterStrength === "aggressive") {
    actionCues.push("please advise", "confirm", "review and respond");
  }
  const negativeCues = [
    "urgent",
    "asap",
    "issue",
    "problem",
    "wrong",
    "delay",
    "late",
    "cancel"
  ];
  const automatedSender = /(no[-\s]?reply|noreply|system|automated|notification|alerts?)/.test(author);
  const matchedAutomationCues = automationCues.filter(cue => combined.includes(cue));
  const matchedActionCues = actionCues.filter(cue => combined.includes(cue));
  const matchedNegativeCues = negativeCues.filter(cue => combined.includes(cue));
  const explicitQuestion = /[?]/.test(combined);
  const containsInvoiceCue = invoiceCues.some(cue => combined.includes(cue));
  const containsQuoteCue = orderAcknowledgementCues.some(cue => (cue.includes("quote") || cue.includes("rfq")) && combined.includes(cue));
  const containsOrderAckCue = orderAcknowledgementCues.some(cue => !cue.includes("quote") && !cue.includes("rfq") && combined.includes(cue));
  const humanReplyLikely = (
    (isReplySubject(item.title) && !automatedSender) ||
    matchedActionCues.length > 0 ||
    matchedNegativeCues.length > 0 ||
    explicitQuestion
  );

  return {
    automatedSender,
    matchedAutomationCues,
    matchedActionCues,
    matchedNegativeCues,
    humanReplyLikely,
    explicitQuestion,
    containsInvoiceCue,
    containsQuoteCue,
    containsOrderAckCue
  };
}

function getHeuristicAnalysis(item, analysisHash = "", settings = {}) {
  const fallback = getFallbackAnalysis(item);
  const signals = detectHeuristicSignals(item, settings);
  const summary = item.snippet || fallback.summary;
  const noiseFilterStrength = settings.noiseFilterStrength || "balanced";
  const aggressiveNoiseSuppression = noiseFilterStrength === "aggressive";
  const strictNoiseSuppression = noiseFilterStrength === "strict" || aggressiveNoiseSuppression;
  const looksLikeCommercialNoise = (
    signals.containsInvoiceCue ||
    signals.containsQuoteCue ||
    signals.containsOrderAckCue ||
    signals.matchedAutomationCues.length > 0
  );

  if (looksLikeCommercialNoise && !signals.humanReplyLikely) {
    return {
      ...fallback,
      summary,
      priority: "low",
      priorityReason: "Likely automated acknowledgement with no clear follow-up request.",
      category: "automated_update",
      signals: cleanStringArray(["automated_update", ...signals.matchedAutomationCues.map(value => value.replace(/[^a-z0-9]+/g, "_"))]),
      raw: {
        mode: "heuristic",
        automatedSender: signals.automatedSender,
        matchedAutomationCues: signals.matchedAutomationCues
      },
      hash: analysisHash,
      version: AI_ANALYSIS_VERSION,
      analyzedAt: new Date().toISOString(),
      model: HEURISTIC_MODEL
    };
  }

  if (strictNoiseSuppression && looksLikeCommercialNoise && !signals.matchedNegativeCues.length && !signals.explicitQuestion) {
    return {
      ...fallback,
      summary,
      priority: aggressiveNoiseSuppression ? "low" : "medium",
      priorityReason: "Commercial acknowledgement or billing message without a clear request for follow-up.",
      category: "automated_update",
      signals: cleanStringArray([
        "commercial_noise",
        ...signals.matchedAutomationCues.map(value => value.replace(/[^a-z0-9]+/g, "_"))
      ]),
      raw: {
        mode: "heuristic",
        automatedSender: signals.automatedSender,
        matchedAutomationCues: signals.matchedAutomationCues
      },
      hash: analysisHash,
      version: AI_ANALYSIS_VERSION,
      analyzedAt: new Date().toISOString(),
      model: HEURISTIC_MODEL
    };
  }

  if (signals.humanReplyLikely) {
    const isUrgent = signals.matchedNegativeCues.length > 0;
    return {
      ...fallback,
      summary,
      priority: isUrgent ? "high" : "medium",
      priorityReason: isUrgent
        ? "Reply appears to contain a customer issue or change request."
        : "Reply-like message contains a likely follow-up or question.",
      category: isUrgent ? "customer_request" : "follow_up",
      needsReply: true,
      replyUrgency: isUrgent ? "today" : "soon",
      taskNeeded: isUrgent,
      workflowActions: cleanStringArray(["reply_email", "open_capsule"]),
      signals: cleanStringArray([
        "human_reply_likely",
        ...signals.matchedActionCues.map(value => value.replace(/[^a-z0-9]+/g, "_")),
        ...signals.matchedNegativeCues.map(value => value.replace(/[^a-z0-9]+/g, "_"))
      ]),
      raw: {
        mode: "heuristic",
        automatedSender: signals.automatedSender,
        matchedActionCues: signals.matchedActionCues,
        matchedNegativeCues: signals.matchedNegativeCues
      },
      hash: analysisHash,
      version: AI_ANALYSIS_VERSION,
      analyzedAt: new Date().toISOString(),
      model: HEURISTIC_MODEL
    };
  }

  return {
    ...fallback,
    summary,
    raw: {
      mode: "heuristic",
      automatedSender: signals.automatedSender
    },
    hash: analysisHash,
    version: AI_ANALYSIS_VERSION,
    analyzedAt: new Date().toISOString(),
    model: HEURISTIC_MODEL
  };
}

function getFallbackAnalysis(item) {
  return {
    summary: item.snippet || "",
    priority: "medium",
    priorityReason: "",
    category: "unclassified",
    needsReply: false,
    replyUrgency: "none",
    meetingMentioned: false,
    taskNeeded: false,
    taskType: "",
    suggestedTaskTitle: "",
    suggestedDue: "",
    workflowActions: [],
    signals: []
  };
}

function normalizeAnalysisResult(rawResult, item, analysisHash, options = {}) {
  const fallback = getFallbackAnalysis(item);
  const priority = PRIORITY_LEVELS.includes(rawResult?.priority) ? rawResult.priority : fallback.priority;
  const replyUrgency = REPLY_URGENCY_LEVELS.includes(rawResult?.reply_urgency) ? rawResult.reply_urgency : fallback.replyUrgency;
  const summary = normalizeWhitespace(rawResult?.summary || fallback.summary);

  return {
    summary,
    priority,
    priorityReason: normalizeWhitespace(rawResult?.priority_reason || ""),
    category: normalizeWhitespace(rawResult?.category || fallback.category).toLowerCase(),
    needsReply: Boolean(rawResult?.needs_reply),
    replyUrgency,
    meetingMentioned: Boolean(rawResult?.meeting_mentioned),
    taskNeeded: Boolean(rawResult?.task_needed),
    taskType: normalizeWhitespace(rawResult?.task_type || ""),
    suggestedTaskTitle: normalizeWhitespace(rawResult?.suggested_task_title || ""),
    suggestedDue: normalizeWhitespace(rawResult?.suggested_due || ""),
    workflowActions: cleanStringArray(rawResult?.workflow_actions),
    signals: cleanStringArray(rawResult?.signals),
    raw: rawResult && typeof rawResult === "object" ? rawResult : {},
    hash: analysisHash,
    version: AI_ANALYSIS_VERSION,
    analyzedAt: new Date().toISOString(),
    model: options.model || AI_MODEL
  };
}

function trimAnalysisCache(cache) {
  const entries = Object.entries(cache || {});
  if (entries.length <= MAX_AI_CACHE_ITEMS) {
    return cache || {};
  }

  entries.sort(([, left], [, right]) => {
    const leftTime = new Date(left?.analysis?.analyzedAt || left?.cachedAt || 0).getTime();
    const rightTime = new Date(right?.analysis?.analyzedAt || right?.cachedAt || 0).getTime();
    return rightTime - leftTime;
  });

  return Object.fromEntries(entries.slice(0, MAX_AI_CACHE_ITEMS));
}

function trimDraftCache(cache) {
  const entries = Object.entries(cache || {});
  if (entries.length <= MAX_DRAFT_CACHE_ITEMS) {
    return cache || {};
  }

  entries.sort(([, left], [, right]) => {
    const leftTime = new Date(left?.createdAt || 0).getTime();
    const rightTime = new Date(right?.createdAt || 0).getTime();
    return rightTime - leftTime;
  });

  return Object.fromEntries(entries.slice(0, MAX_DRAFT_CACHE_ITEMS));
}

function parseJsonResponse(rawText) {
  const cleaned = rawText
    .replace(/^```(?:json)?\r?\n/, "")
    .replace(/\r?\n```$/, "")
    .trim();

  if (!cleaned) {
    return null;
  }

  return JSON.parse(cleaned);
}

function slugifyTaskValue(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function getReplyClientLabel(emailClient = "default") {
  return emailClient === "gmail" ? "gmail" : "default";
}

function buildReplyDraftCacheKey(item, emailClient) {
  return [
    item.ai?.hash || "",
    slugifyTaskValue(item.title || ""),
    slugifyTaskValue(item.author || ""),
    getReplyClientLabel(emailClient),
    `v${DRAFT_REPLY_VERSION}`
  ].join(":");
}

function extractEmailAddresses(value) {
  return [...new Set(
    String(value || "")
      .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []
  )];
}

function getReplyRecipients(item) {
  const authorEmails = extractEmailAddresses(item.author);
  const recipientEmails = [
    ...cleanStringArray(item.recipients).flatMap(extractEmailAddresses),
    ...extractEmailAddresses(item.recipientText),
    ...extractEmailAddresses(item.body)
  ];
  const uniqueRecipients = [...new Set(recipientEmails)];
  const to = authorEmails[0] || uniqueRecipients[0] || "";
  const cc = uniqueRecipients.filter(email => email && email !== to);
  return { to, cc };
}

function buildMailtoUrl(item, body = "") {
  const params = new URLSearchParams();
  const recipients = getReplyRecipients(item);
  if (recipients.to) {
    params.set("to", recipients.to);
  }
  if (recipients.cc.length) {
    params.set("cc", recipients.cc.join(","));
  }
  if (item.title) {
    params.set("subject", item.title);
  }
  if (body) {
    params.set("body", body);
  }

  const query = params.toString();
  return query ? `mailto:?${query}` : "mailto:";
}

function buildGmailComposeUrl(item, body = "") {
  const recipients = getReplyRecipients(item);
  const params = new URLSearchParams({
    view: "cm",
    fs: "1",
    su: item.title || ""
  });

  if (recipients.to) {
    params.set("to", recipients.to);
  }

  if (recipients.cc.length) {
    params.set("cc", recipients.cc.join(","));
  }

  if (body) {
    params.set("body", body);
  }

  return `https://mail.google.com/mail/?${params.toString()}`;
}

function buildCalendarUrl(item) {
  const details = [
    item.summary || item.snippet || "",
    item.link ? `Capsule: ${item.link}` : "",
    item.body || ""
  ].filter(Boolean).join("\n\n");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: item.title || "Capsule follow-up",
    details
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function normalizeDraftText(value) {
  const normalized = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }

  return normalized
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

async function capsuleRequest(path, options = {}) {
  const { capsuleToken = "" } = await getSettings();
  if (!capsuleToken) {
    throw new Error("Set a Capsule API token in Settings before syncing tasks.");
  }

  const response = await fetch(`https://api.capsulecrm.com/api/v2${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${capsuleToken}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`Capsule task sync failed: ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

async function openExternalUrl(url) {
  if (!url) {
    throw new Error("Missing URL for external action.");
  }

  await chrome.tabs.create({ url, active: true });
}

function createTaskRecord(item) {
  const now = new Date().toISOString();
  const suggestedTitle = item.ai?.suggestedTaskTitle || `Follow up: ${item.title || "Capsule activity"}`;
  const dueDate = item.ai?.suggestedDue || now.slice(0, 10);

  return {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: suggestedTitle,
    status: dueDate && new Date(dueDate).getTime() < Date.now() ? "overdue" : "open",
    createdAt: now,
    updatedAt: now,
    completedAt: "",
    sourceGuid: item.guid,
    sourceTitle: item.title || "",
    sourceLink: item.link || "",
    threadKey: getThreadKey(item),
    priority: item.ai?.priority || "medium",
    category: item.ai?.category || "follow_up",
    dueDate,
    suggestedDue: dueDate,
    notes: item.ai?.priorityReason || item.summary || item.snippet || "",
    owner: item.author || "",
    assignee: "",
    origin: "ai",
    signals: Array.isArray(item.ai?.signals) ? item.ai.signals : [],
    capsuleTaskId: "",
    capsuleSyncStatus: "pending",
    capsuleSyncMessage: "",
    capsuleLastSyncedAt: "",
    dueToday: dueDate === new Date().toISOString().slice(0, 10)
  };
}

function buildTaskMetadata(item = {}) {
  return [
    `${CAPSULE_TASK_META_PREFIX} GUID: ${item.guid || ""}`,
    `${CAPSULE_TASK_META_PREFIX} Thread: ${getThreadKey(item) || ""}`,
    `${CAPSULE_TASK_META_PREFIX} Link: ${item.link || ""}`
  ].join("\n");
}

function stripTaskMetadata(detail = "") {
  return String(detail || "")
    .split("\n")
    .filter(line => !line.startsWith(`${CAPSULE_TASK_META_PREFIX} `))
    .join("\n")
    .trim();
}

function parseTaskMetadata(detail = "") {
  const lines = String(detail || "").split("\n");
  const metadata = {
    sourceGuid: "",
    threadKey: "",
    sourceLink: ""
  };

  for (const line of lines) {
    if (line.startsWith(`${CAPSULE_TASK_META_PREFIX} GUID:`)) {
      metadata.sourceGuid = normalizeWhitespace(line.split(":").slice(1).join(":"));
    }
    if (line.startsWith(`${CAPSULE_TASK_META_PREFIX} Thread:`)) {
      metadata.threadKey = normalizeWhitespace(line.split(":").slice(1).join(":")).toLowerCase();
    }
    if (line.startsWith(`${CAPSULE_TASK_META_PREFIX} Link:`)) {
      metadata.sourceLink = normalizeWhitespace(line.split(":").slice(1).join(":"));
    }
  }

  return metadata;
}

function normalizeCapsuleTask(task = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const metadata = parseTaskMetadata(task.detail);
  const rawStatus = String(task.status || "OPEN").toUpperCase();
  const normalizedStatus = rawStatus === "COMPLETED" || rawStatus === "PENDING"
    ? rawStatus.toLowerCase()
    : task.dueOn && task.dueOn < today
      ? "overdue"
      : "open";

  return {
    id: `capsule_${task.id}`,
    capsuleTaskId: task.id ? String(task.id) : "",
    taskUrl: task.id ? buildCapsuleWebUrl(configuredCapsuleWebBaseUrl, `/tasks/${task.id}`) : "",
    title: task.description || "",
    notes: stripTaskMetadata(task.detail || ""),
    status: normalizedStatus,
    dueDate: task.dueOn || "",
    dueToday: Boolean(task.dueOn && task.dueOn === today && normalizedStatus === "open"),
    createdAt: task.createdAt || "",
    updatedAt: task.updatedAt || "",
    completedAt: task.completedAt || "",
    sourceGuid: metadata.sourceGuid,
    sourceTitle: "",
    sourceLink: metadata.sourceLink,
    threadKey: metadata.threadKey,
    priority: "medium",
    category: "capsule",
    owner: task.owner?.name || "",
    assignee: task.owner?.name || "",
    origin: "capsule",
    signals: [],
    capsuleSyncStatus: "synced",
    capsuleSyncMessage: "",
    capsuleLastSyncedAt: new Date().toISOString(),
    partyId: task.party?.id ? String(task.party.id) : "",
    partyName: task.party?.name || task.party?.firstName || ""
  };
}

async function fetchCapsuleTasks() {
  const response = await capsuleRequest("/tasks?perPage=100&embed=party,owner");
  return Array.isArray(response?.tasks) ? response.tasks.map(normalizeCapsuleTask) : [];
}

async function refreshCapsuleTasks() {
  const settings = await getSettings();
  const requirements = await ensureRequiredSettings(settings, "tasks");
  if (!requirements.ok) {
    throw new Error(requirements.error);
  }

  const tasks = await fetchCapsuleTasks();
  await chrome.storage.local.set({ capsuleTasks: tasks });
  return tasks;
}

async function createCapsuleTaskForItem(task, item) {
  const payload = {
    task: {
      description: task.title,
      detail: [task.notes, item.link ? `Capsule source: ${item.link}` : "", buildTaskMetadata(item)]
        .filter(Boolean)
        .join("\n\n"),
      dueOn: task.dueDate || undefined,
      ...(item.partyId ? { party: { id: item.partyId } } : {})
    }
  };

  const response = await capsuleRequest("/tasks?embed=party,owner", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  const capsuleTask = response?.task;
  if (!capsuleTask?.id) {
    throw new Error("Capsule task creation returned no task id.");
  }

  const normalizedTask = normalizeCapsuleTask(capsuleTask);
  normalizedTask.sourceGuid = item.guid || normalizedTask.sourceGuid;
  normalizedTask.threadKey = getThreadKey(item) || normalizedTask.threadKey;
  normalizedTask.sourceLink = item.link || normalizedTask.sourceLink;
  normalizedTask.notes = task.notes;
  normalizedTask.priority = item.ai?.priority || "medium";
  normalizedTask.category = item.ai?.category || "follow_up";
  return normalizedTask;
}

function updateTaskStatusShape(task, status) {
  const now = new Date().toISOString();
  return {
    ...task,
    status,
    updatedAt: now,
    completedAt: status === "completed" ? now : "",
    dueToday: task.dueDate === now.slice(0, 10)
  };
}

async function updateStoredTask(updatedTask) {
  const { capsuleTasks = [] } = await chrome.storage.local.get("capsuleTasks");
  const nextTasks = capsuleTasks.map(task => (task.id === updatedTask.id ? updatedTask : task));
  await chrome.storage.local.set({ capsuleTasks: nextTasks });
  return updatedTask;
}

async function syncTaskCompletionToCapsule(task, item) {
  if (!task.capsuleTaskId) {
    throw new Error("Capsule task is missing an id.");
  }

  try {
    await capsuleRequest(`/tasks/${task.capsuleTaskId}`, {
      method: "PUT",
      body: JSON.stringify({
        task: {
          status: "COMPLETED"
        }
      })
    });

    return {
      ...task,
      capsuleSyncStatus: "synced",
      capsuleSyncMessage: "Completed in Capsule.",
      capsuleLastSyncedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      ...task,
      capsuleSyncStatus: "unavailable",
      capsuleSyncMessage: error.message || "Capsule completion sync unavailable.",
      capsuleLastSyncedAt: new Date().toISOString()
    };
  }
}

function getTaskSummary(tasks) {
  const today = new Date().toISOString().slice(0, 10);
  const activeTasks = tasks.filter(task => task.status !== "completed" && task.status !== "dismissed");
  const dueToday = activeTasks.filter(task => task.dueDate === today).length;
  const overdue = activeTasks.filter(task => task.dueDate && task.dueDate < today).length;

  return {
    open: activeTasks.length,
    dueToday,
    overdue
  };
}

function trimDigests(digests) {
  return [...digests]
    .sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt))
    .slice(0, MAX_DIGEST_ITEMS);
}

function getDigestTypeLabel(type) {
  switch (type) {
    case "morning":
      return "Morning Digest";
    case "midday":
      return "Midday Digest";
    case "end_of_day":
    default:
      return "Day Digest";
  }
}

function getLocalDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day)
  };
}

function getDigestSchedule(settings) {
  return [
    { type: "morning", hour: settings.morningDigestHour },
    { type: "midday", hour: settings.middayDigestHour },
    { type: "end_of_day", hour: settings.endOfDayDigestHour }
  ];
}

function getDigestWindowStart(now, type) {
  const start = new Date(now);
  switch (type) {
    case "morning":
      start.setHours(0, 0, 0, 0);
      break;
    case "midday":
      start.setHours(8, 0, 0, 0);
      break;
    case "end_of_day":
    default:
      start.setHours(12, 0, 0, 0);
      break;
  }
  return start;
}

function hasDigestForDate(digests, type, dateKey) {
  return digests.some(digest => digest.type === type && digest.dateKey === dateKey);
}

function isDigestRecordCurrent(digest) {
  return Boolean(
    digest &&
    digest.typeLabel &&
    digest.metrics &&
    digest.references &&
    Array.isArray(digest.references.quotesSent) &&
    Array.isArray(digest.references.orderAcknowledgements) &&
    Array.isArray(digest.references.complaintsOpen) &&
    Array.isArray(digest.references.complaintsClosed) &&
    Array.isArray(digest.references.replyNeeded) &&
    Array.isArray(digest.references.topContacts)
  );
}

function buildDigestCounts(items) {
  return items.reduce((counts, item) => {
    const priority = item.ai?.priority || "medium";
    counts.total += 1;
    counts.byPriority[priority] = (counts.byPriority[priority] || 0) + 1;
    if (item.ai?.needsReply) {
      counts.replyNeeded += 1;
    }
    if (item.ai?.taskNeeded) {
      counts.taskNeeded += 1;
    }
    return counts;
  }, {
    total: 0,
    replyNeeded: 0,
    taskNeeded: 0,
    byPriority: {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0
    }
  });
}

function groupDigestThreads(items) {
  const sorted = [...items].sort((a, b) => new Date(b.date) - new Date(a.date));
  const threadMap = new Map();

  for (const item of sorted) {
    const key = getThreadKey(item);
    const existing = threadMap.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }

    threadMap.set(key, {
      key,
      latest: item,
      items: [item]
    });
  }

  return [...threadMap.values()].map(thread => ({
    ...thread,
    items: [...thread.items].sort((a, b) => new Date(b.date) - new Date(a.date))
  }));
}

function buildDigestReference(thread, extra = {}) {
  const latest = thread.latest || {};
  return {
    guid: latest.guid || "",
    threadKey: thread.key,
    title: latest.title || "Capsule activity",
    contact: latest.recipientText || latest.author || "",
    link: latest.link || "",
    date: latest.date || "",
    priority: latest.ai?.priority || "medium",
    category: latest.ai?.category || "",
    ...extra
  };
}

function buildDigestMetrics(items, tasks) {
  const threads = groupDigestThreads(items);
  const today = new Date().toISOString().slice(0, 10);
  const activeTasks = tasks.filter(task => task.status !== "completed" && task.status !== "dismissed" && task.status !== "pending");
  const activeTaskThreadKeys = new Set(activeTasks.map(task => task.threadKey).filter(Boolean));
  const activeTaskSourceGuids = new Set(activeTasks.map(task => task.sourceGuid).filter(Boolean));
  const topContacts = new Map();
  const metrics = {
    threadCount: threads.length,
    contactsTouched: 0,
    quotesSent: 0,
    orderAcknowledgements: 0,
    customerComplaints: {
      open: 0,
      closed: 0
    },
    replyNeededThreads: 0,
    highPriorityThreads: 0
  };
  const references = {
    quotesSent: [],
    orderAcknowledgements: [],
    complaintsOpen: [],
    complaintsClosed: [],
    replyNeeded: [],
    topContacts: []
  };

  const quoteSentCues = ["quote sent", "quotation", "proposal", "pricing attached", "attached quote", "attached proposal"];
  const quoteAckCues = ["quote acknowledgment", "quote acknowledgement", "quote receipt", "quote received", "rfq received"];
  const orderAckCues = ["order acknowledgment", "order acknowledgement", "order confirmation", "receipt confirmation", "shipment notification", "shipping update"];
  const complaintCues = ["complaint", "issue", "problem", "wrong", "delay", "late", "damaged", "cancel", "not working", "incorrect"];
  const resolvedCues = ["resolved", "taken care of", "fixed", "completed", "closed", "thank you", "thanks for resolving"];

  for (const thread of threads) {
    const latest = thread.latest;
    const combined = normalizeWhitespace(thread.items.map(item => [item.title, item.body, item.summary].filter(Boolean).join(" ")).join(" ")).toLowerCase();
    const activeTaskExists = activeTaskThreadKeys.has(thread.key) || thread.items.some(item => activeTaskSourceGuids.has(item.guid));
    const needsReply = thread.items.some(item => item.ai?.needsReply === true);
    const highPriority = thread.items.some(item => getPriorityRank(item.ai?.priority) >= getPriorityRank("high"));
    const complaintSignal = thread.items.some(item => ["customer_request", "escalation", "order_change"].includes(item.ai?.category || ""));
    const hasComplaint = complaintSignal || complaintCues.some(cue => combined.includes(cue));
    const looksResolved = resolvedCues.some(cue => combined.includes(cue));
    const complaintOpen = hasComplaint && (activeTaskExists || needsReply || highPriority) && !looksResolved;
    const hasQuoteAck = quoteAckCues.some(cue => combined.includes(cue));
    const hasQuoteSent = !hasQuoteAck && (quoteSentCues.some(cue => combined.includes(cue)) || ((latest.ai?.category || "") === "quote_request" && !needsReply));
    const hasOrderAcknowledgement = orderAckCues.some(cue => combined.includes(cue)) || (combined.includes("order") && combined.includes("acknowledg"));
    const contactName = latest.recipientText || latest.author || "Unknown contact";
    const contactEntry = topContacts.get(contactName) || {
      name: contactName,
      count: 0,
      latestAt: "",
      link: latest.link || "",
      threadKey: thread.key,
      guid: latest.guid || ""
    };
    contactEntry.count += thread.items.length;
    if (!contactEntry.latestAt || new Date(latest.date).getTime() > new Date(contactEntry.latestAt).getTime()) {
      contactEntry.latestAt = latest.date || "";
      contactEntry.link = latest.link || contactEntry.link;
      contactEntry.threadKey = thread.key;
      contactEntry.guid = latest.guid || contactEntry.guid;
    }
    topContacts.set(contactName, contactEntry);

    if (needsReply) {
      metrics.replyNeededThreads += 1;
      references.replyNeeded.push(buildDigestReference(thread, { status: activeTaskExists ? "tracked" : "reply_needed" }));
    }

    if (highPriority) {
      metrics.highPriorityThreads += 1;
    }

    if (hasQuoteSent) {
      metrics.quotesSent += 1;
      references.quotesSent.push(buildDigestReference(thread));
    }

    if (hasOrderAcknowledgement) {
      metrics.orderAcknowledgements += 1;
      references.orderAcknowledgements.push(buildDigestReference(thread));
    }

    if (hasComplaint) {
      if (complaintOpen) {
        metrics.customerComplaints.open += 1;
        references.complaintsOpen.push(buildDigestReference(thread, { status: "open" }));
      } else {
        metrics.customerComplaints.closed += 1;
        references.complaintsClosed.push(buildDigestReference(thread, { status: looksResolved ? "closed" : "monitoring" }));
      }
    }
  }

  metrics.contactsTouched = topContacts.size;
  references.topContacts = [...topContacts.values()]
    .sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return new Date(b.latestAt || today).getTime() - new Date(a.latestAt || today).getTime();
    })
    .slice(0, 5);

  return { metrics, references, threads };
}

function buildDigestSignals(items) {
  const signalCounts = new Map();
  const categoryCounts = new Map();

  for (const item of items) {
    const category = item.ai?.category;
    if (category) {
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    }

    for (const signal of item.ai?.signals || []) {
      signalCounts.set(signal, (signalCounts.get(signal) || 0) + 1);
    }
  }

  const topCategories = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));

  const topSignals = [...signalCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  return { topCategories, topSignals };
}

function buildLocalDigestText(items, taskSummary, digestMetrics) {
  const counts = buildDigestCounts(items);
  const signals = buildDigestSignals(items);
  const metrics = digestMetrics.metrics;
  const topCategoryText = signals.topCategories
    .map(entry => `${entry.count} ${entry.name.replace(/_/g, " ")}`)
    .join(", ");

  const parts = [
    `Day digest: ${counts.total} updates across ${metrics.contactsTouched} contacts and ${metrics.threadCount} active threads.`,
    `${metrics.quotesSent} quotes were sent and ${metrics.orderAcknowledgements} order acknowledgements landed today.`,
    `${metrics.customerComplaints.open} customer complaints look open and ${metrics.customerComplaints.closed} appear closed.`,
    `${metrics.replyNeededThreads} threads still appear to need a reply. ${taskSummary.open} open tasks remain, with ${taskSummary.dueToday} due today and ${taskSummary.overdue} overdue.`
  ];

  if (topCategoryText) {
    parts.push(`Most common themes: ${topCategoryText}.`);
  }

  return parts.join(" ");
}

function buildDigestFallbackText(type, items, taskSummary, digestMetrics) {
  const prefix = {
    morning: "Morning digest",
    midday: "Midday digest",
    end_of_day: "Day digest"
  }[type] || "Digest";
  const counts = buildDigestCounts(items);
  const metrics = digestMetrics.metrics;
  const parts = [
    `${prefix}: ${counts.total} updates across ${metrics.threadCount} active threads.`,
    `${metrics.quotesSent} quotes were sent and ${metrics.orderAcknowledgements} order acknowledgements were received.`,
    `${metrics.customerComplaints.open} complaints appear open and ${metrics.customerComplaints.closed} appear closed.`,
    `${metrics.replyNeededThreads} threads appear to need a reply. ${taskSummary.open} open tasks remain, with ${taskSummary.dueToday} due today and ${taskSummary.overdue} overdue.`
  ];

  return parts.join(" ");
}

async function maybeGenerateDigestNarrative(items, taskSummary, fallbackText, digestMetrics) {
  const { openaiKey = "", enableSummaries = false } = await chrome.storage.local.get([
    "openaiKey",
    "enableSummaries"
  ]);

  if (!enableSummaries || !openaiKey || items.length < 4) {
    return {
      text: fallbackText,
      source: "local"
    };
  }

  try {
    const payload = items.slice(0, 15).map(item => ({
      subject: item.title,
      summary: item.summary,
      priority: item.ai?.priority || "medium",
      category: item.ai?.category || "unclassified",
      needsReply: item.ai?.needsReply === true,
      taskNeeded: item.ai?.taskNeeded === true
    }));

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You write concise CRM daily digest summaries for sales and customer service teams. " +
              "Return JSON only with a single key `digest`. Keep it to 3-5 short sentences focused on activity, quotes, order acknowledgements, complaints, open items, and follow-up pressure."
          },
          {
            role: "user",
            content: JSON.stringify({
              taskSummary,
              digestMetrics: digestMetrics.metrics,
              items: payload
            })
          }
        ],
        max_tokens: 180,
        temperature: 0.2
      })
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    const rawText = data.choices?.[0]?.message?.content?.trim() || "";
    const parsed = parseJsonResponse(rawText) || {};
    const digest = normalizeWhitespace(parsed.digest || "");
    if (!digest) {
      throw new Error("Digest response was empty.");
    }

    return {
      text: digest,
      source: "ai"
    };
  } catch (error) {
    console.warn("[WARN] Digest narrative generation failed", error);
    return {
      text: fallbackText,
      source: "local"
    };
  }
}

async function generateDigestByType(type = "end_of_day") {
  return runLocked(digestGenerationLocks, type, async () => {
    const { rssItems = [], capsuleTasks = [], digests = [] } = await chrome.storage.local.get([
      "rssItems",
      "capsuleTasks",
      "digests"
    ]);
    const now = new Date();
    const { dateKey } = getLocalDateParts(now);
    const existing = digests.find(digest => digest.type === type && digest.dateKey === dateKey) || null;
    if (existing && isDigestRecordCurrent(existing)) {
      return { ok: true, digest: existing, digests, skipped: "duplicate", created: false };
    }

    const windowStart = getDigestWindowStart(now, type);
    const recentItems = [...rssItems]
      .filter(item => {
        const itemTime = new Date(item.date).getTime();
        return itemTime >= windowStart.getTime() && itemTime <= now.getTime() && !item.deleted;
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    if (!recentItems.length) {
      return { ok: true, digest: null, digests, skipped: "empty", created: false };
    }

    const activeTasks = capsuleTasks.map(task => {
      const today = new Date().toISOString().slice(0, 10);
      const isCompleted = task.status === "completed" || task.status === "dismissed" || task.status === "pending";
      return {
        ...task,
        status: isCompleted
          ? task.status
          : task.dueDate && task.dueDate < today
            ? "overdue"
            : "open",
        dueToday: !isCompleted && task.dueDate === today
      };
    });
    const taskSummary = getTaskSummary(activeTasks);
    const counts = buildDigestCounts(recentItems);
    const signals = buildDigestSignals(recentItems);
    const digestMetrics = buildDigestMetrics(recentItems, activeTasks);
    const fallbackText = buildDigestFallbackText(type, recentItems, taskSummary, digestMetrics);
    const narrative = await maybeGenerateDigestNarrative(recentItems, taskSummary, fallbackText, digestMetrics);
    const digest = {
      id: `digest_${Date.now()}`,
      type,
      typeLabel: getDigestTypeLabel(type),
      dateKey,
      generatedAt: now.toISOString(),
      timeWindowStart: windowStart.toISOString(),
      timeWindowEnd: now.toISOString(),
      itemIds: recentItems.map(item => item.guid),
      itemCount: recentItems.length,
      taskSummary,
      counts,
      signals,
      metrics: digestMetrics.metrics,
      references: digestMetrics.references,
      text: narrative.text,
      source: narrative.source
    };
    const latest = await chrome.storage.local.get("digests");
    const nextDigests = trimDigests([
      digest,
      ...(latest.digests || []).filter(entry => !(entry.type === type && entry.dateKey === dateKey))
    ]);
    await chrome.storage.local.set({ digests: nextDigests });
    await setRuntimeStatus({
      level: "info",
      source: "digests",
      message: `${digest.typeLabel} generated successfully.`
    });
    return { ok: true, digest, digests: nextDigests, created: true };
  });
}

async function generateEndOfDayDigest() {
  return generateDigestByType("end_of_day");
}

async function deleteDigestById(digestId) {
  const { digests = [] } = await chrome.storage.local.get("digests");
  const nextDigests = digests.filter(digest => digest.id !== digestId);
  if (digests.length === nextDigests.length) {
    return { ok: false, error: "Digest not found.", deleted: false, digests };
  }

  await chrome.storage.local.set({ digests: nextDigests });
  await setRuntimeStatus({
    level: "info",
    source: "digests",
    message: "Digest deleted."
  });
  return { ok: true, digests: nextDigests, deleted: true };
}

async function generateScheduledDigestsIfDue() {
  const settings = await getSettings();
  if (!settings.enableDigestAutomation) {
    return { ok: true, generated: [] };
  }

  const now = new Date();
  const { dateKey } = getLocalDateParts(now);
  const currentHour = now.getHours();
  const { digests = [] } = await chrome.storage.local.get("digests");
  const generated = [];

  for (const entry of getDigestSchedule(settings)) {
    if (currentHour < entry.hour) {
      continue;
    }

    if (hasDigestForDate(digests, entry.type, dateKey)) {
      continue;
    }

    const result = await generateDigestByType(entry.type);
    if (result?.digest) {
      digests.unshift(result.digest);
      generated.push(entry.type);
    }
  }

  return { ok: true, generated };
}

async function createLocalTask(item) {
  const lockKey = `${item.guid}:${item.ai?.suggestedTaskTitle || item.title || "task"}`;
  return runLocked(taskCreationLocks, lockKey, async () => {
    const { capsuleTasks = [] } = await chrome.storage.local.get("capsuleTasks");
    const threadKey = getThreadKey(item);
    const existing = capsuleTasks.find(task => (
      (task.sourceGuid === item.guid || (threadKey && task.threadKey === threadKey)) &&
      task.title === (item.ai?.suggestedTaskTitle || `Follow up: ${item.title || "Capsule activity"}`) &&
      task.status !== "completed" &&
      task.status !== "dismissed" &&
      task.status !== "pending"
    ));

    if (existing) {
      return {
        task: existing,
        created: false
      };
    }

    const task = createTaskRecord(item);
    const syncedTask = await createCapsuleTaskForItem(task, item);
    const latest = await chrome.storage.local.get("capsuleTasks");
    const nextTasks = [syncedTask, ...(latest.capsuleTasks || [])]
      .filter((entry, index, array) => array.findIndex(other => other.capsuleTaskId === entry.capsuleTaskId) === index)
      .slice(0, 500);
    await chrome.storage.local.set({ capsuleTasks: nextTasks });
    await setRuntimeStatus({
      level: "info",
      source: "tasks",
      message: "Task created in Capsule."
    });
    return {
      task: syncedTask,
      created: true
    };
  });
}

async function generateReplyDraft(item) {
  const {
    openaiKey = "",
    replyDraftCache = {}
  } = await chrome.storage.local.get([
    "openaiKey",
    "replyDraftCache"
  ]);

  if (!openaiKey) {
    throw new Error("Add an OpenAI API key in Settings before generating AI drafts.");
  }

  const { emailClient = "default" } = await getSettings();
  const cacheKey = buildReplyDraftCacheKey(item, emailClient);
  const cached = replyDraftCache[cacheKey];
  if (cached?.version === DRAFT_REPLY_VERSION && cached?.draft) {
    return cached;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You write concise business email drafts for inside sales and customer service teams. " +
            "Return JSON only with keys: subject, draft. " +
            "The draft must be short, professional, and safe to review before sending. " +
            "Format the draft as a real email with line breaks: greeting, 1-3 short body paragraphs, and a simple closing. " +
            "Do not claim actions were taken unless stated in the source. Do not return one dense paragraph."
        },
        {
          role: "user",
          content: JSON.stringify({
            subject: item.title,
            author: item.author,
            recipients: item.recipients,
            summary: item.summary,
            body: item.body,
            ai: item.ai || {}
          })
        }
      ],
      max_tokens: 220,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content?.trim() || "";
  const parsed = parseJsonResponse(rawText) || {};
  const draftPayload = {
    subject: normalizeWhitespace(parsed.subject || item.title || ""),
    draft: normalizeDraftText(parsed.draft || ""),
    createdAt: new Date().toISOString(),
    version: DRAFT_REPLY_VERSION,
    model: AI_MODEL
  };

  if (!draftPayload.draft) {
    throw new Error("Draft generation returned an empty reply.");
  }

  const nextCache = {
    ...replyDraftCache,
    [cacheKey]: draftPayload
  };
  await chrome.storage.local.set({ replyDraftCache: trimDraftCache(nextCache) });
  return draftPayload;
}

async function analyzeBatch(items) {
  const {
    enableSummaries = false,
    openaiKey = "",
    aiAnalysisCache = {},
    noiseFilterStrength = "balanced",
    deprioritizeInvoiceEmails = true,
    deprioritizeOrderAcknowledgements = true,
    deprioritizeQuoteAcknowledgements = true
  } = await chrome.storage.local.get([
    "enableSummaries",
    "openaiKey",
    "aiAnalysisCache",
    "noiseFilterStrength",
    "deprioritizeInvoiceEmails",
    "deprioritizeOrderAcknowledgements",
    "deprioritizeQuoteAcknowledgements"
  ]);
  const analysisSettings = {
    noiseFilterStrength,
    deprioritizeInvoiceEmails,
    deprioritizeOrderAcknowledgements,
    deprioritizeQuoteAcknowledgements
  };

  if (!items.length) {
    return {};
  }

  const cache = { ...aiAnalysisCache };
  const analysisMap = {};
  const itemsToAnalyze = [];

  if (!enableSummaries || !openaiKey) {
    for (const item of items) {
      const analysisHash = await hashAnalysisFingerprint(
        `${buildAnalysisFingerprint(item)}\n${getAnalysisTuningFingerprint(analysisSettings)}`
      );
      analysisMap[item.guid] = getHeuristicAnalysis(item, analysisHash, analysisSettings);
    }
    return analysisMap;
  }

  for (const item of items) {
    const analysisHash = await hashAnalysisFingerprint(
      `${buildAnalysisFingerprint(item)}\n${getAnalysisTuningFingerprint(analysisSettings)}`
    );
    const heuristic = getHeuristicAnalysis(item, analysisHash, analysisSettings);
    const cached = cache[analysisHash]?.analysis;
    if (cached && cached.version === AI_ANALYSIS_VERSION) {
      analysisMap[item.guid] = {
        ...cached,
        raw: cached.raw || {}
      };
      continue;
    }

    if (heuristic.category === "automated_update" && heuristic.priority === "low" && !heuristic.needsReply) {
      analysisMap[item.guid] = heuristic;
      cache[analysisHash] = {
        cachedAt: heuristic.analyzedAt,
        analysis: heuristic
      };
      continue;
    }

    itemsToAnalyze.push({ ...item, analysisHash });
  }

  if (!itemsToAnalyze.length) {
    return analysisMap;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openaiKey}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You analyze Capsule CRM activity for inside sales, customer service, and sales managers. " +
            "Return structured JSON only. " +
            "Flag automated acknowledgements, invoice notices, quote receipts, order confirmations, and low-value system updates as lower priority unless a customer question, change request, escalation, or explicit follow-up request is present. " +
            "Summaries must describe only the message content and any explicit action items stated in the message. " +
            "Do not recommend next steps, do not infer unstated actions, and do not editorialize."
        },
        {
          role: "user",
          content:
            "Return only a JSON object with an `items` array. " +
            "Each item must include: guid, summary, priority, priority_reason, category, needs_reply, reply_urgency, meeting_mentioned, task_needed, task_type, suggested_task_title, suggested_due, workflow_actions, signals. " +
            "Use priority values low, medium, high, critical. " +
            "Use reply_urgency values none, today, soon, urgent. " +
            "Categories should be concise snake_case labels such as customer_request, order_change, automated_update, internal_note, escalation, scheduling, quote_request, follow_up. " +
            `Noise filtering mode is ${analysisSettings.noiseFilterStrength}. ` +
            `Treat invoice emails as low priority by default: ${analysisSettings.deprioritizeInvoiceEmails !== false}. ` +
            `Treat order acknowledgements as low priority by default: ${analysisSettings.deprioritizeOrderAcknowledgements !== false}. ` +
            `Treat quote acknowledgements as low priority by default: ${analysisSettings.deprioritizeQuoteAcknowledgements !== false}. ` +
            "Each summary must be 12-28 words and summarize only the email plus explicit action items. " +
            "Do not include recommendations, inferred next steps, or commentary about what should happen next. " +
            "Set needs_reply true only when a human reply is warranted. " +
            "Set task_needed true only when work should be tracked. " +
            "workflow_actions should only contain items from: reply_email, schedule_meeting, create_capsule_task, open_capsule. " +
            "signals should be short snake_case labels.\n\n" +
            JSON.stringify(itemsToAnalyze.map(item => ({
              guid: item.guid,
              subject: item.title,
              author: item.author,
              recipients: item.recipients,
              body: item.body
            })))
        }
      ],
      max_tokens: Math.max(300, itemsToAnalyze.length * 220),
      temperature: 0.2
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content?.trim() || "";
  if (!rawText) {
    return analysisMap;
  }

  const parsed = parseJsonResponse(rawText);
  const parsedItems = Array.isArray(parsed) ? parsed : parsed?.items;

  if (!Array.isArray(parsedItems)) {
    return analysisMap;
  }

  const itemLookup = new Map(itemsToAnalyze.map(item => [String(item.guid), item]));

  for (const rawResult of parsedItems) {
    const guid = String(rawResult?.guid || "");
    const sourceItem = itemLookup.get(guid);
    if (!guid || !sourceItem) {
      continue;
    }

    const normalized = normalizeAnalysisResult(rawResult, sourceItem, sourceItem.analysisHash, { model: AI_MODEL });
    analysisMap[guid] = normalized;
    cache[sourceItem.analysisHash] = {
      cachedAt: normalized.analyzedAt,
      analysis: normalized
    };
  }

  for (const item of itemsToAnalyze) {
    if (analysisMap[item.guid]) {
      continue;
    }

    const fallback = getHeuristicAnalysis(item, item.analysisHash, analysisSettings);
    analysisMap[item.guid] = fallback;
    cache[item.analysisHash] = {
      cachedAt: fallback.analyzedAt,
      analysis: fallback
    };
  }

  await chrome.storage.local.set({ aiAnalysisCache: trimAnalysisCache(cache) });

  return analysisMap;
}

function mergeItems(existingItems, incomingItems) {
  const merged = new Map();

  for (const item of existingItems) {
    if (!item.guid) {
      continue;
    }
    merged.set(item.guid, item);
  }

  for (const item of incomingItems) {
    const previous = merged.get(item.guid);
    merged.set(item.guid, {
      ...previous,
      ...item,
      summary: item.summary || previous?.summary || "",
      ai: item.ai || previous?.ai || null,
      read: previous?.read ?? item.read ?? false,
      saved: previous?.saved ?? item.saved ?? false,
      deleted: previous?.deleted ?? item.deleted ?? false,
      snoozedUntil: previous?.snoozedUntil ?? item.snoozedUntil ?? 0
    });
  }

  return [...merged.values()]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_STORED_ITEMS);
}

async function reanalyzeStoredItems() {
  const { rssItems = [] } = await chrome.storage.local.get("rssItems");
  if (!rssItems.length) {
    return [];
  }

  const analysisMap = await analyzeBatch(rssItems);
  const nextItems = rssItems.map(item => {
    const analysis = analysisMap[item.guid];
    if (!analysis) {
      return item;
    }

    return {
      ...item,
      summary: analysis.summary || item.snippet || item.summary || "",
      ai: analysis
    };
  });

  await chrome.storage.local.set({ rssItems: nextItems });
  return nextItems;
}

async function notifyNewItems(newItems) {
  if (!newItems.length) {
    return;
  }

  const displayItems = newItems.slice(0, 5).map(item => ({
    title: item.title,
    message: item.summary || item.snippet || ""
  }));

  await chrome.storage.session.set({ latestNotificationLink: newItems[0].link || "" });
  await chrome.notifications.create(GROUPED_NOTIFICATION_ID, {
    type: "list",
    iconUrl: "icons/icon128.png",
    title: `You have ${newItems.length} new CRM activit${newItems.length === 1 ? "y" : "ies"}`,
    message: newItems.length > 5 ? `And ${newItems.length - 5} more...` : "",
    items: displayItems,
    priority: 1
  });
}

async function maybePlaySound(enabled) {
  if (!enabled || typeof Audio === "undefined") {
    return;
  }

  try {
    const audio = new Audio(chrome.runtime.getURL("ding.mp3"));
    await audio.play();
  } catch (error) {
    console.warn("[WARN] Failed to play sound", error);
  }
}

async function getSettings() {
  const data = await chrome.storage.local.get([
    "interval",
    "notificationsEnabled",
    "soundEnabled",
    "snoozeUntil",
    "enableSummaries",
    "enableDock",
    "capsuleToken",
    "capsuleWebBaseUrl",
    "emailClient",
    "notifyPriorityThreshold",
    "showMediumInFeed",
    "hideLowPriorityInFeed",
    "alwaysShowReplyNeeded",
    "noiseFilterStrength",
    "deprioritizeInvoiceEmails",
    "deprioritizeOrderAcknowledgements",
    "deprioritizeQuoteAcknowledgements",
    "calendarShortcutMode",
    "enableDigestAutomation",
    "morningDigestHour",
    "middayDigestHour",
    "endOfDayDigestHour"
  ]);

  configuredCapsuleWebBaseUrl = normalizeCapsuleWebBaseUrl(data.capsuleWebBaseUrl);

  return {
    interval: data.interval || DEFAULT_INTERVAL,
    notificationsEnabled: data.notificationsEnabled !== false,
    soundEnabled: data.soundEnabled !== false,
    snoozeUntil: data.snoozeUntil || 0,
    enableSummaries: data.enableSummaries === true,
    enableDock: data.enableDock === true,
    capsuleToken: data.capsuleToken || "",
    capsuleWebBaseUrl: configuredCapsuleWebBaseUrl,
    emailClient: data.emailClient || "default",
    notifyPriorityThreshold: PRIORITY_LEVELS.includes(data.notifyPriorityThreshold) ? data.notifyPriorityThreshold : "high",
    showMediumInFeed: data.showMediumInFeed !== false,
    hideLowPriorityInFeed: data.hideLowPriorityInFeed !== false,
    alwaysShowReplyNeeded: data.alwaysShowReplyNeeded !== false,
    noiseFilterStrength: ["balanced", "strict", "aggressive"].includes(data.noiseFilterStrength) ? data.noiseFilterStrength : "balanced",
    deprioritizeInvoiceEmails: data.deprioritizeInvoiceEmails !== false,
    deprioritizeOrderAcknowledgements: data.deprioritizeOrderAcknowledgements !== false,
    deprioritizeQuoteAcknowledgements: data.deprioritizeQuoteAcknowledgements !== false,
    calendarShortcutMode: data.calendarShortcutMode === "always" ? "always" : "meeting_only",
    enableDigestAutomation: data.enableDigestAutomation === true,
    morningDigestHour: Number.isInteger(data.morningDigestHour) ? data.morningDigestHour : 8,
    middayDigestHour: Number.isInteger(data.middayDigestHour) ? data.middayDigestHour : 12,
    endOfDayDigestHour: Number.isInteger(data.endOfDayDigestHour) ? data.endOfDayDigestHour : 17
  };
}

function shouldNotifyItem(item, settings) {
  const analysis = item.ai || getHeuristicAnalysis(item);
  if (!settings.notificationsEnabled) {
    return false;
  }

  if ((item.snoozedUntil || 0) > Date.now()) {
    return false;
  }

  if (settings.alwaysShowReplyNeeded && analysis.needsReply) {
    return true;
  }

  return getPriorityRank(analysis.priority) >= getPriorityRank(settings.notifyPriorityThreshold);
}

async function handleRefresh(options = {}) {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const {
    reason = "manual",
    notificationsEnabled: notificationOverride,
    soundEnabled: soundOverride
  } = options;

  refreshInFlight = (async () => {
    const settings = await getSettings();

    if (reason === "alarm" && Date.now() < settings.snoozeUntil) {
      return { ok: true, newCount: 0, skipped: "snoozed" };
    }

    const requirements = await ensureRequiredSettings(settings, "refresh");
    if (!requirements.ok) {
      return { ok: false, error: requirements.error, missing: requirements.missing };
    }

    const entries = await fetchCapsuleEntries(settings.capsuleToken, settings.capsuleWebBaseUrl);
    const newItems = entries.filter(item => !seenGuids.has(item.guid));
    newItems.forEach(item => seenGuids.add(item.guid));

    let analysisMap = {};
    try {
      analysisMap = await analyzeBatch(newItems);
    } catch (error) {
      console.warn("[WARN] AI analysis failed", error);
    }

    for (const item of newItems) {
      const analysis = analysisMap[item.guid];
      item.summary = analysis?.summary || item.snippet;
      item.ai = analysis || null;
    }

    const { rssItems = [] } = await chrome.storage.local.get("rssItems");
    const mergedItems = mergeItems(rssItems, [...entries, ...newItems]);
    await chrome.storage.local.set({ rssItems: mergedItems });
    try {
      await refreshCapsuleTasks();
    } catch (error) {
      console.warn("[WARN] Capsule task refresh failed", error);
    }
    await seedSeenGuids();
    await updateBadgeFromStorage();

    const notificationsEnabled = notificationOverride ?? settings.notificationsEnabled;
    const soundEnabled = soundOverride ?? settings.soundEnabled;

    const itemsForNotification = newItems.filter(item => shouldNotifyItem(item, {
      ...settings,
      notificationsEnabled
    }));

    if (itemsForNotification.length && notificationsEnabled) {
      await notifyNewItems(itemsForNotification);
    }

    if (itemsForNotification.length && soundEnabled) {
      await maybePlaySound(true);
    }

    if (reason !== "alarm" || newItems.length) {
      await setRuntimeStatus({
        level: "info",
        source: "refresh",
        message: newItems.length ? `Refresh complete. ${newItems.length} new item${newItems.length === 1 ? "" : "s"} found.` : "Refresh complete. No new items."
      });
    }
    return { ok: true, newCount: newItems.length };
  })()
    .catch(error => {
      console.error("[ERROR] Refresh failed:", error);
      setRuntimeStatus({
        level: "error",
        source: "refresh",
        message: error.message || "Refresh failed."
      }).catch(() => {});
      return { ok: false, error: error.message || "Refresh failed." };
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

function getItemByGuid(rssItems, guid) {
  return rssItems.find(item => String(item.guid) === String(guid)) || null;
}

async function openReplyShortcut(guid, mode = "plain") {
  const { rssItems = [] } = await chrome.storage.local.get("rssItems");
  const item = getItemByGuid(rssItems, guid);
  if (!item) {
    throw new Error("Could not find the selected activity.");
  }

  const settings = await getSettings();
  if (mode === "draft") {
    const draftPayload = await generateReplyDraft(item);
    if (settings.emailClient === "gmail") {
      await openExternalUrl(buildGmailComposeUrl(item, draftPayload.draft));
      return { ok: true, mode: "gmail_draft", draft: draftPayload.draft };
    }

    return {
      ok: true,
      mode: "default_draft",
      composeUrl: buildMailtoUrl(item, draftPayload.draft),
      draft: draftPayload.draft
    };
  }

  if (settings.emailClient === "gmail") {
    await openExternalUrl(buildGmailComposeUrl(item));
    return { ok: true, mode: "gmail_subject" };
  }

  return {
    ok: true,
    mode: "default_subject",
    composeUrl: buildMailtoUrl(item)
  };
}

async function openScheduleShortcut(guid) {
  const { rssItems = [] } = await chrome.storage.local.get("rssItems");
  const item = getItemByGuid(rssItems, guid);
  if (!item) {
    throw new Error("Could not find the selected activity.");
  }

  await openExternalUrl(buildCalendarUrl(item));
  return { ok: true };
}

async function createTaskShortcut(guid) {
  const { rssItems = [] } = await chrome.storage.local.get("rssItems");
  const item = getItemByGuid(rssItems, guid);
  if (!item) {
    throw new Error("Could not find the selected activity.");
  }

  return createLocalTask(item);
}

async function getLocalTaskSummary() {
  const { capsuleTasks = [] } = await chrome.storage.local.get("capsuleTasks");
  return {
    ok: true,
    summary: getTaskSummary(capsuleTasks),
    taskCount: capsuleTasks.length
  };
}

async function completeLocalTask(taskId) {
  const { capsuleTasks = [], rssItems = [] } = await chrome.storage.local.get(["capsuleTasks", "rssItems"]);
  const task = capsuleTasks.find(entry => entry.id === taskId);
  if (!task) {
    throw new Error("Could not find the selected task.");
  }

  const item = getItemByGuid(rssItems, task.sourceGuid);
  let updatedTask = updateTaskStatusShape(task, "completed");
  updatedTask = await syncTaskCompletionToCapsule(updatedTask, item);

  await updateStoredTask(updatedTask);
  await setRuntimeStatus({
    level: "info",
    source: "tasks",
    message: "Task completed in Capsule."
  });
  return { ok: true, task: updatedTask };
}

async function scheduleAlarm(interval) {
  await chrome.alarms.clear("rssCheck");
  await chrome.alarms.create("rssCheck", { periodInMinutes: interval });
}

async function scheduleDigestAlarm() {
  await chrome.alarms.clear(DIGEST_ALARM_NAME);
  await chrome.alarms.create(DIGEST_ALARM_NAME, { periodInMinutes: 15 });
}

chrome.notifications.onClicked.addListener(async notificationId => {
  if (notificationId !== GROUPED_NOTIFICATION_ID) {
    return;
  }

  const { latestNotificationLink = "" } = await chrome.storage.session.get("latestNotificationLink");
  if (latestNotificationLink) {
    await openOrUpdateTab(latestNotificationLink);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "openEntry") {
    if (!msg.url) {
      sendResponse({ ok: false, error: "No Capsule link is available for this item." });
      return true;
    }

    openOrUpdateTab(msg.url)
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Unable to open item." }));
    return true;
  }

  if (msg.type === "manualRefresh") {
    handleRefresh({ reason: "manual" }).then(sendResponse);
    return true;
  }

  if (msg.type === "settingsUpdated") {
    getSettings()
      .then(async settings => {
        const requirements = await ensureRequiredSettings(settings, "settings");
        await applyDockSetting();
        await scheduleAlarm(settings.interval);
        await scheduleDigestAlarm();
        await reanalyzeStoredItems();
        if (requirements.ok) {
          try {
            await refreshCapsuleTasks();
          } catch (error) {
            console.warn("[WARN] Capsule task refresh failed after settings update", error);
          }
        }
        await generateScheduledDigestsIfDue();
        return requirements.ok ? { ok: true } : requirements;
      })
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || "Unable to apply settings." }));
    return true;
  }

  if (msg.type === "openReplyShortcut" && msg.guid) {
    openReplyShortcut(msg.guid, msg.mode || "plain")
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || "Unable to open reply action." }));
    return true;
  }

  if (msg.type === "openScheduleShortcut" && msg.guid) {
    openScheduleShortcut(msg.guid)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || "Unable to open calendar action." }));
    return true;
  }

  if (msg.type === "createLocalTask" && msg.guid) {
    createTaskShortcut(msg.guid)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(error => sendResponse({ ok: false, error: error.message || "Unable to create a local task." }));
    return true;
  }

  if (msg.type === "getTaskSummary") {
    getLocalTaskSummary()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || "Unable to load task summary." }));
    return true;
  }

  if (msg.type === "completeLocalTask" && msg.taskId) {
    completeLocalTask(msg.taskId)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || "Unable to complete the task." }));
    return true;
  }

  if (msg.type === "generateEndOfDayDigest") {
    generateEndOfDayDigest()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || "Unable to generate digest." }));
    return true;
  }

  if (msg.type === "generateDigest" && msg.digestType) {
    generateDigestByType(msg.digestType)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || "Unable to generate digest." }));
    return true;
  }

  if (msg.type === "deleteDigest" && msg.digestId) {
    deleteDigestById(msg.digestId)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || "Unable to delete digest." }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(async () => {
  const sessionValues = await chrome.storage.session.get(["capsuleToken", "openaiKey"]);
  if (sessionValues.capsuleToken || sessionValues.openaiKey) {
    await chrome.storage.local.set({
      ...(sessionValues.capsuleToken ? { capsuleToken: sessionValues.capsuleToken } : {}),
      ...(sessionValues.openaiKey ? { openaiKey: sessionValues.openaiKey } : {})
    });
  }

  const settings = await getSettings();
  await seedSeenGuids();
  await applyDockSetting();
  await scheduleAlarm(settings.interval || DEFAULT_INTERVAL);
  await scheduleDigestAlarm();
  const requirements = await ensureRequiredSettings(settings, "install");
  if (requirements.ok) {
    await handleRefresh({ reason: "install", notificationsEnabled: false, soundEnabled: false });
    try {
      await refreshCapsuleTasks();
    } catch (error) {
      console.warn("[WARN] Capsule task refresh failed on install", error);
    }
  }
  await generateScheduledDigestsIfDue();
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await seedSeenGuids();
  await applyDockSetting();
  await scheduleAlarm(settings.interval);
  await scheduleDigestAlarm();
  await updateBadgeFromStorage();
  const requirements = await ensureRequiredSettings(settings, "startup");
  if (requirements.ok) {
    await handleRefresh({ reason: "startup", notificationsEnabled: false, soundEnabled: false });
    try {
      await refreshCapsuleTasks();
    } catch (error) {
      console.warn("[WARN] Capsule task refresh failed on startup", error);
    }
  }
  await generateScheduledDigestsIfDue();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === "rssCheck") {
    await handleRefresh({ reason: "alarm" });
    return;
  }

  if (alarm.name === DIGEST_ALARM_NAME) {
    await generateScheduledDigestsIfDue();
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "local") {
    if (changes.rssItems) {
      await seedSeenGuids();
      await updateBadgeFromStorage();
    }

    if (changes.enableDock) {
      await applyDockSetting();
    }

    if (changes.interval) {
      const nextInterval = Number(changes.interval.newValue) || DEFAULT_INTERVAL;
      await scheduleAlarm(nextInterval);
    }
  }
});

seedSeenGuids();
updateBadgeFromStorage();
applyDockSetting();
scheduleDigestAlarm();
