# Capsule CRM RSS Monitor

A lightweight Chrome extension that polls your Capsule CRM entries via the REST API, surfaces new activity in a popup (or side-panel), desktop notifications, and optional AI-powered summaries.  

- **Group by thread**: consolidates messages with the same subject (ignoring “Re:”/“Fwd:” prefixes).  
- **Smart notifications**: desktop alerts with author, subject, and optional OpenAI summary.  
- **Configurable**: polling interval, notifications & sound toggles, snooze, export to JSON/CSV.  
- **Theming & layout**: light/dark modes, responsive popup or docked side-panel.  

---

## 🗂️ Repository Structure

├── background.js # Service worker: polling, storage, notifications, AI
├── popup.html # UI shell for toolbar popup / side-panel
├── popup.js # Popup logic: thread grouping, rendering, actions
├── options.html # Settings page: feeds, API tokens, toggles, export
├── options.js # Options logic: save/load config, export
├── style.css # Shared styles: theming, layout, cards, inputs
├── manifest.json # Chrome MV3 manifest
├── icons/… # Extension icons (16×16, 48×48, 128×128)
└── README.md # This file

---

## 🚀 Installation & Development

1. **Clone** the repo:
   ```bash
   git clone https://github.com/your-org/capsule-crm-rss-monitor.git
   cd capsule-crm-rss-monitor
Load in Chrome:

Open chrome://extensions/

Enable Developer mode (toggle top-right).

Click “Load unpacked” and select this project’s root folder.

The extension icon (📥) appears in your toolbar. Click it to open the popup or dock it as a side-panel.

⚙️ Configuration (Options Page)
Navigate to Settings ⚙️ in the popup or open chrome://extensions/ → Details → Extension options.

Capsule API Token

Paste your Capsule CRM OAuth token.

RSS Feed URLs

Enter one or more RSS feed endpoints (e.g. from Capsule or other sources).

Check Interval

Poll every 1, 2, 5, 10, 15, 30 or 60 minutes.

Notifications & Sound

Toggle desktop notifications and sound alerts on/off.

Snooze

Temporarily suspend notifications for 15 min, 30 min, 1 h or 2 h.

AI Summaries (optional)

Enter your OpenAI API key and enable summarization.

When enabled, new entries are batch-summarized (20–30 words)
and displayed in both notifications and the popup feed.

Export

Download stored items as JSON or CSV for offline analysis.

Save Settings

Click Save at the bottom. Changes apply immediately.

💡 Usage
Popup Tabs

Recent: newest 10 non-deleted threads

Saved: your pinned entries

History: last 50 entries

Actions (per card):

✓ Mark read

👁 Mark unread

🗑 Delete (hides from Recent)

📌 Save/unsave (pin to Saved)

Mark All Read: marks top 10 Recent threads as read.

Refresh 🔄: manual immediate fetch.

📦 Packaging & Publishing
Ensure manifest.json version is updated.

Build (no build step required; MV3 is pure HTML/JS/CSS).

Zip the extension folder (exclude .git).

Submit to the Chrome Web Store Developer Dashboard (one-time $5 registration fee).

🛠️ Contributing
Fork this repo and create a feature branch.

Submit a Pull Request with clear description/tests.

Ensure linting and manual UI checks pass.

📄 License
This project is released under the MIT License.
Feel free to use, modify, and redistribute in accordance with its terms.
