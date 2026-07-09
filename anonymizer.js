// anonymizer.js — Moodle Snapshotter v2.18.3 — Privacy post-processor
// Loaded by manifest before content.js. Exposes window.sanitizeZip(zip, root, UI).
// Called by content.js after all downloads complete, before ZIP packaging.
// Scans HTML files for names, profile pics, session tokens, DB tables,
// submission content, GitHub links, emails, and more — replacing with
// anonymized placeholders. Language-independent (uses CSS classes, not text).

window.sanitizeZip = async function(zip, root, UI) {
  UI.status('Anonymizing…');
  const htmlFiles = [];
  const nameMap = new Map();
  let doeIdx = 0;

  const hueFor = (name) => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  };

  const allPaths = Object.keys(zip.files).filter(p => p.startsWith(root + '/') && !zip.files[p].dir);

  // Phase 1: Remove assignments, identify HTML files
  for (const fullPath of allPaths) {
    const relPath = fullPath.slice((root + '/').length);
    if (relPath.startsWith('06_Assignments/')) {
      zip.remove(fullPath);
      continue;
    }
    if (/\.html?$/i.test(relPath)) htmlFiles.push(fullPath);
  }

  // Phase 2: Collect all real names from profile links and forum posts
  for (const fullPath of htmlFiles) {
    let html = await zip.file(fullPath)?.async('string');
    if (!html) continue;

    // Names from profile links
    const userLinks = html.match(/<a[^>]*href="[^"]*\/user\/(?:view|profile)\.php\?id=\d+"[^>]*>([^<]+)<\/a>/gi) || [];
    for (const link of userLinks) {
      const nameMatch = link.match(/>([^<]+)<\/a>/);
      if (nameMatch) {
        const name = nameMatch[1].trim();
        if (name && name.length > 1 && !nameMap.has(name) && !/^(John|Jane)\s+Doe/i.test(name)) {
          doeIdx++;
          nameMap.set(name, 'John Doe ' + doeIdx);
        }
      }
    }

    // Names from forum author patterns (par/by Name, with or without <a> wrapper)
    const fNames = html.match(/(?:^|\s)(?:par|by)\s+(?:<a[^>]*>)?\s*([A-ZÉÈÊËÀÂÇÎÏÔÖÙÛÜ][a-zéèêëàâçîïôöùûü]+(?:\s+[A-ZÉÈÊËÀÂÇÎÏÔÖÙÛÜ][a-zéèêëàâçîïôöùûü]+){1,4})/gm) || [];
    for (const m of fNames) {
      const name = m.replace(/^\s*(?:par|by)\s+(?:<a[^>]*>)?\s*/i, '').replace(/<\/a>.*$/i, '').trim();
      if (name && name.length > 3 && !nameMap.has(name) && !/^(John|Jane)\s+Doe/i.test(name)) {
        doeIdx++;
        nameMap.set(name, 'John Doe ' + doeIdx);
      }
    }
  }

  // Phase 3: Apply all replacements to every HTML file
  for (const fullPath of htmlFiles) {
    let html = await zip.file(fullPath)?.async('string');
    if (!html) continue;

    // Replace collected names
    for (const [realName, fakeName] of nameMap) {
      const escaped = realName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      html = html.replace(new RegExp(escaped, 'g'), fakeName);
    }

    // Structural HTML replacements (Moodle-specific, language-independent)
    html = html.replace(/(par|by|réponse\s+à|reply\s+to)\s+John\s+Doe\s+\d+/gi, '$1 a student');
    html = html.replace(/_paq\.push\(\['setUserId',\s*'[^']*'\]\)/gi, '_paq.push([\'setUserId\', \'anonymous\'])');
    html = html.replace(/[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}(?!\/)/g, 'anonymous@example.com');

    html = html.replace(/<div[^>]*class="[^"]*submissionstatustable[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '<div class="submissionstatustable"><p><em>[submission details removed]</em></p></div>');
    html = html.replace(/<div[^>]*class="[^"]*full_assignsubmission_onlinetext[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '<div class="submissiontext"><p><em>[submission text removed for privacy]</em></p></div>');
    html = html.replace(/<div[^>]*class="[^"]*fileuploadsubmission[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '<div class="fileuploadsubmission"><p><em>[file uploads removed]</em></p></div>');
    html = html.replace(/<div[^>]*class="[^"]*submissionlinks[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '<div class="submissionlinks"><p><em>[submission files removed]</em></p></div>');
    html = html.replace(/<div[^>]*class="[^"]*plugincontentsummary[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '<div class="plugincontentsummary"><p><em>[content removed]</em></p></div>');
    html = html.replace(/https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_-]+(\/[^\s<>"']*)?/gi, '[GitHub link removed]');
    html = html.replace(/<textarea[^>]*>[\s\S]*?<\/textarea>/gi, '<textarea readonly style="width:100%;height:60px">[content removed for privacy]</textarea>');

    // Scrub identifiers in JS config and HTML attributes
    html = html.replace(/"sesskey"\s*:\s*"[^"]*"/gi, '"sesskey":"[removed]"');
    html = html.replace(/"userId"\s*:\s*\d+/gi, '"userId":0');
    html = html.replace(/(?:https?:)?\/\/[^"'\s]*\/user\/(?:view|profile)\.php\?id=\d+[^"'\s]*/gi, '#');
    html = html.replace(/<table[^>]*\bgeneraltable\b[^>]*>[\s\S]*?<\/table>/gi, '<table><tr><td><em>[database content removed for privacy]</em></td></tr></table>');
    html = html.replace(/([?&;]|&amp;)sesskey=[A-Za-z0-9]+/gi, '$1sesskey=[removed]');
    html = html.replace(/<input[^>]*name\s*=\s*"sesskey"[^>]*>/gi, '<input type="hidden" name="sesskey" value="[removed]" />');
    html = html.replace(/(data-user-?id\s*=\s*")\d+(")/gi, '$10$2');
    html = html.replace(/(data-route-param\s*=\s*")\d+(")/gi, '$10$2');
    html = html.replace(/"contextInstanceId"\s*:\s*\d+/gi, '"contextInstanceId":0');

    // Strip database activity pages
    if (/page-mod-data-view|database/i.test(html)) {
      html = html.replace(/(<body[^>]*>)[\s\S]*(<\/body>)/i, '$1<style>body,#page-wrapper,#page,.drawer,#page.drawers{min-height:auto!important;height:auto!important;display:block!important;position:static!important;overflow:visible!important;margin:0!important;padding:0!important}</style><div style="max-width:600px;margin:40px auto;padding:30px;font:14px system-ui,sans-serif;background:#0f172a;color:#e2e8f0;border-radius:12px;text-align:center"><h3 style="margin-top:0">Database content removed for privacy</h3><p>This page contained user-submitted data.</p></div>$2');
    }

    // Strip choicegroup member names (preserves group structure)
    if (/page-mod-choicegroup-view|choicegroup/i.test(html)) {
      html = html.replace(/<div[^>]*class="[^"]*membersnames[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '<div class="membersnames"><em>[student names removed for privacy]</em></div>');
    }

    // Scrub remaining identifiers in text content
    html = html.replace(/@[a-zA-Z0-9_-]{2,30}/g, '@anonymous');
    html = html.replace(/([?&;])useridlistid=[a-f0-9]+/gi, '$1useridlistid=[removed]');
    html = html.replace(/https?:\/\/github\.\.\.\./gi, '[GitHub link removed]');
    html = html.replace(/<select[^>]*>[\s\S]*?<\/select>/gi, '<select disabled><option>[options removed for privacy]</option></select>');

    // Split known names into components for partial body-text matches
    const extraNames = new Map();
    for (const [realName] of nameMap) {
      for (const p of realName.split(/\s+/)) {
        if (p.length > 3 && !/^(John|Jane|Doe|a|student)$/i.test(p) && !nameMap.has(p)) {
          extraNames.set(p, 'Student');
        }
      }
    }
    for (const [word, replacement] of extraNames) {
      html = html.replace(new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), replacement);
    }

    // Replace profile pictures with colored circles
    html = html.replace(/<img[^>]*src="[^"]*\/pluginfile\.php\/\d+\/user\/icon\/[^"]*"[^>]*>/gi, (m) => {
      const userMatch = m.match(/pluginfile\.php\/(\d+)\/user\/icon/);
      const h = userMatch ? hueFor(userMatch[1]) : 200;
      return '<span style="display:inline-block;width:35px;height:35px;background:hsl(' + h + ',60%,55%);border-radius:50%;vertical-align:middle"></span>';
    });
    html = html.replace(/<img[^>]*class="[^"]*userpicture[^"]*"[^>]*>/gi, '<span style="display:inline-block;width:35px;height:35px;background:hsl(210,50%,50%);border-radius:50%;vertical-align:middle"></span>');

    zip.file(fullPath, html);
  }
  UI.sub('');
};
