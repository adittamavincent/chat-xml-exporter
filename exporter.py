# /// script
# dependencies = [
#   "selenium>=4.20.0",
# ]
# ///

"""
Usage:
    uv run exporter.py --site claude
    uv run exporter.py --site gemini --output output/my_convo.xml
    uv run exporter.py --site aistudio --root-tag ""   # rootless flat output

Flow:
1. Opens a real (headed) Chrome window with a persistent profile dir, so you
   only have to log in once - subsequent runs reuse the session.
2. Installs the clipboard-capture hook (see clipboard_hook.py).
3. Waits for you to log in (if needed) and open the conversation you want.
4. Walks every turn in chronological (DOM) order, clicking each one's own
   copy button and tagging the result <user> or <response>.
5. Writes flat XML to --output (defaults to output/<site>_<timestamp>.xml).
"""

import argparse
import os
import sys
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

import clipboard_hook
from site_adapters import ADAPTERS
from xml_builder import build_xml

SITE_URLS = {
    "claude": "https://claude.ai",
    "gemini": "https://gemini.google.com/app",
    "aistudio": "https://aistudio.google.com",
}


def build_driver(profile_dir: str):
    options = Options()
    options.add_argument(f"--user-data-dir={os.path.abspath(profile_dir)}")
    options.add_argument("--start-maximized")
    # Stay headed: clipboard writes via navigator.clipboard.writeText need a
    # real user-gesture/focused-document context, which is far less reliable
    # (and these sites' bot detection is far stricter) in headless mode.
    return webdriver.Chrome(options=options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True, choices=ADAPTERS.keys())
    parser.add_argument("--output", default=None, help="output XML path")
    parser.add_argument(
        "--profile",
        default="./chrome_profile",
        help="persistent Chrome profile dir (reused across runs so you only log in once)",
    )
    parser.add_argument(
        "--root-tag",
        default="conversation",
        help='wrapping root element name, pass "" for a rootless flat sequence',
    )
    args = parser.parse_args()

    driver = build_driver(args.profile)
    clipboard_hook.install(driver)
    driver.get(SITE_URLS[args.site])

    input(
        "\nBrowser terbuka. Login kalau perlu, lalu buka conversation yang mau di-export.\n"
        "Tekan Enter di sini begitu conversation-nya udah ke-load full...\n"
    )

    # Defensive re-install: a login redirect usually involves a full reload,
    # and addScriptToEvaluateOnNewDocument already covers that, but this is
    # cheap insurance against an edge case where it doesn't.
    clipboard_hook.install(driver)

    turns = list(ADAPTERS[args.site](driver))

    if not turns:
        print(
            "\nNggak ada turn yang ke-capture. Kemungkinan selector-nya udah berubah "
            "(situ rebuild UI-nya). Cek site_adapters.py dan README buat cara fix-nya."
        )
        driver.quit()
        sys.exit(1)

    xml_output = build_xml(turns, root_tag=args.root_tag or None)

    output_path = args.output
    if not output_path:
        os.makedirs("output", exist_ok=True)
        output_path = os.path.join("output", f"{args.site}_{int(time.time())}.xml")

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(xml_output)

    print(f"\nDone, {len(turns)} turn ke-export ke {output_path}")
    driver.quit()


if __name__ == "__main__":
    main()
