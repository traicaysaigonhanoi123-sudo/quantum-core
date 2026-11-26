# QUANTUM CORE // Multi-Exchange Quant & Orderflow Terminal (v2.0 Zero-Trust)

Hệ thống giao diện Quant & Orderflow Terminal đa sàn tại `D:\QuantumCoreTerminal`, giữ nguyên giao diện tối Cyber-Quant trực quan ban đầu và chuẩn hóa toàn bộ **cấu trúc web + cấu trúc dữ liệu + bảo mật Zero-Trust**.

## Khởi chạy nhanh
- **Chạy với Zero-Trust HTTP Server (Khuyên dùng):**
  ```bash
  node server/server.mjs
  # Hoặc nhấp đúp start-terminal.bat -> http://127.0.0.1:8787
  ```
- **Chạy kiểm thử TDD:**
  ```bash
  node --test tests/core.test.mjs
  ```
- **Xem sơ đồ kiến trúc HTML+SVG (Alabaster Porcelain):** Mở [architecture-diagram.html](file:///D:/QuantumCoreTerminal/docs/architecture-diagram.html).

## Cấu trúc thư mục chuẩn
- `src/core/`: `uuid.js` (UUID v4), `schemas.js` (Validator & Public DTO whitelist), `securityGate.js` (2FA HMAC-SHA256 OTP, 10m TTL, max 5 sai, 60s cooldown, IP binding, Session Revocation).
- `src/engines/`: `marketEngine.js`, `tradingEngine.js` (Risk Shield, Delta-Neutral Arbitrage, Circuit Breaker).
- `src/ui/`: `visualizers.js`, `motionController.js` (GSAP 3.15 + `prefers-reduced-motion`), `commandPalette.js` (`Ctrl+K` / `Cmd+K`), `app.js`.
- `src/styles/terminal.css`: Dark Cyber-Quant UI + CNC 1px borders + cố định bo góc `6px` + loại bỏ glassmorphism/gradient thừa.
- `server/`: `server.mjs` (Node HTTP Zero-Trust `HttpOnly` cookie, rate limit, path guard) & `cloudflare-waf-rules.json`.
- `docs/`: `architecture-diagram.html`, `api-hoppscotch.md`.
- `tests/`: `core.test.mjs`.

## Bản quyền & Giấy phép (Copyright & License)
Copyright © 2026 **traicaysaigonhanoi123-sudo** — **All Rights Reserved**.
Xem chi tiết điều khoản tại [LICENSE](./LICENSE). Nghiêm cấm sao chép, chỉnh sửa, phân phối hoặc sử dụng thương mại khi chưa có sự đồng ý bằng văn bản của tác giả.
