// ==UserScript==
// @name         Immich Move to Album
// @namespace    https://immich.app/
// @icon         data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACIUlEQVQ4T3VTv2/TUBC+e47THxSpK5v7L5iAuuVZYurUslJRS/wBSSREBojiioGRZEVCpRsDUoMC7QKqm4GFlgbEWtVBlVigsUBQkcTvuGcR10nDSZbt83ff3fe9M8KE6MucRKCqIpL6s0D0+VbP+AeNcTiOJ87komVQ73gScYTCmfH3NVkSFwgG0nYVwcYkAiAsZlsH9QsE37zXrkHqMQNCheBnj95sTp20NoDASoNNIZbhnqoBdwDEOi59qGHX27FUNBgZmTUHcPqlNPv56RoSLQ9JxA21ImyxNXxHIRzsVptbSkECGumI6E63qg4QrRFCkC3DOqlzecjm4mm12eXk/IguASEN6FlWZBqXHy7t9eTVQwFQM8rkMTaRxQaG+L3SZEGpUFS7Y+b2Arjitz0M9Rd9MtPlnkx3T2R0K692FZDkcYKP6lLprpmTbF5hKjNnvXuAnSGQduzjdHedjyV8ZROz/X7hibnw8gUs8PFRPGKagLbtIpNWedRYqh6dq31AsxTvweKjM6v/J9odFutcf+7E/ZS7X+NHBkIbFHQgIwIYDJhE8KUa4DTCmODa+u+CokiDkxBoFN/nb+nOI7twDqAi5Bv1/xIgoL/v3ObODJwUIkUgPZr/Cb8O0xJ0zdH1yko400kWJ8UTsEsOOM+D5F+Y5EMsQ65aY1Mkxf8MHZ3P9n64CCJPfKyKZuvxLry96YKh8kBGGyDa1OYNq/4CqB/zUEwubakAAAAASUVORK5CYII=
// @version      1.0.1
// @description  Move selected/current Immich assets to another album using Immich's native add-to-album modal, then remove them from the current album.
// @author       AnonTester
// @homepageURL  https://github.com/AnonTester/user-scripts
// @supportURL   https://github.com/AnonTester/user-scripts/issues
// @updateURL    https://raw.githubusercontent.com/AnonTester/user-scripts/main/immich/move-to-album.user.js
// @downloadURL  https://raw.githubusercontent.com/AnonTester/user-scripts/main/immich/move-to-album.user.js
// @match        http://*/*
// @match        https://*/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  /**
   * Immich Move to Album userscript
   *
   * Behaviour:
   * - Press `m`, or click the floating button.
   * - The script triggers Immich's own "Add to album" UI.
   * - After Immich successfully adds the selected/current assets to the chosen album,
   *   the script removes those assets from the album currently shown in the URL.
   *
   * Notes:
   * - This intentionally reuses the native Immich modal instead of recreating one.
   * - Because Immich's frontend DOM may change between releases, the selectors below
   *   are heuristic and may need minor adjustment for future Immich versions.
   */

  const DEFAULT_ALLOWED_PATTERNS = [
    '*://*'
  ];

  const CONFIG_STORE_KEY = 'immichMoveAllowedPatterns';

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

  GM_registerMenuCommand('Immich Move: configure URL patterns', () => {
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
    keyboardShortcut: 'm',

    // UI labels searched in buttons/menu items.
    addToAlbumTerms: [
      'add to album',
      'add to albums',
      'album',
    ],

    moreButtonTerms: [
      'more',
      'more options',
      'actions',
      'menu',
      'options',
      '...',
    ],

    // UUID-style IDs used by Immich assets/albums.
    uuidRegex: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',

    pollMs: 500,
    autoReloadAfterMove: true,
  };

  const state = {
    pendingMove: null,
    lastKnownAssetIds: [],
    currentAlbumId: null,

    learnedAlbumId: null,
    learnedAlbumAt: 0,

    selectedAssetIds: new Set(),
    selectionCacheViewKey: null,
    lastSelectionSeenAt: 0,
    lastScrollAt: 0,
  };

  injectStyles();
  patchFetch();
  installUi();
  installKeyboardShortcut();

  window.addEventListener(
    'scroll',
    () => {
      state.lastScrollAt = Date.now();
    },
    true,
  );

  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      if (state.selectedAssetIds.size === 0) return;

      const clearButton = findClickedClearSelectionButton(target);

      if (!clearButton) return;

      console.debug?.('[Immich Move] Clear-selection button detected; clearing cache.');

      resetSelectionCache('Immich clear-selection button clicked');
      refreshButton();

      // Run again after Immich updates its own UI.
      window.setTimeout(() => {
        resetSelectionCache('Immich clear-selection button clicked after UI update');
        refreshButton();
      }, 250);
    },
    true,
  );

  document.addEventListener(
    'click',
    () => {
      if (state.selectedAssetIds.size === 0) return;

      window.setTimeout(() => {
        const visibleSelectedIds = getVisibleSelectedAssetIds();

        if (
          visibleSelectedIds.length === 0 &&
          !isImmichSelectionModeLikelyActive() &&
          Date.now() - state.lastScrollAt > 1200
        ) {
          resetSelectionCache('selection cleared after click');
          refreshButton();
        }
      }, 300);
    },
    true,
  );

  const observer = new MutationObserver(scheduleRefresh);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

  let refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      refreshButton();
    }, 150);
  }

  window.setInterval(refreshButton, CONFIG.pollMs);
  refreshButton();

  function findClickedClearSelectionButton(target) {
    const button = target.closest('button, [role="button"]');

    if (!button) return null;
    if (button.id === 'immich-move-to-album-button') return null;

    const rect = button.getBoundingClientRect();

    const name = normalizeText(
      [
        button.getAttribute?.('aria-label'),
        button.getAttribute?.('title'),
        button.getAttribute?.('data-testid'),
        button.getAttribute?.('data-test-id'),
        button.textContent,
      ]
        .filter(Boolean)
        .join(' '),
    );

    if (
      name.includes('clear selection') ||
      name.includes('clear selected') ||
      name.includes('deselect') ||
      name.includes('cancel selection') ||
      name.includes('close selection') ||
      name.includes('exit selection') ||
      name === 'x' ||
      name === '×' ||
      name === 'close'
    ) {
      return button;
    }

    // Immich's X can be icon-only.
    // When selection mode is active, the X/back/clear button is usually a small
    // icon button in the upper-left toolbar area.
    const isSmallIcon =
      rect.width > 0 &&
      rect.height > 0 &&
      rect.width <= 64 &&
      rect.height <= 64;

    const isUpperToolbar = rect.top >= 0 && rect.top <= 120;
    const isLeftSide = rect.left >= 0 && rect.left <= window.innerWidth * 0.35;
    const hasIcon = !!button.querySelector?.('svg');

    if (
      state.selectedAssetIds.size > 0 &&
      isSmallIcon &&
      isUpperToolbar &&
      isLeftSide &&
      hasIcon
    ) {
      return button;
    }

    return null;
  }

  function getImmichToolbarSelectionCount() {
    const candidates = [
      ...document.querySelectorAll(
        [
          'header',
          'nav',
          '[role="toolbar"]',
          '[data-testid*="toolbar"]',
          '[class*="toolbar"]',
          '[class*="Toolbar"]',
        ].join(','),
      ),
    ]
      .filter(isVisible)
      .map((el) => normalizeText(el.textContent || ''))
      .filter(Boolean);

    const text = candidates.join(' ');

    // Common forms:
    // "29 selected"
    // "29 assets selected"
    // "selected 29"
    let match =
      text.match(/\b(\d+)\s+(?:assets?|photos?|items?)?\s*selected\b/) ||
      text.match(/\bselected\s+(\d+)\b/) ||
      text.match(/\b(\d+)\s+(?:assets?|photos?|items?)\b/);

    if (!match) return null;

    const value = Number(match[1]);

    return Number.isFinite(value) ? value : null;
  }

  function patchFetch() {
    patchFetchRequests();
    patchXmlHttpRequests();
  }

  function patchFetchRequests() {
    if (window.__immichMoveFetchPatched) return;
    window.__immichMoveFetchPatched = true;

    const originalFetch = window.fetch;

    window.fetch = async function patchedImmichFetch(input, init = {}) {
      const requestInfo = await getRequestInfo(input, init);

      const response = await originalFetch.apply(this, arguments);

      try {
        learnAlbumContextFromRequest(requestInfo, response.clone());
      } catch (error) {
        console.warn('[Immich Move] Failed while learning album context:', error);
      }

      try {
        await maybeHandleAlbumAddResponse(requestInfo, response.clone());
      } catch (error) {
        console.warn('[Immich Move] Failed while handling album-add response:', error);
      }

      return response;
    };
  }

  function patchXmlHttpRequests() {
    if (window.__immichMoveXhrPatched) return;
    window.__immichMoveXhrPatched = true;

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
      this.__immichMoveRequestInfo = {
        method: String(method || 'GET').toUpperCase(),
        url: String(url || ''),
        bodyText: undefined,
      };

      return originalOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function patchedSend(body) {
      if (this.__immichMoveRequestInfo) {
        if (typeof body === 'string') {
          this.__immichMoveRequestInfo.bodyText = body;
        } else if (body instanceof URLSearchParams) {
          this.__immichMoveRequestInfo.bodyText = body.toString();
        } else if (body instanceof FormData) {
          const obj = {};
          for (const [key, value] of body.entries()) {
            obj[key] = value;
          }
          this.__immichMoveRequestInfo.bodyText = JSON.stringify(obj);
        }
      }

      this.addEventListener('loadend', async () => {
        const requestInfo = this.__immichMoveRequestInfo;
        if (!requestInfo) return;

        const responseLike = {
          ok: this.status >= 200 && this.status < 300,
          status: this.status,
          async json() {
            return JSON.parse(this.responseText || 'null');
          },
          async text() {
            return this.responseText || '';
          },
        };

        try {
          await maybeHandleAlbumAddResponse(requestInfo, responseLike);
        } catch (error) {
          console.warn('[Immich Move] Failed while handling XHR album-add response:', error);
        }
      });

      return originalSend.call(this, body);
    };
  }

  async function getRequestInfo(input, init = {}) {
    let url = '';
    let method = 'GET';
    let bodyText;

    if (typeof input === 'string' || input instanceof URL) {
      url = String(input);
      method = init?.method || 'GET';

      if (typeof init?.body === 'string') {
        bodyText = init.body;
      } else if (init?.body instanceof URLSearchParams) {
        bodyText = init.body.toString();
      } else if (init?.body instanceof Blob) {
        bodyText = await init.body.text().catch(() => undefined);
      }
    } else if (input instanceof Request) {
      url = input.url;
      method = init?.method || input.method || 'GET';

      if (typeof init?.body === 'string') {
        bodyText = init.body;
      } else {
        bodyText = await input.clone().text().catch(() => undefined);
      }
    }

    return {
      url,
      method: String(method).toUpperCase(),
      bodyText,
    };
  }

  async function learnAlbumContextFromRequest(requestInfo, response) {
    if (!response.ok) return;

    const albumIdFromUrl = extractAlbumIdFromAnyAlbumEndpoint(requestInfo.url);

    if (albumIdFromUrl && requestInfo.method === 'GET') {
      rememberSourceAlbum(albumIdFromUrl, 'GET album endpoint');
      return;
    }

    // Some Immich responses include album JSON with an id.
    // Only inspect likely album responses to avoid unnecessary parsing.
    const url = new URL(requestInfo.url, window.location.origin);
    if (!url.pathname.includes('/api/albums')) return;

    try {
      const json = await response.json();

      if (json?.id && isUuid(json.id)) {
        rememberSourceAlbum(json.id, 'album JSON response');
      }
    } catch {
      // Ignore non-JSON responses.
    }
  }

  function rememberSourceAlbum(albumId, reason = '') {
    if (!albumId || !isUuid(albumId)) return;

    state.learnedAlbumId = albumId;
    state.learnedAlbumAt = Date.now();
    state.currentAlbumId = albumId;

    console.debug?.('[Immich Move] Learned source album:', albumId, reason);
  }

  function extractAlbumIdFromAnyAlbumEndpoint(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.origin);

      const match = url.pathname.match(
        new RegExp(`/api/albums/(${CONFIG.uuidRegex})(?:/|$)`, 'i'),
      );

      return match?.[1] || null;
    } catch {
      return null;
    }
  }

  async function maybeHandleAlbumAddResponse(requestInfo, response) {
    const pending = state.pendingMove;
    if (!pending) return;

    if (!['PUT', 'POST'].includes(requestInfo.method)) return;

    const targetAlbumId = extractAlbumIdFromAssetEndpoint(requestInfo.url);
    if (!targetAlbumId) return;

    console.debug?.('[Immich Move] Saw album asset add candidate:', {
      method: requestInfo.method,
      url: requestInfo.url,
      targetAlbumId,
      sourceAlbumId: pending.sourceAlbumId,
      pendingAssetCount: pending.assetIds.length,
      bodyText: requestInfo.bodyText,
      status: response.status,
      ok: response.ok,
    });

    const requestIds = parseIdsFromRequestBody(requestInfo.bodyText);

    let relevantIds;

    if (requestIds.length > 0) {
      // Important:
      // Trust Immich's actual add-to-album request body.
      // The userscript's DOM-based selection detection may miss virtualized/off-screen assets.
      relevantIds = [...new Set(requestIds)];

      console.debug?.('[Immich Move] Using asset IDs from Immich add request:', {
        requestIdCount: relevantIds.length,
        pendingIdCount: pending.assetIds.length,
      });
    } else {
      // Fallback only if the request body cannot be inspected.
      relevantIds = [...new Set(pending.assetIds)];

      console.debug?.('[Immich Move] Could not parse add request body; using pending selected assets.', {
        relevantIds,
      });
    }

    if (relevantIds.length === 0) {
      console.debug?.('[Immich Move] No relevant asset IDs found for album add request.');
      return;
    }

    if (!response.ok) {
      notify(`Immich did not add the asset${relevantIds.length === 1 ? '' : 's'} to the target album. Nothing was removed.`, 'error');
      state.pendingMove = null;
      return;
    }

    let confirmedIds = relevantIds;

    try {
      const result = await response.json();

      console.debug?.('[Immich Move] Album add response JSON:', result);

      const successful = extractSuccessfulAssetIdsFromAddResponse(result);

      if (successful.length > 0) {
        // Intersect against the actual Immich request IDs, not the userscript's pending IDs.
        confirmedIds = relevantIds.filter((id) => successful.includes(id));
      }
    } catch {
      console.debug?.('[Immich Move] Album add response was not JSON or could not be parsed; treating HTTP success as success.');
    }

    if (confirmedIds.length === 0) {
      notify('Assets were added, but the script could not confirm which IDs succeeded. Nothing was removed.', 'error');
      state.pendingMove = null;
      return;
    }

    if (!pending.sourceAlbumId) {
      notify('Added to album. No source album was detected, so nothing was removed.', 'info');
      state.pendingMove = null;
      return;
    }

    if (pending.sourceAlbumId === targetAlbumId) {
      notify('Target album is the current album. Nothing was removed.', 'info');
      state.pendingMove = null;
      return;
    }

    console.debug?.('[Immich Move] Removing assets from source album:', {
      sourceAlbumId: pending.sourceAlbumId,
      targetAlbumId,
      confirmedIds,
      confirmedCount: confirmedIds.length,
    });

    const removed = await removeAssetsFromAlbum(pending.sourceAlbumId, confirmedIds);

    state.pendingMove = null;

    if (removed) {
      resetSelectionCache('move completed');

      notify(`Moved ${confirmedIds.length} asset${confirmedIds.length === 1 ? '' : 's'} to album.`, 'success');

      if (CONFIG.autoReloadAfterMove && isCurrentAlbumPage()) {
        // Give Immich and Firefox a moment to settle after the DELETE.
        // This also reduces the harmless "NetworkError when attempting to fetch resource"
        // caused by reloading while Immich still has in-flight requests.
        window.setTimeout(() => window.location.reload(), 1500);
      }
    } else {
      notify('Assets were added to the target album, but removal from the current album failed.', 'error');
    }
  }

  function extractSuccessfulAssetIdsFromAddResponse(result) {
    const ids = new Set();

    if (Array.isArray(result)) {
      for (const row of result) {
        if (!row) continue;

        if (row.id && (row.success === true || row.error === 'duplicate')) {
          ids.add(row.id);
        }

        if (row.assetId && (row.success === true || row.error === 'duplicate')) {
          ids.add(row.assetId);
        }
      }
    }

    if (Array.isArray(result?.results)) {
      for (const row of result.results) {
        if (!row) continue;

        if (row.id && (row.success === true || row.error === 'duplicate')) {
          ids.add(row.id);
        }

        if (row.assetId && (row.success === true || row.error === 'duplicate')) {
          ids.add(row.assetId);
        }
      }
    }

    if (Array.isArray(result?.ids)) {
      for (const id of result.ids) {
        if (isUuid(id)) ids.add(id);
      }
    }

    if (Array.isArray(result?.assetIds)) {
      for (const id of result.assetIds) {
        if (isUuid(id)) ids.add(id);
      }
    }

    return [...ids];
  }

  function extractAlbumIdFromAssetEndpoint(rawUrl) {
    try {
      const url = new URL(rawUrl, window.location.origin);
      const match = url.pathname.match(new RegExp(`/api/albums/(${CONFIG.uuidRegex})/assets$`, 'i'));
      return match?.[1] || null;
    } catch {
      return null;
    }
  }

  function parseIdsFromRequestBody(bodyText) {
    if (!bodyText) return [];

    try {
      const json = JSON.parse(bodyText);

      if (Array.isArray(json?.ids)) return json.ids.filter(isUuid);
      if (Array.isArray(json?.assetIds)) return json.assetIds.filter(isUuid);
      if (Array.isArray(json?.assetIdsToAdd)) return json.assetIdsToAdd.filter(isUuid);
      if (Array.isArray(json?.assetIdsToRemove)) return json.assetIdsToRemove.filter(isUuid);

      const nestedIds = [];

      JSON.stringify(json).replace(
        new RegExp(CONFIG.uuidRegex, 'gi'),
        (match) => {
          if (isUuid(match)) nestedIds.push(match);
          return match;
        },
      );

      return [...new Set(nestedIds)];
    } catch {
      const rawMatches = String(bodyText).match(new RegExp(CONFIG.uuidRegex, 'gi')) || [];
      return [...new Set(rawMatches.filter(isUuid))];
    }
  }

  function getViewKey() {
    return `${location.pathname}${location.search}`;
  }

  function resetSelectionCache(reason = '') {
    state.selectedAssetIds.clear();
    state.lastKnownAssetIds = [];
    state.selectionCacheViewKey = getViewKey();

    console.debug?.('[Immich Move] Selection cache reset:', reason);
  }

  function updateSelectionCacheFromDom() {
    const viewKey = getViewKey();

    if (state.selectionCacheViewKey !== viewKey) {
      resetSelectionCache('view changed');
    }

    const visibleAssetIds = getVisibleAssetIds();
    const visibleSelectedIds = getVisibleSelectedAssetIds();

    const visibleSelectedSet = new Set(visibleSelectedIds);

    // Add currently visible selected assets.
    for (const id of visibleSelectedIds) {
      state.selectedAssetIds.add(id);
    }

    if (visibleSelectedIds.length > 0) {
      state.lastSelectionSeenAt = Date.now();
    }

    // Reconcile visible unselected cards.
    // If an asset is visible and no longer selected, remove it from the cache.
    for (const id of visibleAssetIds) {
      if (!visibleSelectedSet.has(id)) {
        state.selectedAssetIds.delete(id);
      }
    }

    // Clear immediately when Immich has exited selection mode.
    // Keep the cache only during short scroll/virtualization gaps.
    if (state.selectedAssetIds.size > 0) {
      const visibleSelectedIds = getVisibleSelectedAssetIds();
      const toolbarSelectionCount = getImmichToolbarSelectionCount();

      const definitelyCleared =
        visibleSelectedIds.length === 0 &&
        toolbarSelectionCount === 0;

      const selectionModeEnded =
        !isImmichSelectionModeLikelyActive() &&
        Date.now() - state.lastScrollAt > 1200;

      if (definitelyCleared || selectionModeEnded) {
        resetSelectionCache(definitelyCleared ? 'toolbar says zero selected' : 'selection mode ended');
      }
    }

    state.lastKnownAssetIds = [...state.selectedAssetIds];

    return state.lastKnownAssetIds;
  }

  function getVisibleSelectedAssetIds() {
    const selected = new Set();

    const selectedElements = [
      ...document.querySelectorAll(
        [
          '[aria-selected="true"]',
          '[aria-checked="true"]',
          '[data-selected="true"]',
          'input[type="checkbox"]:checked',
          '.selected',
          '[class*="selected"]',
        ].join(','),
      ),
    ].filter(isVisible);

    for (const el of selectedElements) {
      const assetRoot = getNearestAssetRoot(el);

      if (!assetRoot) continue;

      const assetId = getPrimaryAssetIdFromElement(assetRoot);

      if (assetId) {
        selected.add(assetId);
      }
    }

    return [...selected];
  }

  function getVisibleAssetIds() {
    const ids = new Set();

    const roots = getVisibleAssetRoots();

    for (const root of roots) {
      const id = getPrimaryAssetIdFromElement(root);

      if (id) {
        ids.add(id);
      }
    }

    return [...ids];
  }

  function getVisibleAssetRoots() {
    const roots = new Set();

    const assetLinks = [
      ...document.querySelectorAll(
        [
          'a[href*="/photos/"]',
          'a[href*="/photo/"]',
          '[data-asset-id]',
          '[data-testid*="asset"]',
        ].join(','),
      ),
    ].filter(isVisible);

    for (const el of assetLinks) {
      const root = getNearestAssetRoot(el);

      if (root) {
        roots.add(root);
      }
    }

    return [...roots];
  }

  function getNearestAssetRoot(el) {
    if (!el || !(el instanceof Element)) return null;

    // Prefer actual photo/asset anchors first.
    const assetAnchor = el.closest('a[href*="/photos/"], a[href*="/photo/"]');

    if (assetAnchor && getPrimaryAssetIdFromElement(assetAnchor)) {
      return assetAnchor;
    }

    // Then try common card containers, but keep the scope narrow.
    let node = el;

    for (let depth = 0; depth < 6 && node; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element)) continue;

      if (
        node.matches('[data-asset-id]') ||
        node.querySelector?.(':scope > a[href*="/photos/"], :scope > a[href*="/photo/"]') ||
        node.querySelector?.('a[href*="/photos/"], a[href*="/photo/"]')
      ) {
        const id = getPrimaryAssetIdFromElement(node);

        if (id) {
          return node;
        }
      }
    }

    return null;
  }

  function getPrimaryAssetIdFromElement(root) {
    if (!root || !(root instanceof Element)) return null;

    const ownAssetId = root.getAttribute('data-asset-id');

    if (ownAssetId && isUuid(ownAssetId)) {
      return ownAssetId;
    }

    const ownHref = root.matches('a[href]') ? root.getAttribute('href') : '';

    const ownHrefId = extractAssetIdFromPath(ownHref);

    if (ownHrefId) {
      return ownHrefId;
    }

    const directLink = root.querySelector(':scope a[href*="/photos/"], :scope a[href*="/photo/"]');

    if (directLink) {
      const id = extractAssetIdFromPath(directLink.getAttribute('href'));

      if (id) {
        return id;
      }
    }

    // Final narrow fallback: inspect only asset-ish attributes on the root itself.
    for (const attr of root.getAttributeNames?.() || []) {
      const value = root.getAttribute(attr) || '';

      if (
        attr.toLowerCase().includes('asset') ||
        value.includes('/photos/') ||
        value.includes('/photo/') ||
        value.includes('/api/assets/')
      ) {
        const matches = value.match(new RegExp(CONFIG.uuidRegex, 'ig')) || [];

        for (const id of matches) {
          if (isUuid(id)) {
            return id;
          }
        }
      }
    }

    return null;
  }

  function isImmichSelectionModeLikelyActive() {
    const visibleSelectedIds = getVisibleSelectedAssetIds();

    if (visibleSelectedIds.length > 0) {
      return true;
    }

    const toolbarSelectionCount = getImmichToolbarSelectionCount();

    if (toolbarSelectionCount === 0) {
      return false;
    }

    if (toolbarSelectionCount && toolbarSelectionCount > 0) {
      return true;
    }

    const toolbarText = normalizeText(
      [
        ...document.querySelectorAll(
          [
            'header',
            'nav',
            '[role="toolbar"]',
            '[data-testid*="toolbar"]',
            '[class*="toolbar"]',
            '[class*="Toolbar"]',
          ].join(','),
        ),
      ]
        .filter(isVisible)
        .map((el) => el.textContent || '')
        .join(' '),
    );

    // Only explicit selection wording should keep the cache alive.
    // Do not use generic action words like delete/share/favorite here.
    if (
      /\b\d+\s+(selected|assets selected|photos selected|items selected)\b/.test(toolbarText) ||
      /\bselected\s+\d+\b/.test(toolbarText) ||
      toolbarText.includes('selected')
    ) {
      return true;
    }

    // Preserve cache only during actual scroll virtualization gaps.
    const recentlyScrolling = Date.now() - state.lastScrollAt < 1200;

    if (recentlyScrolling && Date.now() - state.lastSelectionSeenAt < 5000) {
      return true;
    }

    return false;
  }

  async function removeAssetsFromAlbum(albumId, assetIds) {
    if (!albumId || assetIds.length === 0) return false;

    const url = `/api/albums/${albumId}/assets`;

    let response;

    // Current documented shape.
    response = await fetch(url, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ids: assetIds }),
    });

    if (response.ok) return true;

    const firstError = await response.text().catch(() => '');

    console.warn('[Immich Move] DELETE with { ids } failed:', response.status, firstError);

    // Compatibility fallback for older/client-internal shapes.
    response = await fetch(url, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ assetIds }),
    });

    if (response.ok) return true;

    const secondError = await response.text().catch(() => '');

    console.warn('[Immich Move] DELETE with { assetIds } failed:', response.status, secondError);

    return false;
  }

  function installKeyboardShortcut() {
    document.addEventListener(
      'keydown',
      async (event) => {
        if (event.defaultPrevented) return;
        if (event.key.toLowerCase() !== CONFIG.keyboardShortcut) return;
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (isTypingTarget(event.target)) return;

        event.preventDefault();
        await startMoveFlow();
      },
      true,
    );

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Escape') return;

        window.setTimeout(() => {
          const visibleSelectedIds = getVisibleSelectedAssetIds();
          const selectionCount = getImmichToolbarSelectionCount();

          if (visibleSelectedIds.length === 0 && selectionCount === 0) {
            resetSelectionCache('escape cleared all selections');
            refreshButton();
          }
        }, 150);
      },
      true,
    );
  }

  function installUi() {
    const button = document.createElement('button');
    button.id = 'immich-move-to-album-button';
    button.type = 'button';
    button.title = 'Move to album (m)';
    button.setAttribute('aria-label', 'Move to album');
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6.75A2.75 2.75 0 0 1 5.75 4h4.1c.73 0 1.43.29 1.95.8l1.4 1.4c.23.23.55.36.88.36h4.17A2.75 2.75 0 0 1 21 9.31v7.94A2.75 2.75 0 0 1 18.25 20H5.75A2.75 2.75 0 0 1 3 17.25V6.75Z"></path>
        <path d="M12 16.5v-5.25m0 5.25-2.25-2.25M12 16.5l2.25-2.25" class="arrow"></path>
      </svg>
      <span>Move</span>
    `;

    button.addEventListener('click', startMoveFlow);
    document.body.appendChild(button);
  }

  function refreshButton() {
    const button = document.getElementById('immich-move-to-album-button');
    if (!button) return;

    const assetIds = getCurrentAssetIds();
    const albumId = getCurrentAlbumIdFromUrl();

    state.currentAlbumId = albumId;

    const shouldShow = assetIds.length > 0;
    button.hidden = !shouldShow;

    if (shouldShow) {
      button.dataset.count = String(assetIds.length);
      button.title = assetIds.length === 1
        ? 'Move this asset to album (m)'
        : `Move ${assetIds.length} selected assets to album (m)`;
    }
  }

  async function startMoveFlow() {
    const assetIds = getCurrentAssetIds();

    if (getAssetIdFromUrl()) {
      resetSelectionCache('single asset page move');
    }

    if (assetIds.length === 0) {
      notify('No selected or current asset found.', 'error');
      return;
    }

    const sourceAlbumId = getCurrentAlbumIdFromUrl();

    console.debug?.('[Immich Move] Starting move', {
      assetIds,
      sourceAlbumId,
      learnedAlbumId: state.learnedAlbumId,
      url: location.href,
    });

    if (!sourceAlbumId) {
      notify('No current album detected. The asset will be added to the target album, but cannot be removed from a source album.', 'info');
    }

    state.pendingMove = {
      assetIds,
      sourceAlbumId,
      startedAt: Date.now(),
    };

    const opened = await openNativeAddToAlbumModal();

    if (!opened) {
      state.pendingMove = null;
      notify('Could not find Immich’s “Add to album” action. Open the selection menu and try again, or adjust the selector terms in the userscript.', 'error');
    }
  }

  async function openNativeAddToAlbumModal() {
    // 1. If an "Add to album" item/button is already visible, click it.
    let addToAlbum = findNativeAddToAlbumControl();
    if (addToAlbum) {
      clickLikeUser(addToAlbum);
      await sleep(250);
      return true;
    }

    // 2. Try opening Immich's native add/plus action menu first.
    // In recent Immich versions, the Add to album action is usually behind the "+" toolbar button.
    const addMenuTriggers = findNativeAddMenuTriggers();

    for (const trigger of addMenuTriggers) {
      clickLikeUser(trigger);
      await sleep(350);

      addToAlbum = findNativeAddToAlbumControl();
      if (addToAlbum) {
        clickLikeUser(addToAlbum);
        await sleep(250);
        return true;
      }

      // Close this menu before trying another trigger.
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }));

      await sleep(100);
    }

    // 3. Fallback to more/actions menu.
    const moreTriggers = findNativeMoreMenuTriggers();

    for (const trigger of moreTriggers) {
      clickLikeUser(trigger);
      await sleep(350);

      addToAlbum = findNativeAddToAlbumControl();
      if (addToAlbum) {
        clickLikeUser(addToAlbum);
        await sleep(250);
        return true;
      }

      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }));

      await sleep(100);
    }

    return false;
  }

  function findNativeAddToAlbumControl() {
    const controls = getVisibleClickableElements();

    return controls.find((el) => {
      if (el.id === 'immich-move-to-album-button') return false;

      const name = getControlName(el);

      return (
        name.includes('add to album') ||
        name.includes('add to albums') ||
        name.includes('add assets to album') ||
        name.includes('add selected to album') ||
        name.includes('add selected assets to album') ||
        name.includes('album auswählen') ||
        name.includes('zu album hinzufügen')
      );
    }) || null;
  }

  function findNativeAddMenuTriggers() {
    const controls = getVisibleClickableElements();

    const candidates = controls.filter((el) => {
      if (el.id === 'immich-move-to-album-button') return false;

      const name = getControlName(el);
      const text = normalizeText(el.textContent || '');
      const testId = normalizeText(el.getAttribute('data-testid') || '');

      return (
        name === '+' ||
        text === '+' ||
        name === 'add' ||
        name === 'add to' ||
        name.includes('add') ||
        name.includes('create') ||
        name.includes('plus') ||
        testId.includes('add') ||
        testId.includes('plus') ||
        el.getAttribute('aria-haspopup') === 'menu' && name.includes('add')
      );
    });

    // Prefer controls near the top/right toolbar.
    return sortLikelyToolbarControls(candidates);
  }

  function findNativeMoreMenuTriggers() {
    const controls = getVisibleClickableElements();

    const candidates = controls.filter((el) => {
      if (el.id === 'immich-move-to-album-button') return false;

      const name = getControlName(el);
      const testId = normalizeText(el.getAttribute('data-testid') || '');

      return (
        name.includes('more') ||
        name.includes('more options') ||
        name.includes('options') ||
        name.includes('actions') ||
        name.includes('menu') ||
        name === '...' ||
        name === '⋮' ||
        testId.includes('more') ||
        testId.includes('menu') ||
        testId.includes('actions') ||
        el.getAttribute('aria-haspopup') === 'menu'
      );
    });

    return sortLikelyToolbarControls(candidates);
  }

  function getVisibleClickableElements() {
    return [
      ...document.querySelectorAll([
        'button',
        '[role="button"]',
        '[role="menuitem"]',
        'a[href]',
        '[tabindex]:not([tabindex="-1"])',
      ].join(',')),
    ].filter(isVisible);
  }

  function getControlName(el) {
    return normalizeText([
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-test-id'),
      el.getAttribute('name'),
      el.textContent,
    ].filter(Boolean).join(' '));
  }

  function normalizeText(value) {
    return String(value)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  function sortLikelyToolbarControls(elements) {
    return [...elements].sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();

      // Prefer elements in the upper half of the page.
      const aTopScore = ar.top < window.innerHeight / 2 ? 0 : 1000;
      const bTopScore = br.top < window.innerHeight / 2 ? 0 : 1000;

      // Prefer right-side toolbar controls.
      const aRightScore = -ar.right;
      const bRightScore = -br.right;

      return (aTopScore + aRightScore) - (bTopScore + bRightScore);
    });
  }

  function clickLikeUser(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const eventOptions = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    };

    el.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
    el.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    el.dispatchEvent(new PointerEvent('pointerup', { ...eventOptions, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...eventOptions, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...eventOptions, buttons: 0 }));
  }


  function getCurrentAssetIds() {
    const fromPhotoPage = getAssetIdFromUrl();

    if (fromPhotoPage) {
      return [fromPhotoPage];
    }

    return updateSelectionCacheFromDom();
  }

  function isLikelyAssetSelectionElement(el) {
    if (!isVisible(el)) return false;

    const idInside = findAssetIdsInside(el.closest('article, li, figure, div') || el);
    if (idInside.length === 0) return false;

    const text = accessibleName(el).toLowerCase();
    const className = String(el.className || '').toLowerCase();

    return (
      el.matches('input[type="checkbox"]:checked') ||
      el.getAttribute('aria-selected') === 'true' ||
      el.getAttribute('aria-checked') === 'true' ||
      el.getAttribute('data-selected') === 'true' ||
      className.includes('selected') ||
      text.includes('selected')
    );
  }

  function findAssetIdsInside(root) {
    if (!root) return [];

    const ids = new Set();

    for (const anchor of root.querySelectorAll('a[href]')) {
      const id = extractAssetIdFromPath(anchor.getAttribute('href'));
      if (id) ids.add(id);
    }

    // Also inspect generic attributes in case Immich exposes IDs in data fields.
    for (const el of root.querySelectorAll('*')) {
      for (const attr of el.getAttributeNames?.() || []) {
        const value = el.getAttribute(attr);
        if (!value) continue;

        const matches = value.match(new RegExp(CONFIG.uuidRegex, 'ig')) || [];
        for (const maybeId of matches) {
          // Prefer IDs associated with photo/asset-ish links/attrs.
          if (
            attr.toLowerCase().includes('asset') ||
            attr.toLowerCase().includes('photo') ||
            value.includes('/photos/') ||
            value.includes('/api/assets/')
          ) {
            ids.add(maybeId);
          }
        }
      }
    }

    return [...ids];
  }

  function getAssetIdFromUrl() {
    return extractAssetIdFromPath(window.location.pathname);
  }

  function extractAssetIdFromPath(path) {
    if (!path) return null;

    const match = String(path).match(new RegExp(`/(?:photos|photo)/(${CONFIG.uuidRegex})(?:[/?#]|$)`, 'i'));
    return match?.[1] || null;
  }

  function getCurrentAlbumIdFromUrl() {
    const text = `${window.location.pathname}${window.location.search}${window.location.hash}`;

    const patterns = [
      new RegExp(`/(?:albums|album)/(${CONFIG.uuidRegex})(?:[/?#]|$)`, 'i'),
      new RegExp(`[?&#]albumId=(${CONFIG.uuidRegex})(?:&|$)`, 'i'),
      new RegExp(`[?&#]album=(${CONFIG.uuidRegex})(?:&|$)`, 'i'),
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match?.[1] && isUuid(match[1])) {
        rememberSourceAlbum(match[1], 'URL');
        return match[1];
      }
    }

    // Fallback: if Immich recently loaded an album through its API,
    // use that as the source album. This is needed when viewing an asset
    // from inside an album but the URL only shows /photos/<assetId>.
    const learnedIsFresh = state.learnedAlbumId && Date.now() - state.learnedAlbumAt < 10 * 60 * 1000;

    if (learnedIsFresh) {
      return state.learnedAlbumId;
    }

    return null;
  }

  function isCurrentAlbumPage() {
    return Boolean(getCurrentAlbumIdFromUrl());
  }

  function findClickableByTerms(terms, options = {}) {
    const elements = [
      ...document.querySelectorAll(
        [
          'button',
          '[role="button"]',
          '[role="menuitem"]',
          'a',
          '[tabindex]',
        ].join(','),
      ),
    ].filter(isVisible);

    const matches = elements.filter((el) => {
      const name = accessibleName(el).toLowerCase().trim();
      if (!name) return false;

      return terms.some((term) => {
        const normalized = term.toLowerCase();
        if (normalized === 'album') {
          return name === 'add to album' || name === 'add to albums';
        }

        return name.includes(normalized);
      });
    });

    return options.preferLast ? matches.at(-1) || null : matches[0] || null;
  }

  function accessibleName(el) {
    return [
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
      el.getAttribute?.('data-testid'),
      el.textContent,
    ]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isTypingTarget(target) {
    if (!target) return false;

    const el = target instanceof Element ? target : null;
    if (!el) return false;

    return Boolean(
      el.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'),
    );
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      style.opacity !== '0'
    );
  }

  function isUuid(value) {
    return new RegExp(`^${CONFIG.uuidRegex}$`, 'i').test(String(value));
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function notify(message, type = 'info') {
    const existing = document.getElementById('immich-move-toast');
    existing?.remove();

    const toast = document.createElement('div');
    toast.id = 'immich-move-toast';
    toast.dataset.type = type;
    toast.textContent = message;

    document.body.appendChild(toast);

    window.setTimeout(() => {
      toast.remove();
    }, 4500);
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #immich-move-to-album-button {
        position: fixed;
        right: 20px;
        bottom: 84px;
        z-index: 99999;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 0;
        border-radius: 999px;
        padding: 10px 14px;
        font: 600 14px/1 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: white;
        background: rgba(37, 99, 235, 0.95);
        box-shadow: 0 10px 30px rgba(0,0,0,0.28);
        cursor: pointer;
      }

      #immich-move-to-album-button:hover {
        background: rgba(29, 78, 216, 0.98);
      }

      #immich-move-to-album-button[hidden] {
        display: none !important;
      }

      #immich-move-to-album-button svg {
        width: 20px;
        height: 20px;
        fill: currentColor;
      }

      #immich-move-to-album-button svg .arrow {
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      #immich-move-to-album-button::after {
        content: attr(data-count);
        min-width: 18px;
        height: 18px;
        padding: 0 5px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: rgba(37, 99, 235, 1);
        background: white;
        font-size: 12px;
        font-weight: 800;
      }

      #immich-move-toast {
        position: fixed;
        right: 20px;
        bottom: 24px;
        z-index: 100000;
        max-width: min(420px, calc(100vw - 40px));
        padding: 12px 14px;
        border-radius: 12px;
        color: white;
        background: rgba(31, 41, 55, 0.96);
        box-shadow: 0 10px 30px rgba(0,0,0,0.32);
        font: 500 14px/1.35 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      #immich-move-toast[data-type="success"] {
        background: rgba(22, 101, 52, 0.96);
      }

      #immich-move-toast[data-type="error"] {
        background: rgba(185, 28, 28, 0.96);
      }

      #immich-move-toast[data-type="info"] {
        background: rgba(37, 99, 235, 0.96);
      }
    `;
    document.head.appendChild(style);
  }
})();