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
// popup.js

// … keep normalizeSubject, loadTheme, toggleTheme, loadPosts, etc. …

function renderPosts(tab) {
  const feedList   = document.getElementById("feedList");
  const searchTerm = (document.getElementById("searchInput").value || "")
    .toLowerCase();
  const template   = document.getElementById("postTemplate");

  feedList.innerHTML = "";

  // 1) Build raw list based on which tab we’re on
  let raw;
  if (tab === "recent") {
    raw = posts.filter(p => !p.deleted);
  } else if (tab === "saved") {
    raw = posts.filter(p => p.saved);
  } else {  // history
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;  // last 24h
    raw = posts.filter(p => new Date(p.date).getTime() >= cutoff);
  }

  // 2) Sort by descending date
  raw.sort((a, b) => new Date(b.date) - new Date(a.date));

  // 3) Group by normalized subject
  const seen = new Set();
  const items = [];
  for (const p of raw) {
    const norm = normalizeSubject(p.title);
    if (seen.has(norm)) continue;
    seen.add(norm);
    // gather all in this thread (from the same raw array)
    const thread = raw
      .filter(q => normalizeSubject(q.title) === norm)
      .sort((a, b) => new Date(b.date) - new Date(a.date));
    items.push({ latest: thread[0], count: thread.length });
    // cap recent threads at 10
    if (tab === "recent" && items.length >= 10) break;
  }

  // 4) Filter by searchTerm across title, author, AND full body
  const visible = items.filter(({ latest: p }) => {
    const hay = [
      p.title,
      p.author,
      p.body  // full content
    ].join(" ").toLowerCase();
    return hay.includes(searchTerm);
  });

  if (visible.length === 0) {
    feedList.innerHTML = "<p class='empty'>No posts found.</p>";
    return;
  }

  // 5) Render exactly as before
  visible.forEach(item => {
    const post        = item.latest;
    const threadCount = item.count;
    const clone       = template.content.cloneNode(true);
    const link        = clone.querySelector(".post-title");
    const time        = clone.querySelector(".post-time");
    const authorEl    = clone.querySelector(".post-author");
    const snippetEl   = clone.querySelector(".post-snippet");
    const container   = clone.querySelector(".post");
    const titleCt     = clone.querySelector(".title-container");

    // Title + link
    link.textContent = post.title;
    link.href        = post.link;
    link.addEventListener("click", () => updatePost(post.guid, { read: true }));

    // Thread badge
    if (threadCount > 1) {
      const badge = document.createElement("span");
      badge.className   = "thread-count";
      badge.textContent = threadCount;
      badge.title       = `${threadCount} messages in thread`;
      container.classList.add("threaded");
      titleCt.prepend(badge);
    }

    // Date / author / snippet
    time.textContent        = new Date(post.date).toLocaleString();
    authorEl.textContent    = post.author ? `by ${post.author}` : "";
    snippetEl.textContent   = post.summary || post.snippet || "";

    // Read / Saved styling
    if (post.read)  container.classList.add("read");
    if (post.saved) container.classList.add("saved");

    // Buttons
    clone.querySelector(".mark-read").onclick    = () => updatePost(post.guid, { read: true });
    clone.querySelector(".mark-unread").onclick  = () => updatePost(post.guid, { read: false });
    clone.querySelector(".delete").onclick       = () => updatePost(post.guid, { deleted: true });
    clone.querySelector(".save").onclick         = () => updatePost(post.guid, { saved: !post.saved });

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
    window.close();  // hides the side-panel  
  } else {
    // undocked: show the popup (and close any open side panel)
    window.close();  // hides the side-panel  
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