chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) {
    chrome.tabs.create({
      url: chrome.runtime.getURL(`popup.html?targetTabId=${tab.id}`)
    });
  }
});
