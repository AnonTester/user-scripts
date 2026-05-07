// ==UserScript==
// @name         Immich quick rotate and save
// @namespace    https://immich.app/
// @icon         data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACIUlEQVQ4T3VTv2/TUBC+e47THxSpK5v7L5iAuuVZYurUslJRS/wBSSREBojiioGRZEVCpRsDUoMC7QKqm4GFlgbEWtVBlVigsUBQkcTvuGcR10nDSZbt83ff3fe9M8KE6MucRKCqIpL6s0D0+VbP+AeNcTiOJ87komVQ73gScYTCmfH3NVkSFwgG0nYVwcYkAiAsZlsH9QsE37zXrkHqMQNCheBnj95sTp20NoDASoNNIZbhnqoBdwDEOi59qGHX27FUNBgZmTUHcPqlNPv56RoSLQ9JxA21ImyxNXxHIRzsVptbSkECGumI6E63qg4QrRFCkC3DOqlzecjm4mm12eXk/IguASEN6FlWZBqXHy7t9eTVQwFQM8rkMTaRxQaG+L3SZEGpUFS7Y+b2Arjitz0M9Rd9MtPlnkx3T2R0K692FZDkcYKP6lLprpmTbF5hKjNnvXuAnSGQduzjdHedjyV8ZROz/X7hibnw8gUs8PFRPGKagLbtIpNWedRYqh6dq31AsxTvweKjM6v/J9odFutcf+7E/ZS7X+NHBkIbFHQgIwIYDJhE8KUa4DTCmODa+u+CokiDkxBoFN/nb+nOI7twDqAi5Bv1/xIgoL/v3ObODJwUIkUgPZr/Cb8O0xJ0zdH1yko400kWJ8UTsEsOOM+D5F+Y5EMsQ65aY1Mkxf8MHZ3P9n64CCJPfKyKZuvxLry96YKh8kBGGyDa1OYNq/4CqB/zUEwubakAAAAASUVORK5CYII=
// @version      1.2.1
// @description  Immich userscript. R rotates clockwise and saves; Shift+R rotates counterclockwise and saves. Adds overlay rotate buttons.
// @author       AnonTester
// @homepageURL  https://github.com/AnonTester/user-scripts
// @supportURL   https://github.com/AnonTester/user-scripts/issues
// @updateURL    https://raw.githubusercontent.com/AnonTester/user-scripts/main/immich/rotate.js
// @downloadURL  https://raw.githubusercontent.com/AnonTester/user-scripts/main/immich/rotate.js
// @match        http://*/*
// @match        https://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const DEFAULT_ALLOWED_PATTERNS = [
    '*://*',
  ];

  const CONFIG_STORE_KEY = 'immichRotateAllowedPatterns';

  function getAllowedPatterns() {
    const saved = GM_getValue(CONFIG_STORE_KEY, null);

    if (Array.isArray(saved) && saved.length > 0) {
      return saved;
    }

    return DEFAULT_ALLOWED_PATTERNS;
  }

  function setAllowedPatterns(patterns) {
    GM_setValue(
      CONFIG_STORE_KEY,
      patterns
        .map((p) => String(p).trim())
        .filter(Boolean),
    );
  }

  function wildcardToRegExp(pattern) {
    const escaped = String(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*');

    return new RegExp(`^${escaped}$`);
  }

  function isAllowedImmichUrl(url = location.href) {
    return getAllowedPatterns().some((pattern) => wildcardToRegExp(pattern).test(url));
  }

  if (!isAllowedImmichUrl()) {
    return;
  }

  if (!document.title.toLowerCase().includes('immich') && !location.pathname.match(/\/(albums|photos|library)/)) {
    return;
  }

  GM_registerMenuCommand('Immich Rotate: configure URL patterns', () => {
    const current = getAllowedPatterns();

    const input = prompt(
      [
        'Enter the local Immich URL pattern.',
        '',
        'Examples:',
        'https://immich.example.com/*',
        'https://photos.example.net/albums*',
        '*://immich.sub.example.org/*',
        'http://192.168.1.50:2283/*',
        '',
        'Current patterns:',
      ].join('\n'),
      current.join('\n'),
    );

    if (input === null) return;

    const patterns = input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (patterns.length === 0) {
      alert('No patterns saved. Keeping previous configuration.');
      return;
    }

    setAllowedPatterns(patterns);

    alert('Immich Move URL patterns saved. Reload the Immich page.');
  });

  const CONFIG = {
    debug: false,

    // Faster polling. Increase slightly if your Immich host is slow.
    pollMs: 25,
    editorOpenTimeoutMs: 1200,
    rotateTimeoutMs: 1200,
    saveTimeoutMs: 1200,

    afterRotateClickMs: 40,

    buttonTopPx: 220,
    buttonRightPx: 18,
    zIndex: 999999,

    /**
     * Strict photo viewer routes.
     *
     * Add more regexes here if you also want album photo URLs, for example:
     *   /^\/albums\/[^/]+\/photos\/[^/]+\/?$/
     */
    photoRoutePatterns: [
      /^\/photos\/[^/]+\/?$/,
      /^\/albums\/[^/]+\/photos\/[^/]+\/?$/,
    ],
  };

  let busy = false;
  let overlay = null;
  let routeTick = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(...args) {
    if (CONFIG.debug) console.log('[Immich quick rotate]', ...args);
  }

  function warn(...args) {
    console.warn('[Immich quick rotate]', ...args);
  }

  function currentPath() {
    return window.location.pathname;
  }

  function isPhotoViewerRoute() {
    const path = currentPath();
    return CONFIG.photoRoutePatterns.some((re) => re.test(path));
  }

  function isTypingTarget(el = document.activeElement) {
    if (!el) return false;

    const tag = el.tagName?.toLowerCase();

    return (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      el.isContentEditable ||
      el.closest?.('[contenteditable="true"]')
    );
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;

    const style = getComputedStyle(el);

    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0'
    ) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function labelOf(el) {
    return [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-test-id'),
      el.getAttribute('data-cy'),
      el.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function candidates() {
    return [...document.querySelectorAll('button, [role="button"], a')]
      .filter(isVisible)
      .filter((el) => !el.closest('#immich-quick-rotate-overlay'));
  }

  function findButton({ include = [], exclude = [] }) {
    return (
      candidates().find((el) => {
        const label = labelOf(el).toLowerCase();

        return (
          include.some((re) => re.test(label)) &&
          !exclude.some((re) => re.test(label))
        );
      }) || null
    );
  }

  function dumpButtons() {
    const labels = candidates()
      .map((el) => labelOf(el))
      .filter(Boolean)
      .slice(0, 120);

    warn('visible button labels:', labels);
  }

  function findEditButton() {
    return findButton({
      include: [
        /\bedit\b/i,
        /\beditor\b/i,
        /\bcrop\b/i,
        /\badjust\b/i,
      ],
      exclude: [
        /description/i,
        /date/i,
        /location/i,
        /album/i,
      ],
    });
  }

  function findSaveButton() {
    return findButton({
      include: [
        /\bsave\b/i,
        /\bdone\b/i,
        /\bapply\b/i,
        /\bconfirm\b/i,
      ],
      exclude: [
        /as album/i,
        /search/i,
      ],
    });
  }

  function findRotateButton(direction) {
    if (direction === 'clockwise') {
      return findButton({
        include: [
          /rotate.*clockwise/i,
          /clockwise/i,
          /rotate.*right/i,
          /right.*rotate/i,
          /rotate.*90.*right/i,
          /↷/,
        ],
        exclude: [
          /counter/i,
          /anti/i,
          /left/i,
          /back/i,
          /undo/i,
        ],
      });
    }

    return findButton({
      include: [
        /rotate.*counter/i,
        /counter.*clockwise/i,
        /anti.*clockwise/i,
        /rotate.*left/i,
        /left.*rotate/i,
        /rotate.*90.*left/i,
        /↶/,
      ],
      exclude: [
        /right/i,
        /redo/i,
      ],
    });
  }

  function editorLikelyOpen() {
    return Boolean(
      findRotateButton('clockwise') ||
      findRotateButton('counterclockwise') ||
      findSaveButton()
    );
  }

  async function waitFor(fn, timeoutMs) {
    const start = performance.now();

    while (performance.now() - start < timeoutMs) {
      const result = fn();
      if (result) return result;
      await sleep(CONFIG.pollMs);
    }

    return null;
  }

  function clickButton(button, name) {
    if (!button) return false;

    log(`clicking ${name}:`, labelOf(button), button);

    button.scrollIntoView?.({
      block: 'center',
      inline: 'center',
      behavior: 'instant',
    });

    button.click();
    return true;
  }

  async function ensureEditorOpen() {
    if (editorLikelyOpen()) return true;

    const editButton = findEditButton();

    if (!editButton) {
      warn('Could not find Immich Edit button.');
      dumpButtons();
      return false;
    }

    clickButton(editButton, 'edit');

    const opened = await waitFor(
      () => editorLikelyOpen(),
      CONFIG.editorOpenTimeoutMs
    );

    if (!opened) {
      warn('Clicked Edit, but editor did not appear.');
      dumpButtons();
      return false;
    }

    return true;
  }

  async function rotateAndSave(direction) {
    if (busy) return;
    if (!isPhotoViewerRoute()) return;
    if (isTypingTarget()) return;

    busy = true;

    try {
      const opened = await ensureEditorOpen();
      if (!opened) return;

      const rotateButton = await waitFor(
        () => findRotateButton(direction),
        CONFIG.rotateTimeoutMs
      );

      if (!rotateButton) {
        warn(`Could not find ${direction} rotate button.`);
        dumpButtons();
        return;
      }

      clickButton(rotateButton, `${direction} rotate`);

      // Tiny delay gives Immich/Svelte time to update editor state before save.
      await sleep(CONFIG.afterRotateClickMs);

      const saveButton = await waitFor(
        () => findSaveButton(),
        CONFIG.saveTimeoutMs
      );

      if (!saveButton) {
        warn('Could not find Save/Done/Apply button.');
        dumpButtons();
        return;
      }

      clickButton(saveButton, 'save');
    } finally {
      busy = false;
    }
  }

  function makeButton(label, title, onClick) {
    const button = document.createElement('button');

    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);

    Object.assign(button.style, {
      width: '44px',
      height: '44px',
      borderRadius: '9999px',
      border: '1px solid rgba(255,255,255,0.25)',
      background: 'rgba(20,20,20,0.72)',
      color: 'white',
      fontSize: '24px',
      lineHeight: '40px',
      cursor: 'pointer',
      boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
      backdropFilter: 'blur(6px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      userSelect: 'none',
      marginBottom: '10px',
    });

    button.addEventListener('mouseenter', () => {
      button.style.background = 'rgba(40,40,40,0.9)';
    });

    button.addEventListener('mouseleave', () => {
      button.style.background = 'rgba(20,20,20,0.72)';
    });

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });

    return button;
  }

  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) return overlay;
    if (!document.body) return null;

    overlay = document.createElement('div');
    overlay.id = 'immich-quick-rotate-overlay';

    Object.assign(overlay.style, {
      position: 'fixed',
      top: `${CONFIG.buttonTopPx}px`,
      right: `${CONFIG.buttonRightPx}px`,
      zIndex: String(CONFIG.zIndex),
      display: 'none',
      flexDirection: 'column',
      alignItems: 'center',
      pointerEvents: 'auto',
    });

    overlay.appendChild(
      makeButton(
        '↶',
        'Rotate counterclockwise and save — Shift+R',
        () => rotateAndSave('counterclockwise')
      )
    );

    overlay.appendChild(
      makeButton(
        '↷',
        'Rotate clockwise and save — R',
        () => rotateAndSave('clockwise')
      )
    );

    document.body.appendChild(overlay);
    return overlay;
  }

  function updateOverlayVisibility() {
    const el = ensureOverlay();
    if (!el) return;

    el.style.display = isPhotoViewerRoute() ? 'flex' : 'none';
  }

  function onRouteMaybeChanged() {
    routeTick++;
    const thisTick = routeTick;

    // Hide immediately when leaving a photo route.
    updateOverlayVisibility();

    // Then re-check after Svelte has rendered the next page.
    requestAnimationFrame(() => {
      if (thisTick === routeTick) updateOverlayVisibility();
    });

    setTimeout(() => {
      if (thisTick === routeTick) updateOverlayVisibility();
    }, 100);
  }

  function patchHistoryMethod(method) {
    const original = history[method];

    history[method] = function patchedHistoryMethod(...args) {
      const result = original.apply(this, args);
      onRouteMaybeChanged();
      return result;
    };
  }

  patchHistoryMethod('pushState');
  patchHistoryMethod('replaceState');

  window.addEventListener('popstate', onRouteMaybeChanged);
  window.addEventListener('hashchange', onRouteMaybeChanged);

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented) return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (isTypingTarget(event.target)) return;
      if (!isPhotoViewerRoute()) return;

      if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        event.stopPropagation();

        rotateAndSave(event.shiftKey ? 'counterclockwise' : 'clockwise');
      }

      // Do not intercept "e"; Immich can keep handling editor open itself.
    },
    true
  );

  function start() {
    ensureOverlay();
    updateOverlayVisibility();

    const observer = new MutationObserver(() => {
      // This catches Immich SPA transitions that do not trigger popstate/hashchange.
      updateOverlayVisibility();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    log('loaded');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();