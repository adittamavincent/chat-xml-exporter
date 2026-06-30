# Chat XML Exporter

Export chat conversation dari Claude, Gemini, AI Studio → XML flat (`<user>` + `<response>`). Fokus: ambil text paling “asli” (pakai tombol Copy bawaan situs kalau ada), lalu simpan jadi file `.xml`.

Output contoh:

```xml
<conversation>
<user><![CDATA[isi prompt kamu]]></user>
<response><![CDATA[isi response AI]]></response>
</conversation>
```

## Tutorial (Chrome Extension) — rekomendasi

Source: folder [extension/](file:///Users/adittama/repositories/chat-xml-exporter/extension).

### Install (Load unpacked)

1. Buka `chrome://extensions`
2. Toggle **Developer mode**
3. Klik **Load unpacked**
4. Pilih folder: `chat-xml-exporter/extension`

### Pakai

1. Buka conversation di:
   - `https://claude.ai/*`
   - `https://gemini.google.com/*`
   - `https://aistudio.google.com/*`
2. Klik icon extension → popup auto jalan “Extracting…”
3. Klik **Download XML**
4. File masuk folder **Downloads** user (default Chrome) dengan nama `chat_export_YYYY-MM-DD.xml`

Kalau Chrome setting “Ask where to save each file” aktif, Chrome bisa tetap munculin prompt lokasi simpan.

### Kalau gagal / kosong

- Popup bilang “Reload page and try again” → reload tab conversation, coba lagi.
- “No turns found” → selector situs berubah. Edit selector di [content.js](file:///Users/adittama/repositories/chat-xml-exporter/extension/content.js) (cari `scrapeClaude` / `scrapeGemini` / `scrapeAISudio`).

Cara cepet update selector:
1. Klik kanan tombol Copy / menu “Copy as …” di page → Inspect
2. Cari atribut stabil: `data-testid`, `aria-label`, atau custom element tag (mis. `user-query`, `ms-chat-turn`)
3. Ganti selector string di `content.js`, reload extension (di `chrome://extensions`)

## Tutorial (Python + Selenium) — alternatif

Script utama: [exporter.py](file:///Users/adittama/repositories/chat-xml-exporter/exporter.py)

### Setup

- Butuh Chrome terinstall.
- Selenium 4 pakai Selenium Manager buat chromedriver (umumnya tanpa setup manual).
- Dependency: `selenium` (lihat [requirements.txt](file:///Users/adittama/repositories/chat-xml-exporter/requirements.txt)).

Opsional pakai `uv` (jalan langsung tanpa bikin venv manual), karena `exporter.py` punya inline dependency header:

```bash
uv run exporter.py --site claude
```

Atau venv manual:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### Pakai

```bash
uv run exporter.py --site claude
uv run exporter.py --site gemini
uv run exporter.py --site aistudio
```

Flow:
1. Chrome window (headed) kebuka.
2. Login kalau perlu, buka conversation target.
3. Balik ke terminal, tekan Enter.
4. Output default: `output/<site>_<timestamp>.xml`

Flag penting:

```bash
uv run exporter.py --site claude --output output/my_chat.xml
uv run exporter.py --site claude --profile ./profiles/claude
uv run exporter.py --site claude --root-tag ""
```

### Kalau selector berubah

Update selector di [site_adapters.py](file:///Users/adittama/repositories/chat-xml-exporter/site_adapters.py). Pola fix sama: Inspect tombol Copy → cari atribut stabil → ganti selector.
