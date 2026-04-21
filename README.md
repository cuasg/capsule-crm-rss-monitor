# Capsule CRM Activity Monitor

Chrome extension that turns Capsule CRM activity into a browser-side triage workspace. It monitors Capsule entries, groups related activity, surfaces AI-assisted summaries and priority signals, exposes workflow shortcuts for email and calendar actions, and tracks Capsule-backed tasks and saved digests from the popup or side panel.

## Current Scope

- Capsule activity polling with manual refresh and side-panel support
- Grouped recent feed, saved view, history view, digest view, and dedicated tasks view
- AI summaries, priority classification, action flags, and structured metadata on new entries
- Workflow shortcuts for reply, AI draft, scheduling, Capsule task creation, and Capsule task completion
- Capsule-backed task tracking with owner filtering and task-state counts
- Search across message content, recipients, AI fields, and task/action flags like `reply needed` and `task needed`
- Digest generation and storage for morning, midday, and end-of-day review
- JSON and CSV export of cached activity

## Main Files

- [manifest.json](./manifest.json): Chrome extension manifest
- [background.js](./background.js): polling, Capsule/OpenAI calls, task sync, digests, notifications
- [popup.html](./popup.html): popup and side-panel markup
- [popup.js](./popup.js): feed rendering, task tab, UI actions
- [options.html](./options.html): settings page
- [options.js](./options.js): settings persistence and export actions
- [style.css](./style.css): shared popup/options styling

## Setup

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this project directory.
6. Open the extension and go to `Settings`.
7. Add your Capsule API token.
8. Optionally add an OpenAI API key and enable AI summaries.

## Runtime Dependencies

- Capsule API: `https://api.capsulecrm.com/api/v2/*`
- OpenAI API: `https://api.openai.com/v1/*`
- Capsule web app links are currently built against `https://msi-products.capsulecrm.com/`

## Notes On Data And Storage

- The extension stores UI state and cached activity in Chrome extension storage.
- Capsule and OpenAI credentials are stored in the local Chrome profile, not in this repository.
- Task counts in the UI are Capsule-focused. Local storage is used as a cache, not the primary task system.
- AI summaries and classifications are cached to reduce repeat API usage.

## Git / Upload Checklist

Before pushing or packaging:

1. Confirm `manifest.json` version is correct.
2. Verify no secrets were added to tracked files.
3. Load the extension unpacked and click through:
   `Recent`, `Saved`, `History`, `Digests`, `Tasks`, `Settings`
4. Sanity-check:
   refresh, notifications, Gmail reply shortcut, AI draft, task creation/completion, digest generation
5. Review `git status` and make sure local-only files are ignored.

## Recommended Pre-Push Review

- Test with real Capsule data, especially:
  task creation/completion, task owner filtering, thread grouping, and digest rendering
- Confirm any account-specific Capsule web URL assumptions still hold
- If publishing externally, replace tenant-specific references in docs or manifest text as needed

## Packaging

For a release build:

1. Update the version in [manifest.json](./manifest.json).
2. Reload the unpacked extension in Chrome.
3. Run through the main user flows.
4. Zip the project directory contents for upload to the Chrome Web Store, excluding ignored local files.
