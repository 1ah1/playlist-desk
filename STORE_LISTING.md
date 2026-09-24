# Chrome Web Store listing — copy into the developer dashboard

## Name
Playlist Desk

## Summary (132 chars max)
Search, filter and bulk-edit your YouTube playlists, including Watch Later. Runs locally in your browser.

## Description
Playlist Desk adds a manager panel to youtube.com for your own playlists.

What it does:
• Indexes a whole playlist in seconds — thousands of videos, no scrolling
• Instant search by title or channel
• Filters: duration, channel, unavailable (deleted or private) videos, started or watched, duplicates
• Select many videos at once and remove them, or move / copy them to another playlist
• 10-second Undo after removing
• Export to CSV
• Keyboard shortcuts: / to search, Delete to remove, Alt+P to open

Works with Watch Later, Liked videos and every playlist you own.

Everything runs inside your browser using the YouTube session you are already signed
into. There is no server, no account, no analytics, and nothing is collected.

Playlist Desk is an independent project. It is not affiliated with or endorsed by
YouTube or Google. It relies on YouTube's web interface, so a YouTube redesign may
temporarily break it until an update is published.

Source code: https://github.com/1ah1/playlist-desk

## Category
Productivity → Tools

## Single purpose (form field)
Manage the videos in the user's own YouTube playlists: search, filter, remove and move them in bulk.

## Permission justification — host permission https://www.youtube.com/*
The extension runs only on youtube.com. It needs access to that site to add the
"Playlists" button to the page and to read and edit the signed-in user's playlists
through YouTube's own web interface, on the user's request. No other site is accessed.

## Remote code
No remote code is used. All scripts are packaged in the extension.

## Data usage disclosure
Does not collect or use user data. (Playlist contents are stored locally in the
browser only.)

## Privacy policy URL
https://github.com/1ah1/playlist-desk/blob/main/PRIVACY.md

## Assets needed
- Screenshots: 1280×800 PNG, 1–5 images (panel over YouTube; search + filters; selection bar)
- Small promo tile: 440×280 (optional)
- Icon: 128×128 — public/icons/icon-128.png
