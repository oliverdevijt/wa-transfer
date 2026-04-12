# WA Transfer

A free, open-source Windows desktop app that migrates WhatsApp and WhatsApp Business chat history from Android to iPhone — no root required, no paid subscription, no cloud upload.

Built with Electron + React.

---

## Use Cases

### 1. Switching from Android to iPhone
You bought a new iPhone and want to keep your entire WhatsApp chat history — messages, photos, voice notes, documents. WA Transfer extracts your chats from Android and injects them into an iOS backup that iTunes restores onto your iPhone.

### 2. Migrating WhatsApp Business chats
Business owners switching from Android to iPhone can migrate their WhatsApp Business conversations, customer threads, and media using the same flow — without paying for commercial tools.

### 3. No root required (Android ≤ 11)
On Android 9, 10, and 11, WA Transfer uses the legacy ADB backup method to extract encrypted chat data without rooting the device. Just enable USB debugging and connect via USB.

### 4. Rooted device — full extraction
On rooted Android devices (any version), Root Mode directly accesses the encryption key and database via `su`, then decrypts locally on your PC. Works on Android 12, 13, 14, and beyond.

### 5. Keeping chat history after losing your Android phone
If you still have a WhatsApp backup file (`.crypt15`) from Google Drive or a previous ADB backup, WA Transfer can decrypt it (with the matching key) and transfer it to your iPhone.

### 6. Archive and read your WhatsApp chats on PC
The app decrypts and parses the Android WhatsApp database into a readable SQLite file. You can open it with any SQLite viewer to search, export, or archive your messages.

### 7. Privacy-first migration
All processing happens locally on your PC. No chat data is uploaded to any server, cloud service, or third party. The app is fully open source — every line is auditable.

### 8. Testing with Android emulator
Developers and testers can use an Android Studio emulator (API 28+) with ADB to test the extraction pipeline without a physical Android device.

---

## How It Works

```
Android Device                     Your PC                        iPhone
──────────────                     ────────────────────           ──────────────
WhatsApp crypt15  ── ADB pull ──►  Decrypt (AES-256-GCM)
Encryption key    ── ADB pull ──►  Parse SQLite DB        ──►    iOS Backup
                                   Map to iOS schema              iTunes Restore
                                   Patch Manifest.plist
```

---

## Extraction Modes

| Mode | Works On | How |
|------|----------|-----|
| **No Root** | Android ≤ 11 | Pulls crypt15 from external storage + `run-as` for key |
| **APK Mode** | Android ≤ 11 | Installs legacy APK, triggers `adb backup` to get key + DB |
| **Root Mode** | Any rooted device | Uses `su` to copy key from `/data/data/com.whatsapp/files/key` |

---

## Requirements

- Windows 10 / 11
- Android phone with USB debugging enabled
- iTunes installed (for iOS restore)
- ADB drivers for your Android device

---

## Installation

Download the latest installer from [Releases](../../releases) and run `WA Transfer Setup x.x.x.exe`.

---

## Building from Source

```bash
git clone https://github.com/YOUR_USERNAME/wa-transfer.git
cd wa-transfer
npm install
npm run dev          # development
npm run build        # production build
npm run dist         # package as .exe installer
```

---

## Tech Stack

- **Electron 29** — desktop shell
- **React 18 + Vite 5** — UI
- **Tailwind CSS** — styling
- **adb-ts** — ADB communication
- **better-sqlite3** — SQLite parsing
- **Node.js crypto** — AES-256-GCM decryption

---

## Disclaimer

This tool is intended for personal use to migrate your own WhatsApp data. Always comply with WhatsApp's Terms of Service. The authors are not responsible for any data loss — always keep a backup before migrating.

---

## License

MIT
