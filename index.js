/**
 * PAGE HIGHLIGHTER
 * Run this in your browser's DevTools console (F12 → Console tab).
 * - Select any text on the page, then press Alt+H (or click the toolbar button)
 * - Highlights are saved to localStorage and restored on every page load/refresh
 * - Click any highlight to remove it
 *
 * PERSISTENCE STRATEGY:
 *   Each highlight stores the matched text + ~80 chars of surrounding context
 *   (prefix & suffix). On restore, it first tries to find "prefix+text+suffix"
 *   in the page's full text content, then falls back to just "text" alone.
 *   This tolerates minor page edits while still finding the right occurrence.
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
      mark.className  = HIGHLIGHT_CLASS;
      mark.dataset.hlId = id;
      mark.title      = 'Click to remove highlight';
      mark.textContent = highlighted;
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

    // Try with context first (most precise)
    const contextStr = prefix + text + suffix;
    let idx = fullText.indexOf(contextStr);
    let textStart, textEnd;

    if (idx !== -1) {
      textStart = idx + prefix.length;
      textEnd   = textStart + text.length;
    } else {
      // Fallback: bare text search
      idx = fullText.indexOf(text);
      if (idx === -1) return false;   // text no longer exists on page
      textStart = idx;
      textEnd   = idx + text.length;
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
    const text = sel.toString().trim();
    if (text.length < 2) { toast('Selection too short'); return; }

    const { fullText } = buildTextMap();
    const idx = fullText.indexOf(text);
    const prefix = idx > -1 ? fullText.slice(Math.max(0, idx - CONTEXT_LEN), idx) : '';
    const suffix = idx > -1 ? fullText.slice(idx + text.length, idx + text.length + CONTEXT_LEN) : '';

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
