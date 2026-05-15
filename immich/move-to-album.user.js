// ==UserScript==
// @name         Immich Move to Album
// @namespace    https://immich.app/
// @icon         data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAACIUlEQVQ4T3VTv2/TUBC+e47THxSpK5v7L5iAuuVZYurUslJRS/wBSSREBojiioGRZEVCpRsDUoMC7QKqm4GFlgbEWtVBlVigsUBQkcTvuGcR10nDSZbt83ff3fe9M8KE6MucRKCqIpL6s0D0+VbP+AeNcTiOJ87komVQ73gScYTCmfH3NVkSFwgG0nYVwcYkAiAsZlsH9QsE37zXrkHqMQNCheBnj95sTp20NoDASoNNIZbhnqoBdwDEOi59qGHX27FUNBgZmTUHcPqlNPv56RoSLQ9JxA21ImyxNXxHIRzsVptbSkECGumI6E63qg4QrRFCkC3DOqlzecjm4mm12eXk/IguASEN6FlWZBqXHy7t9eTVQwFQM8rkMTaRxQaG+L3SZEGpUFS7Y+b2Arjitz0M9Rd9MtPlnkx3T2R0K692FZDkcYKP6lLprpmTbF5hKjNnvXuAnSGQduzjdHedjyV8ZROz/X7hibnw8gUs8PFRPGKagLbtIpNWedRYqh6dq31AsxTvweKjM6v/J9odFutcf+7E/ZS7X+NHBkIbFHQgIwIYDJhE8KUa4DTCmODa+u+CokiDkxBoFN/nb+nOI7twDqAi5Bv1/xIgoL/v3ObODJwUIkUgPZr/Cb8O0xJ0zdH1yko400kWJ8UTsEsOOM+D5F+Y5EMsQ65aY1Mkxf8MHZ3P9n64CCJPfKyKZuvxLry96YKh8kBGGyDa1OYNq/4CqB/zUEwubakAAAAASUVORK5CYII=
// @version      1.1.3
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

    alert('Immich Move URL patterns saved. New Immich tabs should activate automatically; reload only if already open and inactive.');
  });

  if (!isAllowedImmichUrl()) {
    return;
  }

  const CONFIG = {
    keyboardShortcut: 'm',

    // UUID-style IDs used by Immich assets/albums.
    uuidRegex: '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',

    pollMs: 500,
    membershipPollMs: 900,
    membershipMonitorTimeoutMs: 90_000,
    membershipCancelGraceMs: 1_400,
    postSelectionFinalizeGraceMs: 450,
  };

  const state = {
    pendingMove: null,
    lastKnownAssetIds: [],
    currentAlbumId: null,

    learnedAlbumId: null,
    learnedAlbumAt: 0,

    selectedAssetIds: new Set(),
    selectionCacheViewKey: null,
    membershipMonitorTimer: null,
    recentDuplicateToastAt: 0,
  };

  let scriptRuntimeReady = false;
  let refreshTimer = null;

  maybeBootstrapRuntime();

  function maybeBootstrapRuntime() {
    let startupObserver = null;
    let startupPollTimer = null;
    let startupTimeoutTimer = null;
    let startupEventHandler = null;

    const cleanup = () => {
      startupObserver?.disconnect();
      startupObserver = null;

      if (startupPollTimer) {
        window.clearInterval(startupPollTimer);
        startupPollTimer = null;
      }

      if (startupTimeoutTimer) {
        window.clearTimeout(startupTimeoutTimer);
        startupTimeoutTimer = null;
      }

      if (startupEventHandler) {
        window.removeEventListener('popstate', startupEventHandler, true);
        window.removeEventListener('hashchange', startupEventHandler, true);
        document.removeEventListener('visibilitychange', startupEventHandler, true);
      }
    };

    const tryStart = () => {
      if (scriptRuntimeReady) {
        cleanup();
        return true;
      }
      if (!isLikelyImmichRuntimeContext()) return false;

      initializeScriptRuntime();
      scriptRuntimeReady = true;
      cleanup();
      return true;
    };

    startupEventHandler = () => {
      tryStart();
    };

    if (tryStart()) return;

    startupObserver = new MutationObserver(() => {
      tryStart();
    });
    startupObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    startupPollTimer = window.setInterval(() => {
      tryStart();
    }, 1200);

    startupTimeoutTimer = window.setTimeout(() => {
      if (!scriptRuntimeReady) {
        cleanup();
      }
    }, 60_000);

    window.addEventListener('popstate', startupEventHandler, true);
    window.addEventListener('hashchange', startupEventHandler, true);
    document.addEventListener('visibilitychange', startupEventHandler, true);
  }

  function isLikelyImmichRuntimeContext() {
    const titleText = normalizeText(document.title || '');
    if (titleText.includes('immich')) return true;

    const pathText = normalizeText(location.pathname || '');
    if (/\/(albums|photos|photo|library|people|search|timeline|memories)(?:\/|$)/i.test(pathText)) {
      return true;
    }

    const appNameMeta = document.querySelector('meta[name="application-name"]');
    if (normalizeText(appNameMeta?.getAttribute('content') || '').includes('immich')) {
      return true;
    }

    return Boolean(
      document.querySelector(
        [
          '[data-testid*="immich"]',
          'a[href*="/albums/"]',
          'a[href*="/photos/"]',
          'a[href*="/photo/"]',
          'a[href*="/library"]',
        ].join(','),
      ),
    );
  }

  function initializeScriptRuntime() {
    injectStyles();
    patchFetch();
    installUi();
    installKeyboardShortcut();

    document.addEventListener(
      'pointerdown',
      (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        if (state.selectedAssetIds.size === 0) return;

        const clearButton = findClickedClearSelectionButton(target);

        if (!clearButton) return;

        resetSelectionCache();
        refreshButton();

        // Run again after Immich updates its own UI.
        window.setTimeout(() => {
          resetSelectionCache();
          refreshButton();
        }, 250);
      },
      true,
    );

    document.addEventListener(
      'click',
      (event) => {
        maybeCaptureTargetAlbumSelection(event);

        if (state.selectedAssetIds.size === 0) return;

        window.setTimeout(() => {
          const visibleSelectedIds = getVisibleSelectedAssetIds();
          const toolbarSelectionCount = getImmichToolbarSelectionCount();

          if (
            !isSelectionCacheStillActive(visibleSelectedIds.length, toolbarSelectionCount)
          ) {
            resetSelectionCache();
            refreshButton();
          }
        }, 300);
      },
      true,
    );

    const observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    window.setInterval(refreshButton, CONFIG.pollMs);
    refreshButton();
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      refreshButton();
    }, 150);
  }

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

      try {
        markPendingMoveAlbumAddRequest(requestInfo);
      } catch (error) {
        console.error('[Immich Move] Failed while marking album-add request:', error);
      }

      const response = await originalFetch.apply(this, arguments);

      try {
        learnAlbumContextFromRequest(requestInfo, response.clone());
      } catch (error) {
        console.error('[Immich Move] Failed while learning album context:', error);
      }

      try {
        await maybeHandleAlbumAddResponse(requestInfo, response.clone());
      } catch (error) {
        console.error('[Immich Move] Failed while handling album-add response:', error);
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

        try {
          markPendingMoveAlbumAddRequest(this.__immichMoveRequestInfo);
        } catch (error) {
          console.error('[Immich Move] Failed while marking XHR album-add request:', error);
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
          console.error('[Immich Move] Failed while handling XHR album-add response:', error);
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
      rememberSourceAlbum(albumIdFromUrl);
      return;
    }

    // Some Immich responses include album JSON with an id.
    // Only inspect likely album responses to avoid unnecessary parsing.
    const url = new URL(requestInfo.url, window.location.origin);
    if (!url.pathname.includes('/api/albums')) return;

    try {
      const json = await response.json();

      if (json?.id && isUuid(json.id)) {
        rememberSourceAlbum(json.id);
      }
    } catch {
      // Ignore non-JSON responses.
    }
  }

  function rememberSourceAlbum(albumId) {
    if (!albumId || !isUuid(albumId)) return;

    const now = Date.now();

    state.learnedAlbumId = albumId;
    state.learnedAlbumAt = now;
    state.currentAlbumId = albumId;
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

  function markPendingMoveAlbumAddRequest(requestInfo) {
    const pending = state.pendingMove;
    if (!pending || !requestInfo) return;
    if (!['PUT', 'POST', 'PATCH'].includes(requestInfo.method)) return;

    const parsedBody = parseJsonBody(requestInfo.bodyText);
    const requestIds = parseIdsFromRequestBody(requestInfo.bodyText, parsedBody);
    if (requestIds.length === 0) return;

    const albumIds = parseAlbumIdsFromRequestBody(requestInfo.bodyText, parsedBody);
    const url = safeParseUrl(requestInfo.url);
    const path = url?.pathname || '';
    const pathLooksAlbumAdd = /\/api\/albums\/.+\/assets(?:\/|$)/i.test(path);

    if (albumIds.length === 0 && !pathLooksAlbumAdd) {
      return;
    }

    pending.addRequestObservedAt = Date.now();
  }

  async function maybeHandleAlbumAddResponse(requestInfo, response) {
    const pending = state.pendingMove;
    if (!pending) return;

    if (!['PUT', 'POST', 'PATCH'].includes(requestInfo.method)) return;

    const parsedBody = parseJsonBody(requestInfo.bodyText);
    const requestIds = parseIdsFromRequestBody(requestInfo.bodyText, parsedBody);
    const albumIdsInRequest = parseAlbumIdsFromRequestBody(requestInfo.bodyText, parsedBody);
    const requestLooksAlbumRelated =
      requestInfo.url.includes('/api/albums') ||
      albumIdsInRequest.length > 0;

    if (!requestLooksAlbumRelated) {
      return;
    }

    let targetAlbumId = extractTargetAlbumIdFromAddRequest(requestInfo, parsedBody, pending);

    if (!targetAlbumId && requestIds.length > 0) {
      targetAlbumId = await resolveTargetAlbumIdFromPendingSelection(pending);
    }

    if (!targetAlbumId) {
      return;
    }

    pending.addResponseObservedAt = Date.now();

    let relevantIds;

    if (requestIds.length > 0) {
      // Important:
      // Trust Immich's actual add-to-album request body.
      // The userscript's DOM-based selection detection may miss virtualized/off-screen assets.
      relevantIds = [...new Set(requestIds)];

    } else {
      // Fallback only if the request body cannot be inspected.
      relevantIds = [...new Set(pending.assetIds)];

    }

    if (relevantIds.length === 0) {
      return;
    }

    let confirmedIds = relevantIds;
    let addResult = null;
    let addResultParsed = false;

    try {
      addResult = await response.json();
      addResultParsed = true;

    } catch {
      // Ignore parse failures; we'll fall back to HTTP status + request IDs below.
    }

    const duplicateOnlyFailure = !response.ok && isDuplicateAddFailure(addResult);

    if (!response.ok && !duplicateOnlyFailure) {
      notify(`Immich did not add the asset${relevantIds.length === 1 ? '' : 's'} to the target album. Nothing was removed.`, 'error');
      state.pendingMove = null;
      stopMembershipMonitor();
      return;
    }

    if (addResultParsed) {
      const failedIds = extractExplicitlyFailedAssetIdsFromAddResponse(addResult);

      if (failedIds.length > 0) {
        const failedSet = new Set(failedIds);
        confirmedIds = relevantIds.filter((id) => !failedSet.has(id));

      } else if (response.ok) {
        // Some Immich responses only list newly-added IDs and omit duplicates.
        // On HTTP success, treat request IDs as confirmed unless specific IDs failed.
        confirmedIds = relevantIds;
      }
    }

    if (confirmedIds.length === 0 && duplicateOnlyFailure) {
      // Duplicate responses can omit per-asset success rows, but we still want
      // to remove those requested assets from the source album.
      confirmedIds = relevantIds;
    }

    if (confirmedIds.length === 0) {
      notify('Assets were added, but the script could not confirm which IDs succeeded. Nothing was removed.', 'error');
      state.pendingMove = null;
      stopMembershipMonitor();
      return;
    }

    await finalizeMoveAfterTargetDetected({
      pending,
      targetAlbumId,
      confirmedIds,
    });
  }

  async function finalizeMoveAfterTargetDetected({
    pending,
    targetAlbumId,
    confirmedIds,
  }) {
    if (!pending || state.pendingMove !== pending) return;

    if (!pending.sourceAlbumId) {
      notify('Added to album. No source album was detected, so nothing was removed.', 'info');
      state.pendingMove = null;
      stopMembershipMonitor();
      return;
    }

    if (!targetAlbumId) {
      return;
    }

    if (pending.sourceAlbumId === targetAlbumId) {
      notify('Target album is the current album. Nothing was removed.', 'info');
      state.pendingMove = null;
      stopMembershipMonitor();
      return;
    }

    const idsToRemove = [...new Set((confirmedIds || []).filter(isUuid))];

    if (idsToRemove.length === 0) {
      notify('No asset IDs were confirmed for removal from the source album.', 'error');
      state.pendingMove = null;
      stopMembershipMonitor();
      return;
    }

    notify(
      `Move in progress. Removing ${idsToRemove.length} asset${idsToRemove.length === 1 ? '' : 's'} from source album...`,
      'info',
      { persist: true, spinner: true },
    );

    const removed = await removeAssetsFromAlbum(pending.sourceAlbumId, idsToRemove);

    state.pendingMove = null;
    stopMembershipMonitor();

    if (removed) {
      clearImmichSelectionUiAfterMove();
      resetSelectionCache();

      const successMessage = `Moved ${idsToRemove.length} asset${idsToRemove.length === 1 ? '' : 's'} to album.`;
      notify(successMessage, 'success');
    } else {
      notify('Assets were added to the target album, but removal from the current album failed.', 'error');
    }
  }

  function extractExplicitlyFailedAssetIdsFromAddResponse(result) {
    const failed = new Set();
    const rows = [];

    if (Array.isArray(result)) {
      rows.push(...result);
    }

    if (Array.isArray(result?.results)) {
      rows.push(...result.results);
    }

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;

      const id = isUuid(row.id)
        ? row.id
        : (isUuid(row.assetId) ? row.assetId : null);

      if (!id) continue;

      const message = [
        typeof row.error === 'string' ? row.error : '',
        typeof row.message === 'string' ? row.message : '',
        typeof row.reason === 'string' ? row.reason : '',
      ]
        .filter(Boolean)
        .join(' ')
        .trim();

      if (row.success === false) {
        failed.add(id);
        continue;
      }

      if (!message) continue;
      if (isDuplicateToken(message)) continue;
      if (isLikelyFailureToken(message)) {
        failed.add(id);
      }
    }

    return [...failed];
  }

  function isDuplicateToken(value) {
    if (typeof value !== 'string') return false;
    return /\bduplicate\b|\balready\s+exists?\b|\balready\s+part\s+of\s+the\s+album\b|\balready\s+in\s+(?:the\s+)?album\b/i.test(value);
  }

  function isLikelyFailureToken(value) {
    if (typeof value !== 'string') return false;
    return /\b(fail(?:ed|ure)?|error|invalid|forbidden|denied|cannot|unable|not\s+found|bad\s+request)\b/i.test(value);
  }

  function isDuplicateAddFailure(result) {
    if (!result) return false;

    if (Array.isArray(result)) {
      if (result.length === 0) return false;

      const duplicateRows = result.filter((row) => {
        if (!row || typeof row !== 'object') return false;
        return isDuplicateToken(row.error) || isDuplicateToken(row.message);
      });

      return duplicateRows.length > 0 && duplicateRows.length === result.length;
    }

    if (typeof result === 'object') {
      if (isDuplicateToken(result.error) || isDuplicateToken(result.message)) {
        return true;
      }

      if (Array.isArray(result.results) && result.results.length > 0) {
        const duplicateRows = result.results.filter((row) => {
          if (!row || typeof row !== 'object') return false;
          return isDuplicateToken(row.error) || isDuplicateToken(row.message);
        });

        if (duplicateRows.length > 0 && duplicateRows.length === result.results.length) {
          return true;
        }
      }
    }

    return false;
  }

  function extractAlbumIdFromAssetEndpoint(rawUrl) {
    const url = safeParseUrl(rawUrl);
    if (!url) return null;

    const match = url.pathname.match(
      new RegExp(`/api/albums/(${CONFIG.uuidRegex})/assets(?:/|$)`, 'i'),
    );

    return match?.[1] || null;
  }

  function extractTargetAlbumIdFromAddRequest(requestInfo, parsedBody = undefined, pending = null) {
    const fromPath = extractAlbumIdFromAssetEndpoint(requestInfo.url);
    if (fromPath) return fromPath;

    const albumIds = [...new Set(parseAlbumIdsFromRequestBody(requestInfo.bodyText, parsedBody))];

    if (albumIds.length === 0) {
      return null;
    }

    const sourceAlbumId = pending?.sourceAlbumId && isUuid(pending.sourceAlbumId)
      ? pending.sourceAlbumId
      : null;

    if (sourceAlbumId) {
      const nonSource = albumIds.filter((id) => id !== sourceAlbumId);
      if (nonSource.length === 1) {
        return nonSource[0];
      }
    }

    const baselineSet = new Set((pending?.baselineAlbumIds || []).filter(isUuid));

    if (baselineSet.size > 0) {
      const nonBaseline = albumIds.filter((id) => !baselineSet.has(id));
      if (nonBaseline.length === 1) {
        return nonBaseline[0];
      }
    }

    if (albumIds.length === 1) {
      return albumIds[0];
    }


    return null;
  }

  async function resolveTargetAlbumIdFromPendingSelection(pending) {
    if (!pending) return null;

    if (isUuid(pending.explicitTargetAlbumId) && pending.explicitTargetAlbumId !== pending.sourceAlbumId) {
      return pending.explicitTargetAlbumId;
    }

    if (!pending.explicitTargetAlbumName) return null;

    const resolved = await resolveAlbumIdByNameForPending(
      pending.explicitTargetAlbumName,
      pending,
    );

    if (resolved && resolved !== pending.sourceAlbumId) {
      pending.explicitTargetAlbumId = resolved;
      return resolved;
    }

    return null;
  }

  function parseIdsFromRequestBody(bodyText, parsedBody = undefined) {
    if (!bodyText && !parsedBody) return [];

    const json = parsedBody === undefined ? parseJsonBody(bodyText) : parsedBody;

    if (json) {
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
    }

    const rawMatches = String(bodyText || '').match(new RegExp(CONFIG.uuidRegex, 'gi')) || [];
    return [...new Set(rawMatches.filter(isUuid))];
  }

  function parseAlbumIdsFromRequestBody(bodyText, parsedBody = undefined) {
    const json = parsedBody === undefined ? parseJsonBody(bodyText) : parsedBody;
    if (!json || typeof json !== 'object') return [];

    const ids = new Set();

    if (Array.isArray(json.albumIds)) {
      for (const id of json.albumIds) {
        if (isUuid(id)) ids.add(id);
      }
    }

    if (isUuid(json.albumId)) {
      ids.add(json.albumId);
    }

    if (json.album && isUuid(json.album.id)) {
      ids.add(json.album.id);
    }

    return [...ids];
  }

  function parseJsonBody(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return null;

    try {
      return JSON.parse(bodyText);
    } catch {
      return null;
    }
  }

  function safeParseUrl(rawUrl) {
    try {
      return new URL(rawUrl, window.location.origin);
    } catch {
      return null;
    }
  }

  function getViewKey() {
    return `${location.pathname}${location.search}`;
  }

  function resetSelectionCache() {
    state.selectedAssetIds.clear();
    state.lastKnownAssetIds = [];
    state.selectionCacheViewKey = getViewKey();
  }

  function updateSelectionCacheFromDom() {
    const viewKey = getViewKey();

    if (state.selectionCacheViewKey !== viewKey) {
      resetSelectionCache();
    }

    const visibleAssetIds = getVisibleAssetRoots()
      .map((root) => getPrimaryAssetIdFromElement(root))
      .filter((id) => isUuid(id));
    const visibleSelectedIds = getVisibleSelectedAssetIds();

    const visibleSelectedSet = new Set(visibleSelectedIds);

    // Add currently visible selected assets.
    for (const id of visibleSelectedIds) {
      state.selectedAssetIds.add(id);
    }

    // Reconcile visible unselected cards.
    // If an asset is visible and no longer selected, remove it from the cache.
    for (const id of visibleAssetIds) {
      if (!visibleSelectedSet.has(id)) {
        state.selectedAssetIds.delete(id);
      }
    }

    // Clear immediately when no selected cards are visible and toolbar
    // no longer reports selected items.
    if (state.selectedAssetIds.size > 0) {
      const toolbarSelectionCount = getImmichToolbarSelectionCount();
      const selectionStillActive = isSelectionCacheStillActive(
        visibleSelectedIds.length,
        toolbarSelectionCount,
      );

      if (!selectionStillActive) {
        resetSelectionCache();
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

  function isSelectionCacheStillActive(visibleSelectedCount, toolbarSelectionCount) {
    if (visibleSelectedCount > 0) return true;
    if (toolbarSelectionCount && toolbarSelectionCount > 0) return true;
    return false;
  }

  async function removeAssetsFromAlbum(albumId, assetIds) {
    if (!albumId || assetIds.length === 0) return false;

    const ids = [...new Set(assetIds.filter(isUuid))];
    if (ids.length === 0) return false;

    const currentAlbumId = getCurrentAlbumIdFromUrl();
    if (currentAlbumId !== albumId) {
      return false;
    }

    return removeAssetsFromAlbumViaNativeUi(ids);
  }

  async function removeAssetsFromAlbumViaNativeUi(ids) {
    const opened = await openNativeRemoveFromAlbumAction();
    if (!opened) return false;

    const confirmed = await confirmNativeRemoveIfPrompted();
    if (!confirmed) return false;

    // Native dialog confirmation completed. Immich handles the UI/state update.
    await sleep(Math.min(600, Math.max(180, ids.length * 35)));
    return true;
  }

  async function openNativeRemoveFromAlbumAction() {
    let removeControl = findNativeRemoveFromAlbumControl();
    if (removeControl) {
      clickLikeUser(removeControl);
      await sleep(260);
      return true;
    }

    const moreTriggers = findNativeMoreMenuTriggers();

    for (const trigger of moreTriggers) {
      clickLikeUser(trigger);
      await sleep(320);

      removeControl = findNativeRemoveFromAlbumControl();
      if (removeControl) {
        clickLikeUser(removeControl);
        await sleep(260);
        return true;
      }

      dispatchEscapeForSelectionClear();
      await sleep(100);
    }

    return false;
  }

  async function confirmNativeRemoveIfPrompted() {
    const initialWaitUntil = Date.now() + 1600;
    let sawRemovalDialog = false;

    // Wait a short moment for the dialog to appear.
    while (Date.now() < initialWaitUntil) {
      const dialog = getVisibleNativeRemovalDialog();
      if (dialog) {
        sawRemovalDialog = true;
        break;
      }
      await sleep(90);
    }

    // No dialog appeared; some Immich builds may remove immediately.
    if (!sawRemovalDialog) {
      return true;
    }

    const deadline = Date.now() + 5200;

    while (Date.now() < deadline) {
      const dialog = getVisibleNativeRemovalDialog();
      if (!dialog) {
        // Dialog disappeared after we saw it; assume it was confirmed.
        return true;
      }

      const confirmButton = findNativeRemoveConfirmControl(dialog);
      if (confirmButton) {
        clickLikeUser(confirmButton);
        // Extra fallback for modal/button implementations that only respect native click.
        confirmButton.click?.();

        await sleep(180);
        continue;
      }

      await sleep(130);
    }

    return false;
  }

  function findNativeRemoveFromAlbumControl() {
    const controls = getVisibleClickableElements();

    return controls.find((el) => {
      if (el.id === 'immich-move-to-album-button') return false;

      const name = getControlName(el);
      const testId = normalizeText(el.getAttribute('data-testid') || '');

      return (
        name.includes('remove from album') ||
        name.includes('remove from current album') ||
        name.includes('remove from this album') ||
        name.includes('remove selected from album') ||
        name.includes('remove selected assets from album') ||
        name.includes('aus album entfernen') ||
        name.includes('vom album entfernen') ||
        (name.includes('remove') && name.includes('album')) ||
        (testId.includes('remove') && testId.includes('album'))
      );
    }) || null;
  }

  function getVisibleNativeRemovalDialog() {
    const dialogSelectors = [
      '[role="dialog"]',
      '[aria-modal="true"]',
      'dialog[open]',
    ].join(',');

    const dialogs = [...document.querySelectorAll(dialogSelectors)].filter(isVisible);

    for (const dialog of dialogs) {
      const dialogText = normalizeText(dialog.textContent || '');
      const dialogLooksLikeRemoval =
        dialogText.includes('remove') ||
        dialogText.includes('entfernen') ||
        dialogText.includes('supprimer') ||
        dialogText.includes('delete');

      if (dialogLooksLikeRemoval) {
        return dialog;
      }
    }

    return null;
  }

  function findNativeRemoveConfirmControl(dialogEl = null) {
    const dialogs = dialogEl ? [dialogEl] : [getVisibleNativeRemovalDialog()].filter(Boolean);
    if (dialogs.length === 0) return null;

    let bestControl = null;
    let bestScore = -1;

    for (const dialog of dialogs) {
      const controls = [
        ...dialog.querySelectorAll('button, [role="button"], [role="menuitem"]'),
      ].filter(isVisible);

      for (const control of controls) {
        const score = scoreNativeRemoveConfirmControl(control);
        if (score > bestScore) {
          bestScore = score;
          bestControl = control;
        }
      }
    }

    if (bestScore <= 0) return null;
    return bestControl;
  }

  function scoreNativeRemoveConfirmControl(el) {
    const name = getControlName(el);
    if (!name) return 0;

    if (
      name.includes('cancel') ||
      name.includes('abort') ||
      name.includes('close') ||
      name === 'no' ||
      name === 'nein' ||
      name === 'non'
    ) {
      return -100;
    }

    let score = 0;

    if (
      name === 'remove' ||
      name === 'remove from album' ||
      name === 'entfernen' ||
      name === 'supprimer' ||
      name === 'delete'
    ) {
      score += 120;
    }

    if (
      name.includes('remove') ||
      name.includes('entfernen') ||
      name.includes('supprimer') ||
      name.includes('delete')
    ) {
      score += 70;
    }

    if (
      name.includes('yes') ||
      name.includes('confirm') ||
      name.includes('ok')
    ) {
      score += 25;
    }

    const className = normalizeText(el.getAttribute('class') || '');
    const testId = normalizeText(el.getAttribute('data-testid') || '');
    const ariaLabel = normalizeText(el.getAttribute('aria-label') || '');

    if (
      className.includes('destructive') ||
      className.includes('danger') ||
      className.includes('delete') ||
      className.includes('remove') ||
      testId.includes('remove') ||
      testId.includes('delete') ||
      testId.includes('confirm') ||
      ariaLabel.includes('remove') ||
      ariaLabel.includes('delete')
    ) {
      score += 18;
    }

    return score;
  }

  function clearImmichSelectionUiAfterMove() {
    // Defensive fallback for stale checkbox visuals in date groups/cards.
    for (const checkbox of document.querySelectorAll('input[type="checkbox"]:checked')) {
      checkbox.checked = false;
      checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function dispatchEscapeForSelectionClear() {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      bubbles: true,
      cancelable: true,
    }));
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
            resetSelectionCache();
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

    const albumId = getCurrentAlbumIdFromUrl();

    state.currentAlbumId = albumId;

    const assetIds = getCurrentAssetIds();

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
      resetSelectionCache();
    }

    if (assetIds.length === 0) {
      notify('No selected or current asset found.', 'error');
      return;
    }

    const sourceAlbumId = getCurrentAlbumIdFromUrl();


    if (!sourceAlbumId) {
      notify('No current album detected. The asset will be added to the target album, but cannot be removed from a source album.', 'info');
    }

    const probeAssetId = assetIds[0] || null;
    let baselineAlbumIds = [];

    if (probeAssetId) {
      baselineAlbumIds = await getAlbumIdsForAsset(probeAssetId);
    }

    state.pendingMove = {
      assetIds,
      sourceAlbumId,
      startedAt: Date.now(),
      probeAssetId,
      baselineAlbumIds,
      membershipCheckInFlight: false,
      explicitTargetAlbumId: null,
      explicitTargetAlbumName: '',
      explicitTargetSelectedAt: 0,
      explicitTargetResolveAt: 0,
      duplicateToastHandled: false,
      addRequestObservedAt: 0,
      addResponseObservedAt: 0,
    };

    notify(
      `Move in progress. Select target album for ${assetIds.length} asset${assetIds.length === 1 ? '' : 's'}...`,
      'info',
      { persist: true, spinner: true },
    );

    const opened = await openNativeAddToAlbumModal();

    if (!opened) {
      state.pendingMove = null;
      stopMembershipMonitor();
      notify('Could not find Immich’s “Add to album” action. Open the selection menu and try again, or adjust the selector terms in the userscript.', 'error');
      return;
    }

    startMembershipMonitor();
  }

  function startMembershipMonitor() {
    stopMembershipMonitor();

    state.membershipMonitorTimer = window.setInterval(() => {
      void checkPendingMoveMembershipFallback();
    }, CONFIG.membershipPollMs);

    // Also run one immediate check shortly after opening the modal.
    window.setTimeout(() => {
      void checkPendingMoveMembershipFallback();
    }, 1200);
  }

  function stopMembershipMonitor() {
    if (!state.membershipMonitorTimer) return;
    window.clearInterval(state.membershipMonitorTimer);
    state.membershipMonitorTimer = null;
  }

  async function checkPendingMoveMembershipFallback() {
    const pending = state.pendingMove;
    if (!pending) {
      stopMembershipMonitor();
      return;
    }

    if (pending.membershipCheckInFlight) return;
    pending.membershipCheckInFlight = true;

    try {
      const ageMs = Date.now() - (pending.startedAt || Date.now());
      if (ageMs > CONFIG.membershipMonitorTimeoutMs) {
        notify('Move timed out before Immich confirmed the add operation. Nothing was removed.', 'error');
        state.pendingMove = null;
        stopMembershipMonitor();
        return;
      }

      const handledFromClosedPicker = await maybeResolvePendingMoveWhenPickerClosed(pending, ageMs);
      if (handledFromClosedPicker) {
        return;
      }

      const probeAssetId = pending.probeAssetId;
      if (!probeAssetId) return;

      const resolvedExplicitTarget = await tryResolveExplicitTargetAlbum(pending, ageMs);

      if (resolvedExplicitTarget && resolvedExplicitTarget !== pending.sourceAlbumId) {
        await finalizeMoveAfterTargetDetected({
          pending,
          targetAlbumId: resolvedExplicitTarget,
          confirmedIds: pending.assetIds,
        });
        return;
      }

      if (!pending.duplicateToastHandled && sawRecentDuplicateToast()) {
        pending.duplicateToastHandled = true;

        let duplicateTarget = pending.explicitTargetAlbumId;

        if (!duplicateTarget && pending.explicitTargetAlbumName) {
          duplicateTarget = await resolveAlbumIdByNameForPending(
            pending.explicitTargetAlbumName,
            pending,
          );

          if (duplicateTarget) {
            pending.explicitTargetAlbumId = duplicateTarget;
          }
        }

        if (duplicateTarget && duplicateTarget !== pending.sourceAlbumId) {

          await finalizeMoveAfterTargetDetected({
            pending,
            targetAlbumId: duplicateTarget,
            confirmedIds: pending.assetIds,
          });
          return;
        }
      }

      const currentAlbumIds = await getAlbumIdsForAsset(probeAssetId);
      if (state.pendingMove !== pending) return;
      if (currentAlbumIds.length === 0) return;

      const baseline = new Set((pending.baselineAlbumIds || []).filter(isUuid));
      const newlyAddedAlbumIds = currentAlbumIds.filter((id) => isUuid(id) && !baseline.has(id));

      if (newlyAddedAlbumIds.length === 0) return;

      let targetAlbumId = null;

      if (newlyAddedAlbumIds.length === 1) {
        targetAlbumId = newlyAddedAlbumIds[0];
      } else if (pending.sourceAlbumId) {
        const withoutSource = newlyAddedAlbumIds.filter((id) => id !== pending.sourceAlbumId);
        if (withoutSource.length === 1) {
          targetAlbumId = withoutSource[0];
        }
      }

      if (!targetAlbumId) {
        return;
      }


      await finalizeMoveAfterTargetDetected({
        pending,
        targetAlbumId,
        confirmedIds: pending.assetIds,
      });
    } catch (error) {
    } finally {
      if (state.pendingMove === pending) {
        pending.membershipCheckInFlight = false;
      }
    }
  }

  async function maybeResolvePendingMoveWhenPickerClosed(pending, ageMs) {
    if (!pending) return false;
    if (ageMs < CONFIG.membershipCancelGraceMs) return false;
    if (isNativeAddToAlbumPickerVisible()) return false;

    const now = Date.now();
    const addRequestSeen = Number(pending.addRequestObservedAt || 0) > 0;
    const addResponseSeen = Number(pending.addResponseObservedAt || 0) > 0;
    const selectedAt = Number(pending.explicitTargetSelectedAt || 0);
    const selectionAgeMs = selectedAt > 0 ? now - selectedAt : 0;

    if (!addRequestSeen && selectedAt > 0 && selectionAgeMs >= CONFIG.postSelectionFinalizeGraceMs) {
      const targetAlbumId = await resolveTargetAlbumIdFromPendingSelection(pending);

      if (targetAlbumId && targetAlbumId !== pending.sourceAlbumId) {
        await finalizeMoveAfterTargetDetected({
          pending,
          targetAlbumId,
          confirmedIds: pending.assetIds,
        });
        return true;
      }
    }

    if (!addRequestSeen && !addResponseSeen && selectedAt === 0) {
      notify('Move cancelled before selecting a target album.', 'info');
      state.pendingMove = null;
      stopMembershipMonitor();
      return true;
    }

    if (!addRequestSeen && !addResponseSeen && selectedAt > 0 && selectionAgeMs > CONFIG.membershipCancelGraceMs * 3) {
      notify('Move cancelled or target album could not be resolved. Nothing was removed.', 'info');
      state.pendingMove = null;
      stopMembershipMonitor();
      return true;
    }

    return false;
  }

  function isNativeAddToAlbumPickerVisible() {
    const dialogs = [
      ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]'),
    ].filter(isVisible);

    for (const dialog of dialogs) {
      const text = normalizeText(dialog.textContent || '');

      if (
        text.includes('add to album') ||
        text.includes('add to shared album') ||
        text.includes('select album') ||
        text.includes('choose album') ||
        text.includes('create album') ||
        text.includes('new album') ||
        text.includes('zu album hinzufügen') ||
        text.includes('album auswählen')
      ) {
        return true;
      }

      const inputs = [
        ...dialog.querySelectorAll('input, [role="textbox"]'),
      ].filter(isVisible);

      const hasAlbumishInput = inputs.some((input) => {
        const metadata = normalizeText(
          [
            input.getAttribute?.('aria-label'),
            input.getAttribute?.('placeholder'),
            input.getAttribute?.('name'),
            input.getAttribute?.('data-testid'),
          ]
            .filter(Boolean)
            .join(' '),
        );

        return metadata.includes('album') || metadata.includes('search');
      });

      const hasAlbumishControl = [
        ...dialog.querySelectorAll('button, [role="button"], [role="menuitem"]'),
      ]
        .filter(isVisible)
        .some((control) => getControlName(control).includes('album'));

      if (hasAlbumishInput && hasAlbumishControl) {
        return true;
      }
    }

    return false;
  }

  async function getAlbumIdsForAsset(assetId, options = {}) {
    if (!isUuid(assetId)) return [];

    const strict = Boolean(options?.strict);

    const url = `/api/albums?assetId=${encodeURIComponent(assetId)}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return strict ? null : [];
      }

      const json = await response.json().catch(() => null);

      if (!Array.isArray(json)) {
        return strict ? null : [];
      }

      const ids = new Set();
      for (const row of json) {
        const id = row?.id;
        if (isUuid(id)) ids.add(id);
      }

      return [...ids];
    } catch (error) {
      return strict ? null : [];
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
      dispatchEscapeForSelectionClear();
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

      dispatchEscapeForSelectionClear();
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

  function maybeCaptureTargetAlbumSelection(event) {
    const pending = state.pendingMove;
    if (!pending) return;

    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const candidateId = extractAlbumIdFromElement(target);
    const candidateName = getReasonableAlbumCandidateName(target);

    if (candidateId && candidateId !== pending.sourceAlbumId) {
      pending.explicitTargetAlbumId = candidateId;
      pending.explicitTargetSelectedAt = Date.now();
      pending.explicitTargetResolveAt = 0;
      if (candidateName) {
        pending.explicitTargetAlbumName = candidateName;
      }
      return;
    }

    if (candidateName) {
      pending.explicitTargetAlbumName = candidateName;
      pending.explicitTargetSelectedAt = Date.now();
      pending.explicitTargetResolveAt = 0;
    }

    if (isDuplicateToastText(target.textContent || '')) {
      state.recentDuplicateToastAt = Date.now();
    }
  }

  function extractAlbumIdFromElement(el) {
    let node = el;

    for (let depth = 0; depth < 8 && node; depth += 1, node = node.parentElement) {
      if (!(node instanceof Element)) continue;

      const attrEntries = [];

      for (const attr of node.getAttributeNames?.() || []) {
        const value = node.getAttribute(attr);
        if (!value) continue;
        attrEntries.push([attr.toLowerCase(), String(value)]);
      }

      if (node instanceof HTMLAnchorElement && node.href) {
        attrEntries.push(['href', node.href]);
      }

      for (const [attr, value] of attrEntries) {
        const albumPath = value.match(new RegExp(`/albums?/(${CONFIG.uuidRegex})(?:[/?#]|$)`, 'i'));
        if (albumPath?.[1] && isUuid(albumPath[1])) {
          return albumPath[1];
        }

        const apiPath = value.match(new RegExp(`/api/albums/(${CONFIG.uuidRegex})(?:[/?#]|$)`, 'i'));
        if (apiPath?.[1] && isUuid(apiPath[1])) {
          return apiPath[1];
        }

        const uuidMatches = value.match(new RegExp(CONFIG.uuidRegex, 'ig')) || [];
        for (const maybeId of uuidMatches) {
          if (!isUuid(maybeId)) continue;

          if (
            attr.includes('album') ||
            attr.includes('aria-controls') ||
            attr.includes('for') ||
            value.includes('/albums/') ||
            value.includes('/api/albums/')
          ) {
            return maybeId;
          }
        }
      }
    }

    return null;
  }

  function getReasonableAlbumCandidateName(el) {
    const text = normalizeText(el.textContent || '');
    if (!text) return '';
    if (text.length < 2 || text.length > 120) return '';

    if (
      text.includes('add to album') ||
      text.includes('create album') ||
      text.includes('new album') ||
      text.includes('cancel') ||
      text.includes('close') ||
      text.includes('search') ||
      text.includes('already part of the album')
    ) {
      return '';
    }

    return text;
  }

  function isDuplicateToastText(value) {
    if (!value) return false;
    const text = normalizeText(value);
    return (
      text.includes('already part of the album') ||
      text.includes('already exists in album') ||
      (text.includes('already exists') && text.includes('album'))
    );
  }

  function sawRecentDuplicateToast() {
    if (Date.now() - state.recentDuplicateToastAt < 10_000) {
      return true;
    }

    const liveNodes = [
      ...document.querySelectorAll(
        [
          '[role="status"]',
          '[role="alert"]',
          '[data-testid*="toast"]',
          '[class*="toast"]',
          '[class*="snackbar"]',
        ].join(','),
      ),
    ];

    for (const node of liveNodes) {
      if (!isVisible(node)) continue;
      if (isDuplicateToastText(node.textContent || '')) {
        state.recentDuplicateToastAt = Date.now();
        return true;
      }
    }

    return false;
  }

  async function tryResolveExplicitTargetAlbum(pending, ageMs) {
    if (!pending) return null;
    if (!pending.explicitTargetAlbumId && !pending.explicitTargetAlbumName) return null;

    // Give Immich a short moment after album click before acting.
    if (ageMs < 900) return null;

    const now = Date.now();
    if (pending.explicitTargetResolveAt && now - pending.explicitTargetResolveAt < 1600) {
      return null;
    }
    pending.explicitTargetResolveAt = now;

    if (pending.explicitTargetAlbumId && pending.explicitTargetAlbumId !== pending.sourceAlbumId) {
      return pending.explicitTargetAlbumId;
    }

    if (!pending.explicitTargetAlbumName) return null;

    const resolved = await resolveAlbumIdByNameForPending(pending.explicitTargetAlbumName, pending);

    if (resolved && resolved !== pending.sourceAlbumId) {
      pending.explicitTargetAlbumId = resolved;
      return resolved;
    }

    return null;
  }

  async function resolveAlbumIdByNameForPending(albumName, pending) {
    const normalized = normalizeAlbumNameForMatching(albumName);
    if (!normalized) return null;

    let candidates = [];

    if (pending.probeAssetId) {
      candidates = await fetchAlbumRecords({ assetId: pending.probeAssetId });
    }

    if (candidates.length === 0) {
      candidates = await fetchAlbumRecords({});
    }

    if (candidates.length === 0) {
      return null;
    }

    const byName = candidates.filter((album) => {
      const candidateName = normalizeAlbumNameForMatching(album.albumName || '');
      if (!candidateName) return false;

      return (
        candidateName === normalized ||
        candidateName.startsWith(`${normalized} `) ||
        normalized.startsWith(`${candidateName} `)
      );
    });

    if (byName.length === 0) return null;

    const sourceAlbumId = pending.sourceAlbumId && isUuid(pending.sourceAlbumId)
      ? pending.sourceAlbumId
      : null;

    if (sourceAlbumId) {
      const nonSource = byName.filter((album) => album.id !== sourceAlbumId);
      if (nonSource.length === 1) return nonSource[0].id;
      if (nonSource.length > 1) {
        const nonBaseline = nonSource.filter((album) => !(pending.baselineAlbumIds || []).includes(album.id));
        if (nonBaseline.length === 1) return nonBaseline[0].id;
      }
    }

    if (byName.length === 1) return byName[0].id;


    return null;
  }

  async function fetchAlbumRecords({ assetId } = {}) {
    const query = assetId && isUuid(assetId)
      ? `?assetId=${encodeURIComponent(assetId)}`
      : '';

    try {
      const response = await fetch(`/api/albums${query}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        return [];
      }

      const json = await response.json().catch(() => null);
      if (!Array.isArray(json)) return [];

      return json
        .map((row) => ({
          id: row?.id,
          albumName: row?.albumName || row?.name || '',
        }))
        .filter((row) => isUuid(row.id));
    } catch (error) {
      return [];
    }
  }

  function normalizeAlbumNameForMatching(value) {
    let text = normalizeText(value);
    if (!text) return '';

    // Remove common trailing count badges from list rows, e.g.:
    // "album name 8 items", "album name · 8 photos"
    text = text
      .replace(/\s*[·•|-]\s*\d+\s+(items?|assets?|photos?|videos?)\b.*$/i, '')
      .replace(/\s+\d+\s+(items?|assets?|photos?|videos?)\b.*$/i, '')
      .trim();

    return text;
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
    if (!el) return false;

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const eventOptions = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
    };

    const pointerOptions = {
      ...eventOptions,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };

    const dispatch = (EventCtor, type, options) => {
      try {
        el.dispatchEvent(new EventCtor(type, options));
        return true;
      } catch (error) {
        return false;
      }
    };

    // Firefox userscript sandboxes can reject UIEventInit.view values across realms.
    // Build events without `view` and gracefully fall back to native click.
    const pointerDownSent = typeof PointerEvent === 'function'
      ? dispatch(PointerEvent, 'pointerdown', pointerOptions)
      : false;
    const mouseDownSent = dispatch(MouseEvent, 'mousedown', eventOptions);

    if (typeof PointerEvent === 'function') {
      dispatch(PointerEvent, 'pointerup', { ...pointerOptions, buttons: 0 });
    }

    dispatch(MouseEvent, 'mouseup', { ...eventOptions, buttons: 0 });
    const clickSent = dispatch(MouseEvent, 'click', { ...eventOptions, buttons: 0 });

    if (!pointerDownSent && !mouseDownSent && !clickSent) {
      el.click?.();
    }

    return true;
  }


  function getCurrentAssetIds() {
    const fromPhotoPage = getAssetIdFromUrl();

    if (fromPhotoPage) {
      return [fromPhotoPage];
    }

    return updateSelectionCacheFromDom();
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
        rememberSourceAlbum(match[1]);
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

  function notify(message, type = 'info', options = {}) {
    const persist = Boolean(options?.persist);
    const spinner = Boolean(options?.spinner);

    const existing = document.getElementById('immich-move-toast');
    existing?.remove();

    const toast = document.createElement('div');
    toast.id = 'immich-move-toast';
    toast.dataset.type = type;

    if (spinner) {
      toast.dataset.spinner = 'true';

      const spinnerEl = document.createElement('span');
      spinnerEl.className = 'immich-move-spinner';
      spinnerEl.setAttribute('aria-hidden', 'true');

      const textEl = document.createElement('span');
      textEl.className = 'immich-move-toast-text';
      textEl.textContent = message;

      toast.append(spinnerEl, textEl);
    } else {
      toast.textContent = message;
    }

    document.body.appendChild(toast);

    if (!persist) {
      window.setTimeout(() => {
        toast.remove();
      }, 4500);
    }
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

      #immich-move-toast[data-spinner="true"] {
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }

      .immich-move-spinner {
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.45);
        border-top-color: rgba(255, 255, 255, 1);
        animation: immichMoveSpin 0.9s linear infinite;
        flex: 0 0 auto;
      }

      .immich-move-toast-text {
        min-width: 0;
      }

      @keyframes immichMoveSpin {
        to {
          transform: rotate(360deg);
        }
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
