// ---------------------------------------------------------------------------
// ATLAS — Searchable Combobox Component
// ---------------------------------------------------------------------------
// Replaces native <select> elements with a searchable dropdown that scales
// to 1000+ entries. Supports keyboard navigation, filtering, and works
// seamlessly with the existing path-select styling.
//
// Usage:
//   const combo = new SearchableCombo(containerEl, {
//     placeholder: 'Select node...',
//     emptyValue: '',           // value when nothing selected
//     onSelect: (value, label) => { ... },
//   });
//   combo.setOptions([{ value: 'PE-1', label: 'PE-1' }, ...]);
//   combo.getValue();
//   combo.setValue('PE-1');
// ---------------------------------------------------------------------------

class SearchableCombo {
  constructor(container, opts = {}) {
    this.container = container;
    this.placeholder = opts.placeholder || 'Search...';
    this.emptyValue = opts.emptyValue ?? '';
    this.onSelect = opts.onSelect || null;
    this.options = []; // [{ value, label }]
    this.filtered = [];
    this.selectedValue = this.emptyValue;
    this.selectedLabel = '';
    this.highlightIdx = -1;
    this.isOpen = false;

    this._build();
    this._wireEvents();
  }

  _build() {
    this.container.classList.add('combo-container');
    this.container.innerHTML = `
      <input type="text" class="combo-input path-select" placeholder="${this.placeholder}" autocomplete="off" />
      <div class="combo-dropdown"></div>
    `;
    this.input = this.container.querySelector('.combo-input');
    this.dropdown = this.container.querySelector('.combo-dropdown');
  }

  _wireEvents() {
    // Focus → open dropdown
    this.input.addEventListener('focus', () => {
      this.input.select();
      this._filter(this.input.value);
      this._open();
    });

    // Typing → filter
    this.input.addEventListener('input', () => {
      this._filter(this.input.value);
      this._open();
    });

    // Keyboard navigation
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._moveHighlight(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._moveHighlight(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.highlightIdx >= 0 && this.highlightIdx < this.filtered.length) {
          this._select(this.filtered[this.highlightIdx]);
        }
        this._close();
      } else if (e.key === 'Escape') {
        this._close();
        // Restore previous selection
        this.input.value = this.selectedLabel;
      } else if (e.key === 'Tab') {
        this._close();
      }
    });

    // Blur → close (with delay for click to register)
    this.input.addEventListener('blur', () => {
      setTimeout(() => {
        this._close();
        // If input doesn't match a selection, restore
        if (this.input.value !== this.selectedLabel) {
          this.input.value = this.selectedLabel;
        }
      }, 200);
    });
  }

  _filter(query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) {
      this.filtered = this.options.slice(0, 100); // Show first 100 when empty
    } else {
      // Prioritize starts-with, then contains
      const starts = [];
      const contains = [];
      for (const opt of this.options) {
        const lbl = opt.label.toLowerCase();
        if (lbl.startsWith(q)) starts.push(opt);
        else if (lbl.includes(q)) contains.push(opt);
      }
      this.filtered = [...starts, ...contains].slice(0, 50);
    }
    this.highlightIdx = -1;
    this._renderDropdown();
  }

  _renderDropdown() {
    if (this.filtered.length === 0) {
      this.dropdown.innerHTML = '<div class="combo-empty">No matches</div>';
      return;
    }

    this.dropdown.innerHTML = this.filtered.map((opt, i) => {
      const selected = opt.value === this.selectedValue ? ' combo-selected' : '';
      const highlighted = i === this.highlightIdx ? ' combo-highlighted' : '';
      return `<div class="combo-option${selected}${highlighted}" data-idx="${i}" data-value="${this._esc(opt.value)}">${this._esc(opt.label)}</div>`;
    }).join('');

    // Wire click on options
    this.dropdown.querySelectorAll('.combo-option').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevent blur
        const idx = parseInt(el.dataset.idx, 10);
        this._select(this.filtered[idx]);
        this._close();
      });
    });

    // Show count if truncated
    if (this.options.length > this.filtered.length) {
      this.dropdown.innerHTML += `<div class="combo-count">${this.filtered.length} of ${this.options.length}</div>`;
    }
  }

  _moveHighlight(direction) {
    if (this.filtered.length === 0) return;
    this.highlightIdx += direction;
    if (this.highlightIdx < 0) this.highlightIdx = this.filtered.length - 1;
    if (this.highlightIdx >= this.filtered.length) this.highlightIdx = 0;
    this._renderDropdown();

    // Scroll highlighted item into view
    const highlighted = this.dropdown.querySelector('.combo-highlighted');
    if (highlighted) highlighted.scrollIntoView({ block: 'nearest' });
  }

  _select(opt) {
    if (!opt) return;
    this.selectedValue = opt.value;
    this.selectedLabel = opt.label;
    this.input.value = opt.label;

    if (this.onSelect) this.onSelect(opt.value, opt.label);
  }

  _open() {
    this.isOpen = true;
    this.dropdown.classList.add('open');
  }

  _close() {
    this.isOpen = false;
    this.dropdown.classList.remove('open');
  }

  // ── Public API ──

  setOptions(options) {
    this.options = options; // [{ value, label }]
    this.filtered = options.slice(0, 100);
    if (this.isOpen) this._renderDropdown();
  }

  getValue() {
    return this.selectedValue;
  }

  setValue(value) {
    const opt = this.options.find(o => o.value === value);
    if (opt) {
      this.selectedValue = opt.value;
      this.selectedLabel = opt.label;
      this.input.value = opt.label;
    } else {
      this.selectedValue = this.emptyValue;
      this.selectedLabel = '';
      this.input.value = '';
    }
  }

  clear() {
    this.selectedValue = this.emptyValue;
    this.selectedLabel = '';
    this.input.value = '';
  }

  _esc(str) {
    const div = document.createElement('div');
    div.textContent = String(str ?? '');
    return div.innerHTML;
  }
}
