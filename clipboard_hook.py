"""
Intercepts clipboard writes inside the page instead of reading the OS clipboard.

Why: clicking a site's own "copy" button calls navigator.clipboard.writeText(text)
(or, on older code paths, document.execCommand('copy') against a hidden textarea).
Reading the real OS clipboard from Python afterwards works, but it's racy and breaks
under headless/CI. Instead we patch writeText before the page's own scripts run, so
whatever text the site tries to copy gets stashed in a JS variable we can read back
through Selenium directly - same trick used by browser extensions that export chats.
"""

INJECT_SCRIPT = """
(function() {
  if (window.__clipboardHookInstalled) return;
  window.__clipboardHookInstalled = true;
  window.__capturedClipboard = null;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function(text) {
        window.__capturedClipboard = text;
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
          window.__capturedClipboard = sel.toString();
        }
      }
      return originalExec(cmd, ...rest);
    };
  } catch (e) {}
})();
"""


def install(driver):
    """Call once right after the driver is created (and again after a full
    page reload, e.g. post-login) so the hook is present before the site's
    own JS loads."""
    driver.execute_cdp_cmd(
        "Page.addScriptToEvaluateOnNewDocument", {"source": INJECT_SCRIPT}
    )
    driver.execute_script(INJECT_SCRIPT)


def read(driver, timeout=6.0, poll=0.1):
    """Wait for a captured clipboard write and return it, clearing the slot
    afterwards. Returns None on timeout (e.g. the copy button didn't fire)."""
    import time

    deadline = time.time() + timeout
    while time.time() < deadline:
        value = driver.execute_script("return window.__capturedClipboard;")
        if value:
            driver.execute_script("window.__capturedClipboard = null;")
            return value
        time.sleep(poll)
    return None
