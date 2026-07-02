// Inject clipboard hook into the page context
function injectClipboardHook() {
  const script = document.createElement("script");
  script.textContent = `
    (function() {
      if (window.__clipboardHookInstalled) return;
      window.__clipboardHookInstalled = true;

      function dispatchCapturedClipboard(text) {
        if (typeof text !== 'string') return;
        const cleaned = text.trim();
        if (!cleaned) return;
        document.dispatchEvent(new CustomEvent('captured-clipboard', { detail: cleaned }));
      }

      try {
        if (window.Clipboard && Clipboard.prototype.writeText) {
          const original = Clipboard.prototype.writeText;
          Object.defineProperty(Clipboard.prototype, 'writeText', {
            value: function(text) {
              dispatchCapturedClipboard(text);
              return original.apply(this, arguments);
            },
            writable: true,
            configurable: true
          });
        }
      } catch (e) {}

      try {
        if (window.Clipboard && Clipboard.prototype.write) {
          const original = Clipboard.prototype.write;
          Object.defineProperty(Clipboard.prototype, 'write', {
            value: function(items) {
              try {
                const first = items && items[0];
                if (first && typeof first.getType === 'function') {
                  const typeOrder = ['text/markdown', 'text/plain', 'text/html'];
                  const types = Array.isArray(first.types) ? first.types : [];
                  const pick =
                    typeOrder.find((t) => types.includes(t)) ||
                    types.find((t) => typeOrder.includes(t)) ||
                    types[0];
                  if (pick) {
                    first.getType(pick)
                      .then((blob) => blob.text())
                      .then((text) => {
                        dispatchCapturedClipboard(text);
                      })
                      .catch(() => {});
                  }
                }
              } catch (e) {}
              return original.apply(this, arguments);
            },
            writable: true,
            configurable: true
          });
        }
      } catch (e) {}

      try {
        const originalExec = document.execCommand.bind(document);
        document.execCommand = function(cmd, ...rest) {
          if (cmd === 'copy') {
            const sel = window.getSelection();
            if (sel && sel.toString()) {
              dispatchCapturedClipboard(sel.toString());
            }
          }
          return originalExec(cmd, ...rest);
        };
      } catch (e) {}

      try {
        document.addEventListener('copy', (event) => {
          try {
            const data = event && event.clipboardData;
            if (!data) return;
            const typeOrder = ['text/markdown', 'text/plain', 'text/html'];
            for (const type of typeOrder) {
              const text = data.getData(type);
              if (text) {
                dispatchCapturedClipboard(text);
                return;
              }
            }
          } catch (e) {}
        }, true);
      } catch (e) {}
    })();
  `;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

// Automatically inject hook at document_start
injectClipboardHook();

// Control and State persistence
let isCancelled = false;
let activeRunId = 0;
let activeMode = "idle";
let scraperState = {
  status: "idle", // "idle" | "detecting" | "ready" | "running" | "completed" | "stopped" | "error"
  turns: [],
  logs: []
};

function shouldCancel(runId) {
  return isCancelled || runId !== activeRunId;
}

function beginRun(mode, { resetTurns = false, resetLogs = false } = {}) {
  activeRunId += 1;
  activeMode = mode;
  isCancelled = false;
  scraperState.status = mode === "detect" ? "detecting" : "running";
  if (resetTurns) scraperState.turns = [];
  if (resetLogs) scraperState.logs = [];
  return activeRunId;
}

// Helpers to communicate with dashboard
function sendLog(level, text) {
  const timeStr = new Date().toTimeString().split(' ')[0];
  const logItem = { level, text, timeStr };
  scraperState.logs.push(logItem);
  try {
    chrome.runtime.sendMessage({ action: "log", ...logItem });
  } catch (e) {}
}

function sendTurn(turn) {
  scraperState.turns.push(turn);
  try {
    chrome.runtime.sendMessage({ action: "turn", turn });
  } catch (e) {}
}

// Helper to find copy button in multiple languages or by material icon name
function findCopyButton(el) {
  const selectors = [
    'button[aria-label*="Copy" i]',
    'button[aria-label*="Salin" i]',
    'button[aria-label*="Copiar" i]',
    'button[aria-label*="Copier" i]',
    'button[aria-label*="Kopieren" i]',
    'button[aria-label*="Copia" i]',
    'button[aria-label*="copy" i]',
    'button[title*="Copy" i]',
    'button[title*="Salin" i]',
    'button[title*="Copiar" i]',
    'button[title*="Copier" i]',
    'button[title*="Kopieren" i]',
    'button[title*="Copia" i]',
    'button[data-testid*="copy" i]'
  ];
  const candidates = new Set(Array.from(el.querySelectorAll(selectors.join(', '))));
  for (const b of el.querySelectorAll('button')) {
    const html = b.innerHTML.toLowerCase();
    const text = b.textContent.toLowerCase();
    if (html.includes('content_copy') || text.includes('content_copy') || text.includes('copy') || text.includes('salin')) {
      candidates.add(b);
    }
  }

  let best = null;
  let bestScore = -Infinity;
  for (const btn of candidates) {
    const text = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''} ${btn.textContent || ''}`.toLowerCase();
    const style = window.getComputedStyle(btn);
    const rect = btn.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    const insideCode = !!btn.closest('pre, code');
    const insideMenu = !!btn.closest('[role="menu"], [role="dialog"], [role="listbox"]');
    let score = 0;
    if (visible) score += 100;
    if (!insideCode) score += 30;
    if (!insideMenu) score += 20;
    if (/copy response|copy answer|copy output/.test(text)) score += 50;
    if (/\bcopy\b|\bsalin\b|\bcopiar\b|\bcopier\b|\bkopieren\b|\bcopia\b/.test(text)) score += 20;
    score += rect.top / 1000;
    score += rect.left / 1000;
    if (score >= bestScore) {
      best = btn;
      bestScore = score;
    }
  }
  return best;
}

// Helper to dynamically locate the scrollable container on the page
function findScrollableContainer() {
  const container = document.querySelector('gmat-main-content, main, .chat-history, .conversation-container');
  if (container) return container;

  // Search DOM for the deepest scrollable element
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (el.scrollHeight > el.clientHeight) {
      const overflow = window.getComputedStyle(el).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        if (el.tagName !== 'HTML' && el.tagName !== 'BODY') {
          return el;
        }
      }
    }
  }
  return window;
}

function getGeminiHistoryScroller() {
  return document.querySelector("#chat-history > infinite-scroller, #chat-history infinite-scroller");
}

// Helper to wait
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to safely click
function safeClick(element) {
  element.scrollIntoView({ block: "center" });
  try {
    element.click();
  } catch (e) {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
}

// Event-driven: resolve Promise the moment captured-clipboard fires instead of polling
function captureAfterClick(clickFn, timeout = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const handler = (e) => {
      if (!e.detail) return;
      done = true;
      document.removeEventListener("captured-clipboard", handler);
      resolve(e.detail);
    };
    document.addEventListener("captured-clipboard", handler);
    clickFn();
    setTimeout(() => {
      if (!done) {
        document.removeEventListener("captured-clipboard", handler);
        resolve(null);
      }
    }, timeout);
  });
}

async function scrapeClaude(runId) {
  const turns = [];
  const groups = document.querySelectorAll('[role="group"][aria-label="Message actions"]');
  sendLog("info", `Found ${groups.length} turns in Claude. Starting extraction...`);

  for (let i = 0; i < groups.length; i++) {
    if (shouldCancel(runId)) break;
    
    const group = groups[i];
    const isResponse = group.querySelector('button[aria-label="Give positive feedback"]') !== null;
    const copyBtn = group.querySelector('button[data-testid="action-bar-copy"]');

    if (!copyBtn) continue;

    sendLog("info", `Copying turn ${i + 1}/${groups.length}...`);
    const text = await captureAfterClick(() => safeClick(copyBtn));
    if (text) {
      const turn = { role: isResponse ? "response" : "user", text };
      turns.push(turn);
      sendTurn(turn);
    }
  }

  return turns;
}

// Auto-scroll to top to load full history for Gemini
async function loadFullHistoryGemini(runId) {
  sendLog("info", "Checking conversation history loading state...");
  const container = getGeminiHistoryScroller();
  if (!container) {
    sendLog("warn", "Gemini history scroller not found. Using currently rendered turns only.");
    return;
  }

  let lastTurnCount = container.querySelectorAll("user-query, model-response").length;
  let stableCount = 0;
  let lastScrollTop = container.scrollTop;
  
  sendLog("info", "Detected Gemini history scroller. Loading older turns...");
  
  for (let i = 0; i < 40; i++) {
    if (shouldCancel(runId)) {
      sendLog("warn", "History load cancelled by user.");
      return;
    }
    
    sendLog("info", `Gemini history fetch ${i + 1}/40...`);
    if (typeof container.scrollTo === "function") {
      container.scrollTo({ top: 0, behavior: "auto" });
    } else {
      container.scrollTop = 0;
    }
    container.dispatchEvent(new Event("scroll", { bubbles: true }));
    
    await wait(1200);
    
    const currentTurnCount = container.querySelectorAll("user-query, model-response").length;
    const currentScrollTop = container.scrollTop;
    if (currentTurnCount > lastTurnCount) {
      sendLog("info", `New Gemini turns loaded. Total in DOM: ${currentTurnCount}`);
      lastTurnCount = currentTurnCount;
      stableCount = 0;
      lastScrollTop = currentScrollTop;
    } else {
      const loadingSpinner = document.querySelector('mat-progress-spinner, [role="progressbar"], .loading');
      const atTop = currentScrollTop === 0 || currentScrollTop === lastScrollTop;
      if (!loadingSpinner && atTop) {
        stableCount++;
        if (stableCount >= 2) {
          sendLog("success", "Reached top of the conversation. All history loaded.");
          break;
        }
      } else {
        sendLog("info", "Loading spinner detected, waiting for response...");
        stableCount = 0;
        lastScrollTop = currentScrollTop;
      }
    }
  }
}

async function scrapeGemini(runId, { skipHistoryLoad = false } = {}) {
  if (!skipHistoryLoad) {
    await loadFullHistoryGemini(runId);
    if (shouldCancel(runId)) return [];
  }

  sendLog("info", "Starting extraction of message content...");
  const turns = [];
  const root = getGeminiHistoryScroller() || document;
  const elements = root.querySelectorAll("user-query, model-response");
  sendLog("info", `Total elements to parse: ${elements.length}`);

  const normalizeUserText = (text) => {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    while (lines.length && /^you said$/i.test(lines[0])) lines.shift();
    return lines.join("\n").trim();
  };

  const normalizeResponseText = (text) => {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim());
    const dropLine = (l) =>
      l.length === 0 ||
      /^md$/i.test(l) ||
      /^\+\s*\d+$/i.test(l) ||
      /^md\s*\+\s*\d+$/i.test(l) ||
      /^copy$/i.test(l) ||
      /^copied$/i.test(l) ||
      /^share$/i.test(l) ||
      /^edit$/i.test(l);
    const kept = lines.filter((l) => !dropLine(l));
    return kept.join("\n").trim();
  };

  for (let i = 0; i < elements.length; i++) {
    if (shouldCancel(runId)) break;
    
    const el = elements[i];
    const tag = el.tagName.toLowerCase();

    if (tag === "user-query") {
      const textEl = el.querySelector(".query-text, .query-text-line");
      const rawText = textEl ? textEl.innerText : el.innerText;
      const text = normalizeUserText(rawText);
      if (text) {
        const turn = { role: "user", text };
        turns.push(turn);
        sendTurn(turn);
      }
    } else {
      const copyBtn = findCopyButton(el);

      let text = null;
      if (copyBtn) {
        sendLog("info", `Copying response ${i + 1}/${elements.length}...`);
        text = await captureAfterClick(() => safeClick(copyBtn), 5000);
      }

      if (text) {
        const turn = { role: "response", text };
        turns.push(turn);
        sendTurn(turn);
        continue;
      }

      sendLog("warn", `Clipboard capture missed turn ${i + 1}. Using innerText fallback (math formatting may be lost).`);
      const fallback = normalizeResponseText(el.innerText);
      if (fallback) {
        const turn = { role: "response", text: fallback };
        turns.push(turn);
        sendTurn(turn);
      }
    }
  }

  return turns;
}

async function scrapeAISudio(runId) {
  const turns = [];
  const chatTurns = document.querySelectorAll("ms-chat-turn");
  sendLog("info", `Found ${chatTurns.length} turns in AI Studio. Starting extraction...`);

  for (let i = 0; i < chatTurns.length; i++) {
    if (shouldCancel(runId)) break;

    const turn = chatTurns[i];
    const userChunk = turn.querySelector("ms-prompt-chunk, [data-turn-role='user']");

    if (userChunk) {
      const text = turn.innerText.trim();
      if (text) {
        const turnObj = { role: "user", text };
        turns.push(turnObj);
        sendTurn(turnObj);
      }
    } else {
      let copyBtn = turn.querySelector('button[aria-label*="markdown" i], button[aria-label*="Copy" i]');

      if (!copyBtn) {
        const menuBtn = turn.querySelector('button[aria-label*="more" i]');
        if (menuBtn) {
          sendLog("info", `AI Studio turn ${i + 1}: Opening context menu...`);
          safeClick(menuBtn);
          await wait(200);
          const menuItems = Array.from(document.querySelectorAll("span, button, div"));
          copyBtn = menuItems.find(el => el.textContent.toLowerCase().includes("markdown"));
        }
      }

      if (!copyBtn) {
        sendLog("warn", `AI Studio turn ${i + 1}: Copy button not found.`);
        continue;
      }

      sendLog("info", `AI Studio turn ${i + 1}: Copying markdown...`);
      const text = await captureAfterClick(() => safeClick(copyBtn));
      if (text) {
        const turnObj = { role: "response", text };
        turns.push(turnObj);
        sendTurn(turnObj);
      }
    }
  }

  return turns;
}

async function scrapePerplexity(runId) {
  const turns = [];
  const root = document.querySelector("main") || document.body;
  sendLog("info", "Starting Perplexity extraction...");

  const normalizeUserText = (text) => {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const dropLine = (l) =>
      /^edit query$/i.test(l) ||
      /^copy query$/i.test(l) ||
      /^you said$/i.test(l) ||
      /^question$/i.test(l);
    const kept = lines.filter((l) => !dropLine(l));
    return kept.join("\n").trim();
  };

  const normalizeResponseText = (text) => {
    const lines = String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim());
    const dropLine = (l) =>
      l.length === 0 ||
      /^download$/i.test(l) ||
      /^copy$/i.test(l) ||
      /^copied$/i.test(l) ||
      /^share$/i.test(l) ||
      /^edit$/i.test(l);
    const kept = lines.filter((l) => !dropLine(l));
    return kept.join("\n").trim();
  };

  const seen = new Set();
  const pushTurn = (role, text) => {
    const t = String(text || "").trim();
    if (!t) return;
    const key = `${role}\u0000${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    const turnObj = { role, text: t };
    turns.push(turnObj);
    sendTurn(turnObj);
  };

  const getTurnContainer = (btn, role) => {
    const wantUser = role === "user";
    const minLen = wantUser ? 5 : 40;
    let best = btn.closest("div") || btn.parentElement || btn;

    let cur = best;
    for (let i = 0; i < 14 && cur; i++) {
      if (cur === root || cur === document.body) break;

      const userBtnCount = cur.querySelectorAll('button[aria-label="Copy query"]').length;
      const respBtnCount = cur.querySelectorAll('button[aria-label="Copy"]').length;
      const t = (cur.innerText || "").trim();

      const hasOnlyThisTurn =
        wantUser ? userBtnCount === 1 && respBtnCount === 0 : respBtnCount === 1 && userBtnCount === 0;

      if (hasOnlyThisTurn && t.length >= minLen && t.length <= 20_000) {
        best = cur;
        break;
      }

      cur = cur.parentElement;
    }

    return best;
  };

  const items = [];

  for (const btn of Array.from(root.querySelectorAll('button[aria-label="Copy query"]'))) {
    items.push({ role: "user", btn, container: getTurnContainer(btn, "user") });
  }

  for (const btn of Array.from(root.querySelectorAll('button[aria-label="Copy"]'))) {
    items.push({ role: "response", btn, container: getTurnContainer(btn, "response") });
  }

  items.sort((a, b) => {
    if (a.btn === b.btn) return 0;
    const pos = a.btn.compareDocumentPosition(b.btn);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  sendLog("info", `Found ${items.length} interactive elements on Perplexity.`);

  for (const item of items) {
    if (shouldCancel(runId)) break;
    
    let text = null;
    if (item.btn) {
      sendLog("info", `Perplexity: Copying item (${item.role})...`);
      text = await captureAfterClick(() => safeClick(item.btn));
    }

    if (text) {
      pushTurn(item.role, text);
      continue;
    }

    sendLog("warn", `Perplexity: Using DOM fallback for ${item.role}.`);
    if (item.role === "user") {
      pushTurn("user", normalizeUserText(item.container?.innerText || ""));
    } else {
      pushTurn("response", normalizeResponseText(item.container?.innerText || ""));
    }
  }

  if (!turns.some((t) => t.role === "user")) {
    const h1 = root.querySelector("h1");
    if (h1) pushTurn("user", normalizeUserText(h1.innerText));
  }

  return turns;
}

async function detectConversation(runId) {
  const host = window.location.hostname;
  sendLog("info", `Starting detect phase on ${host}...`);

  if (host.includes("gemini.google.com")) {
    await loadFullHistoryGemini(runId);
    if (shouldCancel(runId)) return { ready: false, detectedTurns: 0 };

    const root = getGeminiHistoryScroller() || document;
    const detectedTurns = root.querySelectorAll("user-query, model-response").length;
    sendLog("success", `Detect complete. Gemini rendered ${detectedTurns} nodes.`);
    return { ready: true, detectedTurns };
  }

  sendLog("info", "Detect phase skipped for this site. Extraction can start now.");
  return { ready: true, detectedTurns: 0 };
}

// Listen for scrape request
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.action === "get-state") {
    sendResponse(scraperState);
    return true;
  } else if (request.action === "clear-logs") {
    scraperState.logs = [];
    sendResponse({ cleared: true });
    return true;
  } else if (request.action === "start-detect") {
    const runId = beginRun("detect", { resetLogs: true });
    injectClipboardHook();

    detectConversation(runId)
      .then((result) => {
        if (runId !== activeRunId) return;
        if (shouldCancel(runId)) {
          scraperState.status = "stopped";
          chrome.runtime.sendMessage({ action: "stopped", mode: "detect", turns: scraperState.turns });
          return;
        }

        scraperState.status = result.ready ? "ready" : "idle";
        chrome.runtime.sendMessage({ action: "detect-finished", ...result });
      })
      .catch((err) => {
        if (runId !== activeRunId) return;
        scraperState.status = "error";
        chrome.runtime.sendMessage({ action: "error", message: err.message });
      });

    sendResponse({ started: true, mode: "detect" });
    return true;
  } else if (request.action === "start-scrape" || request.action === "force-start-scrape") {
    const force = request.force === true || request.action === "force-start-scrape";
    const previousStatus = scraperState.status;
    const host = window.location.hostname;
    if (!force && scraperState.status === "detecting") {
      sendResponse({ started: false, reason: "detecting" });
      return true;
    }
    if (!force && host.includes("gemini.google.com") && previousStatus !== "ready") {
      sendResponse({ started: false, reason: "detect_required" });
      return true;
    }

    const runId = beginRun("scrape", { resetTurns: true, resetLogs: true });
    injectClipboardHook();
    
    let promise;
    sendLog("info", `Starting extraction on ${host}...`);

    if (host.includes("claude.ai")) {
      promise = scrapeClaude(runId);
    } else if (host.includes("gemini.google.com")) {
      promise = scrapeGemini(runId, { skipHistoryLoad: force || previousStatus === "ready" });
    } else if (host.includes("aistudio.google.com")) {
      promise = scrapeAISudio(runId);
    } else if (host.includes("perplexity.ai")) {
      promise = scrapePerplexity(runId);
    } else {
      scraperState.status = "error";
      chrome.runtime.sendMessage({ action: "error", message: "Unsupported website" });
      return;
    }

    promise.then((turns) => {
      if (runId !== activeRunId) return;
      if (shouldCancel(runId)) {
        scraperState.status = "stopped";
        chrome.runtime.sendMessage({ action: "stopped", mode: "scrape", turns });
      } else {
        scraperState.status = "completed";
        chrome.runtime.sendMessage({ action: "finished", turns });
      }
    }).catch((err) => {
      if (runId !== activeRunId) return;
      scraperState.status = "error";
      chrome.runtime.sendMessage({ action: "error", message: err.message });
    });

    sendResponse({ started: true, forced: force });
    return true; 
  } else if (request.action === "stop-scrape") {
    isCancelled = true;
    sendLog("warn", `Stop signal received. Cancelling ${activeMode}...`);
    sendResponse({ stopped: true });
    return true;
  }
});
