// popup.js

let posts = [];
let currentTab = "recent";

// Normalize subjects by stripping leading Re:/Fwd: prefixes
function normalizeSubject(subject) {
  return subject.replace(/^(?:\s*(?:re|fwd)\s*[:\-]\s*)+/i, '').trim();
}

// Load and apply theme
function loadTheme() {
  chrome.storage.local.get("theme", data => {
    document.body.className = data.theme === "dark" ? "theme-dark" : "theme-light";
  });
}

// Toggle between light/dark
function toggleTheme() {
  const newTheme = document.body.className === "theme-dark" ? "light" : "dark";
  document.body.className = "theme-" + newTheme;
  chrome.storage.local.set({ theme: newTheme });
}

// Fetch posts from storage, sort, then render
let enableManualRefresh = true;
function loadPosts() {
  chrome.storage.local.get("rssItems", data => {
    posts = Array.isArray(data.rssItems) ? data.rssItems : [];
    // Sort descending by date
    posts.sort((a, b) => new Date(b.date) - new Date(a.date));
    renderPosts(currentTab);
  });
}

// Render posts based on active tab and search filter
function renderPosts(tab) {
  const feedList   = document.getElementById("feedList");
  const searchTerm = (document.getElementById("searchInput").value || "").toLowerCase();
  const template   = document.getElementById("postTemplate");
  feedList.innerHTML = "";

  let items = [];

  if (tab === "saved") {
    // Show all saved posts individually
    items = posts.filter(p => p.saved).map(p => ({ latest: p, count: 1 }));
  } else if (tab === "history") {
    // Show last 50 posts individually
    items = posts.slice(0, 50).map(p => ({ latest: p, count: 1 }));
  } else {
    // Recent tab: group by normalized subject, show up to 10 threads
    const seenNorm = new Set();
    for (const p of posts) {
      if (p.deleted) continue;
      const norm = normalizeSubject(p.title);
      if (!seenNorm.has(norm)) {
        seenNorm.add(norm);
        // collect all in this thread
        const threadItems = posts
          .filter(q => normalizeSubject(q.title) === norm && !q.deleted)
          .sort((a, b) => new Date(b.date) - new Date(a.date));
        items.push({ latest: threadItems[0], count: threadItems.length });
      }
      if (items.length >= 10) break;
    }
  }

  // filter by search term on title
  const visible = items.filter(item => item.latest.title.toLowerCase().includes(searchTerm));
  if (visible.length === 0) {
    feedList.innerHTML = "<p class='empty'>No posts found.</p>";
    return;
  }

  visible.forEach(item => {
    const post = item.latest;
    const threadCount = item.count;

    const clone     = template.content.cloneNode(true);
    const link      = clone.querySelector(".post-title");
    const time      = clone.querySelector(".post-time");
    const authorEl  = clone.querySelector(".post-author");
    const snippetEl = clone.querySelector(".post-snippet");
    const container = clone.querySelector(".post");
    const titleContainer = clone.querySelector(".title-container");

    // Title + link
    link.textContent = post.title;
    link.href        = post.link;
    link.target      = "_blank";
    link.rel         = "noopener noreferrer";
    link.addEventListener("click", () => updatePost(post.guid, { read: true }));

    // Thread badge if multiple messages
    if (threadCount > 1) {
      const badge = document.createElement("span");
      badge.className = "thread-count";
      badge.title     = `${threadCount} messages in thread`;
      badge.textContent = threadCount;
      container.classList.add("threaded");
      titleContainer.prepend(badge);
    }

    // Date
    time.textContent = new Date(post.date).toLocaleString();

    // Author & summary
    authorEl.textContent  = post.author ? `by ${post.author}` : "";
    snippetEl.textContent = post.summary || post.snippet || "";

    // Read/Saved styling
    if (post.read)   container.classList.add("read");
    if (post.saved)  container.classList.add("saved");

    // Per-post actions
    clone.querySelector(".mark-read").onclick   = () => updatePost(post.guid, { read: true });
    clone.querySelector(".mark-unread").onclick = () => updatePost(post.guid, { read: false });
    clone.querySelector(".delete").onclick      = () => updatePost(post.guid, { deleted: true });
    clone.querySelector(".save").onclick        = () => updatePost(post.guid, { saved: !post.saved });

    feedList.appendChild(clone);
  });
}

// Update all entries matching this GUID, re-sort & re-render
function updatePost(guid, changes) {
  chrome.storage.local.get("rssItems", data => {
    const list = Array.isArray(data.rssItems) ? data.rssItems : [];
    const updated = list.map(p => p.guid === guid ? { ...p, ...changes } : p);
    updated.sort((a, b) => new Date(b.date) - new Date(a.date));
    chrome.storage.local.set({ rssItems: updated }, () => renderPosts(currentTab));
  });
}

// Mark All as Read → mark the top 10 recent threads read
function markAllRead() {
  chrome.storage.local.get("rssItems", data => {
    const all = Array.isArray(data.rssItems) ? data.rssItems : [];
    // Determine threads in the recent tab
    const seenNorm = new Set();
    const recentThreads = [];
    for (const p of all.sort((a,b)=>new Date(b.date)-new Date(a.date))) {
      if (p.deleted) continue;
      const norm = normalizeSubject(p.title);
      if (!seenNorm.has(norm) && recentThreads.length < 10) {
        seenNorm.add(norm);
        const threadItems = all.filter(q=>normalizeSubject(q.title)===norm);
        recentThreads.push(threadItems.map(x=>x.guid));
      }
    }
    // Mark all GUIDs in those threads as read
    const toRead = new Set(recentThreads.flat());
    const updated = all.map(p => toRead.has(p.guid)?{...p, read:true}:p);
    updated.sort((a,b)=>new Date(b.date)-new Date(a.date));
    chrome.storage.local.set({ rssItems: updated }, () => renderPosts(currentTab));
  });
}

// Re-load whenever storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.rssItems) {
    loadPosts();
  }
});

// DOM Ready
document.addEventListener("DOMContentLoaded", () => {
  loadTheme();

  // On open, manual refresh then loadPosts
  chrome.runtime.sendMessage({ type: "manualRefresh" }, resp => {
    if (resp && resp.ok) loadPosts();
  });

  // Settings & theme toggle
  document.getElementById("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);

// Dock toggle
const dockBtn = document.getElementById("dockToggleBtn");

async function updateDockButton() {
  const { enableDock = false } = await chrome.storage.local.get("enableDock");
  dockBtn.textContent = enableDock ? '⇱' : '⇲';
  dockBtn.title       = enableDock ? 'Undock panel' : 'Dock panel';
  document.body.classList.toggle('docked',   enableDock);
  document.body.classList.toggle('undocked', !enableDock);   
}

dockBtn.addEventListener("click", async () => {
  const { enableDock = false } = await chrome.storage.local.get("enableDock");
  const newVal = !enableDock;
  await chrome.storage.local.set({ enableDock: newVal });

  // update Chrome’s behavior
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: newVal });

  // apply immediately
  if (newVal) {
    // docked: open the side panel in current window
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
  } else {
    // undocked: show the popup (and close any open side panel)
    await chrome.action.openPopup();
  }

  updateDockButton();
});

// initialize on load
updateDockButton();



  // Search input
  document.getElementById("searchInput").addEventListener("input", () => renderPosts(currentTab));

  // Refresh button
  document.getElementById("refreshBtn").addEventListener("click", () => chrome.runtime.sendMessage({ type: "manualRefresh" }, resp => { if (resp && resp.ok) loadPosts(); }));

  // Mark All Read button
  document.getElementById("markAllReadBtn").addEventListener("click", markAllRead);

  // Tab click handlers
  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentTab = btn.dataset.tab;
    renderPosts(currentTab);
  }));
});