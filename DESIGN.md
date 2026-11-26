# DESIGN.md — QUANTUM CORE Design Contract

- **Visual Mode:** Cyber-Quant Dark UI/UX preserved per user directive (`#05070B` void canvas, `#0D0F14` CNC-milled panel surfaces, Electric Cyan `#00F0FF`, Solar Gold `#FBBF24`, Mint `#34D399`, Crimson `#FF3B6B`, Sapphire focus ring `#2563EB`)
- **Surface & Geometry Invariants:**
  - Fixed `6px` border-radius across all controls, panels, cards, badges, inputs, modals, and toasts
  - Dark CNC-milled 1px subpixel border (`inset 0 1px 0 0 rgba(255,255,255,0.08), 0 0 0 1px rgba(255,255,255,0.06), 0 2px 4px 0 rgba(0,0,0,0.40)`)
  - Zero `backdrop-filter` glassmorphism; zero decorative CSS button/banner gradients
  - Tactile button press (`scale(0.98)` on `:active`), `Plus Jakarta Sans` + `Inter` + `JetBrains Mono` (`tabular-nums`)
  - Strict `prefers-reduced-motion` support across CSS, Canvas visualizers, and GSAP controller
- **Editorial Documentation Diagram (`docs/architecture-diagram.html`):** Alabaster Porcelain palette (`#F7F8FA`, `#FFFFFF`, `#0F172A`, `#2563EB`, `#E2E8F0`).
