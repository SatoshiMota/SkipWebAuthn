chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    if (!tab.url || !tab.url.startsWith('http')) return;
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['inject.js'],
      world: 'MAIN'
    });
  }
});