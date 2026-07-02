// Inject clipboard hook into the page context
function injectClipboardHook() {
  const script = document.createElement("script");
  script.textContent = `
    (function() {
      if (window.__clipboardHookInstalled) return;
      window.__clipboardHookInstalled = true;

      try {
        if (window.Clipboard && Clipboard.prototype.writeText) {
          const original = Clipboard.prototype.writeText;
          Object.defineProperty(Clipboard.prototype, 'writeText', {
            value: function(text) {
              document.dispatchEvent(new CustomEvent('captured-clipboard', { detail: text }));
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
                  const typeOrder = ['text/plain', 'text/markdown', 'text/html'];
                  const types = Array.isArray(first.types) ? first.types : [];
                  const pick =
                    typeOrder.find((t) => types.includes(t)) ||
                    types.find((t) => typeOrder.includes(t)) ||
                    types[0];
                  if (pick) {
                    first.getType(pick)
                      .then((blob) => blob.text())
                      .then((text) => {
                        document.dispatchEvent(new CustomEvent('captured-clipboard', { detail: text }));
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
              document.dispatchEvent(new CustomEvent('captured-clipboard', { detail: sel.toString() }));
            }
          }
          return originalExec(cmd, ...rest);
        };
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
let scraperState = {
  status: "idle", // "idle" | "running" | "completed" | "stopped" | "error"
  turns: [],
  logs: []
};

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
  let btn = el.querySelector(selectors.join(', '));
  if (btn) return btn;

  const buttons = el.querySelectorAll('button');
  for (const b of buttons) {
    const html = b.innerHTML.toLowerCase();
    const text = b.textContent.toLowerCase();
    if (html.includes('content_copy') || text.includes('content_copy') || text.includes('copy') || text.includes('salin')) {
      return b;
    }
  }
  return null;
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

async function scrapeClaude() {
  const turns = [];
  const groups = document.querySelectorAll('[role="group"][aria-label="Message actions"]');
  sendLog("info", `Found ${groups.length} turns in Claude. Starting extraction...`);

  for (let i = 0; i < groups.length; i++) {
    if (isCancelled) break;
    
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
async function loadFullHistoryGemini() {
  sendLog("info", "Checking conversation history loading state...");
  const container = findScrollableContainer();
  let lastTurnCount = document.querySelectorAll("user-query").length;
  let stableCount = 0;
  
  sendLog("info", `Detected scroll container: ${container === window ? 'window' : container.tagName.toLowerCase() + '.' + container.className}`);
  
  for (let i = 0; i < 40; i++) {
    if (isCancelled) {
      sendLog("warn", "History load cancelled by user.");
      return;
    }
    
    sendLog("info", `Scrolling up to fetch older turns (attempt ${i + 1}/40)...`);
    if (container === window) {
      window.scrollTo({ top: 0, behavior: 'instant' });
    } else {
      container.scrollTop = 0;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    
    await wait(1200);
    
    const currentTurnCount = document.querySelectorAll("user-query").length;
    if (currentTurnCount > lastTurnCount) {
      sendLog("info", `New turns loaded! Total turns in DOM: ${currentTurnCount}`);
      lastTurnCount = currentTurnCount;
      stableCount = 0;
    } else {
      const loadingSpinner = document.querySelector('mat-progress-spinner, [role="progressbar"], .loading');
      if (!loadingSpinner) {
        stableCount++;
        if (stableCount >= 2) {
          sendLog("success", "Reached top of the conversation. All history loaded.");
          break;
        }
      } else {
        sendLog("info", "Loading spinner detected, waiting for response...");
        stableCount = 0;
      }
    }
  }
}

async function scrapeGemini() {
  await loadFullHistoryGemini();
  if (isCancelled) return [];

  sendLog("info", "Starting extraction of message content...");
  const turns = [];
  const elements = document.querySelectorAll("user-query, model-response");
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
      /^copy$/i.test(l) ||
      /^copied$/i.test(l) ||
      /^share$/i.test(l) ||
      /^edit$/i.test(l);
    const kept = lines.filter((l) => !dropLine(l));
    return kept.join("\n").trim();
  };

  for (let i = 0; i < elements.length; i++) {
    if (isCancelled) break;
    
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
        text = await captureAfterClick(() => safeClick(copyBtn));
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

async function scrapeAISudio() {
  const turns = [];
  const chatTurns = document.querySelectorAll("ms-chat-turn");
  sendLog("info", `Found ${chatTurns.length} turns in AI Studio. Starting extraction...`);

  for (let i = 0; i < chatTurns.length; i++) {
    if (isCancelled) break;

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

async function scrapePerplexity() {
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
    if (isCancelled) break;
    
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

// Listen for scrape request
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "get-state") {
    sendResponse(scraperState);
    return true;
  } else if (request.action === "clear-logs") {
    scraperState.logs = [];
    sendResponse({ cleared: true });
    return true;
  } else if (request.action === "start-scrape") {
    isCancelled = false;
    scraperState.status = "running";
    scraperState.turns = [];
    scraperState.logs = [];
    
    injectClipboardHook();
    
    const host = window.location.hostname;
    let promise;
    sendLog("info", `Starting extraction on ${host}...`);

    if (host.includes("claude.ai")) {
      promise = scrapeClaude();
    } else if (host.includes("gemini.google.com")) {
      promise = scrapeGemini();
    } else if (host.includes("aistudio.google.com")) {
      promise = scrapeAISudio();
    } else if (host.includes("perplexity.ai")) {
      promise = scrapePerplexity();
    } else {
      scraperState.status = "error";
      chrome.runtime.sendMessage({ action: "error", message: "Unsupported website" });
      return;
    }

    promise.then((turns) => {
      if (isCancelled) {
        scraperState.status = "stopped";
        chrome.runtime.sendMessage({ action: "stopped", turns });
      } else {
        scraperState.status = "completed";
        chrome.runtime.sendMessage({ action: "finished", turns });
      }
    }).catch((err) => {
      scraperState.status = "error";
      chrome.runtime.sendMessage({ action: "error", message: err.message });
    });

    sendResponse({ started: true });
    return true; 
  } else if (request.action === "stop-scrape") {
    isCancelled = true;
    sendLog("warn", "Stop signal received. Cancelling execution...");
    sendResponse({ stopped: true });
    return true;
  }
});
