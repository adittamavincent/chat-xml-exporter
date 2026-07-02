document.addEventListener("DOMContentLoaded", async () => {
  const statusTextEl = document.getElementById("status-text");
  const statusDotEl = document.getElementById("status-dot");
  const detectBtn = document.getElementById("detect-btn");
  const startBtn = document.getElementById("start-btn");
  const forceStartBtn = document.getElementById("force-start-btn");
  const stopBtn = document.getElementById("stop-btn");
  const downloadBtn = document.getElementById("download-btn");
  const previewList = document.getElementById("preview-list");
  const consoleEl = document.getElementById("console");
  const turnsCounterEl = document.getElementById("turns-counter");
  const clearBtn = document.getElementById("clear-btn");

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
      detectBtn.disabled = true;
      startBtn.disabled = true;
      forceStartBtn.disabled = true;
      stopBtn.disabled = true;
      downloadBtn.disabled = true;
      return;
    }

    log("info", `Connected to active tab (${host})`);
    updateStatus("Ready to Detect", "active");
    
    // Retrieve scraper state if it was already running/completed in the page
    getScraperState();
  } catch (err) {
    log("error", "Error: Cannot access active tab.");
    updateStatus("Disconnected", "");
    detectBtn.disabled = true;
    startBtn.disabled = true;
    forceStartBtn.disabled = true;
    stopBtn.disabled = true;
    downloadBtn.disabled = true;
    return;
  }

  // Log function helper
  function log(level, text, timeStr) {
    const tStr = timeStr || new Date().toTimeString().split(' ')[0];
    const shouldAutoScroll = isNearBottom(consoleEl);
    
    const line = document.createElement("div");
    line.className = "console-line";
    
    const timeSpan = document.createElement("span");
    timeSpan.className = "console-time";
    timeSpan.textContent = `[${tStr}]`;
    
    const textSpan = document.createElement("span");
    textSpan.className = `console-text ${level}`;
    textSpan.textContent = text;
    
    line.appendChild(timeSpan);
    line.appendChild(textSpan);
    consoleEl.appendChild(line);
    
    if (shouldAutoScroll) {
      consoleEl.scrollTop = consoleEl.scrollHeight;
    }
  }

  function isNearBottom(element, threshold = 24) {
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    return distanceFromBottom <= threshold;
  }

  function updateStatus(text, state) {
    statusTextEl.textContent = text;
    statusDotEl.className = "status-dot";
    if (state === "active" || state === "ready") {
      statusDotEl.classList.add("active");
    } else if (state === "running" || state === "detecting") {
      statusDotEl.classList.add("running");
    }
  }

  function updateScraperStatus(status) {
    switch (status) {
      case "detecting":
        updateStatus("Detecting", "detecting");
        detectBtn.disabled = false;
        startBtn.disabled = true;
        forceStartBtn.disabled = false;
        stopBtn.disabled = false;
        downloadBtn.disabled = true;
        break;
      case "ready":
        updateStatus("Ready to Start", "ready");
        detectBtn.disabled = false;
        startBtn.disabled = false;
        forceStartBtn.disabled = true;
        stopBtn.disabled = true;
        downloadBtn.disabled = extractedTurns.length === 0;
        break;
      case "running":
        updateStatus("Running", "running");
        detectBtn.disabled = true;
        startBtn.disabled = true;
        forceStartBtn.disabled = true;
        stopBtn.disabled = false;
        downloadBtn.disabled = true;
        break;
      case "completed":
        updateStatus("Completed", "active");
        detectBtn.disabled = false;
        startBtn.disabled = false;
        forceStartBtn.disabled = true;
        stopBtn.disabled = true;
        downloadBtn.disabled = extractedTurns.length === 0;
        break;
      case "stopped":
        updateStatus("Stopped", "active");
        detectBtn.disabled = false;
        startBtn.disabled = false;
        forceStartBtn.disabled = true;
        stopBtn.disabled = true;
        downloadBtn.disabled = extractedTurns.length === 0;
        break;
      case "error":
        updateStatus("Error", "active");
        detectBtn.disabled = false;
        startBtn.disabled = false;
        forceStartBtn.disabled = true;
        stopBtn.disabled = true;
        downloadBtn.disabled = extractedTurns.length === 0;
        break;
      case "idle":
      default:
        updateStatus("Ready to Detect", "active");
        detectBtn.disabled = false;
        startBtn.disabled = true;
        forceStartBtn.disabled = true;
        stopBtn.disabled = true;
        downloadBtn.disabled = extractedTurns.length === 0;
        break;
    }
  }

  function clearPreview() {
    extractedTurns = [];
    previewList.innerHTML = "";
    turnsCounterEl.textContent = "0 turns";
  }

  function clearConsole() {
    consoleEl.innerHTML = "";
  }

  function getScraperState() {
    chrome.tabs.sendMessage(targetTabId, { action: "get-state" }, (state) => {
      if (chrome.runtime.lastError || !state) {
        return;
      }
      
      // Load turns
      extractedTurns = state.turns || [];
      previewList.innerHTML = "";
      extractedTurns.forEach((turn, idx) => renderTurn(turn, idx));
      turnsCounterEl.textContent = `${extractedTurns.length} turns`;
      
      // Load logs
      consoleEl.innerHTML = "";
      const logs = state.logs || [];
      logs.forEach((logItem) => {
        log(logItem.level, logItem.text, logItem.timeStr);
      });
      
      // Restore status & buttons
      updateScraperStatus(state.status);
    });
  }

  function renderTurn(turn, idx) {
    const shouldAutoScroll = isNearBottom(previewList);
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
    if (shouldAutoScroll) {
      previewList.scrollTop = previewList.scrollHeight;
    }
  }

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.tab && sender.tab.id !== targetTabId) {
      return; // Ignore messages from other tabs
    }

    switch (message.action) {
      case "log":
        log(message.level || "info", message.text, message.timeStr);
        break;
      case "turn":
        extractedTurns.push(message.turn);
        renderTurn(message.turn, extractedTurns.length - 1);
        turnsCounterEl.textContent = `${extractedTurns.length} turns`;
        break;
      case "detect-finished":
        log("success", `Detect finished. ${message.detectedTurns || 0} Gemini nodes ready.`);
        updateScraperStatus("ready");
        break;
      case "finished":
        log("success", `Scraping completed! Successfully extracted ${message.turns.length} turns.`);
        extractedTurns = message.turns;
        updateScraperStatus("completed");
        break;
      case "stopped":
        if (message.mode === "detect") {
          log("warn", "Detect stopped by user.");
        } else {
          log("warn", `Scraping stopped by user. Extracted ${message.turns.length} turns so far.`);
          extractedTurns = message.turns;
        }
        updateScraperStatus("stopped");
        break;
      case "error":
        log("error", `Scraper error: ${message.message}`);
        updateScraperStatus("error");
        break;
    }
  });

  // Action Button Listeners
  detectBtn.addEventListener("click", () => {
    clearConsole();
    log("info", "Starting detect phase...");
    updateScraperStatus("detecting");

    chrome.tabs.sendMessage(targetTabId, { action: "start-detect" }, () => {
      if (chrome.runtime.lastError) {
        log("error", `Could not detect: ${chrome.runtime.lastError.message}. Try reloading the chat page.`);
        updateScraperStatus("idle");
      }
    });
  });

  startBtn.addEventListener("click", () => {
    clearPreview();
    clearConsole();
    updateScraperStatus("running");
    log("info", "Starting extraction process...");

    chrome.tabs.sendMessage(targetTabId, { action: "start-scrape" }, (response) => {
      if (chrome.runtime.lastError) {
        log("error", `Could not start: ${chrome.runtime.lastError.message}. Try reloading the chat page.`);
        updateScraperStatus("idle");
        return;
      }
      if (response && response.reason === "detecting") {
        log("warn", "Detect still running. Wait, or use Force Start.");
        updateScraperStatus("detecting");
        return;
      }
      if (response && response.reason === "detect_required") {
        log("warn", "Run detect first before start.");
        updateScraperStatus("idle");
      }
    });
  });

  forceStartBtn.addEventListener("click", () => {
    clearPreview();
    clearConsole();
    updateScraperStatus("running");
    log("warn", "Force start requested. Detect phase will be interrupted.");

    chrome.tabs.sendMessage(targetTabId, { action: "force-start-scrape" }, (response) => {
      if (chrome.runtime.lastError) {
        log("error", `Could not force start: ${chrome.runtime.lastError.message}. Try reloading the chat page.`);
        updateScraperStatus("idle");
        return;
      }
      if (response && response.reason === "detect_required") {
        log("warn", "Detect required before normal start.");
        updateScraperStatus("idle");
      }
    });
  });

  stopBtn.addEventListener("click", () => {
    log("info", "Requesting stop...");
    stopBtn.disabled = true;
    chrome.tabs.sendMessage(targetTabId, { action: "stop-scrape" });
  });

  clearBtn.addEventListener("click", () => {
    consoleEl.innerHTML = "";
    chrome.tabs.sendMessage(targetTabId, { action: "clear-logs" }, () => {
      log("info", "Logs cleared.");
    });
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
        () => {
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
