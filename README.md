# Capsule CRM Activity Monitor

Chrome extension for reviewing Capsule CRM activity in a browser-side workspace. It pulls recent activity, groups related emails, adds optional AI classification, supports follow-up actions, tracks Capsule tasks, and generates Day Digest views.

## Index

1. Overview
2. Key Features
3. Project Files
4. Setup
5. Configuration
6. Daily Use
7. Digests
8. Data and Storage
9. Pre-Push Checklist
10. Packaging

## Overview

This extension is designed to help review Capsule activity without living inside the Capsule UI all day. It focuses on triage, follow-up, and quick drill-down:

- grouped activity feed
- task-aware workflow shortcuts
- optional AI summaries and priority classification
- configurable filtering for low-value automated email noise
- digest views for daily activity review
- responsive popup and side-panel layouts

## Key Features

- Capsule activity polling with manual refresh and side-panel support
- Grouped `Recent`, `Saved`, `History`, `Digests`, and `Tasks` views
- Optional AI summaries, priority labels, and action flags
- Reply, AI draft, scheduling, and Capsule task shortcuts
- Thread expansion for both grouped threads and single-message posts
- Configurable noise filtering for invoice emails, quote acknowledgements, and order acknowledgements
- AI draft modal with optional extra context before drafting
- Day Digest generation with drill-down into referenced activity
- Clearer empty states and safer fallback behavior for edge cases
- JSON and CSV export of cached activity

## Project Files

- [manifest.json](./manifest.json): Chrome extension manifest
- [background.js](./background.js): polling, Capsule/OpenAI calls, classification, task sync, digests, notifications
- [popup.html](./popup.html): popup and side-panel markup
- [popup.js](./popup.js): feed rendering, digest drill-down, task tab, UI actions
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
7. Add your `Capsule API Token`.
8. Add your `Capsule Web App URL`, for example `https://your-account.capsulecrm.com`.
9. Save settings.
10. Optionally add an OpenAI API key and enable AI summaries.

The popup stays in setup-required mode until the Capsule token and Capsule web URL are configured.

## Configuration

### Required

- `Capsule API Token`
- `Capsule Web App URL`

No Capsule tenant web URL is hardcoded in the extension. Each user must supply their own account URL in Settings.

### Optional

- `OpenAI API Key`
- AI summaries on/off
- notification interval and snooze behavior
- notification priority threshold
- feed visibility rules for medium and low priority items
- always surface reply-needed items
- calendar shortcut behavior
- digest automation schedule
- noise filtering strictness
- mail client selection for reply shortcuts and AI drafts

### Noise Filtering

Noise filtering is intended to suppress low-value commercial email without hiding real customer work.

Available controls:

- `Noise Filter`: `Balanced`, `Strict`, `Aggressive`
- deprioritize invoice emails
- deprioritize order acknowledgements
- deprioritize quote acknowledgements

### AI Summary Rules

Summaries are intended to:

- summarize the message itself
- extract explicit action items mentioned in the message

Summaries should not:

- recommend next steps
- infer actions not stated in the email
- add commentary beyond the message content

## Daily Use

### Feed Views

- `Recent`: main triage view
- `Saved`: pinned threads
- `History`: cached activity history
- `Digests`: generated digest cards with drill-down references
- `Tasks`: Capsule task view with owner and status filters

### Thread Interaction

- Click the subject link to open the Capsule item directly.
- Click the body/card area to expand the thread.
- Single-message posts can also be expanded to view the full detail pane.

### AI Drafts

- Click `AI Draft` on a post to open a draft modal.
- Choose to draft immediately or add extra context before sending the prompt to OpenAI.
- The generated draft opens a fresh compose window with `To`, `CC` when present, `Subject`, and the drafted body.
- If the preferred clipboard API is unavailable, the extension uses a browser fallback.

### Filtering

Priority-based hiding is intended for the `Recent` feed. `History` remains available for broader review even when stricter noise filtering is enabled.

## Digests

The main manual digest action creates a `Day Digest`.

Digests are thread-aware and meant to summarize activity, not just tasks. They can include:

- quotes sent
- order acknowledgements
- open complaints
- closed complaints
- reply-needed threads
- most active contacts

Expanded digest cards support:

- drill-down into related history threads
- direct Capsule links when available
- deletion from the `Digests` view

If a referenced thread cannot be found locally, the extension falls back to opening the related Capsule item directly.

## Data and Storage

- UI state and cached activity are stored in Chrome extension storage.
- Capsule credentials and OpenAI credentials are stored in the local Chrome profile, not in this repository.
- The configured Capsule web URL is stored in the local Chrome profile.
- AI analysis is cached to reduce repeat API usage.
- Changing core analysis settings may invalidate AI analysis cache and reanalyze existing items.
- Task counts in the UI are Capsule-focused. Local storage acts as cache, not the source of truth.

The extension is designed to fail soft where possible:

- cached activity remains available when a refresh fails
- missing setup keeps required actions blocked, but existing stored data can still be reviewed where possible
- empty views use explicit messages instead of silent blank states

## Pre-Push Checklist

1. Confirm `manifest.json` version is correct.
2. Verify no secrets were added to tracked files.
3. Reload the unpacked extension in Chrome.
4. Click through:
   `Recent`, `Saved`, `History`, `Digests`, `Tasks`, `Settings`
5. Sanity-check:
   refresh, notifications, reply shortcut, AI draft, task creation/completion, digest generation/deletion, digest drill-down, setup-required modal
6. Review `git status`.

Recommended real-data checks:

- task creation and completion
- task owner filtering
- thread grouping and expansion
- noise filtering behavior
- AI draft with and without extra context
- digest metrics and drill-down links
- digest duplicate generation handling
- digest deletion
- configured Capsule web URL correctness
- popup and side-panel layout at different heights

## Packaging

1. Update the version in [manifest.json](./manifest.json).
2. Reload the unpacked extension.
3. Run through the main user flows.
4. Zip the project contents for Chrome Web Store upload, excluding ignored local files.
