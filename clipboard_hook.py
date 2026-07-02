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
    if (window.Clipboard && Clipboard.prototype.writeText) {
      const original = Clipboard.prototype.writeText;
      Object.defineProperty(Clipboard.prototype, 'writeText', {
        value: function(text) {
          window.__capturedClipboard = text;
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


def read(driver, timeout=3.0):
    """Wait for a captured clipboard write and return it, clearing the slot
    afterwards. Returns None on timeout (e.g. the copy button didn't fire).

    Uses execute_async_script so polling runs inside the browser at ~5ms
    intervals — a single round-trip per turn instead of N round-trips."""
    script = f"""
        const callback = arguments[arguments.length - 1];
        const deadline = Date.now() + {int(timeout * 1000)};
        function poll() {{
            const val = window.__capturedClipboard;
            if (val) {{
                window.__capturedClipboard = null;
                callback(val);
            }} else if (Date.now() >= deadline) {{
                callback(null);
            }} else {{
                setTimeout(poll, 5);
            }}
        }}
        poll();
    """
    try:
        driver.set_script_timeout(timeout + 1)
        return driver.execute_async_script(script)
    except Exception:
        return None
