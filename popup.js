// popup.js — Extension popup panel controller
//
// Loads/saves user preferences from chrome.storage.sync and injects
// the snapshot payload into the active tab's content script.
//
// Options persisted: includeImages, includeLabels, concurrency,
// crawlDepth, maxFileMB, maxTotalMB, verbose

const els = {
  images: document.getElementById('opt-images'),
  labels: document.getElementById('opt-labels'),
  concurrency: document.getElementById('opt-concurrency'),
  crawlDepth: document.getElementById('opt-crawl-depth'),
  maxFile: document.getElementById('opt-max-file'),
  maxTotal: document.getElementById('opt-max-total'),
  verbose: document.getElementById('opt-verbose'),
  anonymize: document.getElementById('opt-anonymize'),
  btn: document.getElementById('download')
};

// Restore saved options from storage
chrome.storage.sync.get({
  includeImages: true, includeLabels: true, concurrency: 5, crawlDepth: 3,
  maxFileMB: 250, maxTotalMB: 2000, verbose: false, anonymize: false
}, (opts) => {
  els.images.checked = !!opts.includeImages;
  els.labels.checked = !!opts.includeLabels;
  els.concurrency.value = Number(opts.concurrency || 5);
  els.crawlDepth.value = Number(opts.crawlDepth != null ? opts.crawlDepth : 3);
  els.maxFile.value = Number(opts.maxFileMB != null ? opts.maxFileMB : 250);
  els.maxTotal.value = Number(opts.maxTotalMB != null ? opts.maxTotalMB : 2000);
  els.verbose.checked = !!opts.verbose;
  els.anonymize.checked = !!opts.anonymize;
});

// Handle "Create course snapshot" click
els.btn.addEventListener('click', async () => {
  const payload = {
    includeImages: els.images.checked,
    includeLabels: els.labels.checked,
    concurrency: Math.max(1, Math.min(12, Number(els.concurrency.value) || 5)),
    crawlDepth: Math.max(0, Math.min(5, Number(els.crawlDepth.value) ?? 3)),
    maxFileMB: Math.max(0, Number(els.maxFile.value) ?? 250),
    maxTotalMB: Math.max(0, Number(els.maxTotal.value) ?? 2000),
    verbose: els.verbose.checked,
    anonymize: els.anonymize.checked
  };

  // Persist options for next time
  chrome.storage.sync.set(payload);

  // Inject options into the active tab and trigger the snapshot
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (payload) => {
    window.__MOODLE_SNAPSHOTTER_OPTS__ = payload;
    if (window.downloadCourseSnapshot) {
      window.downloadCourseSnapshot();
    } else {
      console.error('Content script not loaded.');
      alert('Content script not loaded on this page. Try reloading the tab.');
    }
  }, args: [payload] });
});
