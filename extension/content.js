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
      const text = textEl ? textEl.innerText.trim() : "";
      if (text) {
        turns.push({ role: "user", text });
      }
    } else {
      const copyBtn = el.querySelector('button[aria-label="Copy"]');
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
