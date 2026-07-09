# Moodle Snapshotter — Architecture & Design

> Chrome Extension (Manifest V3) · v2.18.3 · 1177 lines content + 118 lines anonymizer

## Overview

One-click ZIP archive of an entire Moodle course. Activates from a popup panel, injects two content scripts that crawl the course, discover all activities, download everything (concurrent, size-limited, cancellable), optionally anonymize the output, and package into a self-contained offline ZIP with a searchable index.

---

## File Map

| File | Role | Lines |
|------|------|:----:|
| `manifest.json` | MV3 manifest, permissions, content script registration | 23 |
| `popup.html` | Dark-themed popup with grid layout and options | 86 |
| `popup.js` | Loads/saves `chrome.storage.sync` options, injects payload | 63 |
| `content.js` | **Engine.** Crawls, discovers, downloads, builds ZIP | 1177 |
| `anonymizer.js` | Post-processing privacy scrub (extracted from content.js) | 118 |
| `background.js` | Service worker: reassembles ZIP chunks, triggers `chrome.downloads` | 62 |
| `libs/jszip.min.js` | JSZip v3.10.1 — ZIP creation in-browser | vendor |
| `styles/overlay.css` | Base styles for progress overlay injected into page | 14 |

Placeholders (`content.safe.v7*.js`) are historical backups, no longer maintained.

---

## Data Flow

```
Popup click
  │  popup.js → chrome.storage.sync.set(options)
  │  popup.js → chrome.scripting.executeScript(payload)
  ▼
window.__MOODLE_SNAPSHOTTER_OPTS__ = payload
  │
  ▼
downloadCourseSnapshot()
  │
  ├─ Phase 1 — DISCOVERY
  │   • BFS crawl of course + linked section pages (depth-limited)
  │   • detectModulesInDocument(): parse <li.activity-wrapper> cards
  │   • Classify by modtype_* CSS → file/folder/url/page/assign/forum/label/data
  │   • Collect into Maps: files, folders, urlsExternal, notes, assignments, forums
  │
  ├─ Phase 2 — WORK QUEUE
  │   • Build sorted work[] from Maps (file→url→html→image→assign→folder→forum)
  │
  ├─ Phase 3 — DOWNLOAD
  │   • Concurrency-limited via limiter(n)
  │   • Each file: HEAD→check size→fetch blob→add to JSZip
  │   • Each folder: try download_folder.php ZIP→fallback crawl
  │   • Each forum: fetch discussion list→crawl ≤5 discussions→extract attachments
  │   • Each assignment: crawl for submission files + save page as HTML
  │   • Cancel: AbortController + periodic checks + partial ZIP
  │
  ├─ Phase 4 — ANONYMIZE (optional, in anonymizer.js)
  │   • Remove 06_Assignments/ directory
  │   • Replace names with "John Doe N"
  │   • Replace profile pics with colored <span> circles
  │   • Strip submission status blocks, inline text, repo links
  │   • Scrub Matomo tracking IDs, emails, GitHub URLs
  │   • Strip database pages, choicegroup rosters, select menus
  │
  └─ Phase 5 — ZIP & SAVE
      • zip.generateAsync(STORE if >80MB)→try chrome.downloads→fallback <a> click
      • ZIP filename: CourseSlug__YYMMDD-HHMM[-anon].zip
      • Save ZIP button resets after 5s for re-download
```

---

## CSS Selectors & URL Patterns (`S` object)

All Moodle-specific CSS selectors and URL regex patterns are centralized in a `const S = { ... }` object at lines 11–38 of `content.js`. When Moodle updates break a selector, you fix it in one place. Key entries:

| Key | Value | Used in |
|-----|-------|---------|
| `activityCard` | `li.activity-wrapper` | Module detection |
| `activityLink` | `a.aalink.stretched-link, ...` | Activity link extraction |
| `pluginfileLink` | `a[href*="/pluginfile.php/"]` | File link scanning |
| `folderFileAnchors` | 6-selector union | Folder crawl |
| `assignFileLinks` | 5-selector union | Assignment submissions |
| `forumDiscLinks` | 3-selector union | Discussion discovery |
| `resourceView` | `/\/mod\/resource\/view\.php/` | File handler routing |
| `modPath` | `/^\/(course\|mod\|pluginfile\.php)\//` | Crawl scope filter |

---

## Module Detection (Moodle 4.x)

Scans `S.activityCard` elements. Classified by CSS class on `.activitytitle` or the `<li>` itself:

| CSS class | → type | Handler | Output dir |
|-----------|--------|---------|------------|
| `modtype_resource` | `file` | `handleFile` | `01_Files/` |
| `modtype_folder` | `folder` | `handleFolder` | `02_Folders/` |
| `modtype_url` | `url` | `handleUrl` | `03_URLs/` (.url) |
| `modtype_page` | `page` | `handleHtml` | `04_Notes_Pages/` |
| `modtype_assign` | `assign` | `handleAssign` | `06_Assignments/` + `04_Notes_Pages/` |
| `modtype_label` | `label` | `handleHtml` | `04_Notes_Pages/` |
| `modtype_forum` | `forum` | `handleForum` | `07_Forums/` + `04_Notes_Pages/` |
| `modtype_data` | `data` | `handleHtml` | `04_Notes_Pages/` |
| `modtype_wiki` | `wiki` | `handleWiki` | `08_Wikis/` + `04_Notes_Pages/` |
| `modtype_h5pactivity` | `h5p` | `handleHtml` | `04_Notes_Pages/` |
| `modtype_scorm` | `scorm` | `handleHtml` | `04_Notes_Pages/` |
| `modtype_imscp` | `imscp` | `handleHtml` | `04_Notes_Pages/` |
| `modtype_choicegroup` | `choicegroup` | `handleHtml` | `04_Notes_Pages/` |
| `modtype_organizer` | `organizer` | `handleHtml` | `04_Notes_Pages/` |
| `modtype_ubicast` | `ubicast` | `handleHtml` | `04_Notes_Pages/` |
| `modtype_subsection` | `subsection` | `handleHtml` | `04_Notes_Pages/` |

Activity names: `data-activityname` attribute → `.instancename` span. Fallback: URL pattern matching.

---

## Key Constants & Limits

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_SEG_LEN` | 80 | Max chars per filename segment |
| `MAX_TOTAL_LEN` | 240 | Max chars for full relative path in ZIP |
| File-count hard cap | 10,000 | Global limit on files added to ZIP |
| Forum max discussions | 5 | Per forum crawl limit |
| Forum fetch timeout | 15–20s | Per-page fetch timeout |
| File retries | 3 × 25s | Exponential backoff |
| STORE threshold | 80 MB | Switch from DEFLATE to STORE compression |
| Background chunk | 2 MB | ZIP chunks for service-worker relay |
| HEAD timeout | 8s | Size-check request |
| Large file log threshold | >5 MB | Always logged even without verbose |

---

## Filename Resolution

`pickFilename(res, origUrl, fallbackName, mimeHint)` resolves in priority:

1. **Content-Disposition** — `filename*=UTF-8''...` (RFC 5987) or `filename="..."`
2. **Response URL** — last path segment
3. **Original URL** — last path segment
4. **Fallback name** — activity name or `'file'`

### Mojibake Repair

`fixMojibake(str)` detects UTF-8 byte sequences incorrectly decoded as Latin-1 (é→Ã©). Only re-decodes when valid UTF-8 multi-byte sequences (2/3/4-byte) are detected — avoids corrupting already-correct Latin-1 strings.

### Extension Resolution

1. Existing extension on filename (`.pdf`, `.pptx`)
2. Content-Type → `MIME_EXT` Map (60+ MIME types)

---

## Path Deduplication

`uniquePath(relPath)` guarantees unique paths:
1. `truncatePath()` enforces segment (80) and total (240) limits
2. Append ` (2)`, ` (3)` up to 2000 attempts
3. Random 6-char suffix as last resort

---

## Size Management

| Param | Default | Mechanism |
|-------|---------|-----------|
| `maxFileMB` | 250 MB | HEAD → Content-Length → skip |
| `maxTotalMB` | 2000 MB | Cumulative check before each download |
| Hard file cap | 10,000 | Absolute limit regardless of size |
| STORE threshold | 80 MB | Avoid JSZip OOM crash |
| Download log | auto >5 MB | `⬇ 450.2 MB: video.mp4` |
| Completion log | auto >10 MB | `✓ 450.2 MB — video.mp4` |

---

## Cancellation

- Global `AbortController` kills in-flight fetches
- Cancel checks between every folder file, forum attachment, assignment file
- Cancel button → "Stopping…" (overlay stays visible)
- Partial ZIP generated: "Stopped — saving 37 files (85.3 MB)"
- Save ZIP button appears; resets after 5s for re-download

---

## Anonymization (`anonymizer.js`)

Extracted to `anonymizer.js` as `window.sanitizeZip(zip, root, UI)`. Loaded by manifest before `content.js`. Runs AFTER all downloads, BEFORE ZIP packaging.

| Operation | Method |
|-----------|--------|
| Remove assignments | Deletes all files under `06_Assignments/` |
| Replace names | Profile links/forum authors → `John Doe N`, "par/by N" → "a student" |
| Replace profile pics | Colored `<span>` circles, hue from user ID hash |
| Strip submission content | `.submissionstatustable`, `.full_assignsubmission_onlinetext`, `.fileuploadsubmission`, `.submissionlinks`, `.plugincontentsummary` → removed |
| Strip textareas | All `<textarea>` content → `[content removed for privacy]` |
| Scrub GitHub URLs | Any `github.com/user/...` → `[GitHub link removed]` |
| Scrub emails | `x@y.z` → `anonymous@example.com` |
| Scrub Matomo | `setUserId` → `'anonymous'` |
| Scrub sesskey | URLs, hidden inputs, M.cfg → `[removed]` |
| Scrub user IDs | `userId`, `data-userid`, `data-route-param`, `contextInstanceId` → `0` |
| Scrub user links | `user/view.php?id=X` and `user/profile.php?id=X` → `#` |
| Strip database pages | Entire body replaced with privacy notice |
| Strip choicegroup rosters | Member names → `[student names removed]`, group structure preserved |
| Strip select elements | All `<select>` dropdowns → `[options removed]` |
| Scrub @handles | `@username` → `@anonymous` |
| Scrub useridlistid | `useridlistid=hex` → `[removed]` |
| Split-name matching | Individual name components → `Student` for partial body-text matches |

ZIP filename gets `-anon` suffix when anonymized.

---

## Background Download Relay

When `chrome.downloads` is available:
1. Content script → `chrome.runtime.connect({ name: 'zipTransfer' })`
2. ZIP chunked at 2 MB → `port.postMessage()`
3. `background.js` reassembles → `chrome.downloads.download()`

Fallback: overlay "Save ZIP" button → `<a download>` → `.click()`

---

## Overlay UI

Fixed bottom-right panel (480px):
- Header: title + YYMMDD-HHMM timestamp
- Progress bar: global completion
- Status label: current operation
- Sub-progress: blue detail line per task
- Save ZIP: green button (auto-resets after 5s)
- Footer: Pause / Resume / Cancel (→ "Stopping…")

---

## Popup Layout (v2.14)

Grid layout with two rows of paired boxes:
- **Row 1:** Content (checkboxes) | Speed (concurrency, crawl depth)
- **Row 2:** Size limits (per file, total) | Extras (verbose, anonymize)
- Button: full-width gradient CTA

---

## Security Hardening

| Fix | Line(s) | Description |
|-----|---------|-------------|
| `escHtml()` | content.js:561 | Escapes `<`, `>`, `&`, `"` in index/URL HTML output (XSS prevention) |
| ZIP slip | content.js:386 | `slug()` applied to folder ZIP entry paths (prevents `../` traversal) |
| Error sanitization | content.js:1145 | URLs and sesskeys stripped from error messages before `sendMessage` |
| File-count cap | content.js:741 | Hard 10,000-file limit in `fetchFileAs()` |

---

## Known Limitations

### Currently unhandled Moodle modules

| Module | Has files? | Effort | Notes |
|--------|:----------:|:------:|-------|
| **quiz** | Yes | High | Essay uploads, question media, multi-page review |
| **workshop** | Yes | Medium | Similar to handleAssign |
| **book** | Yes | Low | Recursive chapter crawl |
| **lesson** | Yes | High | Branching navigation |
| **glossary** | Yes | Low | Iterate entries |

### General limitations

- Forums: only 5 discussions crawled per forum
- Forum pagination: only first page of discussions
- Quiz, workshop, lesson: not crawled
- Dynamic content: JS-rendered blocks not captured
- Moodle instance: hardcoded to `moodle.uclouvain.be`
- Memory: courses >3 GB may exceed browser limits
- Anonymization: free-text names in forum post bodies not caught by regex alone
- URL resources: `resolveUrlTarget` is dead code; URLs saved as HTML pages
