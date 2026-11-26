/* ==========================================================================
   QUANTUM CORE // Accessible Command Palette (Ctrl+K / Cmd+K)
   WAI-ARIA dialog with keyboard navigation, live filter, and focus restoration
   ========================================================================== */

(function (global) {
  'use strict';

  class CommandPalette {
    constructor({ backdropEl, inputEl, listEl, motion, getCommands }) {
      this.backdrop = backdropEl;
      this.input = inputEl;
      this.list = listEl;
      this.motion = motion;
      this.getCommands = getCommands;

      this.isOpen = false;
      this.selectedIdx = 0;
      this.filtered = [];
      this.previousFocus = null;

      this._bind();
    }

    _bind() {
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          if (this.isOpen) this.close();
          else this.open();
        } else if (this.isOpen && e.key === 'Escape') {
          e.preventDefault();
          this.close();
        }
      });

      this.backdrop.addEventListener('click', (e) => {
        if (e.target === this.backdrop) this.close();
      });

      this.input.addEventListener('input', () => {
        this.selectedIdx = 0;
        this._renderList();
      });

      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (this.filtered.length > 0) {
            this.selectedIdx = (this.selectedIdx + 1) % this.filtered.length;
            this._renderList();
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (this.filtered.length > 0) {
            this.selectedIdx = (this.selectedIdx - 1 + this.filtered.length) % this.filtered.length;
            this._renderList();
          }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          const cmd = this.filtered[this.selectedIdx];
          if (cmd) this._execute(cmd);
        }
      });

      this.list.addEventListener('click', (e) => {
        const btn = e.target.closest('.cmd-item');
        if (!btn) return;
        const idx = parseInt(btn.dataset.idx, 10);
        if (this.filtered[idx]) this._execute(this.filtered[idx]);
      });
    }

    open() {
      this.previousFocus = document.activeElement;
      this.isOpen = true;
      this.selectedIdx = 0;
      this.input.value = '';
      this.backdrop.classList.remove('hidden');
      this._renderList();
      this.input.focus();
      const card = this.backdrop.querySelector('.cmd-modal');
      if (this.motion && card) this.motion.animateModalOpen(card);
    }

    close() {
      this.isOpen = false;
      this.backdrop.classList.add('hidden');
      if (this.previousFocus && typeof this.previousFocus.focus === 'function') {
        this.previousFocus.focus();
      }
    }

    _execute(cmd) {
      this.close();
      cmd.run();
    }

    _renderList() {
      const q = this.input.value.trim().toLowerCase();
      const all = this.getCommands();
      this.filtered = q
        ? all.filter((c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q))
        : all;

      if (this.filtered.length === 0) {
        this.list.innerHTML = '<div class="muted" style="padding:12px;text-align:center;">Không tìm thấy lệnh phù hợp.</div>';
        return;
      }

      this.list.innerHTML = this.filtered
        .map(
          (c, i) => `
          <button type="button" class="cmd-item ${i === this.selectedIdx ? 'selected' : ''}" data-idx="${i}" role="option" aria-selected="${i === this.selectedIdx}">
            <span>${c.label}</span>
            <span class="cmd-item-cat">${c.category}</span>
          </button>`
        )
        .join('');
    }
  }

  global.QuantumCommandPalette = CommandPalette;
})(window);
