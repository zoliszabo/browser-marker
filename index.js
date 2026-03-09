/**
 * PAGE HIGHLIGHTER
 * Run this in your browser's DevTools console (F12 → Console tab).
 * - Select any text on the page, then press Alt+H (or click the toolbar button)
 * - Highlights are saved to localStorage and restored on every page load/refresh
 * - Click any highlight to remove it
 *
 * PERSISTENCE STRATEGY:
 *   Each highlight stores the matched text + ~80 chars of surrounding context
 *   (prefix & suffix). On restore, it first tries to anchor via prefix, then
 *   falls back to bare text search. \r\n in cross-element selections is handled
 *   by splitting on newlines and finding parts sequentially in the text map.
 */

(function () {
  'use strict';

  /* ─── Config ─────────────────────────────────────────────── */
  const HIGHLIGHT_COLOR  = '#ffe066';
  const HIGHLIGHT_CLASS  = '_hl_mark_';
  const CONTEXT_LEN      = 80;          // chars of prefix/suffix context to save
  const STORAGE_KEY      = '_hl_' + btoa(encodeURIComponent(location.href))
                               .replace(/[^a-zA-Z0-9]/g, '').slice(0, 60);

  /* ─── Styles ─────────────────────────────────────────────── */
  if (!document.getElementById('_hl_styles_')) {
    const s = document.createElement('style');
    s.id = '_hl_styles_';
    s.textContent = `
      .${HIGHLIGHT_CLASS} {
        background: ${HIGHLIGHT_COLOR} !important;
        color: inherit !important;
        border-radius: 2px;
        padding: 0 1px;
        cursor: pointer;
        transition: background 0.15s;
      }
      .${HIGHLIGHT_CLASS}:hover {
        background: #ffc800 !important;
        outline: 1px dashed #a07800;
      }
    `;
    document.head.appendChild(s);
  }

  /* ─── Storage helpers ────────────────────────────────────── */
  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch { return []; }
  }
  function save(list) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  /* ─── Text normalisation ─────────────────────────────────── */
  /**
   * Normalise line endings and strip leading/trailing whitespace per line.
   * selection.toString() returns \r\n between block elements on Windows,
   * but text nodes in the DOM are concatenated with no separator at all.
   * We store/search a \n-normalised form and match parts sequentially.
   */
  function normalizeText(s) {
    return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  /* ─── Smart text finder ──────────────────────────────────── */
  /**
   * Find `needle` inside `fullText`, tolerating the absence of \n between
   * text-node boundaries (the gap where block elements meet).
   *
   * Algorithm:
   *  - Split needle on \n into parts (trimming per-line whitespace).
   *  - Find the first part, then each subsequent part, allowing a short
   *    gap in fullText for whitespace-only text nodes between elements.
   *  - Returns {start, end} of the matched range in fullText, or null.
   *
   * `searchFrom` lets callers restrict the search to a window of fullText.
   */
  function findText(fullText, needle, searchFrom = 0) {
    const n = normalizeText(needle);

    if (!n.includes('\n')) {
      const i = fullText.indexOf(n, searchFrom);
      return i === -1 ? null : { start: i, end: i + n.length };
    }

    // Multi-line path: split and match parts sequentially.
    const parts = n.split('\n').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return null;

    let from = searchFrom;
    while (from < fullText.length) {
      const fi = fullText.indexOf(parts[0], from);
      if (fi === -1) return null;

      let pos = fi + parts[0].length;
      let ok  = true;

      for (let i = 1; i < parts.length; i++) {
        const ni = fullText.indexOf(parts[i], pos);
        // Allow up to 30 chars of gap (whitespace text nodes between blocks).
        if (ni === -1 || ni - pos > 30) { ok = false; break; }
        pos = ni + parts[i].length;
      }

      if (ok) return { start: fi, end: pos };
      from = fi + 1;
    }
    return null;
  }

  /* ─── DOM text map ───────────────────────────────────────── */
  /**
   * Walk all visible text nodes in <body> and build:
   *   fullText  – one long string of all text concatenated
   *   nodeMap   – [{node, start, end}] parallel array
   */
  function buildTextMap() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const p = node.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'textarea'].includes(tag))
            return NodeFilter.FILTER_REJECT;
          // Don't re-walk nodes already inside a highlight span
          if (p.classList && p.classList.contains(HIGHLIGHT_CLASS))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    let fullText = '';
    const nodeMap = [];
    let n;
    while ((n = walker.nextNode())) {
      const start = fullText.length;
      fullText += n.textContent;
      nodeMap.push({ node: n, start, end: fullText.length });
    }
    return { fullText, nodeMap };
  }

  /* ─── Apply highlight to a text range ────────────────────── */
  /**
   * Wraps characters [globalStart, globalEnd) across one or more text nodes
   * in <mark class="HIGHLIGHT_CLASS"> elements.
   */
  function applyRange(nodeMap, globalStart, globalEnd, id) {
    // Iterate in reverse so replacing nodes doesn't break earlier indices
    const overlapping = nodeMap.filter(
      ({ start, end }) => end > globalStart && start < globalEnd
    ).reverse();

    for (const { node, start: nStart, end: nEnd } of overlapping) {
      const localStart = Math.max(0, globalStart - nStart);
      const localEnd   = Math.min(nEnd - nStart, globalEnd - nStart);
      const text       = node.textContent;

      const before      = text.slice(0, localStart);
      const highlighted = text.slice(localStart, localEnd);
      const after       = text.slice(localEnd);

      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));

      const mark = document.createElement('mark');
      mark.className    = HIGHLIGHT_CLASS;
      mark.dataset.hlId = id;
      mark.title        = 'Click to remove highlight';
      mark.textContent  = highlighted;
      mark.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeById(id);
      });
      frag.appendChild(mark);

      if (after) frag.appendChild(document.createTextNode(after));
      node.parentNode.replaceChild(frag, node);
    }
  }

  /* ─── Find & highlight one saved entry ───────────────────── */
  function restoreOne({ id, text, prefix, suffix }) {
    // Already applied?
    if (document.querySelector(`[data-hl-id="${id}"]`)) return true;

    const { fullText, nodeMap } = buildTextMap();
    let textStart, textEnd;

    // Strategy 1: anchor via prefix (most precise, handles duplicates well).
    if (prefix) {
      const prefixIdx = fullText.indexOf(prefix);
      if (prefixIdx !== -1) {
        const searchFrom = prefixIdx + prefix.length;
        // text should start very close to searchFrom
        const result = findText(fullText, text, searchFrom);
        if (result && result.start - searchFrom <= 10) {
          textStart = result.start;
          textEnd   = result.end;
        }
      }
    }

    // Strategy 2: bare text search fallback.
    if (textStart === undefined) {
      const result = findText(fullText, text);
      if (!result) return false;   // text no longer exists on page
      textStart = result.start;
      textEnd   = result.end;
    }

    applyRange(nodeMap, textStart, textEnd, id);
    return true;
  }

  /* ─── Remove a highlight by id ───────────────────────────── */
  function removeById(id) {
    document.querySelectorAll(`[data-hl-id="${id}"]`).forEach(mark => {
      const text = document.createTextNode(mark.textContent);
      mark.parentNode.replaceChild(text, mark);
      text.parentNode.normalize();
    });
    const list = load().filter(h => h.id !== id);
    save(list);
    toast('Highlight removed');
  }

  /* ─── Save + apply a new selection ───────────────────────── */
  function highlightSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { toast('Select some text first'); return; }

    // Normalise the raw selection string before storing/searching.
    const text = normalizeText(sel.toString().trim());
    if (text.length < 2) { toast('Selection too short'); return; }

    const { fullText } = buildTextMap();
    const match  = findText(fullText, text);
    const prefix = match ? fullText.slice(Math.max(0, match.start - CONTEXT_LEN), match.start) : '';
    const suffix = match ? fullText.slice(match.end, match.end + CONTEXT_LEN) : '';

    const list = load();
    // Deduplicate
    if (list.some(h => h.text === text && h.prefix === prefix)) {
      toast('Already highlighted!');
      return;
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    list.push({ id, text, prefix, suffix, savedAt: Date.now() });
    save(list);

    restoreOne({ id, text, prefix, suffix });
    sel.removeAllRanges();
    toast('✓ Highlighted & saved');
  }

  /* ─── Restore all saved highlights ───────────────────────── */
  function restoreAll() {
    load().forEach(h => restoreOne(h));
  }

  /* ─── Toast notification ─────────────────────────────────── */
  function toast(msg) {
    let el = document.getElementById('_hl_toast_');
    if (!el) {
      el = document.createElement('div');
      el.id = '_hl_toast_';
      Object.assign(el.style, {
        position: 'fixed', bottom: '24px', right: '24px',
        background: '#1a1a1a', color: '#fff',
        padding: '9px 16px', borderRadius: '7px',
        fontSize: '13px', fontFamily: 'system-ui, sans-serif',
        zIndex: '2147483647', opacity: '0',
        transition: 'opacity 0.25s', pointerEvents: 'none',
        boxShadow: '0 4px 14px rgba(0,0,0,0.35)'
      });
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = '0'; }, 2400);
  }

  /* ─── Toolbar ─────────────────────────────────────────────── */
  function buildToolbar() {
    if (document.getElementById('_hl_toolbar_')) return;

    const bar = document.createElement('div');
    bar.id = '_hl_toolbar_';
    Object.assign(bar.style, {
      position: 'fixed', top: '12px', right: '12px',
      display: 'flex', alignItems: 'center', gap: '6px',
      background: '#fff', border: '1px solid #ddd',
      borderRadius: '9px', padding: '6px 10px',
      boxShadow: '0 3px 12px rgba(0,0,0,0.15)',
      zIndex: '2147483647',
      fontFamily: 'system-ui, sans-serif', fontSize: '13px'
    });

    const btn = (label, title, onclick, bg = '#f5f5f5') => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.onclick = onclick;
      Object.assign(b.style, {
        padding: '4px 10px', cursor: 'pointer',
        border: '1px solid #ccc', borderRadius: '5px',
        background: bg, fontSize: '13px', lineHeight: '1.4'
      });
      return b;
    };

    bar.appendChild(Object.assign(document.createElement('span'), {
      textContent: '🖊',
      title: 'Page Highlighter (Alt+H)'
    }));
    bar.appendChild(btn('Highlight', 'Highlight selected text (Alt+H)', highlightSelection, '#fff8d6'));
    bar.appendChild(btn('Clear all', 'Remove all highlights on this page', () => {
      if (confirm(`Remove all ${load().length} highlight(s) on this page?`)) {
        localStorage.removeItem(STORAGE_KEY);
        document.querySelectorAll('.' + HIGHLIGHT_CLASS).forEach(mark => {
          const tn = document.createTextNode(mark.textContent);
          mark.parentNode.replaceChild(tn, mark);
        });
        document.body.normalize();
        toast('All highlights cleared');
      }
    }));
    bar.appendChild(btn('✕', 'Hide toolbar (re-run script to show again)', () => bar.remove()));

    document.body.appendChild(bar);
  }

  /* ─── Keyboard shortcut: Alt+H ───────────────────────────── */
  document.addEventListener('keydown', e => {
    if (e.altKey && e.key === 'h') { e.preventDefault(); highlightSelection(); }
  });

  /* ─── Boot ───────────────────────────────────────────────── */
  buildToolbar();
  restoreAll();
  toast(`Highlighter active — select text & press Alt+H  (${load().length} saved)`);

})();
