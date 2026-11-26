# handoff.md — Cross-Agent Typed Handoff

- **Claim Lock:** `quantum-core-v2-architecture-refactor` (completed)
- **Goal:** Standardize data structures (`UUID v4`, DTO validation/scrubbing, Zero-Trust 2FA `HMAC-SHA256`) and web architecture (`src/core`, `src/engines`, `src/ui`, `src/styles`, `server/server.mjs`, `tests/core.test.mjs`) while preserving original dark Cyber-Quant UI/UX.
- **Invariants:**
  1. Never store plaintext OTPs (`_challenges` stores only `otpHmac` SHA-256 hex).
  2. Never use sequential numeric IDs for orders, positions, logs, or sessions (`QuantumUUID.v4()` only).
  3. Always keep UMD wrappers in `src/core/*` and `src/engines/*` so both Node (`require`) and browser `<script defer>` (`file://` & `http://`) run identically without a bundler.
  4. Never persist API secrets or Agent keys to disk/`localStorage`.
- **Next Steps (if extending to Live CEX Signing):**
  1. Wire `server/server.mjs` to a dedicated HMAC/EIP-712 signing worker for Hyperliquid / Binance REST order submission.
  2. Replace `devPreviewOtp` sandbox preview with an actual Gmail SMTP / transactional mailer transport when deploying beyond localhost.
  3. Run `node --test tests/core.test.mjs` after any engine modification.
