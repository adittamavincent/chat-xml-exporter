// Inject clipboard hook into the page context
function injectClipboardHook() {
  const script = document.createElement("script");
  script.textContent = `
    (function() {
      if (window.__clipboardHookInstalled) return;
      window.__clipboardHookInstalled = true;

      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          const original = navigator.clipboard.writeText.bind(navigator.clipboard);
          navigator.clipboard.writeText = function(text) {
            document.dispatchEvent(new CustomEvent('captured-clipboard', { detail: text }));
            return original(text);
          };
        }
      } catch (e) {}

      try {
        if (navigator.clipboard && navigator.clipboard.write) {
          const original = navigator.clipboard.write.bind(navigator.clipboard);
          navigator.clipboard.write = function(items) {
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
            return original(items);
          };
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

// Helper to wait
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper to safely click
function safeClick(element) {
  element.scrollIntoView({ block: "center" });
  try {
    element.click();
  } catch (e) {
    // Fallback to JS click
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
}

async function scrapeClaude() {
  const turns = [];
  const groups = document.querySelectorAll('[role="group"][aria-label="Message actions"]');
  
  let capturedText = null;
  const onCapture = (e) => {
    capturedText = e.detail;
  };
  document.addEventListener("captured-clipboard", onCapture);

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const isResponse = group.querySelector('button[aria-label="Give positive feedback"]') !== null;
    const copyBtn = group.querySelector('button[data-testid="action-bar-copy"]');
    
    if (!copyBtn) continue;

    capturedText = null;
    safeClick(copyBtn);

    // Wait up to 2 seconds
    for (let attempt = 0; attempt < 20; attempt++) {
      if (capturedText !== null) break;
      await wait(100);
    }

    if (capturedText) {
      turns.push({
        role: isResponse ? "response" : "user",
        text: capturedText
      });
    }
  }

  document.removeEventListener("captured-clipboard", onCapture);
  return turns;
}

async function scrapeGemini() {
  const turns = [];
  const elements = document.querySelectorAll("user-query, model-response");

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

  let capturedText = null;
  const onCapture = (e) => {
    capturedText = e.detail;
  };
  document.addEventListener("captured-clipboard", onCapture);

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const tag = el.tagName.toLowerCase();

    if (tag === "user-query") {
      const textEl = el.querySelector(".query-text, .query-text-line");
      const rawText = textEl ? textEl.innerText : el.innerText;
      const text = normalizeUserText(rawText);
      if (text) {
        turns.push({ role: "user", text });
      }
    } else {
      const copyBtn = el.querySelector(
        'button[aria-label*="Copy" i], button[title*="Copy" i], button[data-testid*="copy" i]'
      );

      capturedText = null;
      if (copyBtn) safeClick(copyBtn);

      for (let attempt = 0; attempt < 20; attempt++) {
        if (capturedText !== null) break;
        await wait(100);
      }

      if (capturedText) {
        turns.push({ role: "response", text: capturedText });
        continue;
      }

      const fallback = normalizeResponseText(el.innerText);
      if (fallback) {
        turns.push({ role: "response", text: fallback });
      }
    }
  }

  document.removeEventListener("captured-clipboard", onCapture);
  return turns;
}

async function scrapeAISudio() {
  const turns = [];
  const chatTurns = document.querySelectorAll("ms-chat-turn");

  let capturedText = null;
  const onCapture = (e) => {
    capturedText = e.detail;
  };
  document.addEventListener("captured-clipboard", onCapture);

  for (let i = 0; i < chatTurns.length; i++) {
    const turn = chatTurns[i];
    const userChunk = turn.querySelector("ms-prompt-chunk, [data-turn-role='user']");

    if (userChunk) {
      const text = turn.innerText.trim();
      if (text) {
        turns.push({ role: "user", text });
      }
    } else {
      // Find copy button or fallback to kebab menu
      let copyBtn = turn.querySelector('button[aria-label*="markdown" i], button[aria-label*="Copy" i]');
      
      if (!copyBtn) {
        const menuBtn = turn.querySelector('button[aria-label*="more" i]');
        if (menuBtn) {
          safeClick(menuBtn);
          await wait(200);
          // Find menu item containing markdown
          const menuItems = Array.from(document.querySelectorAll("span, button, div"));
          copyBtn = menuItems.find(el => el.textContent.toLowerCase().includes("markdown"));
        }
      }

      if (!copyBtn) continue;

      capturedText = null;
      safeClick(copyBtn);

      for (let attempt = 0; attempt < 20; attempt++) {
        if (capturedText !== null) break;
        await wait(100);
      }

      if (capturedText) {
        turns.push({ role: "response", text: capturedText });
      }
    }
  }

  document.removeEventListener("captured-clipboard", onCapture);
  return turns;
}

async function scrapePerplexity() {
  const turns = [];
  const root = document.querySelector("main") || document.body;

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
    turns.push({ role, text: t });
  };

  let capturedText = null;
  const onCapture = (e) => {
    capturedText = e.detail;
  };
  document.addEventListener("captured-clipboard", onCapture);

  const queryButtons = Array.from(root.querySelectorAll('button[aria-label="Copy query"]'));
  const articles = Array.from(root.querySelectorAll("article"));
  const candidates = [];

  for (const btn of queryButtons) {
    const wrapper = btn.closest("div.group") || btn.closest("div") || btn;
    candidates.push({ role: "user", el: wrapper, btn });
  }

  for (const article of articles) {
    candidates.push({ role: "response", el: article, btn: null });
  }

  candidates.sort((a, b) => {
    if (a.el === b.el) return 0;
    const pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  for (const item of candidates) {
    if (item.role === "user") {
      pushTurn("user", normalizeUserText(item.el.innerText));
    } else {
      pushTurn("response", normalizeResponseText(item.el.innerText));
    }

    if (!item.btn) continue;

    capturedText = null;
    safeClick(item.btn);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (capturedText !== null) break;
      await wait(100);
    }
    if (capturedText) {
      pushTurn(item.role, capturedText);
    }
  }

  const copyButtons = Array.from(root.querySelectorAll('button[aria-label="Copy"]'));
  for (const btn of copyButtons) {
    capturedText = null;
    safeClick(btn);
    for (let attempt = 0; attempt < 20; attempt++) {
      if (capturedText !== null) break;
      await wait(100);
    }
    if (capturedText) {
      pushTurn("response", capturedText);
    }
  }

  if (!turns.some((t) => t.role === "user")) {
    const h1 = root.querySelector("h1");
    if (h1) pushTurn("user", normalizeUserText(h1.innerText));
  }

  document.removeEventListener("captured-clipboard", onCapture);
  return turns;
}

// Listen for scrape request
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "scrape") {
    injectClipboardHook();
    
    const host = window.location.hostname;
    let promise;

    if (host.includes("claude.ai")) {
      promise = scrapeClaude();
    } else if (host.includes("gemini.google.com")) {
      promise = scrapeGemini();
    } else if (host.includes("aistudio.google.com")) {
      promise = scrapeAISudio();
    } else if (host.includes("perplexity.ai")) {
      promise = scrapePerplexity();
    } else {
      sendResponse({ success: false, error: "Unsupported website" });
      return true;
    }

    promise.then((turns) => {
      sendResponse({ success: true, turns });
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });

    return true; // Keep message channel open for async response
  }
});
