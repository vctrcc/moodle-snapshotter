// background.js — Service worker for ZIP download relay
//
// The content script builds a ZIP blob in memory. Instead of saving it
// via a temporary <a> click (which has size limits and UX issues), the
// content script can stream the blob in 2 MB chunks to this service
// worker, which reassembles and triggers chrome.downloads.
//
// Protocol:
//   Content script opens a port named 'zipTransfer'
//   → { type: 'start', id, filename, size, mime }   // init session
//   → { type: 'chunk', id, offset, chunk: ArrayBuffer }  // repeated
//   → { type: 'end',   id }                         // finalize & download
//   ← { type: 'done',  id, ok, downloadId }          // confirmation

const ZIP_SESSIONS = new Map();

// Feature detection: does this browser support chrome.downloads?
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'canDownloadZip') {
    const has = !!(chrome.downloads && chrome.downloads.download);
    sendResponse({ downloads: has });
    return true;  // async response
  }
});

// Long-lived port for chunked ZIP transfer
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'zipTransfer') return;
  port.onMessage.addListener(async (msg) => {
    try {
      if (!msg || !msg.type) return;
      if (msg.type === 'start') {
        // Create a new transfer session
        ZIP_SESSIONS.set(msg.id, {
          chunks: [],
          filename: msg.filename || ('snapshot_' + Date.now() + '.zip'),
          mime: msg.mime || 'application/zip'
        });
      } else if (msg.type === 'chunk') {
        // Accumulate chunk bytes
        const sess = ZIP_SESSIONS.get(msg.id);
        if (!sess) return;
        sess.chunks.push(new Uint8Array(msg.chunk));
      } else if (msg.type === 'end') {
        // Reassemble and trigger download
        const sess = ZIP_SESSIONS.get(msg.id);
        if (!sess) return;
        const blob = new Blob(sess.chunks, { type: sess.mime });
        const url = URL.createObjectURL(blob);
        chrome.downloads.download({ url, filename: sess.filename, saveAs: false }, (downloadId) => {
          const ok = !chrome.runtime.lastError && !!downloadId;
          port.postMessage({ type: 'done', id: msg.id, ok, downloadId, error: chrome.runtime.lastError?.message || null });
          // Revoke blob URL after 60s (enough time for download to start)
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch(_) {} }, 60000);
          ZIP_SESSIONS.delete(msg.id);
        });
      }
    } catch (e) {
      try { port.postMessage({ type: 'done', id: msg.id, ok: false, error: String(e) }); } catch(_) {}
    }
  });
});
