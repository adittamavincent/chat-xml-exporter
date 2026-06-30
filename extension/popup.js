document.addEventListener("DOMContentLoaded", async () => {
  const statusEl = document.getElementById("status");
  const downloadBtn = document.getElementById("download-btn");
  const previewList = document.getElementById("preview-list");

  let extractedTurns = [];

  downloadBtn.disabled = true;
  statusEl.textContent = "Connecting to tab...";
  
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      statusEl.textContent = "Error: No active tab found";
      return;
    }

    const host = new URL(tab.url).hostname;
    const supported = ["claude.ai", "gemini.google.com", "aistudio.google.com", "perplexity.ai"].some(h => host.includes(h));
    
    if (!supported) {
      statusEl.textContent = "Please open Claude, Gemini, AI Studio, or Perplexity";
      return;
    }

    statusEl.textContent = "Extracting turns... (Please wait)";
    
    // Send message to content script
    chrome.tabs.sendMessage(tab.id, { action: "scrape" }, (response) => {
      if (chrome.runtime.lastError) {
        statusEl.textContent = "Reload page and try again";
        console.error(chrome.runtime.lastError);
        return;
      }

      if (response && response.success) {
        extractedTurns = response.turns;
        renderPreview(extractedTurns);
        
        if (extractedTurns.length > 0) {
          statusEl.textContent = `Successfully extracted ${extractedTurns.length} turns!`;
          downloadBtn.disabled = false;
        } else {
          statusEl.textContent = "No turns found. Check selectors.";
        }
      } else {
        statusEl.textContent = `Error: ${response ? response.error : 'Unknown'}`;
      }
    });

  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
  }

  function renderPreview(turns) {
    previewList.innerHTML = "";
    turns.forEach((turn, idx) => {
      const item = document.createElement("div");
      item.className = "turn-item";
      
      const idxSpan = document.createElement("span");
      idxSpan.className = "turn-index";
      idxSpan.textContent = `#${idx + 1}`;

      const tagBadge = document.createElement("span");
      tagBadge.className = `tag-badge tag-${turn.role}`;
      tagBadge.textContent = `<${turn.role}>`;

      item.appendChild(idxSpan);
      item.appendChild(tagBadge);
      previewList.appendChild(item);
    });
  }

  function triggerDownload() {
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
            statusEl.textContent = `Download gagal: ${chrome.runtime.lastError.message}`;
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
            return;
          }

          if (!downloadId) {
            statusEl.textContent = "Download gagal: unknown";
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
            return;
          }

          statusEl.textContent = `Download start: ${filename}`;
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
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  downloadBtn.addEventListener("click", triggerDownload);
});
