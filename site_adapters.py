"""
One generator per site. Each yields (role, text) tuples in DOM order, which
is chronological order for every one of these chat UIs (oldest turn first).

STATUS:
- claude   : selectors verified against a working public export tool
             (agarwalvishal/claude-chat-exporter). Should work as-is.
- gemini   : best-effort. Gemini's Angular app uses generated class names
             that rotate across deploys; only the custom element tag names
             below tend to survive a rebuild. Verify before trusting this.
- aistudio : best-effort, same caveat as gemini.

If a site adapter stops finding turns, open DevTools (right-click the copy
button -> Inspect), compare against the selector below, and patch this file.
That's a 2-minute fix, not a rewrite.
"""

from selenium.webdriver.common.by import By
from selenium.common.exceptions import (
    NoSuchElementException,
    ElementClickInterceptedException,
    StaleElementReferenceException,
)

import clipboard_hook


def _safe_click(driver, element):
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", element)
    try:
        element.click()
    except ElementClickInterceptedException:
        driver.execute_script("arguments[0].click();", element)


# ---------------------------------------------------------------------------
# Claude.ai
# ---------------------------------------------------------------------------


def iter_claude_turns(driver):
    groups = driver.find_elements(
        By.CSS_SELECTOR, '[role="group"][aria-label="Message actions"]'
    )
    for group in groups:
        try:
            is_response = (
                len(
                    group.find_elements(
                        By.CSS_SELECTOR, 'button[aria-label="Give positive feedback"]'
                    )
                )
                > 0
            )
            copy_btn = group.find_element(
                By.CSS_SELECTOR, 'button[data-testid="action-bar-copy"]'
            )
        except (NoSuchElementException, StaleElementReferenceException):
            continue  # e.g. an in-progress / still-streaming turn with no copy button yet

        _safe_click(driver, copy_btn)
        text = clipboard_hook.read(driver)
        if text:
            yield ("response" if is_response else "user", text)


# ---------------------------------------------------------------------------
# Gemini (gemini.google.com) - BEST EFFORT, verify selectors first
# ---------------------------------------------------------------------------


def iter_gemini_turns(driver):
    turns = driver.find_elements(By.CSS_SELECTOR, "user-query, model-response")
    for turn in turns:
        tag = turn.tag_name.lower()
        try:
            if tag == "user-query":
                text_el = turn.find_element(
                    By.CSS_SELECTOR, ".query-text, .query-text-line"
                )
                text = text_el.text.strip()
                if text:
                    yield ("user", text)
            else:
                copy_btn = turn.find_element(
                    By.CSS_SELECTOR, 'button[aria-label="Copy"]'
                )
                _safe_click(driver, copy_btn)
                text = clipboard_hook.read(driver)
                if text:
                    yield ("response", text)
        except (NoSuchElementException, StaleElementReferenceException):
            continue


# ---------------------------------------------------------------------------
# AI Studio (aistudio.google.com) - BEST EFFORT, verify selectors first
# ---------------------------------------------------------------------------


def iter_aistudio_turns(driver):
    turns = driver.find_elements(By.CSS_SELECTOR, "ms-chat-turn")
    for turn in turns:
        try:
            user_chunk = turn.find_elements(
                By.CSS_SELECTOR, "ms-prompt-chunk, [data-turn-role='user']"
            )
            if user_chunk:
                text = turn.text.strip()
                if text:
                    yield ("user", text)
                continue

            # newer builds hide "Copy markdown" behind a per-turn kebab menu;
            # older ones expose it as a direct button. Try the direct button
            # first, then fall back to opening the menu.
            try:
                copy_btn = turn.find_element(
                    By.CSS_SELECTOR,
                    'button[aria-label*="markdown" i], button[aria-label*="Copy" i]',
                )
            except NoSuchElementException:
                menu_btn = turn.find_element(
                    By.CSS_SELECTOR, 'button[aria-label*="more" i]'
                )
                _safe_click(driver, menu_btn)
                copy_btn = driver.find_element(
                    By.XPATH,
                    '//*[contains(translate(text(), "MARKDOWN", "markdown"), "markdown")]',
                )

            _safe_click(driver, copy_btn)
            text = clipboard_hook.read(driver)
            if text:
                yield ("response", text)
        except (NoSuchElementException, StaleElementReferenceException):
            continue


ADAPTERS = {
    "claude": iter_claude_turns,
    "gemini": iter_gemini_turns,
    "aistudio": iter_aistudio_turns,
}
