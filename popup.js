// popup.js

let posts = [];
let currentTab = "recent";

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

// Fetch posts from storage, sort once, then render
enableManualRefresh = true;
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

  let slice;
  if (tab === "saved") {
    slice = posts.filter(p => p.saved);
  } else if (tab === "history") {
    slice = posts.slice(0, 50);
  } else {
    slice = posts.filter(p => !p.deleted).slice(0, 10);
  }

  const visible = slice.filter(p => p.title.toLowerCase().includes(searchTerm));
  if (visible.length === 0) {
    feedList.innerHTML = "<p class='empty'>No posts found.</p>";
    return;
  }

  visible.forEach(post => {
    const clone     = template.content.cloneNode(true);
    const link      = clone.querySelector(".post-title");
    const time      = clone.querySelector(".post-time");
    const authorEl  = clone.querySelector(".post-author");
    const snippetEl = clone.querySelector(".post-snippet");
    const container = clone.querySelector(".post");

    // Title + link
    link.textContent = post.title;
    link.href        = post.link;
    link.target      = "_blank";
    link.rel         = "noopener noreferrer";

    // when clicked, mark this post as read before following link
    link.addEventListener("click", () => {
      updatePost(post.guid, { read: true });
    });

    // Date
    time.textContent = new Date(post.date).toLocaleString();

    // Author & AI summary (fallback to snippet)
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

// Update all entries matching this GUID, re-sort & re-render
function updatePost(guid, changes) {
  chrome.storage.local.get("rssItems", data => {
    const list = Array.isArray(data.rssItems) ? data.rssItems : [];
    const updated = list.map(p => p.guid === guid ? { ...p, ...changes } : p);
    updated.sort((a, b) => new Date(b.date) - new Date(a.date));
    chrome.storage.local.set({ rssItems: updated }, () => renderPosts(currentTab));
  });
}

// “Mark All as Read” → mark the top 10 recent items read
function markAllRead() {
  chrome.storage.local.get("rssItems", data => {
    const all = Array.isArray(data.rssItems) ? data.rssItems : [];
    const recentGuids = all
      .filter(p => !p.deleted)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 10)
      .map(p => p.guid);
    const updated = all.map(p =>
      recentGuids.includes(p.guid) ? { ...p, read: true } : p
    );
    updated.sort((a, b) => new Date(b.date) - new Date(a.date));
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
    if (resp?.ok) loadPosts();
  });

  // Settings & theme
  document.getElementById("settingsBtn").addEventListener("click", () =>
    chrome.runtime.openOptionsPage()
  );
  document.getElementById("themeToggle").addEventListener("click", toggleTheme);

  // Search input
  document.getElementById("searchInput").addEventListener("input", () =>
    renderPosts(currentTab)
  );

  // Refresh button
  document.getElementById("refreshBtn").addEventListener("click", () =>
    chrome.runtime.sendMessage({ type: "manualRefresh" }, resp => {
      if (resp?.ok) loadPosts();
    })
  );

  // Mark All Read
  document.getElementById("markAllReadBtn").addEventListener("click", markAllRead);

  // Tab click handlers
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentTab = btn.dataset.tab;
      renderPosts(currentTab);
    });
  });

  // Final initial load
  loadPosts();
});