/* content.js — Moodle Snapshotter v2.18.3
   Main engine injected into moodle.uclouvain.be pages.
   Five-phase pipeline: Discovery → Work Queue → Download → Anonymize → ZIP & Save.
   CSS selectors in `S` object. Anonymizer in `anonymizer.js` (window.sanitizeZip).
   Background download relay in `background.js`. See DESIGN.md for full architecture.
*/
/* global JSZip */

(() => {
    // ── CSS SELECTORS & URL PATTERNS (centralized; update here for Moodle compat) ──
    const S = {
      activityCard:       'li.activity-wrapper',
      activityName:       '.activity-item',
      instanceName:       '.instancename',
      activityLink:       'a.aalink.stretched-link, a.aalink, a[href]',
      activityTitle:      '.activitytitle',
      pluginfileLink:     'a[href*="/pluginfile.php/"]',
      forcedDlLink:       'a[href*="/pluginfile.php/"][href*="forcedownload=1"]',
      folderFileAnchors:  ['a[href*="/pluginfile.php/"]','a[href*="/mod/resource/view.php"]',
        '.fp-filename-icon a[href*="/pluginfile.php/"]','.fp-file a[href*="/pluginfile.php/"]',
        '.foldertree a[href*="/pluginfile.php/"]','a[data-fileurl*="/pluginfile.php/"]'].join(','),
      assignFileLinks:    ['a[href*="assignsubmission_file"]',
        'a[href*="/pluginfile.php/"][href*="/assignsubmission_file/"]',
        'a[href*="/pluginfile.php/"][href*="/mod_assign/"]',
        '.submissionfile a[href*="/pluginfile.php/"]',
        '.fileuploadsubmission a[href*="/pluginfile.php/"]'].join(','),
      forumDiscLinks:     ['a[href*="/mod/forum/discuss.php?d="]',
        'a[href*="discuss.php?d="]','tr.discussion a[href*="discuss.php"]'].join(','),
      courseSeedLinks:    'a[href*="course/view.php"][href*="section="], a.sectionlink, a.section-link, a[href*="format=singleactivity"], a[href*="week="], a[href*="topic="]',
      folderViewLink:     'a[href*="/mod/folder/view.php"]',
      imageExclude:       '#courseindex, nav.drawer, .activityiconcontainer, .navbar',
      courseTitle:        '.page-header-headings h1, h1.coursename, header .page-title',
      discussionName:     '.discussionname',
      postContainer:      '.forum-post-container',
      wikiPageLinks:      'a[href*="mod/wiki/view.php?pageid="], a[href*="/mod/wiki/view.php"]',
      wikiAttachLinks:    'a[href*="/pluginfile.php/"][href*="/mod_wiki/"]',
      modPath:            /^\/(course|mod|pluginfile\.php)\//,
      resourceView:       /\/mod\/resource\/view\.php/,
      folderView:         /\/mod\/folder\/view\.php/,
      assignView:         /\/mod\/assign\/view\.php/,
      forumView:          /\/mod\/forum\/view\.php/,
      wikiView:           /\/mod\/wiki\/view\.php/,
      pluginfilePath:     /\/pluginfile\.php\//,
      viewPhpName:        /^(view|index|mod)\.php$/i,
    };
    // ── UTILITIES ──────────────────────────────────────────────
    //  sleep, timestamps, URL helpers, slug, concurrency limiter
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const nowStamp = () => {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear().toString().slice(2) + pad(d.getMonth()+1) + pad(d.getDate()) + '-' +
             pad(d.getHours()) + pad(d.getMinutes());
    };
    const sameHost = (u) => { try { return new URL(u, location.origin).host === location.host; } catch (_) { return false; } };
    const toAbs = (u) => { try { return new URL(u, location.origin).toString(); } catch (_) { return null; } };
    const addForced = (u) => {
      try {
        const url = new URL(u, location.origin);
        if (/pluginfile\.php/.test(url.pathname) && !url.searchParams.has('forcedownload')) {
          url.searchParams.set('forcedownload', '1');
        }
        return url.toString();
      } catch (_) { return u; }
    };
    const pathOk = (p) => S.modPath.test(p || '');
    const slug = (s) =>
      (s || 'untitled')
        .replace(/[\s\/\\:]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[<>:"|?*]/g, '')
        .slice(0, 150);

    const extractContextFromBody = () => {
      const cls = document.body.className;
      const cm = cls.match(/course-(\d+)/);
      const cxm = cls.match(/context-(\d+)/);
      return { courseId: cm ? cm[1] : null, contextId: cxm ? cxm[1] : null };
    };
  
    const withRetries = async (fn, { tries = 3, base = 350 } = {}) => {
      let last;
      for (let i = 0; i < tries; i++) {
        try { return await fn(); } catch (e) { last = e; await sleep(base * Math.pow(2, i)); }
      }
      throw last;
    };
  
    const withTimeout = async (p, ms) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort('timeout'), ms);
      try { return await p(ctrl.signal); } finally { clearTimeout(t); }
    };
  
    const limiter = (n) => {
      const q = []; let active = 0;
      const pump = () => {
        if (active >= n || q.length === 0) return;
        const { fn, res, rej } = q.shift();
        active++;
        fn().then((v)=>{active--;res(v);pump();}).catch((e)=>{active--;rej(e);pump();});
      };
      return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); pump(); });
    };
  
    // ----------------------------- Filenames & paths
    const MIME_EXT = new Map([
      ['application/pdf','.pdf'],['application/zip','.zip'],
      ['application/vnd.openxmlformats-officedocument.wordprocessingml.document','.docx'],
      ['application/msword','.doc'],
      ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.xlsx'],
      ['application/vnd.ms-excel','.xls'],
      ['application/vnd.openxmlformats-officedocument.presentationml.presentation','.pptx'],
      ['application/vnd.ms-powerpoint','.ppt'],
      ['text/plain','.txt'],['text/html','.html'],
      ['image/png','.png'],['image/jpeg','.jpg'],['image/gif','.gif'],['image/svg+xml','.svg'],
      ['application/octet-stream','']
    ]);
    const extFromMime = (mime) => MIME_EXT.get((mime||'').split(';')[0].trim().toLowerCase()) || '';
  
    const splitExt = (name) => {
      const i = name.lastIndexOf('.');
      if (i <= 0 || i === name.length - 1) return { base: name, ext: '' };
      return { base: name.slice(0, i), ext: name.slice(i) };
    };
  
    const extractNameFromCD = (res) => {
      const cd = res.headers.get('content-disposition') || '';
      const m = cd.match(/filename\*=UTF-8''([^;]+)|filename="?([^\";]+)"?/i);
      if (m && (m[1] || m[2])) {
        try { return decodeURIComponent(m[1] || m[2]); } catch (_) { return m[1] || m[2]; }
      }
      return '';
    };
    const fixMojibake = (str) => {
      if (!str) return str;
      const bytes = new Uint8Array(str.length);
      let hasUtf8Seq = false;
      for (let i = 0; i < str.length; i++) {
        bytes[i] = str.charCodeAt(i);
      }
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        if (b < 0x80) continue;
        if (b >= 0xC2 && b <= 0xDF && i + 1 < bytes.length && (bytes[i + 1] & 0xC0) === 0x80) { hasUtf8Seq = true; break; }
        if (b >= 0xE0 && b <= 0xEF && i + 2 < bytes.length && (bytes[i + 1] & 0xC0) === 0x80 && (bytes[i + 2] & 0xC0) === 0x80) { hasUtf8Seq = true; break; }
        if (b >= 0xF0 && b <= 0xF4 && i + 3 < bytes.length && (bytes[i + 1] & 0xC0) === 0x80 && (bytes[i + 2] & 0xC0) === 0x80 && (bytes[i + 3] & 0xC0) === 0x80) { hasUtf8Seq = true; break; }
      }
      if (!hasUtf8Seq) return str;
      try {
        const decoded = new TextDecoder('utf-8').decode(bytes);
        if (/[\uFFFD]/.test(decoded)) return str;
        return decoded;
      } catch(_) {}
      return str;
    };
    const extractNameFromUrl = (url) => {
      try {
        const u = new URL(url);
        const last = u.pathname.split('/').pop();
        if (!last || S.viewPhpName.test(last) || /^[a-z]+\.php\?/.test(last)) return '';
        return last ? decodeURIComponent(last) : '';
      } catch(_) { return ''; }
    };
    const ensureExtension = (name, mime) => {
      if (/[.][A-Za-z0-9]{2,6}$/.test(name)) return name;
      const ext = extFromMime(mime);
      return name + (ext || '');
    };
    const pickFilename = (res, origUrl, fallbackName, mimeHint) => {
      let name = extractNameFromCD(res);
      if (!name) name = extractNameFromUrl(res.url);
      if (!name) name = extractNameFromUrl(origUrl);
      if (!name) name = fallbackName;
      name = name.replace(/\?.*$/, '');
      name = slug(fixMojibake(name));
      const mime = res.headers.get('content-type') || mimeHint || '';
      return ensureExtension(name, mime) || (slug(fallbackName) + (extFromMime(mime) || ''));
    };
  
    // Path management
    const usedPaths = new Set();
    const MAX_SEG_LEN = 80;
    const MAX_TOTAL_LEN = 240;
    const trimSeg = (seg) => seg.length > MAX_SEG_LEN ? (seg.slice(0, MAX_SEG_LEN-1) + '…') : seg;
    const truncatePath = (p) => {
      const parts = p.split('/').map(trimSeg);
      let out = parts.join('/');
      if (out.length <= MAX_TOTAL_LEN) return out;
      const fname = parts.pop();
      while (parts.length && (parts.join('/').length + 1 + fname.length) > MAX_TOTAL_LEN) {
        const i = parts.findIndex(s => s.length > 10);
        if (i === -1) break;
        parts[i] = parts[i].slice(0, Math.max(8, Math.floor(parts[i].length * 0.7))) + '…';
      }
      out = parts.join('/') + (parts.length ? '/' : '') + fname;
      if (out.length <= MAX_TOTAL_LEN) return out;
      return out.slice(-MAX_TOTAL_LEN);
    };
    const uniquePath = (relPath) => {
      let p = truncatePath(relPath);
      if (!usedPaths.has(p)) { usedPaths.add(p); return p; }
      const parts = p.split('/');
      const leaf = parts.pop();
      const { base, ext } = splitExt(leaf);
      const prefix = parts.join('/');
      const baseTrim = trimSeg(base);
      for (let i = 1; i <= 2000; i++) {
        const leaf2 = baseTrim + ' (' + i + ')' + ext;
        let candidate = prefix ? (prefix + '/' + leaf2) : leaf2;
        candidate = truncatePath(candidate);
        if (!usedPaths.has(candidate)) { usedPaths.add(candidate); return candidate; }
      }
      const rand = Math.random().toString(36).slice(2,8);
      const leaf3 = (baseTrim.slice(0, Math.max(1, MAX_SEG_LEN-7))) + '~' + rand + ext;
      const fallback = truncatePath(prefix ? (prefix + '/' + leaf3) : leaf3);
      usedPaths.add(fallback);
      return fallback;
    };
  
    // ── GLOBAL STATE (set at session start) ────────────────────
    const debugLines = [];
    const warnings = [];
    let abortCtrl = null;
    let verbose = false;
    let maxFileBytes = 0;
    let maxTotalBytes = 0;
    let totalSkippedBytes = 0;
    const UI = (() => {
      let overlay, logEl, progressEl, labelEl, countsEl, subEl, btnSave;
      let paused = false, cancelled = false;
      const ensure = () => {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'moodle-snap-overlay';
        overlay.style.cssText = [
          'position:fixed','z-index:2147483647','right:12px','bottom:12px','width:480px','background:#0f172a',
          'color:#e2e8f0','border-radius:12px','box-shadow:0 8px 30px rgba(0,0,0,.35)','font:13px/1.4 system-ui,Arial,sans-serif'
        ].join(';');
        overlay.innerHTML = [
          '<header style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid #1f2a44">',
            '<h3 style="margin:0;font-size:14px">Course Snapshot</h3>',
            '<span class="muted" id="snap-ts" style="opacity:.8">', nowStamp(), '</span>',
          '</header>',
          '<div class="body" style="padding:10px 12px">',
            '<div class="row"><progress id="snap-prog" max="100" value="0" style="width:100%;height:12px"></progress></div>',
            '<div class="row" style="margin-top:6px;display:flex;justify-content:space-between;gap:8px;align-items:center">',
              '<span id="snap-label">Preparing…</span>',
              '<button id="snap-save" style="display:none;padding:6px 10px;border-radius:8px;cursor:pointer;background:#16a34a;color:#fff;border:1px solid #22c55e">Save ZIP</button>',
            '</div>',
            '<div class="row muted" id="snap-counts" style="opacity:.9;margin-top:4px">0 / 0</div>',
            '<div class="row" id="snap-sub" style="display:none;margin-top:2px;font-size:11px;color:#93c5fd"></div>',
            '<div class="log" style="max-height:240px;overflow:auto;background:#0b1220;border-radius:8px;padding:6px 8px;margin-top:8px">',
              '<pre id="snap-log" style="white-space:pre-wrap;margin:0;color:#d1e9ff"></pre>',
            '</div>',
          '</div>',
          '<footer style="padding:10px 12px;display:flex;gap:8px;border-top:1px solid #1f2a44">',
            '<button id="snap-pause" style="padding:6px 8px;border-radius:8px;cursor:pointer;background:#1e293b;color:#e2e8f0;border:1px solid #334155">Pause</button>',
            '<button id="snap-resume" style="padding:6px 8px;border-radius:8px;cursor:pointer;background:#1e293b;color:#e2e8f0;border:1px solid #334155;display:none">Resume</button>',
            '<button id="snap-cancel" style="padding:6px 8px;border-radius:8px;cursor:pointer;background:#be123c;color:#fff;border:1px solid #e11d48">Cancel</button>',
          '</footer>'
        ].join('');
        document.body.appendChild(overlay);
        logEl = overlay.querySelector('#snap-log');
        progressEl = overlay.querySelector('#snap-prog');
        labelEl = overlay.querySelector('#snap-label');
        countsEl = overlay.querySelector('#snap-counts');
        subEl = overlay.querySelector('#snap-sub');
        btnSave = overlay.querySelector('#snap-save');
        overlay.querySelector('#snap-pause').onclick = () => { paused = true; overlay.querySelector('#snap-pause').style.display = 'none'; overlay.querySelector('#snap-resume').style.display = ''; };
        overlay.querySelector('#snap-resume').onclick = () => { paused = false; overlay.querySelector('#snap-pause').style.display = ''; overlay.querySelector('#snap-resume').style.display = 'none'; };
        overlay.querySelector('#snap-cancel').onclick = () => { cancelled = true; if (abortCtrl) abortCtrl.abort('cancelled'); const cancelBtn = overlay.querySelector('#snap-cancel'); cancelBtn.disabled = true; cancelBtn.textContent = 'Stopping…'; };
      };
      const waitIfPaused = async () => { while (paused && !cancelled) await sleep(250); if (cancelled || (abortCtrl && abortCtrl.signal.aborted)) throw new Error('Cancelled'); };
      const log = (msg) => { ensure(); const line = new Date().toLocaleTimeString() + '  ' + msg; debugLines.push(line); logEl.textContent += (logEl.textContent ? '\n' : '') + line; logEl.scrollTop = logEl.scrollHeight; };
      const warn = (msg) => { warnings.push(msg); log('⚠️  ' + msg); };
      const status = (msg) => { ensure(); labelEl.textContent = msg; };
      const counts = (done, total) => { ensure(); countsEl.textContent = done + ' / ' + total; progressEl.value = total ? Math.floor((done/total)*100) : 0; };
      const sub = (msg) => { ensure(); if (msg) { subEl.textContent = msg; subEl.style.display = ''; } else { subEl.style.display = 'none'; } };
      const showSave = (onClick) => {
        ensure();
        btnSave.style.display='inline-block';
        btnSave.disabled = false;
        btnSave.textContent = 'Save ZIP';
        let fired = false;
        btnSave.onclick = () => { if (fired) return; fired = true; onClick(); btnSave.disabled = true; btnSave.textContent = 'Saving…'; setTimeout(() => { fired = false; btnSave.disabled = false; btnSave.textContent = 'Save ZIP'; }, 5000); };
      };
      const isCancelled = () => cancelled;
      return { ensure, log, warn, status, counts, sub, waitIfPaused, isCancelled, showSave };
    })();
  
    // ── HTTP & URL RESOLUTION ──────────────────────────────────
    const fetchResp = async (url, type /* 'blob' | 'text' */) =>
      withRetries(async () => {
        const res = await withTimeout((signal) => fetch(url, { credentials: 'include', redirect: 'follow', signal }), 25000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = type === 'blob' ? await res.blob() : await res.text();
        return { res, data };
      }, { tries: 3, base: 600 });
  
    const resourceResolveCache = new Map();
    const resolveResourceDownloadUrl = async (resourceViewUrl) => {
      if (resourceResolveCache.has(resourceViewUrl)) return resourceResolveCache.get(resourceViewUrl);
      let resolved = resourceViewUrl;
      if (S.pluginfilePath.test(resourceViewUrl)) { resolved = addForced(resourceViewUrl); resourceResolveCache.set(resourceViewUrl, resolved); return resolved; }
      try {
        const { data: html } = await fetchResp(resourceViewUrl, 'text');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        let a = doc.querySelector(S.forcedDlLink);
        if (!a) a = doc.querySelector('div.resourceworkaround a[href*="/pluginfile.php"]');
        if (!a) a = doc.querySelector('a[href*="/pluginfile.php/"]');
        if (!a) a = doc.querySelector('.resourcecontent a[href*="pluginfile"]');
        if (!a) a = doc.querySelector('.resourceinfo a[href*="pluginfile"]');
        if (!a) a = doc.querySelector('.generaltable a[href*="pluginfile"]');
        if (!a) a = doc.querySelector('.box a[href*="pluginfile"]');
        if (!a) {
          const obj = doc.querySelector('object[data*="pluginfile.php"]');
          if (obj) { resolved = addForced(obj.getAttribute('data')); resourceResolveCache.set(resourceViewUrl, resolved); return resolved; }
          const embed = doc.querySelector('embed[src*="pluginfile.php"]');
          if (embed) { resolved = addForced(embed.getAttribute('src')); resourceResolveCache.set(resourceViewUrl, resolved); return resolved; }
        }
        if (a) resolved = addForced(a.getAttribute('href'));
      } catch (_) { if (verbose) UI.log('  Resource resolution failed silently for: ' + resourceViewUrl); }
      resourceResolveCache.set(resourceViewUrl, resolved);
      return resolved;
    };
  
    const urlResolveCache = new Map();
    const resolveUrlTarget = async (urlViewUrl) => {
      if (urlResolveCache.has(urlViewUrl)) return urlResolveCache.get(urlViewUrl);
      let out = null;
      try {
        const { data: html } = await fetchResp(urlViewUrl, 'text');
        const doc = new DOMParser().parseFromString(html, 'text/html');
        let a = doc.querySelector('div.urlworkaround a[href]');
        if (!a) a = doc.querySelector('a[target], a[href][rel]');
        if (a) out = toAbs(a.getAttribute('href'));
        if (!out) {
          const meta = doc.querySelector('meta[http-equiv="refresh"]');
          if (meta) {
            const c = meta.getAttribute('content') || '';
            const m = c.match(/url=(.*)$/i);
            if (m) out = toAbs(m[1]);
          }
        }
      } catch (_) {}
      urlResolveCache.set(urlViewUrl, out);
      return out;
    };
  
    // ── MOODLE PAGE PARSING ────────────────────────────────────
    //  Detects activities via Moodle 4.x CSS classes (modtype_*)
    //  Extracts sections for potential future section-aware indexing
    const detectModulesInDocument = (doc) => {
      const cards = Array.from(doc.querySelectorAll(S.activityCard));
      return cards.map((card) => {
        const name = (card.querySelector(S.activityName)?.getAttribute('data-activityname') || '')
          || (card.querySelector(S.instanceName)?.textContent?.replace(/\s+/g, ' ').trim() || '');
        const link = card.querySelector(S.activityLink);
        const href = link?.href || '';
        const titleClasses = (card.querySelector(S.activityTitle)?.className || '') + ' ' + card.className;
        const text = card.textContent || '';
        let type = 'unknown';
        if (/modtype_folder/.test(titleClasses)) type = 'folder';
        else if (/modtype_resource/.test(titleClasses)) type = 'file';
        else if (/modtype_url/.test(titleClasses)) type = 'url';
        else if (/modtype_page/.test(titleClasses)) type = 'page';
        else if (/modtype_assign/.test(titleClasses)) type = 'assign';
        else if (/modtype_label/.test(titleClasses)) type = 'label';
        else if (/modtype_forum/.test(titleClasses)) type = 'forum';
        else if (/modtype_data/.test(titleClasses)) type = 'data';
        else if (/modtype_h5pactivity/.test(titleClasses)) type = 'h5p';
        else if (/modtype_scorm/.test(titleClasses)) type = 'scorm';
        else if (/modtype_imscp/.test(titleClasses)) type = 'imscp';
        else if (/modtype_wiki/.test(titleClasses)) type = 'wiki';
        else if (/modtype_choicegroup/.test(titleClasses)) type = 'choicegroup';
        else if (/modtype_organizer/.test(titleClasses)) type = 'organizer';
        else if (/modtype_ubicast/.test(titleClasses)) type = 'ubicast';
        else if (/modtype_subsection/.test(titleClasses)) type = 'subsection';
        else if (/\bLabel\b/i.test(text)) type = 'label';
        if (type === 'unknown') {
          if (/mod\/folder\//.test(href)) type = 'folder';
          else if (/mod\/resource\//.test(href) || /\/pluginfile\.php/.test(href)) type = 'file';
          else if (/mod\/url\//.test(href)) type = 'url';
          else if (/mod\/page\//.test(href)) type = 'page';
          else if (/mod\/assign\//.test(href)) type = 'assign';
          else if (/mod\/forum\//.test(href)) type = 'forum';
        }
        return { name, href, type };
      });
    };
    // ── FOLDER CRAWLER ─────────────────────────────────────────
    //  Strategy 1: download_folder.php ZIP (fast, one request)
    //  Strategy 2: recursive subdir crawl (slow, many requests)
    //  Respects size limits and cancellation between files
    const discoverSesskey = () => {
      const m = document.documentElement.innerHTML.match(/"sesskey"\s*:\s*"([A-Za-z0-9]+)"/);
      if (m) return m[1];
      const inp = document.querySelector('input[name="sesskey"]');
      if (inp && inp.value) return inp.value;
      const meta = document.querySelector('meta[name="sesskey"]');
      if (meta) return meta.getAttribute('content') || '';
      return '';
    };
    const zipTried = new Set();
    const zipFailed = new Set();
    const downloadAndExtractFolderZip = async (cmid, root, destRelDir, addIndex, folderLabel, stats) => {
      if (zipFailed.has(cmid)) { UI.log('ZIP previously failed for cmid=' + cmid + '; skipping.'); return false; }
      if (zipTried.has(cmid)) { UI.log('ZIP already attempted for cmid=' + cmid + '; skipping.'); return false; }
      zipTried.add(cmid);
      const base = location.origin + '/mod/folder/download_folder.php?id=' + encodeURIComponent(cmid);
      UI.log('Downloading folder ZIP for cmid=' + cmid);
      try {
        const { res, data: blob } = await fetchResp(base, 'blob');
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        if (/text\/html/.test(ct)) throw new Error('server returned HTML instead of ZIP');
        const zip2 = await JSZip.loadAsync(blob);
        const zipFileCount = Object.keys(zip2.files).filter(k => !zip2.files[k].dir).length;
        UI.sub('Folder ' + folderLabel + ' — extracting ' + zipFileCount + ' files…');
        const writeOps = [];
        zip2.forEach((innerPath, entry) => {
          if (entry.dir) return;
          const fixedPath = fixMojibake(slug(innerPath));
          writeOps.push((async () => {
            const data = await entry.async('uint8array');
            const rel = destRelDir + '/' + fixedPath.replace(/\\+/g, '/').replace(/^\/+/, '');
            const rel2 = uniquePath(rel);
            window._snapshot_zip.file(root + '/' + rel2, data);
            addIndex('Folder file', folderLabel + ' / ' + fixedPath, rel2);
            stats.files++; stats.bytes += data.byteLength;
            const ext = (rel2.split('.').pop() || '').toLowerCase();
            stats.byType[ext] = (stats.byType[ext] || 0) + 1;
          })());
        });
        await Promise.all(writeOps);
        UI.sub('');
        stats.foldersZipped++;
        return true;
      } catch (e) {
        zipFailed.add(cmid);
        UI.warn('Folder ZIP extraction failed for cmid=' + cmid + ': ' + (e.message || e));
        stats.folderZipFails++;
        return false;
      }
    };
    const crawlFolderDeep = async (folderUrl) => {
      const out = { files: [], tried: [], errors: [] };
      let cmid = ''; try { cmid = (new URL(folderUrl, location.origin)).searchParams.get('id') || ''; } catch(_) {}
      const sesskey = discoverSesskey();
      const buildUrl = (subdir, style) => {
        const base = folderUrl.split('?')[0];
        const u = new URL(base, location.origin);
        u.searchParams.set('id', cmid);
        if (style === 'subdir') u.searchParams.set('subdir', subdir);
        if (style === 'path')  u.searchParams.set('path', subdir);
        if (sesskey) u.searchParams.set('sesskey', sesskey);
        return u.toString();
      };
      const queue = [{ style: 'root', url: folderUrl, key: '/' }];
      const seen = new Set(['/']);
      while (queue.length) {
        const item = queue.shift();
        out.tried.push(item.url);
        try {
          const { data: html } = await fetchResp(item.url, 'text');
          const doc = new DOMParser().parseFromString(html, 'text/html');
          const fileAnchors = Array.from(doc.querySelectorAll(S.folderFileAnchors));
          for (const a of fileAnchors) {
            let href = a.getAttribute('data-fileurl') || a.getAttribute('href'); if (!href) continue;
            href = toAbs(href);
            if (!href) continue;
            if (/\/mod\/resource\/view\.php/.test(href)) href = await resolveResourceDownloadUrl(href);
            if (sameHost(href)) out.files.push({ href: addForced(href) });
          }
          const subdirCandidates = new Set();
          doc.querySelectorAll('a[href*="&subdir="], a[data-subdir]').forEach((el) => {
            let sd = el.getAttribute('data-subdir');
            if (!sd && el.tagName === 'A') {
              try { sd = new URL(el.href, location.origin).searchParams.get('subdir'); } catch (_) {}
            }
            if (sd) subdirCandidates.add(sd);
          });
          doc.querySelectorAll('a[href*="&path="], a[data-path]').forEach((el) => {
            let sd = el.getAttribute('data-path');
            if (!sd && el.tagName === 'A') {
              try { sd = new URL(el.href, location.origin).searchParams.get('path'); } catch (_) {}
            }
            if (sd) subdirCandidates.add(sd);
          });
          if (subdirCandidates.size === 0 && item.style === 'root' && cmid) {
            ['subdir', 'path'].forEach(st => {
              const attempt = buildUrl('/', st);
              if (!seen.has(st + ':/')) {
                seen.add(st + ':/'); queue.push({ style: st, url: attempt, key: st + ':/' });
              }
            });
          }
          for (const sd of subdirCandidates) {
            if (!seen.has(sd)) {
              seen.add(sd);
              queue.push({ style: 'subdir', url: buildUrl(sd, 'subdir'), key: sd });
              queue.push({ style: 'path',  url: buildUrl(sd, 'path'),  key: sd });
            }
          }
        } catch (e) {
          out.errors.push({ url: item.url, error: e.message || String(e) });
        }
      }
      if (out.files.length === 0 && cmid) out.files.push({ href: location.origin + '/mod/folder/download_folder.php?id=' + cmid });
      return out;
    };
  
    // ── BACKGROUND DOWNLOAD RELAY ──────────────────────────────
    async function tryBackgroundDownload(blob, filename, UI) {
      if (!chrome?.runtime?.sendMessage || !chrome?.runtime?.connect) return false;
      const caps = await new Promise((resolve) => {
        try { chrome.runtime.sendMessage({ type: 'canDownloadZip' }, resolve); }
        catch(_) { resolve(null); }
      });
      if (!caps || !caps.downloads) return false;
      UI.log('Sending ZIP to background for download…');
      const id = 'z' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const port = chrome.runtime.connect({ name: 'zipTransfer' });
      const CHUNK = 2 * 1024 * 1024;
      let sent = 0;
      port.postMessage({ type: 'start', id, filename, size: blob.size, mime: 'application/zip' });
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        const slice = blob.slice(offset, Math.min(blob.size, offset + CHUNK));
        const ab = await slice.arrayBuffer();
        port.postMessage({ type: 'chunk', id, offset, chunk: ab });
        sent += ab.byteLength;
        if (sent % (16*CHUNK) === 0) UI.log('  …sent ' + Math.min(sent, blob.size) + ' / ' + blob.size + ' bytes');
      }
      const done = await new Promise((resolve) => {
        const timer = setTimeout(() => { resolve(false); try { port.disconnect(); } catch(_) {} }, 120000);
        port.onMessage.addListener((msg) => {
          if (msg && msg.type === 'done' && msg.id === id) { clearTimeout(timer); resolve(!!msg.ok); }
        });
        port.postMessage({ type: 'end', id });
      });
      if (done) UI.log('Background download started via chrome.downloads.');
      return done;
    }
  
    // ── MAIN ENTRY POINT ───────────────────────────────────────
    //  Phase 1: Discovery (crawl → detect → classify)
    //  Phase 2: Work queue building (sorted: heavy items last)
    //  Phase 3: Download (concurrent, size-checked, cancellable)
    //  Phase 4: ZIP generation & save (background or anchor fallback)
    async function downloadCourseSnapshot() {
        const opts = window.__MOODLE_SNAPSHOTTER_OPTS__ || {};
        const includeImages = opts.includeImages !== false;
        const includeLabels = opts.includeLabels !== false;
        const concurrency = Math.max(1, Math.min(12, Number(opts.concurrency) || 5));
        const crawlDepth = Math.max(0, Number(opts.crawlDepth != null ? opts.crawlDepth : 3));
        verbose = !!opts.verbose;
        const anonymize = !!opts.anonymize;
        maxFileBytes = (Number(opts.maxFileMB) || 0) * 1024 * 1024;
        maxTotalBytes = (Number(opts.maxTotalMB) || 0) * 1024 * 1024;
        totalSkippedBytes = 0;
        abortCtrl = new AbortController();
        const runLimited = limiter(concurrency);

        UI.ensure();
        UI.status('Scanning course (background exploration)…');

        const ctx = extractContextFromBody();
        const course = (document.querySelector(S.courseTitle)?.textContent
          || document.querySelector('#section-0')?.getAttribute('data-sectionname')
          || document.title?.split('|')[0]?.replace(/^(Cours?e?)\s*[:\-–—]\s*/i, '')?.trim()
          || 'Course').trim();
        const courseSlug = slug(course);
        const date = nowStamp();
        const root = (courseSlug.slice(0, 40) + '__' + date).replace(/__+/, '__') + (anonymize ? '-anon' : '');
        usedPaths.clear();
  
        const zip = new JSZip();
        window._snapshot_zip = zip;
  
        const dirFilesRel = '01_Files';
        const dirUrlsRel = '03_URLs';
        const dirNotesRel = '04_Notes_Pages';
        const dirImagesRel = '05_Inline_Images';
        const dirDebugRel = '99_Debug';
  
        const indexRows = [];
        const indexLinks = [];
        const discovery = { pages: [], files: [], folders: [], urls: [], notes: [] };
  
        const stats = { files: 0, bytes: 0, foldersZipped: 0, folderZipFails: 0, foldersCrawled: 0, byType: Object.create(null), externalUrls: 0, inlineImages: 0, startedAt: new Date().toISOString() };

        const escHtml = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const addIndex = (type, name, relPath) => { indexRows.push('<tr><td>' + escHtml(type) + '</td><td>' + escHtml(name) + '</td><td><a href="' + escHtml(relPath) + '">' + escHtml(relPath) + '</a></td></tr>'); };
        const addUrlLink = (label, url) => { indexLinks.push('<li><a href="' + escHtml(url) + '">' + escHtml(label || url) + '</a> <span style="opacity:.6">(' + escHtml(url) + ')</span></li>'); };
  
        try {
          const mainHtml = '<!doctype html><meta charset="utf-8"><title>' + course + '</title>' + document.documentElement.outerHTML;
          const rel = uniquePath(dirNotesRel + '/course_main.html');
          zip.file(root + '/' + rel, mainHtml);
          addIndex('Note/Page', 'Course main', rel);
        } catch(_) {}

        try {
          const seeds = new Set([location.href.split('#')[0]]);
        document.querySelectorAll(S.courseSeedLinks)
          .forEach((a)=>{ const u = toAbs(a.getAttribute('href')); if (u && sameHost(u)) seeds.add(u); });
  
        const visited = new Set();
        const queue = Array.from(seeds).map(u => ({ url: u, depth: 0 }));
        const crawledDocs = [];
        const shouldCrawl = (u, depth) => {
          try { const n = new URL(u, location.origin); return sameHost(n) && pathOk(n.pathname) && !visited.has(n.toString()) && depth <= crawlDepth; }
          catch (_) { return false; }
        };
        while (queue.length) {
          const { url, depth } = queue.shift();
          if (!shouldCrawl(url, depth)) continue;
          visited.add(url);
          try {
            const { data: html } = await fetchResp(url, 'text');
            const doc = new DOMParser().parseFromString(html, 'text/html');
            crawledDocs.push({ url, doc, depth });
          } catch (e) { UI.log('Crawl fetch failed: ' + e.message + ' @ ' + url); }
        }
        UI.log('Crawled ' + crawledDocs.length + ' internal pages.');
  
        const files = new Map();
        const folders = new Map();
        const urlsExternal = new Map();
        const notes = new Map();
        const assignments = new Map();
        const forums = new Map();
        const wikis = new Map();

        const pushFile = (label, url) => { if (!url) return; const u = addForced(url); if (!files.has(u)) files.set(u, label); discovery.files.push({label, url}); };
        const pushFolder = (label, url) => {
          try {
            const u = new URL(url, location.origin);
            if (!/\/mod\/folder\/view\.php/.test(u.pathname)) return;
            const cmid = u.searchParams.get('id');
            if (cmid) { if (!folders.has(cmid)) folders.set(cmid, label || 'Folder'); discovery.folders.push({label, cmid, url}); }
          } catch(_) {}
        };
        const pushUrl = (label, url) => {
          if (!url) return;
          if (!sameHost(url)) { if (!urlsExternal.has(url)) urlsExternal.set(url, label || url); stats.externalUrls++; discovery.urls.push({label, url, external:true}); }
          else { if (!notes.has(url)) notes.set(url, label || url); discovery.notes.push({label, url}); }
        };
        const pushAssign = (label, url) => {
          try {
            const u = new URL(url, location.origin);
            if (!/\/mod\/assign\/view\.php/.test(u.pathname)) return;
            const cmid = u.searchParams.get('id');
            if (cmid && !assignments.has(cmid)) assignments.set(cmid, { label: label || 'Assignment', url });
          } catch(_) {}
        };
        const pushForum = (label, url) => {
          try {
            const u = new URL(url, location.origin);
            if (!/\/mod\/forum\/view\.php/.test(u.pathname)) return;
            const cmid = u.searchParams.get('id');
            if (cmid && !forums.has(cmid)) forums.set(cmid, { label: label || 'Forum', url });
          } catch(_) {}
        };
        const pushWiki = (label, url) => {
          try {
            const u = new URL(url, location.origin);
            if (!/\/mod\/wiki\/view\.php/.test(u.pathname)) return;
            const cmid = u.searchParams.get('id');
            if (cmid && !wikis.has(cmid)) wikis.set(cmid, { label: label || 'Wiki', url });
          } catch(_) {}
        };

        const consumeDoc = (doc, sourceUrl) => {
          discovery.pages.push(sourceUrl || '(inline)');
          const modules = detectModulesInDocument(doc);
          modules.forEach(m => {
            const abs = toAbs(m.href); if (!abs) return;
            if (!sameHost(abs)) { pushUrl(m.name, abs); return; }
            if (m.type === 'file') pushFile(m.name, abs);
            else if (m.type === 'folder') pushFolder(m.name, abs);
            else if (m.type === 'url') pushUrl(m.name, abs);
            else if (m.type === 'page') { if (includeLabels) notes.set(abs, m.name); }
            else if (m.type === 'assign') pushAssign(m.name, abs);
            else if (m.type === 'label' && includeLabels) notes.set(abs, m.name);
            else if (m.type === 'forum') pushForum(m.name, abs);
            else if (m.type === 'data' && includeLabels) notes.set(abs, m.name);
            else if (m.type === 'h5p' || m.type === 'scorm' || m.type === 'imscp') {
              if (includeLabels) notes.set(abs, m.name);
            }
            else if (m.type === 'wiki') pushWiki(m.name, abs);
            else if (m.type === 'choicegroup' || m.type === 'organizer' || m.type === 'ubicast') {
              if (includeLabels) notes.set(abs, m.name);
            }
            else if (m.type === 'subsection' && includeLabels) notes.set(abs, m.name);
          });
          Array.from(doc.querySelectorAll(S.pluginfileLink)).forEach(a => {
            const href = toAbs(a.getAttribute('href')); if (href && sameHost(href)) pushFile((a.textContent||'file').trim(), href);
          });
          Array.from(doc.querySelectorAll(S.folderViewLink)).forEach(a => {
            const href = toAbs(a.getAttribute('href')); if (href && sameHost(href)) pushFolder((a.textContent||'Folder').trim(), href);
          });
        };
        consumeDoc(document, '(current)');
        crawledDocs.forEach(({doc, url}) => consumeDoc(doc, url));
  
        const work = [];
        Array.from(files.entries()).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([url,label]) => {
          const name = (label && label !== 'file' && !/^view\.php$/i.test(label)) ? label : (extractNameFromUrl(url) || 'file');
          work.push({ kind: 'file', name, url });
        });
        Array.from(folders.entries()).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([cmid,label]) => work.push({ kind: 'folder', name: label, url: location.origin + '/mod/folder/view.php?id=' + encodeURIComponent(cmid), cmid }));
        if (includeLabels) {
          Array.from(notes.entries()).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([url,label]) => work.push({ kind: 'html', name: label, url }));
        }
        Array.from(urlsExternal.entries()).sort((a,b)=>a[0].localeCompare(b[0])).forEach(([url,label]) => work.push({ kind: 'url', name: label, url }));
        Array.from(assignments.entries()).forEach(([cmid, info]) => work.push({ kind: 'assign', name: info.label, url: info.url, cmid }));
        Array.from(forums.entries()).forEach(([cmid, info]) => work.push({ kind: 'forum', name: info.label, url: info.url, cmid }));
        Array.from(wikis.entries()).forEach(([cmid, info]) => work.push({ kind: 'wiki', name: info.label, url: info.url, cmid }));
        if (includeImages) {
          Array.from(document.images).forEach((img, idx) => {
            const u = img.src;
            if (!sameHost(u)) return;
            if (/\/theme\//.test(u) || /core_admin/.test(u)) return;
            if (img.closest(S.imageExclude)) return;
            if (img.classList.contains('icon') || img.classList.contains('activityicon') || img.classList.contains('smallicon')) return;
            if (img.width > 0 && img.height > 0 && Math.max(img.width, img.height) < 30) return;
            work.push({ kind: 'inline-image', name: slug((idx+1)+'_'+(img.alt||'image')), url: u });
          });
        }

        work.sort((a, b) => {
          const heavy = { folder: 3, forum: 3, assign: 2, html: 1 };
          return (heavy[a.kind] || 0) - (heavy[b.kind] || 0);
        });

        UI.counts(0, work.length);
  
        const fetchFileAs = async (url) => {
          let sizeEstimate = 0;
          let shortName = (url.split('/').pop() || 'file').split('?')[0];
          try { shortName = decodeURIComponent(shortName); } catch(_) {}
          shortName = fixMojibake(shortName);
          if (maxFileBytes > 0 || maxTotalBytes > 0) {
            try {
              const head = await withTimeout(
                (signal) => fetch(url, { method: 'HEAD', credentials: 'include', signal }),
                8000
              );
              if (head.ok) {
                const cl = head.headers.get('content-length');
                if (cl) sizeEstimate = Number(cl);
                const cdName = extractNameFromCD({ headers: head.headers });
                if (cdName) shortName = fixMojibake(cdName);
              }
            } catch(_) {}
          }
          if (sizeEstimate > 0) {
            const sizeMB = (sizeEstimate/1048576).toFixed(1);
            if (verbose || sizeEstimate > 5 * 1024 * 1024) UI.log('  ⬇ ' + sizeMB + ' MB: ' + shortName);
          }
          if (maxFileBytes > 0 && sizeEstimate > maxFileBytes) {
            UI.log('  ⊘ SKIPPED (too large: ' + (sizeEstimate/1048576).toFixed(1) + ' MB > ' + (maxFileBytes/1048576).toFixed(0) + ' MB limit): ' + shortName);
            totalSkippedBytes += sizeEstimate;
            return null;
          }
          if (maxTotalBytes > 0 && (stats.bytes + sizeEstimate) > maxTotalBytes) {
            UI.log('  ⊘ SKIPPED (would exceed total limit): ' + shortName);
            totalSkippedBytes += sizeEstimate;
            return null;
          }
          if (stats.files >= 10000) { UI.log('  ⊘ SKIPPED (file-count limit reached): ' + shortName); return null; }
          const sizeLabel = sizeEstimate > 0 ? (sizeEstimate/1048576).toFixed(1) + ' MB: ' : '';
          UI.status('Downloading ' + sizeLabel + shortName + '…');
          if (sizeEstimate > 10 * 1024 * 1024) UI.sub('Large download: ' + shortName + ' (' + (sizeEstimate/1048576).toFixed(1) + ' MB)');
          const { res, data: blob } = await fetchResp(url, 'blob');
          if (verbose || blob.size > 10 * 1024 * 1024) {
            const kb = 1024, mb = kb * 1024, gb = mb * 1024;
            const fmt = blob.size >= gb ? (blob.size / gb).toFixed(2) + ' GB' : blob.size >= mb ? (blob.size / mb).toFixed(1) + ' MB' : (blob.size / kb).toFixed(0) + ' KB';
            UI.log('  ✓ ' + fmt + ' — ' + shortName);
          }
          const name = slug(pickFilename(res, url, 'file', blob.type));
          return { name, blob, res };
        };
  
        const handleFile = async (t) => {
          let url = t.url;
          if (S.resourceView.test(url)) url = await resolveResourceDownloadUrl(url);
          url = addForced(url);
          const result = await fetchFileAs(url);
          if (!result) return;
          const { name, blob, res } = result;
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (/text\/html/.test(ct)) {
            let fallbackName = slug(t.name);
            try {
              const txt = await blob.text();
              const titleMatch = txt.match(/<title>([^<]+)<\/title>/i);
              if (titleMatch) {
                const rawTitle = titleMatch[1].split('|')[0].replace(/^Cours?e?\s*[:\-–—]\s*/i, '').trim();
                if (rawTitle && rawTitle.length > 3) fallbackName = slug(rawTitle);
              }
              const dbg = uniquePath(dirDebugRel + '/' + ('html_' + fallbackName).replace(/\W+/g,'_') + '.txt');
              zip.file(root + '/' + dbg, txt.slice(0, 20000));
            } catch(_) {}
            const shortcut = '[InternetShortcut]\nURL=' + (res.url || url) + '\n';
            const rel = uniquePath(dirUrlsRel + '/' + fallbackName + '.url');
            zip.file(root + '/' + rel, shortcut);
            addIndex('URL', fallbackName, rel);
            UI.log('Received HTML for "' + fallbackName + '" — saved link only.');
            return;
          }
          const rel = uniquePath(dirFilesRel + '/' + name);
          zip.file(root + '/' + rel, blob);
          const displayName = (t.name && !/^view\.php$/i.test(t.name) && t.name !== 'file') ? t.name : name;
          addIndex('File', displayName, rel);
          stats.files++; stats.bytes += blob.size;
          const ext = (name.split('.').pop() || '').toLowerCase();
          stats.byType[ext] = (stats.byType[ext] || 0) + 1;
        };
  
        const handleFolder = async (t) => {
          const cmid = t.cmid || (new URL(t.url, location.origin)).searchParams.get('id');
          const folderBase = '02_Folders' + '/' + slug(t.name);
          let extracted = false;
          if (cmid) extracted = await downloadAndExtractFolderZip(cmid, root, folderBase, addIndex, t.name, stats);
          if (!extracted) {
            UI.log('Falling back to subdir crawl for folder: ' + t.name);
            const result = await crawlFolderDeep(t.url);
            stats.foldersCrawled++;
            const seenHrefs = new Set();
            const folderFiles = result.files.filter(f => f.href).length;
            let folderDone = 0;
            for (const f of result.files) {
              if (seenHrefs.has(f.href)) continue;
              seenHrefs.add(f.href);
              try {
                if (UI.isCancelled() || (abortCtrl && abortCtrl.signal.aborted)) throw new Error('Cancelled');
                folderDone++;
                const fname = fixMojibake((f.href.split('/').pop() || 'file').split('?')[0]);
                try { UI.sub('Folder ' + t.name + ' — file ' + folderDone + '/' + folderFiles + ': ' + decodeURIComponent(fname).slice(0, 50)); } catch(_) { UI.sub('Folder ' + t.name + ' — file ' + folderDone + '/' + folderFiles); }
                const result = await fetchFileAs(f.href);
                if (!result) continue;
                const { name, blob } = result;
                const rel = uniquePath(folderBase + '/' + name);
                zip.file(root + '/' + rel, blob);
                addIndex('Folder file', t.name + ' / ' + name, rel);
                stats.files++; stats.bytes += blob.size;
                const ext = (name.split('.').pop() || '').toLowerCase();
                stats.byType[ext] = (stats.byType[ext] || 0) + 1;
              } catch (e) { UI.warn('Folder file failed: ' + (e.message || e)); }
            }
            UI.sub('');
          }
        };
  
        const handleUrl = async (t) => {
          const rel = uniquePath(dirUrlsRel + '/' + slug(t.name) + '.url');
          zip.file(root + '/' + rel, '[InternetShortcut]\nURL=' + t.url + '\n');
          addIndex('URL', t.name, rel);
          addUrlLink(t.name, t.url);
        };
  
        const handleHtml = async (t) => {
          let html = '';
          try { const r = await fetchResp(t.url, 'text'); html = r.data; } catch (e) { UI.log('HTML fetch failed: ' + e.message); }
          const page = '<!doctype html><meta charset="utf-8"><title>' + t.name + '</title><body>' + (html || '') + '</body>';
          const rel = uniquePath(dirNotesRel + '/' + slug(fixMojibake(t.name)) + '.html');
          zip.file(root + '/' + rel, page);
          addIndex('Note/Page', fixMojibake(t.name), rel);
        };
  
        const handleInlineImage = async (t) => {
          if (!sameHost(t.url)) { UI.log('Skipped external inline image: ' + t.url); return; }
          const result = await fetchFileAs(t.url);
          if (!result) return;
          const { name, blob } = result;
          const rel = uniquePath(dirImagesRel + '/' + name);
          zip.file(root + '/' + rel, blob);
          addIndex('Inline image', t.name, rel);
          stats.inlineImages++; stats.bytes += blob.size;
        };

        const handleAssign = async (t) => {
          UI.log('Crawling assignment: ' + t.name);
          try {
            const { data: html } = await fetchResp(t.url, 'text');
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const fileLinks = Array.from(doc.querySelectorAll(S.assignFileLinks));
            if (fileLinks.length === 0) {
              UI.log('No submission files found for assignment: ' + t.name);
              if (includeLabels) {
                const page = '<!doctype html><meta charset="utf-8"><title>' + t.name + '</title><body>' + (html || '') + '</body>';
                const rel = uniquePath(dirNotesRel + '/' + slug(t.name) + '.html');
                zip.file(root + '/' + rel, page);
                addIndex('Note/Page', t.name, rel);
              }
              return;
            }
            const assignDir = '06_Assignments/' + slug(t.name);
            let assignDone = 0;
            for (const a of fileLinks) {
              assignDone++;
              const fname = (a.getAttribute('href') || 'file').split('/').pop()?.split('?')[0] || 'file';
              try { UI.sub('Assignment ' + t.name + ' — ' + assignDone + '/' + fileLinks.length + ': ' + decodeURIComponent(fname).slice(0, 40)); } catch(_) { UI.sub('Assignment ' + t.name + ' — file ' + assignDone + '/' + fileLinks.length); }
              let href = toAbs(a.getAttribute('href')); if (!href || !sameHost(href)) continue;
              href = addForced(href);
              try {
                if (UI.isCancelled() || (abortCtrl && abortCtrl.signal.aborted)) throw new Error('Cancelled');
                const result = await fetchFileAs(href);
                if (!result) continue;
                const { name, blob } = result;
                const rel = uniquePath(assignDir + '/' + name);
                zip.file(root + '/' + rel, blob);
                addIndex('Assignment', t.name + ' / ' + name, rel);
                stats.files++; stats.bytes += blob.size;
                const ext = (name.split('.').pop() || '').toLowerCase();
                stats.byType[ext] = (stats.byType[ext] || 0) + 1;
              } catch (e) { UI.warn('Assignment file failed: ' + (e.message || e)); }
            }
            UI.sub('');
          } catch (e) { UI.warn('Assignment page fetch failed: ' + (e.message || e)); }
        };

        const handleForum = async (t) => {
          const fStart = performance.now();
          UI.log('Forum: ' + t.name + ' — fetching discussion list…');
          try {
            const html = await withTimeout(
              (signal) => fetch(t.url, { credentials: 'include', redirect: 'follow', signal }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }),
              20000
            );
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const discussionLinks = Array.from(doc.querySelectorAll(S.forumDiscLinks));
            const seenDiscussions = new Set();
            const validLinks = [];
            discussionLinks.forEach(a => {
              const href = toAbs(a.getAttribute('href'));
              if (!href || !sameHost(href)) return;
              const m = href.match(/d=(\d+)/);
              if (m && !seenDiscussions.has(m[1])) {
                seenDiscussions.add(m[1]);
                validLinks.push({ url: href, did: m[1], label: (a.textContent || '').trim().slice(0, 80) || ('Discussion ' + m[1]) });
              }
            });
            UI.log('Found ' + validLinks.length + ' discussion(s) in forum: ' + t.name);
            if (verbose) validLinks.forEach((d, i) => UI.log('  [' + (i + 1) + '] ' + d.label + ' (d=' + d.did + ')'));
            const forumDir = '07_Forums/' + slug(t.name);
            const maxDiscussions = Math.min(validLinks.length, 5);
            if (includeLabels && validLinks.length === 0) {
              const page = '<!doctype html><meta charset="utf-8"><title>' + t.name + '</title><body>' + (html || '') + '</body>';
              const rel = uniquePath(dirNotesRel + '/' + slug(t.name) + '.html');
              zip.file(root + '/' + rel, page);
              addIndex('Note/Page', t.name, rel);
            }
            for (let di = 0; di < maxDiscussions; di++) {
              const d = validLinks[di];
              const discStart = performance.now();
              UI.log('Forum discussion ' + (di + 1) + '/' + maxDiscussions + ': ' + d.label);
              UI.sub('Forum ' + t.name + ' — discussion ' + (di + 1) + ' / ' + maxDiscussions);
              try {
                const discHtml = await withTimeout(
                  (signal) => fetch(d.url, { credentials: 'include', redirect: 'follow', signal }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }),
                  15000
                );
                const discDoc = new DOMParser().parseFromString(discHtml, 'text/html');
                const discName = (discDoc.querySelector(S.discussionName)?.textContent?.trim() || d.label);
                if (verbose) UI.log('  Fetched: ' + discName + ' (' + discHtml.length + ' bytes)');
                const discNameFixed = fixMojibake(discName);
                const discSlug = slug(discNameFixed);
                const postContainers = discDoc.querySelectorAll(S.postContainer);
                const attachSeen = new Set();
                const dlPromises = [];
                postContainers.forEach(post => {
                  const attachLinks = post.querySelectorAll('a[href*="/pluginfile.php/"]');
                  attachLinks.forEach(al => {
                    const href = toAbs(al.getAttribute('href'));
                    if (!href || !sameHost(href)) return;
                    const fullHref = addForced(href);
                    if (attachSeen.has(fullHref)) return;
                    attachSeen.add(fullHref);
                    dlPromises.push((async () => {
                      try {
                        if (UI.isCancelled() || (abortCtrl && abortCtrl.signal.aborted)) return;
                        const result = await fetchFileAs(fullHref);
                        if (!result) return;
                        const { name, blob } = result;
                        const rel = uniquePath(forumDir + '/' + discSlug + '/' + name);
                        zip.file(root + '/' + rel, blob);
                        addIndex('Forum file', discNameFixed + ' / ' + name, rel);
                        stats.files++; stats.bytes += blob.size;
                        const ext = (name.split('.').pop() || '').toLowerCase();
                        stats.byType[ext] = (stats.byType[ext] || 0) + 1;
                      } catch (e) { UI.warn('Forum file failed: ' + (e.message || e)); }
                    })());
                  });
                });
                if (dlPromises.length) {
                  UI.log('  ' + dlPromises.length + ' attachment(s) in discussion');
                  UI.sub('Forum ' + t.name + ' — disc ' + (di + 1) + '/' + maxDiscussions + ' — ' + dlPromises.length + ' attachments…');
                  await Promise.all(dlPromises);
                  UI.sub('');
                }
                const discTime = ((performance.now() - discStart) / 1000).toFixed(1);
                UI.log('  Discussion done in ' + discTime + 's');
                if (includeLabels) {
                  const page = '<!doctype html><meta charset="utf-8"><title>' + discNameFixed + '</title><body>' + (discHtml || '') + '</body>';
                  const rel = uniquePath(dirNotesRel + '/' + discSlug + '.html');
                  zip.file(root + '/' + rel, page);
                  addIndex('Note/Page', discNameFixed, rel);
                }
              } catch (e) { UI.warn('Forum discussion failed after ' + ((performance.now() - discStart) / 1000).toFixed(1) + 's: ' + d.label + ' - ' + (e.message || e)); }
            }
            UI.log('Forum: ' + t.name + ' done in ' + ((performance.now() - fStart) / 1000).toFixed(1) + 's');
            UI.sub('');
          } catch (e) { UI.warn('Forum page fetch failed: ' + (e.message || e)); }
        };

        const handleWiki = async (t) => {
          UI.log('Crawling wiki: ' + t.name);
          try {
            const { data: html } = await fetchResp(t.url, 'text');
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const pageLinks = doc.querySelectorAll(S.wikiPageLinks);
            const seenPages = new Set();
            const wikiDir = '08_Wikis/' + slug(t.name);
            for (const a of pageLinks) {
              const href = toAbs(a.getAttribute('href'));
              if (!href || !sameHost(href) || seenPages.has(href)) continue;
              seenPages.add(href);
              try {
                const { data: pageHtml } = await fetchResp(href, 'text');
                const pageDoc = new DOMParser().parseFromString(pageHtml, 'text/html');
                const attachLinks = pageDoc.querySelectorAll(S.wikiAttachLinks);
                const pageName = slug((pageDoc.querySelector('.page-title, h2')?.textContent || a.textContent || 'page').trim());
                for (const al of attachLinks) {
                  const dlHref = addForced(toAbs(al.getAttribute('href')));
                  if (!dlHref || !sameHost(dlHref)) continue;
                  try {
                    const result = await fetchFileAs(dlHref);
                    if (!result) continue;
                    const rel = uniquePath(wikiDir + '/' + pageName + '/' + result.name);
                    zip.file(root + '/' + rel, result.blob);
                    addIndex('Wiki file', t.name + ' / ' + pageName + ' / ' + result.name, rel);
                    stats.files++; stats.bytes += result.blob.size;
                    const ext = (result.name.split('.').pop() || '').toLowerCase();
                    stats.byType[ext] = (stats.byType[ext] || 0) + 1;
                  } catch (e) { UI.warn('Wiki file failed: ' + (e.message || e)); }
                }
                if (includeLabels) {
                  const page = '<!doctype html><meta charset="utf-8"><title>' + pageName + '</title><body>' + (pageHtml || '') + '</body>';
                  const rel = uniquePath(dirNotesRel + '/' + pageName + '.html');
                  zip.file(root + '/' + rel, page);
                  addIndex('Note/Page', pageName, rel);
                }
              } catch (e) { UI.warn('Wiki page fetch failed: ' + (e.message || e)); }
            }
            UI.log('Wiki: ' + t.name + ' — ' + seenPages.size + ' pages crawled');
          } catch (e) { UI.warn('Wiki page fetch failed: ' + (e.message || e)); }
        };

        // Handler registry: kind → handler function
        const handlerMap = { file: handleFile, folder: handleFolder, url: handleUrl, html: handleHtml, 'inline-image': handleInlineImage, assign: handleAssign, forum: handleForum, wiki: handleWiki };
  
        let done = 0;
        if (verbose) UI.log('[verbose] ' + work.length + ' tasks queued: ' + [...new Set(work.map(t => t.kind))].join(', '));
        await Promise.all(work.map(task => runLimited(async () => {
          await UI.waitIfPaused();
          if (UI.isCancelled() || (abortCtrl && abortCtrl.signal.aborted)) throw new Error('Cancelled');
          const handler = handlerMap[task.kind];
          if (!handler) return;
          const t0 = performance.now();
          try {
            if (verbose) UI.log('  ▶ ' + task.kind + ': ' + task.name);
            UI.status(task.kind + ': ' + task.name);
            await handler(task);
            done++; UI.counts(done, work.length);
            const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
            if (task.kind !== 'forum' || verbose) UI.log('  ✓ ' + task.kind + ' – ' + task.name + ' (' + elapsed + 's)');
          }
          catch (e) {
            const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
            UI.log('❌ ' + task.kind + ' – ' + task.name + ': ' + e.message + ' (' + elapsed + 's)');
          }
        })));
  
        // ── WRITE INDEX, LOGS, AND METADATA INTO ZIP ───────────
        const prettyBytes = (n) => {
          const kb = 1024, mb = kb*1024, gb = mb*1024;
          if (n >= gb) return (n/gb).toFixed(2) + ' GB';
          if (n >= mb) return (n/mb).toFixed(2) + ' MB';
          if (n >= kb) return (n/kb).toFixed(2) + ' KB';
          return n + ' B';
        };
        const indexHtml = [
          '<!doctype html><meta charset="utf-8"><title>Snapshot Index</title>',
          '<style>body{font:14px system-ui,Arial,sans-serif;background:#0b1220;color:#e2e8f0;padding:20px}',
          '.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}.card{background:#0f172a;border:1px solid #1f2a44;border-radius:10px;padding:10px 12px;min-width:140px}',
          '.card .val{font-size:20px;font-weight:700;color:#93c5fd} .card .lbl{opacity:.7;font-size:12px}',
          'table{width:100%;border-collapse:collapse;margin-top:10px}th,td{padding:6px 8px;border-bottom:1px solid #1f2a44;text-align:left}',
          'th{position:sticky;top:0;background:#0b1220;z-index:1}',
          'a{color:#93c5fd}input[type=search]{padding:6px 8px;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#e2e8f0;width:100%;max-width:400px;margin-bottom:12px}</style>',
          '<h1>', course, '</h1>',
          '<p style="opacity:.7">Snapshot &mdash; ', date, '</p>',
          '<div class="cards">',
            '<div class="card"><div class="lbl">Total files</div><div class="val">', String(stats.files), '</div></div>',
            '<div class="card"><div class="lbl">Total size</div><div class="val">', prettyBytes(stats.bytes), '</div></div>',
            '<div class="card"><div class="lbl">Folder ZIPs</div><div class="val">', String(stats.foldersZipped), '</div></div>',
            '<div class="card"><div class="lbl">ZIP fails</div><div class="val">', String(stats.folderZipFails), '</div></div>',
            '<div class="card"><div class="lbl">Crawled</div><div class="val">', String(stats.foldersCrawled), '</div></div>',
            '<div class="card"><div class="lbl">External links</div><div class="val">', String(stats.externalUrls), '</div></div>',
            '<div class="card"><div class="lbl">Inline images</div><div class="val">', String(stats.inlineImages), '</div></div>',
          '</div>',
          '<input id="q" type="search" placeholder="Filter items…" oninput="(function(){var q=document.getElementById(\'q\').value.toLowerCase();document.querySelectorAll(\'#tbl tbody tr\').forEach(r=>{r.style.display=r.textContent.toLowerCase().includes(q)?\'\':\'none\'});})()">',
          '<table id="tbl"><thead><tr><th>Type</th><th>Name</th><th>Path</th></tr></thead><tbody>',
            indexRows.join('') || '<tr><td colspan="3" style="opacity:.7">No items collected.</td></tr>',
          '</tbody></table>',
          '<p style="margin-top:20px">See also: <a href="./03_URLs/urls.html">External links</a></p>'
        ].join('');
        const urlsHtml = [
          '<!doctype html><meta charset="utf-8"><title>External URLs</title>',
          '<style>body{font:14px system-ui,Arial,sans-serif;background:#0b1220;color:#e2e8f0;padding:20px} a{color:#93c5fd}</style>',
          '<h1>External URLs</h1><ul>',
          indexLinks.join('') || '<li class="muted">No external URLs.</li>',
          '</ul>'
        ].join('');
        const logTxt = debugLines.join('\n');
        const discJson = JSON.stringify({ ...stats, discovered: discovery, warnings }, null, 2);
        zip.file(root + '/' + '00_index.html', indexHtml);
        zip.file(root + '/' + dirUrlsRel + '/urls.html', urlsHtml);
        zip.file(root + '/' + dirDebugRel + '/log.txt', logTxt);
        zip.file(root + '/' + dirDebugRel + '/discovery.json', discJson);

        if (anonymize) { await window.sanitizeZip(zip, root, UI); UI.log('Anonymized output — names replaced, assignments removed.'); }

        // ── FINALIZE ZIP & TRIGGER DOWNLOAD ────────────────────
        if (totalSkippedBytes > 0) UI.log('Skipped ' + (totalSkippedBytes/1048576).toFixed(1) + ' MB of oversized files (' + (maxFileBytes/1048576).toFixed(0) + ' MB limit).');
        UI.status('Packaging ZIP…');
        const t0 = performance.now();
        const zipSize = stats.bytes;
        const useStore = zipSize > 80 * 1024 * 1024;
        if (useStore) UI.log('Large archive detected — using STORE (no compression) to avoid memory errors.');
        const blob = await zip.generateAsync({ type: 'blob', compression: useStore ? 'STORE' : 'DEFLATE', compressionOptions: { level: 6 } });
        const t1 = performance.now();
        UI.log('ZIP built in ' + ((t1 - t0)/1000).toFixed(1) + 's — ~' + (blob.size/1048576).toFixed(2) + ' MB.');

        let saved = false;
        try {
          const bgOk = await tryBackgroundDownload(blob, (root + '.zip'), UI);
          if (bgOk) { UI.status('Done'); saved = true; }
        } catch (_) {}

        if (!saved) {
          UI.status('Ready to save');
          UI.showSave(() => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = (root + '.zip'); a.style.display = 'none';
            document.body.appendChild(a); a.click();
            setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch(_) {} }, 30000);
            UI.log('Triggered browser download.');
            UI.status('Done');
          });
        }
      } catch (e) {
        const safeMsg = (e.message || '').replace(/https?:\/\/[^\s]+/g, '[URL]').replace(/sesskey=[A-Za-z0-9]+/gi, 'sesskey=[redacted]');
        if (e.message === 'Cancelled') {
          UI.status('Building partial ZIP…');
          UI.log('Stopped — saving ' + stats.files + ' files (' + (stats.bytes/1048576).toFixed(1) + ' MB) collected so far.');
          try {
            const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
            const partialSize = (blob.size/1048576).toFixed(2);
            UI.log('Partial ZIP: ~' + partialSize + ' MB. Click "Save ZIP" to download.');
            UI.status('Partial snapshot ready');
            UI.showSave(() => {
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = (root + '.zip'); a.style.display = 'none';
              document.body.appendChild(a); a.click();
              setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch(_) {} }, 30000);
            });
          } catch (_) {
            try { chrome.runtime?.sendMessage?.({ type: 'notify', title: 'Snapshot failed', message: safeMsg }); } catch (_) {}
          }
        } else {
          try { chrome.runtime?.sendMessage?.({ type: 'notify', title: 'Snapshot failed', message: safeMsg }); } catch (_) {}
          throw e;
        }
      }
    }
  
    // Public trigger
    window.downloadCourseSnapshot = downloadCourseSnapshot;
  })();