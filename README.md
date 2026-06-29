# chat-xml-exporter

Selenium tool buat export chat conversation (Claude.ai, Gemini, AI Studio) jadi
flat XML, pakai tombol "copy" / "copy as markdown" bawaan masing-masing situs
sendiri jadi formatting markdown-nya akurat (bukan scrape innerText yang udah
ke-render jadi HTML).

Output:

```xml
<conversation>
<user><![CDATA[isi prompt kamu]]></user>
<response><![CDATA[isi response AI, markdown intact]]></response>
<user><![CDATA[...]]></user>
<response><![CDATA[...]]></response>
</conversation>
```

Urutan tag ngikutin urutan asli percakapan (kronologis), karena diambil
sesuai urutan DOM dari atas ke bawah.

## Setup

Script ini menggunakan [uv](https://github.com/astral-sh/uv). Tidak perlu install manual, `uv` otomatis membaca dependency inline dan men-setup environment pas pertama kali jalan:

```bash
# Langsung jalankan dengan uv run
uv run exporter.py --site claude
```

Atau jika ingin membuat virtual environment manual menggunakan `uv`:

```bash
uv venv
uv pip install -r requirements.txt
source .venv/bin/activate
```

Butuh Chrome browser terinstall di mesin kamu. Selenium 4 udah auto-handle
download chromedriver yang matching (Selenium Manager), nggak perlu setup
manual.

## Pakai

```bash
uv run exporter.py --site claude
uv run exporter.py --site gemini
uv run exporter.py --site aistudio
```

Browser headed (kelihatan, bukan headless) akan terbuka. Login manual kalau
belum, buka conversation yang mau di-export, terus balik ke terminal dan
tekan Enter. Script bakal jalanin ekstraksi-nya otomatis.

Profile Chrome disimpen di `./chrome_profile` by default, jadi run
selanjutnya nggak perlu login ulang. Mau pisah profile per situs:

```bash
uv run exporter.py --site claude --profile ./profiles/claude
```

Custom output path:

```bash
uv run exporter.py --site claude --output output/sidang_proposal_chat.xml
```

Flat tanpa root wrapper (langsung `<user>`/`<response>` berurutan tanpa
`<conversation>` di luar, kalau emang butuh format itu buat di-paste ke
Cogdex/Notion):

```bash
uv run exporter.py --site claude --root-tag ""
```

## Status selector per situs

- **claude** - sudah diverifikasi terhadap open-source export tool yang
  jalan (action bar `[role="group"][aria-label="Message actions"]`, tombol
  copy `button[data-testid="action-bar-copy"]`, dibedain user/response
  via ada-tidaknya tombol thumbs-up). Harusnya langsung jalan.
- **gemini** dan **aistudio** - best-effort. Dua-duanya Angular SPA yang
  generated class name-nya gampang berubah tiap rebuild, jadi selector di
  `site_adapters.py` itu tebakan terbaik berdasarkan custom element tag yang
  biasanya lebih stabil ketimbang class name. Kalau pas dijalanin nggak ada
  turn yang ke-capture ("Nggak ada turn yang ke-capture..."), berarti
  selector-nya udah basi, perlu di-update.

## Cara fix selector kalau berubah

1. Buka conversation-nya manual di Chrome biasa.
2. Klik kanan tombol copy (atau menu "..." -> "Copy as markdown" di AI
   Studio) -> Inspect.
3. Lihat di Elements panel: cari atribut yang stabil — `data-testid`,
   `aria-label`, atau nama custom element (tag yang nggak generic kayak
   `<div>`/`<span>`, contoh `<user-query>`, `<ms-chat-turn>`).
4. Update CSS selector yang relevan di `site_adapters.py`, tiap fungsi
   adapter komentarnya udah jelasin selector mana yang ngapain.

Nggak perlu nulis ulang struktur script, cuma ganti string selector-nya aja.

## Kenapa headed, bukan headless

`navigator.clipboard.writeText` butuh context user-gesture / document yang
focused biar browser ngasih izin nulis clipboard. Di headless mode ini sering
gagal silent, dan bot-detection situs-situs ini juga jauh lebih strict kalau
headless. Jadi script ini sengaja didesain headed.

## Gimana cara kerja capture clipboard-nya

`clipboard_hook.py` nge-inject script via Chrome DevTools Protocol
(`Page.addScriptToEvaluateOnNewDocument`) sebelum script situsnya sendiri
jalan, buat nge-patch `navigator.clipboard.writeText`. Begitu situs klik
tombol copy-nya sendiri, text yang mau di-copy ketangkep ke variable JS
(`window.__capturedClipboard`) yang langsung dibaca balik lewat Selenium -
nggak gantung ke OS clipboard yang ribet ngurusin timing/race condition-nya.
