document.addEventListener("DOMContentLoaded", async () => {
  const statusTextEl = document.getElementById("status-text");
  const statusDotEl = document.getElementById("status-dot");
  const startBtn = document.getElementById("start-btn");
  const stopBtn = document.getElementById("stop-btn");
  const downloadBtn = document.getElementById("download-btn");
  const previewList = document.getElementById("preview-list");
  const consoleEl = document.getElementById("console");
  const turnsCounterEl = document.getElementById("turns-counter");

  let extractedTurns = [];
  
  // Get current active tab
  let targetTabId = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error("No active tab found");
    }
    targetTabId = tab.id;
    const host = new URL(tab.url).hostname;
    
    // Check if site is supported
    const supported = ["claude.ai", "gemini.google.com", "aistudio.google.com", "perplexity.ai"].some(h => host.includes(h));
    if (!supported) {
      log("error", "Error: Open Claude, Gemini, AI Studio, or Perplexity first.");
      updateStatus("Unsupported Site", "");
      startBtn.disabled = true;
      return;
    }

    log("info", `Connected to active tab (${host})`);
    updateStatus("Connected", "active");
  } catch (err) {
    log("error", "Error: Cannot access active tab.");
    updateStatus("Disconnected", "");
    startBtn.disabled = true;
    return;
  }

  // Log function helper
  function log(level, text) {
    const timeStr = new Date().toTimeString().split(' ')[0];
    
    const line = document.createElement("div");
    line.className = "console-line";
    
    const timeSpan = document.createElement("span");
    timeSpan.className = "console-time";
    timeSpan.textContent = `[${timeStr}]`;
    
    const textSpan = document.createElement("span");
    textSpan.className = `console-text ${level}`;
    textSpan.textContent = text;
    
    line.appendChild(timeSpan);
    line.appendChild(textSpan);
    consoleEl.appendChild(line);
    
    // Auto scroll to bottom
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  function updateStatus(text, state) {
    statusTextEl.textContent = text;
    statusDotEl.className = "status-dot";
    if (state === "active") {
      statusDotEl.classList.add("active");
    } else if (state === "running") {
      statusDotEl.classList.add("running");
    }
  }

  function renderTurn(turn, idx) {
    const item = document.createElement("div");
    item.className = "turn-item";
    
    const header = document.createElement("div");
    header.className = "turn-header";

    const idxSpan = document.createElement("span");
    idxSpan.className = "turn-index";
    idxSpan.textContent = `#${idx + 1}`;

    const tagBadge = document.createElement("span");
    tagBadge.className = `tag-badge tag-${turn.role}`;
    tagBadge.textContent = `<${turn.role}>`;
    
    header.appendChild(idxSpan);
    header.appendChild(tagBadge);
    
    const preview = document.createElement("div");
    preview.className = "turn-preview-text";
    preview.textContent = turn.text;

    item.appendChild(header);
    item.appendChild(preview);
    previewList.appendChild(item);
    previewList.scrollTop = previewList.scrollHeight;
  }

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.tab && sender.tab.id !== targetTabId) {
      return; // Ignore messages from other tabs
    }

    switch (message.action) {
      case "log":
        log(message.level || "info", message.text);
        break;
      case "turn":
        extractedTurns.push(message.turn);
        renderTurn(message.turn, extractedTurns.length - 1);
        turnsCounterEl.textContent = `${extractedTurns.length} turns`;
        break;
      case "finished":
        log("success", `Scraping completed! Successfully extracted ${message.turns.length} turns.`);
        extractedTurns = message.turns;
        updateStatus("Completed", "active");
        startBtn.disabled = false;
        stopBtn.disabled = true;
        downloadBtn.disabled = extractedTurns.length === 0;
        break;
      case "stopped":
        log("warn", `Scraping stopped by user. Extracted ${message.turns.length} turns so far.`);
        extractedTurns = message.turns;
        updateStatus("Stopped", "active");
        startBtn.disabled = false;
        stopBtn.disabled = true;
        downloadBtn.disabled = extractedTurns.length === 0;
        break;
      case "error":
        log("error", `Scraper error: ${message.message}`);
        updateStatus("Error", "active");
        startBtn.disabled = false;
        stopBtn.disabled = true;
        break;
    }
  });

  // Action Button Listeners
  startBtn.addEventListener("click", () => {
    extractedTurns = [];
    previewList.innerHTML = "";
    turnsCounterEl.textContent = "0 turns";
    
    startBtn.disabled = true;
    stopBtn.disabled = false;
    downloadBtn.disabled = true;
    
    log("info", "Starting extraction process...");
    updateStatus("Running", "running");

    chrome.tabs.sendMessage(targetTabId, { action: "start-scrape" }, (response) => {
      if (chrome.runtime.lastError) {
        log("error", `Could not start: ${chrome.runtime.lastError.message}. Try reloading the chat page.`);
        startBtn.disabled = false;
        stopBtn.disabled = true;
        updateStatus("Connected", "active");
      }
    });
  });

  stopBtn.addEventListener("click", () => {
    log("info", "Requesting stop...");
    stopBtn.disabled = true;
    chrome.tabs.sendMessage(targetTabId, { action: "stop-scrape" });
  });

  downloadBtn.addEventListener("click", () => {
    if (extractedTurns.length === 0) return;

    const safeCdata = (text) => String(text).replaceAll("]]>", "]]]]><![CDATA[>");

    let xmlContent = '<?xml version="1.0" encoding="utf-8"?>\n<conversation>\n';
    extractedTurns.forEach((turn) => {
      xmlContent += `  <${turn.role}><![CDATA[${safeCdata(turn.text)}]]></${turn.role}>\n`;
    });
    xmlContent += "</conversation>\n";

    const blob = new Blob([xmlContent], { type: "application/xml" });
    const url = URL.createObjectURL(blob);

    const date = new Date().toISOString().slice(0, 10);
    const filename = `chat_export_${date}.xml`;

    if (chrome.downloads && chrome.downloads.download) {
      chrome.downloads.download(
        {
          url,
          filename,
          saveAs: false,
          conflictAction: "uniquify"
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            log("error", `Download failed: ${chrome.runtime.lastError.message}`);
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
            return;
          }
          log("success", `Download started: ${filename}`);
          setTimeout(() => URL.revokeObjectURL(url), 30_000);
        }
      );
      return;
    }

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    log("success", `Download started: ${filename}`);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
});
