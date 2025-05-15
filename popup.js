// popup.js

let posts = [];
let currentTab = "recent";
let enableManualRefresh = true;

// Normalize subjects by stripping leading Re: Fwd: prefixes
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
function loadPosts() {
  chrome.storage.local.get("rssItems", data => {
    posts = Array.isArray(data.rssItems) ? data.rssItems : [];
    posts.sort((a, b) => new Date(b.date) - new Date(a.date));
    renderPosts(currentTab);
  });
}

// Render posts with grouping in Recent tab
function renderPosts(tab) {
  const feedList   = document.getElementById("feedList");
  const searchTerm = (document.getElementById("searchInput").value || "").toLowerCase();
  const template   = document.getElementById("postTemplate");
  feedList.innerHTML = "";

  let items = [];

  if (tab === "saved") {
    items = posts.filter(p => p.saved);
  } else if (tab === "history") {
    items = posts.slice(0, 50).map(p => ({ latest: p, count: 1 }));
  } else {
    // Group by normalized title for Recent
    const seenNorm = new Set();
    for (const p of posts) {
      if (p.deleted) continue;
      const norm = normalizeSubject(p.title);
      if (!seenNorm.has(norm)) {
        seenNorm.add(norm);
        const threadItems = posts
          .filter(q => normalizeSubject(q.title) === norm && !q.deleted)
          .sort((a, b) => new Date(b.date) - new Date(a.date));
        items.push({ latest: threadItems[0], count: threadItems.length });
      }
      if (items.length >= 10) break;
    }
  }

  // Filter by search term on title
  const visible = items.filter(item => {
    const title = item.latest.title;
    return title.toLowerCase().includes(searchTerm);
  });
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

    // Thread badge
    if (threadCount > 1) {
      const badge = document.createElement("span");
      badge.className = "thread-count";
      badge.title = `${threadCount} messages in thread`;
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

    // Per‑post actions
    clone.querySelector(".mark-read").onclick   = () => updatePost(post.guid, { read: true });
    clone.querySelector(".mark-unread").onclick = () => updatePost(post.guid, { read: false });
    clone.querySelector(".delete").onclick      = () => updatePost(post.guid, { deleted: true });
    clone.querySelector(".save").onclick        = () => updatePost(post.guid, { saved: !post.saved });

    feedList.appendChild(clone);
  });
}

// Update an entry and re-render
function updatePost(guid, changes) {
  chrome.storage.local.get("rssItems", data => {
    const list = Array.isArray(data.rssItems) ? data.rssItems : [];
    const updated = list.map(p => p.guid === guid ? { ...p, ...changes } : p);
    updated.sort((a, b) => new Date(b.date) - new Date(a.date));
    chrome.storage.local.set({ rssItems: updated }, () => renderPosts(currentTab));
  });
}

// Mark all recent as read
function markAllRead() {
  chrome.storage.local.get("rssItems", data => {
    const all = Array.isArray(data.rssItems) ? data.rssItems : [];
    const recentGuids = all
      .filter(p => !p.deleted)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10)
      .map(p => p.guid);
    const updated = all.map(p => recentGuids.includes(p.guid) ? { ...p, read: true } : p);
    updated.sort((a, b) => new Date(b.date) - new Date(a.date));
    chrome.storage.local.set({ rssItems: updated }, () => renderPosts(currentTab));
  });
}

// Live update
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.rssItems) loadPosts();
});

// Setup
document.addEventListener("DOMContentLoaded", () => {
  loadTheme();
  chrome.runtime.sendMessage({ type: "manualRefresh" }, resp => { if (resp?.ok) loadPosts(); });
  document.getElementById("settingsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);
  document.getElementById("searchInput").addEventListener("input", () => renderPosts(currentTab));
  document.getElementById("refreshBtn").addEventListener("click", () => chrome.runtime.sendMessage({ type: "manualRefresh" }, resp => { if (resp?.ok) loadPosts(); }));
  document.getElementById("markAllReadBtn").addEventListener("click", markAllRead);
  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentTab = btn.dataset.tab;
    renderPosts(currentTab);
  }));
});