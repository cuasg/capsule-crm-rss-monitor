let posts = [];
let currentTab = "recent";
let currentTaskFilter = "all";
let currentTaskOwner = "all";
let filterSettings = {
  showMediumInFeed: true,
  hideLowPriorityInFeed: true,
  alwaysShowReplyNeeded: true
};
let actionSettings = {
  emailClient: "default",
  calendarShortcutMode: "meeting_only"
};
let capsuleTasks = [];
let digests = [];
let missingSetupItems = [];
let allTaskIndexes = { byGuid: new Map(), byLink: new Map() };
let filteredTaskIndexes = { byGuid: new Map(), byLink: new Map() };
let taskSummary = {
  open: 0,
  dueToday: 0,
  overdue: 0
};
let runtimeStatus = null;
let loadPostsPromise = null;
const expandedThreads = {
  recent: new Set(),
  saved: new Set(),
  history: new Set()
};

function normalizeSubject(subject = "") {
  return subject.replace(/^(?:\s*(?:re|fwd)\s*[:\-]\s*)+/i, "").trim();
}

function normalizeParticipantKey(item) {
  if (item?.partyId) {
    return `party:${String(item.partyId).trim().toLowerCase()}`;
  }

  if (Array.isArray(item?.recipients) && item.recipients.length) {
    const recipients = [...new Set(
      item.recipients
        .map(value => String(value || "").trim().toLowerCase())
        .filter(Boolean)
    )].sort();

    if (recipients.length) {
      return `recipients:${recipients.join("|")}`;
    }
  }

  if (item?.recipientText) {
    const recipientText = String(item.recipientText).trim().toLowerCase();
    if (recipientText) {
      return `recipient:${recipientText}`;
    }
  }

  if (item?.author) {
    const author = String(item.author).trim().toLowerCase();
    if (author) {
      return `author:${author}`;
    }
  }

  return "participant:unknown";
}

function getThreadKey(item) {
  const subject = normalizeSubject(item?.title || "").toLowerCase();
  const participantKey = normalizeParticipantKey(item);
  return subject ? `${subject}__${participantKey}` : item?.guid || participantKey;
}

function getPriorityRank(priority = "medium") {
  switch (priority) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    default:
      return 1;
  }
}

function getItemPriority(item) {
  return item.ai?.priority || "medium";
}

function getActiveTaskForItem(item) {
  return getAllMatchingTasksForItem(item).find(task => (
    task.status !== "completed" &&
    task.status !== "dismissed" &&
    task.status !== "pending"
  )) || null;
}

function createTaskIndexes(tasks) {
  const byGuid = new Map();
  const byLink = new Map();

  for (const task of tasks) {
    if (task.sourceGuid) {
      const existing = byGuid.get(task.sourceGuid) || [];
      existing.push(task);
      byGuid.set(task.sourceGuid, existing);
    }

    if (task.sourceLink) {
      const existing = byLink.get(task.sourceLink) || [];
      existing.push(task);
      byLink.set(task.sourceLink, existing);
    }
  }

  return { byGuid, byLink };
}

function getIndexedTasksForItem(indexes, item) {
  const matches = [];

  if (item.guid && indexes.byGuid.has(item.guid)) {
    matches.push(...indexes.byGuid.get(item.guid));
  }

  if (item.link && indexes.byLink.has(item.link)) {
    for (const task of indexes.byLink.get(item.link)) {
      if (!matches.includes(task)) {
        matches.push(task);
      }
    }
  }

  return matches;
}

function getFilteredCapsuleTasks() {
  if (currentTaskOwner === "all") {
    return capsuleTasks;
  }

  return capsuleTasks.filter(task => (task.owner || task.assignee || "") === currentTaskOwner);
}

function getLinkedTasks(tasks) {
  return tasks.filter(task => task.sourceGuid || task.sourceLink);
}

function getAllMatchingTasksForItem(item) {
  return getIndexedTasksForItem(allTaskIndexes, item);
}

function getMatchingTasksForItem(item) {
  return getIndexedTasksForItem(filteredTaskIndexes, item);
}

function matchesTaskFilter(item) {
  if (currentTaskFilter === "all") {
    return true;
  }

  const tasks = getMatchingTasksForItem(item).filter(task => (
    task.status !== "completed" &&
    task.status !== "dismissed" &&
    task.status !== "pending"
  ));

  if (!tasks.length) {
    return false;
  }

  if (currentTaskFilter === "open") {
    return true;
  }

  if (currentTaskFilter === "due_today") {
    return tasks.some(task => task.dueToday === true);
  }

  if (currentTaskFilter === "overdue") {
    return tasks.some(task => task.status === "overdue" || (task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10)));
  }

  return true;
}

function populateTaskOwnerFilter() {
  const select = document.getElementById("taskOwnerFilter");
  const owners = [...new Set(
    capsuleTasks
      .map(task => task.owner || task.assignee || "")
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  select.innerHTML = '<option value="all">All task owners</option>';
  for (const owner of owners) {
    const option = document.createElement("option");
    option.value = owner;
    option.textContent = owner;
    select.appendChild(option);
  }

  select.value = owners.includes(currentTaskOwner) ? currentTaskOwner : "all";
  currentTaskOwner = select.value;
  filteredTaskIndexes = createTaskIndexes(getFilteredCapsuleTasks());
}

function updateTaskSummaryUI() {
  const filteredTasks = getFilteredCapsuleTasks();
  const activeTasks = filteredTasks.filter(task => (
    task.status !== "completed" &&
    task.status !== "dismissed" &&
    task.status !== "pending"
  ));

  taskSummary = {
    open: activeTasks.length,
    dueToday: activeTasks.filter(task => task.dueToday).length,
    overdue: activeTasks.filter(task => task.status === "overdue").length
  };

  document.getElementById("taskOpenCount").textContent = String(taskSummary.open || 0);
  document.getElementById("taskDueTodayCount").textContent = String(taskSummary.dueToday || 0);
  document.getElementById("taskOverdueCount").textContent = String(taskSummary.overdue || 0);

  document.querySelectorAll(".task-summary-btn[data-task-filter]").forEach(button => {
    button.classList.toggle("active", button.dataset.taskFilter === currentTaskFilter);
  });

  document.getElementById("taskFilterClear").classList.toggle("hidden", currentTaskFilter === "all");
}

function renderRuntimeStatus() {
  const container = document.getElementById("runtimeStatus");
  window.clearTimeout(renderRuntimeStatus.timeoutId);

  if (!runtimeStatus?.message) {
    container.textContent = "";
    container.className = "runtime-status hidden";
    return;
  }

  container.textContent = runtimeStatus.message;
  container.className = `runtime-status level-${runtimeStatus.level || "info"}`;
  renderRuntimeStatus.timeoutId = window.setTimeout(() => {
    container.textContent = "";
    container.className = "runtime-status hidden";
  }, 5000);
}

function getMissingSetupItems(settings = {}) {
  const missing = [];

  if (!String(settings.capsuleToken || "").trim()) {
    missing.push("Capsule API Token");
  }

  if (!String(settings.capsuleWebBaseUrl || "").trim()) {
    missing.push("Capsule Web App URL");
  }

  return missing;
}

function renderSetupModal() {
  const modal = document.getElementById("setupModal");
  const message = document.getElementById("setupModalMessage");
  const missing = document.getElementById("setupModalMissing");

  if (!missingSetupItems.length) {
    modal.classList.add("hidden");
    return;
  }

  message.textContent = "This extension requires your Capsule account settings before links, refreshes, and task actions can work.";
  const list = document.createElement("ul");
  for (const item of missingSetupItems) {
    const entry = document.createElement("li");
    entry.textContent = item;
    list.appendChild(entry);
  }
  missing.replaceChildren(list);
  modal.classList.remove("hidden");
}

function toggleSecondaryPanels() {
  const taskSummarySection = document.getElementById("taskSummary");
  const taskOwnerBar = document.getElementById("taskOwnerBar");
  const historyFilters = document.getElementById("historyFilters");
  const digestControls = document.getElementById("digestControls");
  taskSummarySection.classList.toggle("hidden", currentTab !== "tasks");
  taskOwnerBar.classList.toggle("hidden", currentTab !== "tasks");
  historyFilters.classList.toggle("hidden", currentTab !== "history");
  digestControls.classList.toggle("hidden", currentTab !== "digests");
}

function showActionStatus(message, isError = false) {
  const status = document.getElementById("actionStatus");
  status.textContent = message;
  status.classList.remove("hidden");
  status.classList.toggle("error", isError);

  window.clearTimeout(showActionStatus.timeoutId);
  showActionStatus.timeoutId = window.setTimeout(() => {
    status.textContent = "";
    status.classList.remove("error");
    status.classList.add("hidden");
  }, 3500);
}

function shouldShowScheduleShortcut(item) {
  return actionSettings.calendarShortcutMode === "always" || item.ai?.meetingMentioned === true;
}

function getReplyButtonLabel() {
  return actionSettings.emailClient === "gmail" ? "Open Gmail" : "Open Email";
}

function getShortcutIcon(actionId) {
  switch (actionId) {
    case "reply":
      return "↩";
    case "draft-reply":
      return "✎";
    case "schedule":
      return "🗓";
    case "create-task":
      return "+";
    case "complete-task":
      return "✓";
    case "mark-reviewed":
      return "👁";
    case "snooze":
      return "⏸";
    case "open-capsule":
      return "↗";
    default:
      return "•";
  }
}

function getFeedActionIcon(actionId, active = false) {
  switch (actionId) {
    case "open":
      return "↗";
    case "mark-read":
      return "✓";
    case "mark-unread":
      return "○";
    case "hide":
      return "✕";
    case "save":
      return active ? "★" : "☆";
    default:
      return "•";
  }
}

function getWorkflowShortcuts(item) {
  const activeTask = getActiveTaskForItem(item);
  const shortcuts = [
    {
      id: "reply",
      label: getReplyButtonLabel(),
      visible: item.ai?.needsReply === true || getItemPriority(item) !== "low"
    },
    {
      id: "draft-reply",
      label: "AI Draft",
      visible: item.ai?.needsReply === true
    },
    {
      id: "schedule",
      label: "Schedule",
      visible: shouldShowScheduleShortcut(item)
    },
    {
      id: "create-task",
      label: "Create Capsule Task",
      visible: !activeTask && (item.ai?.taskNeeded === true || item.ai?.needsReply === true)
    },
    {
      id: "complete-task",
      label: "Complete Capsule Task",
      visible: Boolean(activeTask)
    },
    {
      id: "mark-reviewed",
      label: "Mark Reviewed",
      visible: item.read !== true
    },
    {
      id: "snooze",
      label: "Snooze 4h",
      visible: (item.snoozedUntil || 0) <= Date.now()
    },
    {
      id: "open-capsule",
      label: "Open in Capsule",
      visible: Boolean(item.link)
    }
  ];

  return shortcuts.filter(shortcut => shortcut.visible);
}

async function handleWorkflowShortcut(item, actionId) {
  const activeTask = getActiveTaskForItem(item);
  if (actionId === "open-capsule") {
    await updateThread([item.guid], { read: true });
    await chrome.runtime.sendMessage({ type: "openEntry", url: item.link });
    return;
  }

  if (actionId === "reply") {
    const response = await chrome.runtime.sendMessage({
      type: "openReplyShortcut",
      guid: item.guid,
      mode: "plain"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Unable to open reply shortcut.");
    }

    if (response.mode === "default_subject" && response.composeUrl) {
      window.location.href = response.composeUrl;
    }

    showActionStatus(actionSettings.emailClient === "gmail" ? "Opened Gmail compose." : "Opened your default email app.");
    return;
  }

  if (actionId === "draft-reply") {
    const response = await chrome.runtime.sendMessage({
      type: "openReplyShortcut",
      guid: item.guid,
      mode: "draft"
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Unable to generate a draft reply.");
    }

    if (response.mode === "default_draft") {
      await navigator.clipboard.writeText(response.draft || "");
      if (response.composeUrl) {
        window.location.href = response.composeUrl;
      }
      showActionStatus("AI draft copied to clipboard and your email app was opened. Review before sending.");
      return;
    }

    showActionStatus("Opened Gmail with an AI draft. Review before sending.");
    return;
  }

  if (actionId === "schedule") {
    const response = await chrome.runtime.sendMessage({
      type: "openScheduleShortcut",
      guid: item.guid
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Unable to open Google Calendar.");
    }
    showActionStatus("Opened Google Calendar event creation.");
    return;
  }

  if (actionId === "create-task") {
    const response = await chrome.runtime.sendMessage({
      type: "createLocalTask",
      guid: item.guid
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Unable to create a task.");
    }
    showActionStatus(
      response.created
        ? "Task created in Capsule."
        : "Existing Capsule task reused."
    );
    await loadPosts();
    return;
  }

  if (actionId === "complete-task") {
    if (!activeTask) {
      throw new Error("No linked task found for this item.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "completeLocalTask",
      taskId: activeTask.id
    });
    if (!response?.ok) {
      throw new Error(response?.error || "Unable to complete the task.");
    }
    const syncMessage = response.task?.capsuleSyncMessage || "Task completed in Capsule.";
    showActionStatus(syncMessage);
    await loadPosts();
    return;
  }

  if (actionId === "mark-reviewed") {
    await updateThread([item.guid], { read: true });
    showActionStatus("Marked as reviewed.");
    return;
  }

  if (actionId === "snooze") {
    await updateThread([item.guid], { snoozedUntil: Date.now() + 4 * 60 * 60 * 1000 });
    showActionStatus("Snoozed for 4 hours.");
    return;
  }
}

function attachWorkflowShortcuts(container, item) {
  const target = container.querySelector(".workflow-shortcuts");
  if (!target) {
    return;
  }

  target.innerHTML = "";
  const shortcuts = getWorkflowShortcuts(item);
  if (!shortcuts.length) {
    target.classList.add("hidden");
    return;
  }

  target.classList.remove("hidden");

  for (const shortcut of shortcuts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workflow-btn icon-only-btn";
    button.title = shortcut.label;
    button.setAttribute("aria-label", shortcut.label);
    button.textContent = getShortcutIcon(shortcut.id);
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await handleWorkflowShortcut(item, shortcut.id);
      } catch (error) {
        console.error(error);
        showActionStatus(error.message || "Action failed.", true);
      }
    });
    target.appendChild(button);
  }
}

function shouldHideFromFeed(item, tab) {
  const priority = getItemPriority(item);
  const needsReply = item.ai?.needsReply === true;

  if (tab !== "saved" && filterSettings.alwaysShowReplyNeeded && needsReply) {
    return false;
  }

  if (tab !== "saved" && !filterSettings.showMediumInFeed && priority === "medium") {
    return true;
  }

  if (tab !== "saved" && filterSettings.hideLowPriorityInFeed && priority === "low") {
    return true;
  }

  return false;
}

function getHistoryRangeMs(rangeValue) {
  switch (rangeValue) {
    case "24h":
      return 24 * 60 * 60 * 1000;
    case "3d":
      return 3 * 24 * 60 * 60 * 1000;
    case "7d":
      return 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return 30 * 24 * 60 * 60 * 1000;
    case "90d":
      return 90 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

function getHistoryFilters() {
  return {
    author: document.getElementById("historyAuthorFilter").value,
    recipient: document.getElementById("historyRecipientFilter").value,
    range: document.getElementById("historyRangeFilter").value
  };
}

function loadTheme() {
  chrome.storage.local.get("theme", data => {
    document.body.classList.remove("theme-dark", "theme-light");
    document.body.classList.add(data.theme === "dark" ? "theme-dark" : "theme-light");
  });
}

function toggleTheme() {
  const isDark = document.body.classList.contains("theme-dark");
  const nextTheme = isDark ? "light" : "dark";
  document.body.classList.remove("theme-dark", "theme-light");
  document.body.classList.add(`theme-${nextTheme}`);
  chrome.storage.local.set({ theme: nextTheme });
}

function populateHistoryFilters(items) {
  const authorFilter = document.getElementById("historyAuthorFilter");
  const recipientFilter = document.getElementById("historyRecipientFilter");
  const currentFilters = getHistoryFilters();

  const authors = [...new Set(
    items
      .map(item => item.author || "")
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  const recipients = [...new Set(
    items.flatMap(item => {
      if (Array.isArray(item.recipients) && item.recipients.length) {
        return item.recipients;
      }
      return item.recipientText ? [item.recipientText] : [];
    }).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  authorFilter.innerHTML = '<option value="">All authors</option>';
  for (const author of authors) {
    const option = document.createElement("option");
    option.value = author;
    option.textContent = author;
    authorFilter.appendChild(option);
  }

  recipientFilter.innerHTML = '<option value="">All recipients</option>';
  for (const recipient of recipients) {
    const option = document.createElement("option");
    option.value = recipient;
    option.textContent = recipient;
    recipientFilter.appendChild(option);
  }

  authorFilter.value = authors.includes(currentFilters.author) ? currentFilters.author : "";
  recipientFilter.value = recipients.includes(currentFilters.recipient) ? currentFilters.recipient : "";
}

function filterPostsForTab(items, tab) {
  if (tab === "recent") {
    return items.filter(item => !item.deleted && !shouldHideFromFeed(item, tab));
  }

  if (tab === "saved") {
    return items.filter(item => item.saved && !shouldHideFromFeed(item, tab));
  }

  const { author, recipient, range } = getHistoryFilters();
  const cutoffMs = getHistoryRangeMs(range);
  const cutoffTime = cutoffMs == null ? null : Date.now() - cutoffMs;

  return items.filter(item => {
    const itemTime = new Date(item.date).getTime();
    const itemRecipients = Array.isArray(item.recipients) ? item.recipients : [];
    const recipientText = item.recipientText || itemRecipients.join(", ");

    if (cutoffTime != null && itemTime < cutoffTime) {
      return false;
    }

    if (author && item.author !== author) {
      return false;
    }

    if (recipient && !itemRecipients.includes(recipient) && recipientText !== recipient) {
      return false;
    }

    if (shouldHideFromFeed(item, tab)) {
      return false;
    }

    return true;
  });
}

function groupPosts(items, tab) {
  const filtered = filterPostsForTab(items, tab);
  const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
  const threadMap = new Map();

  for (const item of sorted) {
    const key = getThreadKey(item);
    const thread = threadMap.get(key);

    if (thread) {
      thread.items.push(item);
      continue;
    }

    threadMap.set(key, { key, latest: item, items: [item] });

    if (tab === "recent" && threadMap.size >= 10) {
      break;
    }
  }

  return [...threadMap.values()].map(thread => ({
    ...thread,
    items: [...thread.items].sort((a, b) => new Date(b.date) - new Date(a.date))
  }));
}

function matchesSearch(thread, searchTerm) {
  if (!searchTerm) {
    return true;
  }

  const haystack = thread.items.map(item => [
    item.title,
    item.author,
    item.body,
    item.summary,
    item.snippet,
    item.ai?.priority,
    item.ai?.category,
    item.ai?.priorityReason,
    item.ai?.needsReply ? "reply needed needs reply" : "",
    item.ai?.taskNeeded ? "task needed needs task" : "",
    item.ai?.meetingMentioned ? "meeting mentioned schedule meeting" : "",
    ...(Array.isArray(item.ai?.signals) ? item.ai.signals : []),
    item.recipientText,
    ...(Array.isArray(item.recipients) ? item.recipients : [])
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()).join(" ");

  return haystack.includes(searchTerm);
}

function toTitleCase(value = "") {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function compactSummary(text = "", maxLength = 140) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildInsightBadges(item) {
  const badges = [];
  const priority = item.ai?.priority;
  const category = item.ai?.category;

  if (priority) {
    badges.push({
      className: `insight-badge priority-${priority}`,
      label: toTitleCase(priority)
    });
  }

  if (item.ai?.needsReply) {
    badges.push({
      className: "insight-badge insight-action",
      label: "Reply Needed"
    });
  }

  if (item.ai?.taskNeeded) {
    badges.push({
      className: "insight-badge insight-task",
      label: "Task Needed"
    });
  }

  if ((item.snoozedUntil || 0) > Date.now()) {
    badges.push({
      className: "insight-badge insight-category",
      label: "Snoozed"
    });
  }

  if (category) {
    badges.push({
      className: "insight-badge insight-category",
      label: toTitleCase(category)
    });
  }

  return badges.slice(0, 3);
}

function setMetaContent(container, item) {
  if (!container) {
    return;
  }

  const author = container.querySelector(".post-author");
  const recipient = container.querySelector(".post-recipient");
  const snippet = container.querySelector(".post-snippet");
  const insights = container.querySelector(".post-insights");

  if (author) {
    author.textContent = item.author ? `by ${item.author}` : "";
  }

  if (recipient) {
    recipient.textContent = item.recipientText ? `to ${item.recipientText}` : "";
  }

  if (snippet) {
    snippet.textContent = String(item.summary || item.snippet || item.body || "").replace(/\s+/g, " ").trim();
  }

  if (!insights) {
    return;
  }

  insights.innerHTML = "";

  for (const badge of buildInsightBadges(item)) {
    const element = document.createElement("span");
    element.className = badge.className;
    element.textContent = badge.label;
    insights.appendChild(element);
  }
}

function createThreadMessage(item, threadGuids) {
  const template = document.getElementById("threadItemTemplate");
  const row = template.content.firstElementChild.cloneNode(true);
  if (item.read) {
    row.classList.add("read");
  }

  const titleLink = row.querySelector(".thread-item-title");
  titleLink.href = item.link;
  titleLink.textContent = item.title;
  titleLink.addEventListener("click", async event => {
    event.preventDefault();
    await updateThread([item.guid], { read: true });
    chrome.runtime.sendMessage({ type: "openEntry", url: item.link });
  });

  const time = row.querySelector(".thread-item-time");
  time.textContent = new Date(item.date).toLocaleString();
  const meta = row.querySelector(".thread-item-meta");
  meta.textContent = [item.author ? `by ${item.author}` : "", item.recipientText ? `to ${item.recipientText}` : ""]
    .filter(Boolean)
    .join(" ");

  const body = row.querySelector(".thread-item-body");
  body.textContent = item.body || item.summary || item.snippet || "";

  const actions = row.querySelector(".thread-item-actions");

  const openButton = document.createElement("button");
  openButton.type = "button";
  openButton.className = "icon-only-btn";
  openButton.title = "Open in Capsule";
  openButton.setAttribute("aria-label", "Open in Capsule");
  openButton.textContent = getFeedActionIcon("open");
  openButton.addEventListener("click", async () => {
    await updateThread([item.guid], { read: true });
    chrome.runtime.sendMessage({ type: "openEntry", url: item.link });
  });

  const markReadButton = document.createElement("button");
  markReadButton.type = "button";
  markReadButton.className = "icon-only-btn";
  markReadButton.title = item.read ? "Mark unread" : "Mark read";
  markReadButton.setAttribute("aria-label", item.read ? "Mark unread" : "Mark read");
  markReadButton.textContent = item.read ? getFeedActionIcon("mark-unread") : getFeedActionIcon("mark-read");
  markReadButton.addEventListener("click", () => updateThread([item.guid], { read: !item.read }));

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "icon-only-btn";
  saveButton.title = item.saved ? "Remove saved" : "Save";
  saveButton.setAttribute("aria-label", item.saved ? "Remove saved" : "Save");
  saveButton.textContent = getFeedActionIcon("save", item.saved);
  saveButton.addEventListener("click", () => updateThread([item.guid], { saved: !item.saved }));

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "icon-only-btn";
  deleteButton.title = "Hide thread";
  deleteButton.setAttribute("aria-label", "Hide thread");
  deleteButton.textContent = getFeedActionIcon("hide");
  deleteButton.addEventListener("click", () => updateThread(threadGuids, { deleted: true }));

  actions.append(openButton, markReadButton, saveButton, deleteButton);
  attachWorkflowShortcuts(row, item);
  return row;
}

function toggleHistoryFilters() {
  toggleSecondaryPanels();
}

function createDigestCard(digest) {
  const card = document.createElement("article");
  card.className = "post digest-card";
  card.tabIndex = 0;

  const title = document.createElement("div");
  title.className = "title-container";
  const titleText = document.createElement("strong");
  titleText.className = "post-title";
  titleText.textContent = digest.typeLabel || "Digest";
  const titleTime = document.createElement("span");
  titleTime.className = "post-time";
  titleTime.textContent = new Date(digest.generatedAt).toLocaleString();
  title.append(titleText, titleTime);

  const meta = document.createElement("div");
  meta.className = "post-meta";
  const digestInsights = document.createElement("div");
  digestInsights.className = "post-insights";
  for (const label of [
    digest.source === "ai" ? "AI Summary" : "Local Summary",
    (digest.typeLabel || digest.type || "digest").replace(/_/g, " "),
    `${digest.itemCount} Updates`
  ]) {
    const badge = document.createElement("span");
    badge.className = "insight-badge insight-category";
    badge.textContent = label;
    digestInsights.appendChild(badge);
  }
  const digestSnippet = document.createElement("p");
  digestSnippet.className = "post-snippet";
  digestSnippet.textContent = digest.text || "";
  meta.append(digestInsights, digestSnippet);

  const stats = document.createElement("p");
  stats.className = "digest-stats";
  stats.textContent = `Open tasks: ${digest.taskSummary.open} | Due today: ${digest.taskSummary.dueToday} | Overdue: ${digest.taskSummary.overdue}`;

  const toggleExpanded = () => {
    card.classList.toggle("expanded");
  };

  card.addEventListener("click", toggleExpanded);
  card.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleExpanded();
    }
  });

  card.append(title, meta, stats);
  return card;
}

function matchesTaskSearch(task, searchTerm) {
  if (!searchTerm) {
    return true;
  }

  const haystack = [
    task.title,
    task.notes,
    task.owner,
    task.assignee,
    task.partyName,
    task.sourceTitle,
    task.sourceLink
  ].filter(Boolean).join(" ").toLowerCase();

  return haystack.includes(searchTerm);
}

function getVisibleTasks() {
  const tasks = getFilteredCapsuleTasks();
  const activeTasks = tasks.filter(task => task.status !== "completed" && task.status !== "dismissed" && task.status !== "pending");

  if (currentTaskFilter === "due_today") {
    return activeTasks.filter(task => task.dueToday);
  }

  if (currentTaskFilter === "overdue") {
    return activeTasks.filter(task => task.status === "overdue" || (task.dueDate && task.dueDate < new Date().toISOString().slice(0, 10)));
  }

  return activeTasks;
}

function createTaskCard(task) {
  const card = document.createElement("article");
  card.className = "post task-card";
  card.tabIndex = 0;
  if (task.status === "overdue") {
    card.classList.add("priority-high");
  }

  const top = document.createElement("div");
  top.className = "post-topline";

  const badges = document.createElement("div");
  badges.className = "post-insights";
  const statusBadge = document.createElement("span");
  statusBadge.className = `insight-badge ${task.status === "overdue" ? "priority-high" : "insight-category"}`;
  statusBadge.textContent = task.status === "overdue" ? "Overdue" : task.dueToday ? "Due Today" : "Open";
  const ownerBadge = document.createElement("span");
  ownerBadge.className = "insight-badge insight-category";
  ownerBadge.textContent = task.owner || task.assignee || "Unassigned";
  badges.append(statusBadge, ownerBadge);

  const time = document.createElement("span");
  time.className = "post-time";
  time.textContent = task.dueDate ? `Due ${task.dueDate}` : "No due date";

  top.append(badges, time);

  const title = document.createElement("div");
  title.className = "post-mainline";
  const titleContainer = document.createElement("div");
  titleContainer.className = "title-container";
  const titleText = document.createElement("strong");
  titleText.className = "post-title";
  titleText.textContent = task.title || "Capsule task";
  titleContainer.appendChild(titleText);
  title.appendChild(titleContainer);

  const meta = document.createElement("div");
  meta.className = "post-meta";
  const authorMeta = document.createElement("small");
  authorMeta.className = "post-author";
  authorMeta.textContent = task.partyName ? `for ${task.partyName}` : "";
  const recipientMeta = document.createElement("small");
  recipientMeta.className = "post-recipient";
  recipientMeta.textContent = task.sourceTitle ? `from ${task.sourceTitle}` : "";
  meta.append(authorMeta, recipientMeta);

  const snippet = document.createElement("p");
  snippet.className = "post-snippet";
  snippet.textContent = compactSummary(task.notes || "", 180);

  const toolbar = document.createElement("div");
  toolbar.className = "post-toolbar";

  const actions = document.createElement("div");
  actions.className = "workflow-shortcuts";

  if (task.sourceLink) {
    const openSource = document.createElement("button");
    openSource.type = "button";
    openSource.className = "workflow-btn icon-only-btn";
    openSource.title = "Open linked Capsule item";
    openSource.setAttribute("aria-label", "Open linked Capsule item");
    openSource.textContent = "↗";
    openSource.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      await chrome.runtime.sendMessage({ type: "openEntry", url: task.sourceLink });
    });
    actions.appendChild(openSource);
  }

  const completeButton = document.createElement("button");
  completeButton.type = "button";
  completeButton.className = "workflow-btn icon-only-btn";
  completeButton.title = "Complete Capsule task";
  completeButton.setAttribute("aria-label", "Complete Capsule task");
  completeButton.textContent = "✓";
  completeButton.addEventListener("click", async event => {
    event.preventDefault();
    event.stopPropagation();
    try {
      const response = await chrome.runtime.sendMessage({
        type: "completeLocalTask",
        taskId: task.id
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Unable to complete the task.");
      }
      showActionStatus(response.task?.capsuleSyncMessage || "Task completed in Capsule.");
      await loadPosts();
    } catch (error) {
      console.error(error);
      showActionStatus(error.message || "Task completion failed.", true);
    }
  });
  actions.appendChild(completeButton);

  toolbar.appendChild(actions);
  card.append(top, title, meta, snippet, toolbar);

  const openTask = async () => {
    if (!task.taskUrl) {
      return;
    }
    await chrome.runtime.sendMessage({ type: "openEntry", url: task.taskUrl });
  };

  card.addEventListener("click", async () => {
    await openTask();
  });
  card.addEventListener("keydown", async event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      await openTask();
    }
  });

  return card;
}

function renderPosts(tab) {
  toggleHistoryFilters();

  const feedList = document.getElementById("feedList");
  if (tab === "digests") {
    feedList.innerHTML = "";

    if (!digests.length) {
      feedList.innerHTML = "<p class='empty'>No digests generated yet.</p>";
      return;
    }

    for (const digest of digests) {
      feedList.appendChild(createDigestCard(digest));
    }
    return;
  }

  if (tab === "tasks") {
    const searchTerm = (document.getElementById("searchInput").value || "").toLowerCase();
    const visibleTasks = getVisibleTasks().filter(task => matchesTaskSearch(task, searchTerm));
    feedList.innerHTML = "";

    if (!visibleTasks.length) {
      feedList.innerHTML = "<p class='empty'>No Capsule tasks found for this filter.</p>";
      return;
    }

    for (const task of visibleTasks) {
      feedList.appendChild(createTaskCard(task));
    }
    return;
  }

  const searchTerm = (document.getElementById("searchInput").value || "").toLowerCase();
  const template = document.getElementById("postTemplate");
  const grouped = groupPosts(posts, tab);

  feedList.innerHTML = "";

  const visible = grouped.filter(thread => matchesSearch(thread, searchTerm));

  if (!visible.length) {
    feedList.innerHTML = "<p class='empty'>No posts found.</p>";
    return;
  }

  for (const thread of visible) {
    const post = thread.latest;
    const clone = template.content.cloneNode(true);
    const container = clone.querySelector(".post");
    const toggle = clone.querySelector(".post-toggle");
    const threadItemsContainer = clone.querySelector(".thread-items");
    const titleContainer = clone.querySelector(".title-container");
    const link = clone.querySelector(".post-title");
    const time = clone.querySelector(".post-time");
    const chevron = clone.querySelector(".thread-chevron");
    const markReadButton = clone.querySelector(".mark-read");
    const markUnreadButton = clone.querySelector(".mark-unread");
    const saveButton = clone.querySelector(".save");
    const deleteButton = clone.querySelector(".delete");
    const threadGuids = thread.items.map(item => item.guid);
    const isBundle = thread.items.length > 1;
    const isExpanded = expandedThreads[tab].has(thread.key);

    if (isBundle) {
      const badge = document.createElement("span");
      badge.className = "thread-count";
      badge.textContent = String(thread.items.length);
      badge.title = `${thread.items.length} messages in thread`;
      titleContainer.insertBefore(badge, link);
      container.classList.add("threaded");
      toggle.classList.add("expandable");
      toggle.tabIndex = 0;
    } else {
      chevron.remove();
      threadItemsContainer.remove();
      toggle.classList.add("single-message", "expandable");
      toggle.tabIndex = 0;
    }

    link.textContent = post.title;
    link.href = post.link;
    link.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      await updateThread([post.guid], { read: true });
      chrome.runtime.sendMessage({ type: "openEntry", url: post.link });
    });

    time.textContent = new Date(post.date).toLocaleString();
    setMetaContent(toggle, post);
    attachWorkflowShortcuts(container, post);

    if (thread.items.every(item => item.read)) {
      container.classList.add("read");
    }

    if (thread.items.some(item => item.saved)) {
      container.classList.add("saved");
    }

    const threadPriority = thread.items.reduce((current, item) => (
      getPriorityRank(getItemPriority(item)) > getPriorityRank(current) ? getItemPriority(item) : current
    ), getItemPriority(post));
    container.classList.add(`priority-${threadPriority}`);

    if (isExpanded) {
      container.classList.add("expanded");
    }

    if (isBundle && isExpanded) {
      threadItemsContainer.classList.remove("hidden");
      for (const item of thread.items) {
        threadItemsContainer.appendChild(createThreadMessage(item, threadGuids));
      }
    }

    toggle.addEventListener("click", () => {
      if (expandedThreads[tab].has(thread.key)) {
        expandedThreads[tab].delete(thread.key);
      } else {
        expandedThreads[tab].add(thread.key);
      }
      renderPosts(currentTab);
    });
    toggle.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle.click();
      }
    });

    const allSaved = thread.items.every(item => item.saved);
    const allRead = thread.items.every(item => item.read);

    markReadButton.textContent = getFeedActionIcon("mark-read");
    markReadButton.title = "Mark thread read";
    markReadButton.setAttribute("aria-label", "Mark thread read");
    markUnreadButton.textContent = getFeedActionIcon("mark-unread");
    markUnreadButton.title = "Mark thread unread";
    markUnreadButton.setAttribute("aria-label", "Mark thread unread");
    markReadButton.classList.toggle("hidden", allRead);
    markUnreadButton.classList.toggle("hidden", !allRead);
    saveButton.textContent = getFeedActionIcon("save", allSaved);
    saveButton.title = allSaved ? "Remove saved" : "Save";
    saveButton.setAttribute("aria-label", allSaved ? "Remove saved" : "Save");
    deleteButton.textContent = getFeedActionIcon("hide");
    deleteButton.title = "Hide thread";
    deleteButton.setAttribute("aria-label", "Hide thread");

    markReadButton.onclick = event => {
      event.stopPropagation();
      return updateThread(threadGuids, { read: true });
    };
    markUnreadButton.onclick = event => {
      event.stopPropagation();
      return updateThread(threadGuids, { read: false });
    };
    deleteButton.onclick = event => {
      event.stopPropagation();
      return updateThread(threadGuids, { deleted: true });
    };
    saveButton.onclick = event => {
      event.stopPropagation();
      const shouldSave = !allSaved;
      return updateThread(threadGuids, { saved: shouldSave });
    };

    feedList.appendChild(clone);
  }
}

async function loadPosts() {
  if (loadPostsPromise) {
    return loadPostsPromise;
  }

  loadPostsPromise = (async () => {
  const {
    rssItems = [],
    capsuleTasks: storedTasks = [],
    digests: storedDigests = [],
    runtimeStatus: storedRuntimeStatus = null,
    showMediumInFeed = true,
    hideLowPriorityInFeed = true,
    alwaysShowReplyNeeded = true,
    capsuleToken = "",
    capsuleWebBaseUrl = "",
    emailClient = "default",
    calendarShortcutMode = "meeting_only"
  } = await chrome.storage.local.get([
    "rssItems",
    "capsuleTasks",
    "digests",
    "runtimeStatus",
    "showMediumInFeed",
    "hideLowPriorityInFeed",
    "alwaysShowReplyNeeded",
    "capsuleToken",
    "capsuleWebBaseUrl",
    "emailClient",
    "calendarShortcutMode"
  ]);

  const sortedPosts = [...rssItems].sort((a, b) => new Date(b.date) - new Date(a.date));
  const postsByGuid = new Map(sortedPosts.map(item => [item.guid, item]));
  const postsByLink = new Map(sortedPosts.filter(item => item.link).map(item => [item.link, item]));

  filterSettings = {
    showMediumInFeed,
    hideLowPriorityInFeed,
    alwaysShowReplyNeeded
  };
  actionSettings = {
    emailClient,
    calendarShortcutMode
  };
  capsuleTasks = storedTasks.map(task => {
    const sourceItem = postsByGuid.get(task.sourceGuid) || (task.sourceLink ? postsByLink.get(task.sourceLink) : null);
    const today = new Date().toISOString().slice(0, 10);
    const isCompleted = task.status === "completed" || task.status === "dismissed" || task.status === "pending";
    const normalizedStatus = isCompleted
      ? task.status
      : task.dueDate && task.dueDate < today
        ? "overdue"
        : "open";

    return {
      ...task,
      sourceTitle: task.sourceTitle || sourceItem?.title || "",
      sourceLink: task.sourceLink || sourceItem?.link || "",
      status: normalizedStatus,
      dueToday: !isCompleted && task.dueDate === today
    };
  });
  allTaskIndexes = createTaskIndexes(capsuleTasks);
  digests = [...storedDigests].sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
  runtimeStatus = storedRuntimeStatus;
  missingSetupItems = getMissingSetupItems({ capsuleToken, capsuleWebBaseUrl });
  posts = sortedPosts;
  populateHistoryFilters(posts);
  populateTaskOwnerFilter();
  updateTaskSummaryUI();
  renderRuntimeStatus();
  renderPosts(currentTab);
  renderSetupModal();
  })().finally(() => {
    loadPostsPromise = null;
  });

  return loadPostsPromise;
}

async function updateThread(guids, changes) {
  const { rssItems = [] } = await chrome.storage.local.get("rssItems");
  const guidSet = new Set(guids);
  const updated = rssItems
    .map(item => (guidSet.has(item.guid) ? { ...item, ...changes } : item))
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  await chrome.storage.local.set({ rssItems: updated });
}

async function markAllRead() {
  const recentThreads = groupPosts(posts, "recent");
  const guids = recentThreads.flatMap(thread => thread.items.map(item => item.guid));
  await updateThread(guids, { read: true });
}

function setRefreshState(isRefreshing) {
  const refreshBtn = document.getElementById("refreshBtn");
  refreshBtn.disabled = isRefreshing;
  refreshBtn.classList.toggle("loading", isRefreshing);
}

async function refreshPosts() {
  if (missingSetupItems.length) {
    renderSetupModal();
    showActionStatus("Complete setup in Settings before refreshing.", true);
    return;
  }

  setRefreshState(true);

  try {
    const response = await chrome.runtime.sendMessage({ type: "manualRefresh" });
    if (!response?.ok) {
      console.error(response?.error || "Manual refresh failed");
    }
  } finally {
    setRefreshState(false);
    await loadPosts();
  }
}

async function generateDigest() {
  if (missingSetupItems.length) {
    renderSetupModal();
    showActionStatus("Complete setup in Settings before generating digests.", true);
    return;
  }

  const button = document.getElementById("generateDigestBtn");
  button.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ type: "generateDigest", digestType: "end_of_day" });
    if (!response?.ok) {
      throw new Error(response?.error || "Digest generation failed.");
    }
    showActionStatus("End-of-day digest generated.");
    await loadPosts();
    currentTab = "digests";
    document.querySelectorAll(".tab").forEach(tab => tab.classList.toggle("active", tab.dataset.tab === "digests"));
    renderPosts(currentTab);
  } catch (error) {
    console.error(error);
    showActionStatus(error.message || "Digest generation failed.", true);
  } finally {
    button.disabled = false;
  }
}

async function updateDockButton() {
  const dockBtn = document.getElementById("dockToggleBtn");
  const { enableDock = false } = await chrome.storage.local.get("enableDock");

  dockBtn.textContent = enableDock ? "⇱" : "⇲";
  dockBtn.title = enableDock ? "Undock panel" : "Dock panel";
  document.body.classList.toggle("docked", enableDock);
  document.body.classList.toggle("undocked", !enableDock);
}

document.addEventListener("DOMContentLoaded", async () => {
  loadTheme();
  await loadPosts();
  await updateDockButton();
  toggleHistoryFilters();

  document.getElementById("searchInput").addEventListener("input", () => renderPosts(currentTab));
  document.getElementById("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("openSettingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("retrySetupBtn").addEventListener("click", loadPosts);
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  document.getElementById("refreshBtn").addEventListener("click", refreshPosts);
  document.getElementById("markAllReadBtn").addEventListener("click", markAllRead);
  document.getElementById("generateDigestBtn").addEventListener("click", generateDigest);
  document.querySelectorAll(".task-summary-btn[data-task-filter]").forEach(button => {
    button.addEventListener("click", () => {
      currentTaskFilter = currentTaskFilter === button.dataset.taskFilter ? "all" : button.dataset.taskFilter;
      updateTaskSummaryUI();
      renderPosts(currentTab);
    });
  });
  document.getElementById("taskFilterClear").addEventListener("click", () => {
    currentTaskFilter = "all";
    updateTaskSummaryUI();
    renderPosts(currentTab);
  });
  document.getElementById("taskOwnerFilter").addEventListener("change", event => {
    currentTaskOwner = event.target.value || "all";
    updateTaskSummaryUI();
    renderPosts(currentTab);
  });

  document.getElementById("historyAuthorFilter").addEventListener("change", () => renderPosts(currentTab));
  document.getElementById("historyRecipientFilter").addEventListener("change", () => renderPosts(currentTab));
  document.getElementById("historyRangeFilter").addEventListener("change", () => renderPosts(currentTab));

  document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(tab => tab.classList.remove("active"));
      button.classList.add("active");
      currentTab = button.dataset.tab;
      renderPosts(currentTab);
    });
  });

  document.getElementById("dockToggleBtn").addEventListener("click", async () => {
    const { enableDock = false } = await chrome.storage.local.get("enableDock");
    const nextValue = !enableDock;

    await chrome.storage.local.set({ enableDock: nextValue });
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: nextValue });

    if (nextValue) {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      window.close();
      return;
    }

    window.close();
    await chrome.action.openPopup();
  });
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") {
    return;
  }

  if (
    changes.rssItems ||
    changes.showMediumInFeed ||
    changes.hideLowPriorityInFeed ||
    changes.alwaysShowReplyNeeded ||
    changes.emailClient ||
    changes.calendarShortcutMode ||
    changes.capsuleTasks ||
    changes.digests ||
    changes.runtimeStatus ||
    changes.capsuleToken ||
    changes.capsuleWebBaseUrl
  ) {
    await loadPosts();
  }

  if (changes.enableDock) {
    await updateDockButton();
  }

  if (changes.theme) {
    loadTheme();
  }
});
