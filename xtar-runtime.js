// xtar-runtime-v4
// Do not remove. Do not modify. Do not move.
// Part of Xtarify agent infrastructure. Single vanilla bundle served from a
// CDN (jsdelivr, from github.com/daybigo/xtar-runtime) and loaded via a
// <script> tag in index.html. It bundles the route reporter, the Studio
// visual editor bridge, the whole client-side error system (runtime/promise/
// console/network capture + blank-screen + a React-crash fallback screen that
// replaces the old ErrorBoundary.tsx/ErrorScreen.tsx), and the "Hecho con
// Xtarify" badge. Removing or editing it can break the IDE preview, the Studio
// editor, error reporting, or the badge.
// See ARQUITECTURA_XTARIFY/104_XTAR_RUNTIME_BUNDLE_XTARIFY.md.

(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // Guard de doble carga: si un index.html quedo con DOS tags del runtime
  // (p.ej. el local viejo + el del CDN tras una migracion a medias), el
  // segundo script NO debe reinicializar — duplicaria los listeners del
  // Studio Bridge (comandos de edicion aplicados dos veces), el wrap de
  // fetch/console.error y los observers del error system.
  if (window.XTAR_RUNTIME_VERSION) return;
  window.XTAR_RUNTIME_VERSION = '4';

  // ====================================================================
  // 0) ROUTE REPORTER
  // --------------------------------------------------------------------
  // Informa al IDE (ventana padre) la ruta activa del preview para la barra de
  // navegacion. El PreviewIframe del IDE escucha `{ type: 'navigation', pathname }`.
  // ====================================================================
  (function reportRouteToParent() {
    try {
      if (!window.parent || window.parent === window) return;
      var lastReported = null;
      function reportRoute() {
        try {
          var path = (location.pathname || '/') + (location.search || '') + (location.hash || '');
          if (path === lastReported) return;
          lastReported = path;
          window.parent.postMessage({ type: 'navigation', pathname: path }, '*');
        } catch (e) {}
      }
      var origPush = history.pushState;
      var origReplace = history.replaceState;
      history.pushState = function () { var r = origPush.apply(this, arguments); reportRoute(); return r; };
      history.replaceState = function () { var r = origReplace.apply(this, arguments); reportRoute(); return r; };
      window.addEventListener('popstate', reportRoute);
      window.addEventListener('hashchange', reportRoute);
      window.addEventListener('load', reportRoute);
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        reportRoute();
      } else {
        window.addEventListener('DOMContentLoaded', reportRoute);
      }
    } catch (e) {}
  })();

  // ====================================================================
  // 1) STUDIO BRIDGE v0.2.0
  // --------------------------------------------------------------------
  // postMessage handshake con el IDE parent. Mantiene un overlay de
  // seleccion/hover, expone snapshots de elementos (rect, styles, source
  // fiber), aplica patches temporales (style/text/attr) con undo.
  // Costo en frio: solo un message listener; el resto se monta tras enable().
  // ====================================================================
  (function studioBridge() {
    var VERSION = '0.2.0';
    var MESSAGE_PREFIX = 'XTAR_STUDIO_';
    var MAX_TEXT_LENGTH = 700;
    var MAX_ATTR_LENGTH = 1200;
    var MUTATION_DEBOUNCE = 220;
    var CLEANUP_INTERVAL = 60000;

    var active = false;
    var parentOrigin = null;
    var overlayRoot = null;
    var studioScrollbarStyle = null;
    var hoverBox = null;
    var selectedBox = null;
    var multiBoxes = [];
    var guideLayer = null;
    var selectedElement = null;
    var hoverElement = null;
    var multiElements = [];
    var mutationObserver = null;
    var resizeObserver = null;
    var mutationTimer = 0;
    var resizeTimer = 0;
    var lastReportedHeight = 0;
    var rafToken = 0;
    var idCounter = 0;
    var elementsById = new Map();
    var idsByElement = new WeakMap();
    var temporaryEdits = new Map();
    var pausedVideos = new Set();
    var inlineTextRecord = null;
    var lastSelectedSnapshotKey = '';
    var cleanupTimer = 0;
    var bridgeStartedAt = 0;

    var SAFE_ATTRIBUTES = {
      id: true,
      class: true,
      src: true,
      srcset: true,
      href: true,
      alt: true,
      title: true,
      role: true,
      'aria-label': true,
      'data-testid': true,
    };

    var SAFE_WRITE_ATTRIBUTES = {
      src: true,
      srcset: true,
      href: true,
      alt: true,
      title: true,
      class: true,
      'aria-label': true,
      backgroundImage: true,
    };

    var STYLE_PROPS = [
      'display',
      'position',
      'color',
      'backgroundColor',
      'backgroundImage',
      'fontSize',
      'fontWeight',
      'lineHeight',
      'letterSpacing',
      'width',
      'height',
      'minWidth',
      'minHeight',
      'maxWidth',
      'maxHeight',
      'margin',
      'padding',
      'borderRadius',
      'borderColor',
      'borderWidth',
      'boxShadow',
      'objectFit',
      'gap',
      'flex',
      'flexDirection',
      'justifyContent',
      'alignItems',
      'gridTemplateColumns',
      'zIndex',
      'opacity',
      'transform',
    ];

    function getConfiguredOrigins() {
      var configured = window.XTAR_STUDIO_ALLOWED_ORIGINS;
      return Array.isArray(configured)
        ? configured.filter(function (value) {
            return typeof value === 'string';
          })
        : [];
    }

    function isAllowedParentOrigin(origin) {
      if (!origin || origin === 'null') return false;
      var configured = getConfiguredOrigins();
      if (configured.indexOf(origin) !== -1) return true;
      try {
        var url = new URL(origin);
        var hostname = url.hostname.toLowerCase();
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
        return (
          hostname === 'xtarify.com' ||
          hostname === 'www.xtarify.com' ||
          hostname === 'xtarify.app' ||
          hostname === 'www.xtarify.app' ||
          hostname === 'xtar.dev' ||
          hostname === 'www.xtar.dev' ||
          hostname.endsWith('.xtarify.com') ||
          hostname.endsWith('.xtarify.app') ||
          hostname.endsWith('.xtar.dev')
        );
      } catch (_error) {
        return false;
      }
    }

    function post(type, payload) {
      if (!parentOrigin || window.parent === window) return;
      window.parent.postMessage(
        Object.assign(
          { type: type, version: VERSION, source: 'xtarify-studio-bridge', timestamp: Date.now() },
          payload || {},
        ),
        parentOrigin,
      );
    }

    function postAck(requestId, ok, reason, snapshot) {
      post('XTAR_STUDIO_APPLY_ACK', {
        requestId: requestId,
        ok: ok,
        reason: reason,
        snapshot: snapshot || undefined,
      });
    }

    function safeText(value, limit) {
      if (typeof value !== 'string') return '';
      var normalized = value.replace(/\s+/g, ' ').trim();
      var max = limit || MAX_TEXT_LENGTH;
      return normalized.length > max ? normalized.slice(0, max) : normalized;
    }

    function isElement(value) {
      return value && value.nodeType === 1;
    }

    function getElementId(element) {
      var existing = idsByElement.get(element);
      if (existing) return existing;
      idCounter += 1;
      var id = 'xtar-studio-' + idCounter;
      idsByElement.set(element, id);
      elementsById.set(id, element);
      return id;
    }

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, function (character) {
        return '\\' + character;
      });
    }

    function buildSelector(element) {
      if (!isElement(element)) return '';
      if (element.id) return '#' + cssEscape(element.id);
      var parts = [];
      var current = element;
      while (current && current.nodeType === 1 && current !== document.documentElement) {
        var tag = current.tagName.toLowerCase();
        var parent = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        var index = 1;
        var sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === current.tagName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(tag + ':nth-of-type(' + index + ')');
        current = parent;
      }
      return parts.join(' > ');
    }

    function resolveElement(message) {
      if (!message) return selectedElement;
      if (message.elementId && elementsById.has(message.elementId)) {
        var stored = elementsById.get(message.elementId);
        if (stored && document.contains(stored)) return stored;
        elementsById.delete(message.elementId);
      }
      if (message.selector && typeof message.selector === 'string') {
        try {
          return document.querySelector(message.selector);
        } catch (_error) {
          return null;
        }
      }
      return selectedElement;
    }

    function shouldIgnoreElement(element) {
      if (!isElement(element)) return true;
      if (overlayRoot && overlayRoot.contains(element)) return true;
      if (element.closest && element.closest('[data-xtar-studio-ignore]')) return true;
      var tag = element.tagName.toLowerCase();
      return tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta' || tag === 'title';
    }

    function getSelectableElement(target) {
      var element = isElement(target) ? target : target && target.parentElement;
      while (element && shouldIgnoreElement(element)) element = element.parentElement;
      if (!element || element === document.documentElement) return document.body;
      return element;
    }

    function getSafeAttributes(element) {
      var attributes = {};
      for (var index = 0; index < element.attributes.length; index += 1) {
        var attribute = element.attributes[index];
        if (SAFE_ATTRIBUTES[attribute.name]) {
          attributes[attribute.name] = safeText(attribute.value, MAX_ATTR_LENGTH);
        }
      }
      return attributes;
    }

    function getComputedSnapshot(element) {
      var computed = window.getComputedStyle(element);
      var styles = {};
      STYLE_PROPS.forEach(function (prop) {
        styles[prop] = computed[prop] || '';
      });
      return styles;
    }

    function getImageSnapshot(element) {
      var tag = element.tagName.toLowerCase();
      if (tag === 'img') {
        return {
          kind: 'img',
          src: safeText(element.getAttribute('src') || '', MAX_ATTR_LENGTH),
          currentSrc: safeText(element.currentSrc || '', MAX_ATTR_LENGTH),
          alt: safeText(element.getAttribute('alt') || '', 240),
          naturalWidth: element.naturalWidth || undefined,
          naturalHeight: element.naturalHeight || undefined,
        };
      }
      var backgroundImage = window.getComputedStyle(element).backgroundImage;
      if (backgroundImage && backgroundImage !== 'none') {
        return { kind: 'background', backgroundImage: safeText(backgroundImage, MAX_ATTR_LENGTH) };
      }
      return undefined;
    }

    function inferElementKind(element) {
      var tag = element.tagName.toLowerCase();
      var role = element.getAttribute('role') || '';
      if (tag === 'body') return 'page';
      if (tag === 'section' || tag === 'main' || tag === 'header' || tag === 'footer' || tag === 'nav') return 'section';
      if (tag === 'img' || getImageSnapshot(element)) return 'image';
      if (tag === 'button' || role === 'button') return 'button';
      if (tag === 'a') return 'link';
      if (/^h[1-6]$/.test(tag) || tag === 'p' || tag === 'span' || tag === 'label') return 'text';
      if (tag === 'div' || tag === 'article' || tag === 'aside' || tag === 'ul' || tag === 'ol' || tag === 'li') return 'container';
      return 'element';
    }

    function getLayerLabel(element) {
      var tag = element.tagName.toLowerCase();
      var label =
        element.getAttribute('aria-label') ||
        element.getAttribute('alt') ||
        element.getAttribute('title') ||
        element.getAttribute('data-testid') ||
        element.id ||
        safeText(element.innerText || element.textContent || '', 80);
      if (!label && element.className && typeof element.className === 'string') {
        label = element.className.split(/\s+/).slice(0, 2).join(' ');
      }
      return label ? tag + ' - ' + safeText(label, 80) : tag;
    }

    function isVisibleEnough(element) {
      var rect = element.getBoundingClientRect();
      var computed = window.getComputedStyle(element);
      return (
        computed.display !== 'none' &&
        computed.visibility !== 'hidden' &&
        Number(computed.opacity || '1') > 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function hasOnlyTextChildren(element) {
      for (var index = 0; index < element.childNodes.length; index += 1) {
        if (element.childNodes[index].nodeType === 1) return false;
      }
      return true;
    }

    function isWrapperWithoutValue(element, kind) {
      if (kind !== 'container') return false;
      var tag = element.tagName.toLowerCase();
      if (tag !== 'div' && tag !== 'span') return false;
      if (element.id || element.getAttribute('role') || element.getAttribute('aria-label')) return false;
      if (element.getAttribute('data-testid')) return false;
      var className = (element.className && typeof element.className === 'string') ? element.className.trim() : '';
      if (!className) {
        if (element.children.length === 1) return true;
        if (element.children.length === 0 && !(element.textContent || '').trim()) return true;
      }
      if (className && className.length < 4 && element.children.length === 1) return true;
      return false;
    }

    function buildLayerNode(element, depth, limits) {
      if (!isElement(element) || shouldIgnoreElement(element) || !isVisibleEnough(element)) return null;
      if (limits.count >= limits.max || depth > limits.maxDepth) return null;
      var children = [];
      var childElements = Array.prototype.slice.call(element.children || []);
      childElements.forEach(function (child) {
        var node = buildLayerNode(child, depth + 1, limits);
        if (node) {
          if (Array.isArray(node)) {
            node.forEach(function (entry) { children.push(entry); });
          } else {
            children.push(node);
          }
        }
      });
      var kind = inferElementKind(element);
      if (depth > 0 && isWrapperWithoutValue(element, kind)) {
        return children.map(function (child) { return Object.assign({}, child, { depth: child.depth - 1 }); });
      }
      limits.count += 1;
      return {
        elementId: getElementId(element),
        selector: buildSelector(element),
        tagName: element.tagName,
        label: getLayerLabel(element),
        text: safeText(element.innerText || element.textContent || '', 180) || undefined,
        role: element.getAttribute('role') || undefined,
        source: getReactSource(element),
        depth: depth,
        childCount: children.length,
        kind: kind,
        children: children,
      };
    }

    function postLayerTree(requestId) {
      var root = document.body;
      var limits = { count: 0, max: 220, maxDepth: 10 };
      var rawTree = root ? buildLayerNode(root, 0, limits) : null;
      var tree = [];
      if (Array.isArray(rawTree)) tree = rawTree;
      else if (rawTree) tree = [rawTree];
      post('XTAR_STUDIO_TREE', { requestId: requestId, tree: tree });
    }

    function extractUrlFromBackground(value) {
      if (!value || value === 'none') return '';
      var match = value.match(/url\((['"]?)(.*?)\1\)/);
      return match ? match[2] : '';
    }

    function postDetectedAssets(requestId) {
      var assets = [];
      var seen = {};
      var elements = Array.prototype.slice.call(document.querySelectorAll('img, [style], [class*="bg-"]'));
      var bodyChildren = document.body ? Array.prototype.slice.call(document.body.querySelectorAll('*')) : [];
      var combined = elements.length > 0 ? elements : bodyChildren;
      combined = combined.slice(0, 600);
      combined.forEach(function (element) {
        if (!isElement(element) || shouldIgnoreElement(element) || !isVisibleEnough(element)) return;
        var image = getImageSnapshot(element);
        if (!image) return;
        var src = '';
        var kind = 'img';
        if (image.kind === 'img') {
          src = image.currentSrc || image.src || '';
        } else if (image.kind === 'background') {
          src = extractUrlFromBackground(image.backgroundImage || '');
          kind = 'background';
        }
        var rect = element.getBoundingClientRect();
        var selector = buildSelector(element);
        var key = src + '::' + selector;
        if (!src || seen[key]) return;
        seen[key] = true;
        assets.push({
          id: getElementId(element) + ':' + assets.length,
          kind: kind,
          src: safeText(src, MAX_ATTR_LENGTH),
          alt: image.alt ? image.alt : undefined,
          label: getLayerLabel(element),
          selector: selector,
          elementId: getElementId(element),
          width: rect.width,
          height: rect.height,
        });
      });
      post('XTAR_STUDIO_ASSETS', { requestId: requestId, assets: assets.slice(0, 160) });
    }

    function findReactFiber(element) {
      var current = element;
      while (current && current !== document.documentElement) {
        var keys = Object.keys(current);
        for (var index = 0; index < keys.length; index += 1) {
          var key = keys[index];
          if (key.indexOf('__reactFiber$') === 0 || key.indexOf('__reactInternalInstance$') === 0) {
            return current[key];
          }
        }
        current = current.parentElement;
      }
      return null;
    }

    function getReactSource(element) {
      var fiber = findReactFiber(element);
      if (!fiber) {
        var datasetSrc = element.dataset && element.dataset.xtarSrc;
        if (datasetSrc) {
          var parts = datasetSrc.split(':');
          return {
            fileName: safeText(parts[0] || '', MAX_ATTR_LENGTH),
            lineNumber: parts[1] ? Number(parts[1]) : undefined,
            columnNumber: parts[2] ? Number(parts[2]) : undefined,
          };
        }
        return undefined;
      }
      var source = fiber._debugSource || undefined;
      var owner = fiber._debugOwner || undefined;
      var componentName = fiber.elementType && (fiber.elementType.displayName || fiber.elementType.name);
      var ownerName = owner && owner.elementType && (owner.elementType.displayName || owner.elementType.name);
      if (!source && !componentName && !ownerName) return undefined;
      return {
        fileName: source && source.fileName ? safeText(source.fileName, MAX_ATTR_LENGTH) : undefined,
        lineNumber: source && source.lineNumber ? source.lineNumber : undefined,
        columnNumber: source && source.columnNumber ? source.columnNumber : undefined,
        componentName: componentName ? safeText(componentName, 160) : undefined,
        ownerName: ownerName ? safeText(ownerName, 160) : undefined,
      };
    }

    function buildSnapshot(element) {
      var rect = element.getBoundingClientRect();
      var attributes = getSafeAttributes(element);
      var text = safeText(element.innerText || element.textContent || '', MAX_TEXT_LENGTH);
      var label = safeText(
        attributes['aria-label'] || attributes.alt || attributes.title || element.getAttribute('name') || '',
        240,
      );
      return {
        elementId: getElementId(element),
        selector: buildSelector(element),
        tagName: element.tagName,
        role: attributes.role || undefined,
        label: label || undefined,
        text: text || undefined,
        attributes: attributes,
        rect: {
          x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom,
        },
        viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
        styles: getComputedSnapshot(element),
        image: getImageSnapshot(element),
        source: getReactSource(element),
        hasChildren: !hasOnlyTextChildren(element),
        timestamp: Date.now(),
      };
    }

    function snapshotKey(element) {
      if (!element) return '';
      var rect = element.getBoundingClientRect();
      return [
        getElementId(element),
        Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height),
        element.className || '',
        (element.textContent || '').length,
      ].join('|');
    }

    function updateBox(box, element, color) {
      if (!box || !element || !document.contains(element)) {
        if (box) box.style.display = 'none';
        return;
      }
      var rect = element.getBoundingClientRect();
      box.style.display = rect.width > 0 && rect.height > 0 ? 'block' : 'none';
      box.style.transform = 'translate(' + rect.left + 'px, ' + rect.top + 'px)';
      box.style.width = rect.width + 'px';
      box.style.height = rect.height + 'px';
      box.style.borderColor = color;
    }

    function refreshMultiBoxes() {
      multiBoxes.forEach(function (box) {
        if (box && box.parentNode) box.parentNode.removeChild(box);
      });
      multiBoxes = [];
      multiElements.forEach(function (element) {
        var box = createBox('1px solid #0099ff', 'rgba(0,153,255,0.06)');
        multiBoxes.push(box);
        if (overlayRoot) overlayRoot.appendChild(box);
        updateBox(box, element, '#0099ff');
      });
    }

    function scheduleBoxUpdate() {
      if (rafToken) return;
      rafToken = window.requestAnimationFrame(function () {
        rafToken = 0;
        updateBox(hoverBox, hoverElement, '#8b5cf6');
        updateBox(selectedBox, selectedElement, '#0099ff');
        multiBoxes.forEach(function (box, index) {
          updateBox(box, multiElements[index], '#0099ff');
        });
      });
    }

    function createBox(border, background) {
      var box = document.createElement('div');
      box.style.cssText = [
        'position:fixed', 'display:none', 'box-sizing:border-box',
        'border:' + border, 'background:' + (background || 'transparent'),
        'border-radius:3px', 'pointer-events:none',
        'transition:transform 60ms linear, width 60ms linear, height 60ms linear',
      ].join(';');
      return box;
    }

    function injectOverlay() {
      if (overlayRoot || !document.body) return;
      overlayRoot = document.createElement('div');
      overlayRoot.id = 'xtar-studio-overlay-root';
      overlayRoot.setAttribute('data-xtar-studio-ignore', 'true');
      overlayRoot.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483646',
        'pointer-events:none', 'contain:layout style paint',
      ].join(';');
      hoverBox = createBox('1px solid #8b5cf6', 'rgba(139,92,246,0.06)');
      selectedBox = createBox('1px solid #0099ff', 'transparent');
      selectedBox.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.85),0 0 0 4px rgba(0,153,255,0.16)';
      guideLayer = document.createElement('div');
      guideLayer.style.cssText = ['position:fixed', 'inset:0', 'pointer-events:none'].join(';');
      overlayRoot.appendChild(guideLayer);
      overlayRoot.appendChild(hoverBox);
      overlayRoot.appendChild(selectedBox);
      document.body.appendChild(overlayRoot);
    }

    function clearGuides() {
      if (guideLayer) {
        while (guideLayer.firstChild) guideLayer.removeChild(guideLayer.firstChild);
      }
    }

    function paintGuides(guides) {
      clearGuides();
      if (!guideLayer || !guides) return;
      guides.forEach(function (guide) {
        var line = document.createElement('div');
        var horizontal = guide.axis === 'y';
        line.style.cssText = horizontal
          ? 'position:absolute;left:' + guide.start + 'px;width:' + (guide.end - guide.start) + 'px;top:' + guide.position + 'px;height:1px;background:#0099ff;opacity:0.85;'
          : 'position:absolute;top:' + guide.start + 'px;height:' + (guide.end - guide.start) + 'px;left:' + guide.position + 'px;width:1px;background:#0099ff;opacity:0.85;';
        guideLayer.appendChild(line);
      });
    }

    function postGuides(requestId, message) {
      var element = resolveElement(message);
      if (!element) {
        post('XTAR_STUDIO_GUIDES', { requestId: requestId, guides: [] });
        return;
      }
      var rect = element.getBoundingClientRect();
      var siblings = element.parentElement ? Array.prototype.slice.call(element.parentElement.children) : [];
      var guides = [];
      siblings.forEach(function (sibling) {
        if (sibling === element) return;
        var sibRect = sibling.getBoundingClientRect();
        [
          ['x', sibRect.left, 'edge'],
          ['x', sibRect.right, 'edge'],
          ['y', sibRect.top, 'edge'],
          ['y', sibRect.bottom, 'edge'],
        ].forEach(function (entry) {
          var axis = entry[0];
          var pos = entry[1];
          var refPos = axis === 'x' ? rect.left : rect.top;
          var refRight = axis === 'x' ? rect.right : rect.bottom;
          if (Math.abs(pos - refPos) < 4 || Math.abs(pos - refRight) < 4) {
            guides.push({
              axis: axis, position: pos,
              start: axis === 'x' ? Math.min(rect.top, sibRect.top) : Math.min(rect.left, sibRect.left),
              end: axis === 'x' ? Math.max(rect.bottom, sibRect.bottom) : Math.max(rect.right, sibRect.right),
              reason: entry[2],
            });
          }
        });
      });
      post('XTAR_STUDIO_GUIDES', { requestId: requestId, guides: guides });
    }

    function startMutationObserver() {
      if (mutationObserver || !document.body) return;
      mutationObserver = new MutationObserver(function () {
        if (mutationTimer) return;
        mutationTimer = window.setTimeout(function () {
          mutationTimer = 0;
          scheduleBoxUpdate();
          scheduleResizeReport();
          if (selectedElement && active) {
            var key = snapshotKey(selectedElement);
            if (key !== lastSelectedSnapshotKey) {
              lastSelectedSnapshotKey = key;
              post('XTAR_STUDIO_MUTATION', { snapshot: buildSnapshot(selectedElement) });
            }
          }
        }, MUTATION_DEBOUNCE);
      });
      mutationObserver.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
    }

    function stopMutationObserver() {
      if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
      if (mutationTimer) { window.clearTimeout(mutationTimer); mutationTimer = 0; }
    }

    function cleanupOldIds() {
      var stale = [];
      elementsById.forEach(function (element, id) {
        if (!element || !document.contains(element)) stale.push(id);
      });
      stale.forEach(function (id) { elementsById.delete(id); });
    }

    function startCleanupTimer() {
      if (cleanupTimer) return;
      cleanupTimer = window.setInterval(cleanupOldIds, CLEANUP_INTERVAL);
    }

    function stopCleanupTimer() {
      if (cleanupTimer) { window.clearInterval(cleanupTimer); cleanupTimer = 0; }
    }

    function blockNavigationEvent(event) {
      if (!active) return;
      if (inlineTextRecord) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
    }

    function onPointerMove(event) {
      if (!active) return;
      var element = getSelectableElement(event.target);
      if (!element || element === hoverElement) return;
      hoverElement = element;
      scheduleBoxUpdate();
      post('XTAR_STUDIO_HOVER', { snapshot: buildSnapshot(element) });
    }

    function onPointerDown(event) {
      if (!active) return;
      if (inlineTextRecord) return;
      var element = getSelectableElement(event.target);
      if (!element) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      if (event.shiftKey) {
        var index = multiElements.indexOf(element);
        if (index === -1) multiElements.push(element);
        else multiElements.splice(index, 1);
        refreshMultiBoxes();
        post('XTAR_STUDIO_MULTI_SELECT', {
          snapshots: multiElements.map(function (item) { return buildSnapshot(item); }),
        });
        return;
      }
      multiElements = [];
      refreshMultiBoxes();
      selectedElement = element;
      hoverElement = element;
      lastSelectedSnapshotKey = snapshotKey(element);
      scheduleBoxUpdate();
      post('XTAR_STUDIO_SELECT', { snapshot: buildSnapshot(element) });
    }

    function isTextEditableElement(element) {
      if (!element || !isElement(element)) return false;
      if (!hasOnlyTextChildren(element)) return false;
      var text = safeText(element.textContent || '', 5000);
      return text.length > 0 && text.length < 5000;
    }

    function finishInlineText(commit) {
      if (!inlineTextRecord) return;
      var record = inlineTextRecord;
      inlineTextRecord = null;
      record.element.removeEventListener('input', onInlineTextInput, true);
      record.element.removeEventListener('blur', onInlineTextBlur, true);
      record.element.removeEventListener('keydown', onInlineTextKeyDown, true);
      record.element.removeAttribute('contenteditable');
      record.element.style.outline = record.outline;
      record.element.style.cursor = record.cursor;
      if (!commit) {
        record.element.textContent = record.originalText;
        scheduleBoxUpdate();
        return;
      }
      selectedElement = record.element;
      scheduleBoxUpdate();
      post('XTAR_STUDIO_TEXT_COMMIT', {
        snapshot: buildSnapshot(record.element),
        value: record.element.textContent || '',
        previousValue: record.originalText,
      });
    }

    function onInlineTextInput() {
      if (!inlineTextRecord) return;
      post('XTAR_STUDIO_TEXT_DRAFT', {
        snapshot: buildSnapshot(inlineTextRecord.element),
        value: inlineTextRecord.element.textContent || '',
      });
    }

    function onInlineTextBlur() { finishInlineText(true); }

    function onInlineTextKeyDown(event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        finishInlineText(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finishInlineText(false);
      }
    }

    function startInlineText(element) {
      if (!isTextEditableElement(element)) return false;
      if (inlineTextRecord) finishInlineText(true);
      selectedElement = element;
      inlineTextRecord = {
        element: element,
        originalText: element.textContent || '',
        outline: element.style.outline || '',
        cursor: element.style.cursor || '',
      };
      element.setAttribute('contenteditable', 'true');
      element.style.outline = '1px solid #0099ff';
      element.style.cursor = 'text';
      element.addEventListener('input', onInlineTextInput, true);
      element.addEventListener('blur', onInlineTextBlur, true);
      element.addEventListener('keydown', onInlineTextKeyDown, true);
      element.focus({ preventScroll: true });
      var range = document.createRange();
      range.selectNodeContents(element);
      var selection = window.getSelection();
      if (selection) { selection.removeAllRanges(); selection.addRange(range); }
      post('XTAR_STUDIO_SELECT', { snapshot: buildSnapshot(element) });
      return true;
    }

    function onDoubleClick(event) {
      if (!active) return;
      var element = getSelectableElement(event.target);
      if (startInlineText(element)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    function onKeyDown(event) {
      if (!active) return;
      if (event.key === 'Escape') {
        multiElements = [];
        refreshMultiBoxes();
        selectedElement = null;
        if (inlineTextRecord) finishInlineText(false);
        if (selectedBox) selectedBox.style.display = 'none';
      }
    }

    function bindEvents() {
      document.addEventListener('pointermove', onPointerMove, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('dblclick', onDoubleClick, true);
      document.addEventListener('click', blockNavigationEvent, true);
      document.addEventListener('mousedown', blockNavigationEvent, true);
      document.addEventListener('mouseup', blockNavigationEvent, true);
      document.addEventListener('submit', blockNavigationEvent, true);
      document.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('scroll', scheduleBoxUpdate, true);
      window.addEventListener('resize', onWindowResize, true);
    }

    function unbindEvents() {
      document.removeEventListener('pointermove', onPointerMove, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('dblclick', onDoubleClick, true);
      document.removeEventListener('click', blockNavigationEvent, true);
      document.removeEventListener('mousedown', blockNavigationEvent, true);
      document.removeEventListener('mouseup', blockNavigationEvent, true);
      document.removeEventListener('submit', blockNavigationEvent, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', scheduleBoxUpdate, true);
      window.removeEventListener('resize', onWindowResize, true);
    }

    function onWindowResize() { scheduleBoxUpdate(); scheduleResizeReport(); }

    function reportDocumentHeight() {
      var doc = document.documentElement;
      var height = Math.max(doc ? doc.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
      if (!height || Math.abs(height - lastReportedHeight) < 4) return;
      lastReportedHeight = height;
      post('XTAR_STUDIO_RESIZE', { width: doc ? doc.scrollWidth : window.innerWidth, height: height });
    }

    function scheduleResizeReport() {
      if (resizeTimer) return;
      resizeTimer = window.setTimeout(function () { resizeTimer = 0; reportDocumentHeight(); }, 120);
    }

    function startResizeObserver() {
      if (resizeObserver || !document.body || typeof ResizeObserver === 'undefined') return;
      resizeObserver = new ResizeObserver(function () { scheduleResizeReport(); });
      resizeObserver.observe(document.body);
      if (document.documentElement) resizeObserver.observe(document.documentElement);
    }

    function stopResizeObserver() {
      if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
      if (resizeTimer) { window.clearTimeout(resizeTimer); resizeTimer = 0; }
    }

    function hideStudioScrollbars() {
      var doc = document.documentElement;
      if (doc) doc.setAttribute('data-xtar-studio-active', 'true');
      if (studioScrollbarStyle && studioScrollbarStyle.parentNode) return;
      var style = document.createElement('style');
      style.setAttribute('data-xtar-studio-scrollbars', 'true');
      style.textContent =
        'html[data-xtar-studio-active], html[data-xtar-studio-active] body { scrollbar-width: none; -ms-overflow-style: none; } ' +
        'html[data-xtar-studio-active]::-webkit-scrollbar, html[data-xtar-studio-active] body::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }';
      (document.head || document.documentElement).appendChild(style);
      studioScrollbarStyle = style;
    }

    function restoreStudioScrollbars() {
      if (document.documentElement) document.documentElement.removeAttribute('data-xtar-studio-active');
      if (studioScrollbarStyle && studioScrollbarStyle.parentNode) studioScrollbarStyle.parentNode.removeChild(studioScrollbarStyle);
      studioScrollbarStyle = null;
    }

    function pauseAllMedia() {
      var videos = document.querySelectorAll('video, audio');
      Array.prototype.forEach.call(videos, function (media) {
        if (!media.paused) {
          try { media.pause(); pausedVideos.add(media); } catch (_error) { /* ignore */ }
        }
      });
      hideStudioScrollbars();
    }

    function resumeMedia() {
      pausedVideos.forEach(function (media) {
        if (media && typeof media.play === 'function') {
          var promise = media.play();
          if (promise && typeof promise.catch === 'function') promise.catch(function () { /* ignore */ });
        }
      });
      pausedVideos.clear();
      restoreStudioScrollbars();
    }

    function enable() {
      if (active) {
        post('XTAR_STUDIO_READY', { url: window.location.href, warmStart: true, bootMs: Date.now() - bridgeStartedAt });
        reportDocumentHeight();
        return;
      }
      bridgeStartedAt = Date.now();
      injectOverlay();
      bindEvents();
      startMutationObserver();
      startResizeObserver();
      startCleanupTimer();
      pauseAllMedia();
      active = true;
      post('XTAR_STUDIO_READY', { url: window.location.href, warmStart: false, bootMs: 0 });
      reportDocumentHeight();
    }

    function disable() {
      if (!active) return;
      active = false;
      if (inlineTextRecord) finishInlineText(true);
      selectedElement = null;
      hoverElement = null;
      multiElements = [];
      unbindEvents();
      stopMutationObserver();
      stopResizeObserver();
      stopCleanupTimer();
      resumeMedia();
      if (overlayRoot && overlayRoot.parentNode) overlayRoot.parentNode.removeChild(overlayRoot);
      overlayRoot = null;
      hoverBox = null;
      selectedBox = null;
      guideLayer = null;
      multiBoxes = [];
      elementsById.clear();
      temporaryEdits.clear();
      lastReportedHeight = 0;
    }

    function ensureTempRecord(element) {
      var id = getElementId(element);
      var record = temporaryEdits.get(id);
      if (!record) {
        record = { element: element, styles: {}, attrs: {}, text: null, history: [] };
        temporaryEdits.set(id, record);
      }
      return record;
    }

    function applyStylePatch(message) {
      var element = resolveElement(message);
      if (!element || !message.styles || typeof message.styles !== 'object') {
        postAck(message.requestId, false, 'Elemento o estilos invalidos');
        return;
      }
      var record = ensureTempRecord(element);
      var stepBefore = {};
      Object.keys(message.styles).forEach(function (prop) {
        if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(prop)) return;
        var value = String(message.styles[prop]).slice(0, MAX_ATTR_LENGTH);
        if (!Object.prototype.hasOwnProperty.call(record.styles, prop)) {
          record.styles[prop] = element.style[prop] || '';
        }
        stepBefore[prop] = element.style[prop] || '';
        element.style[prop] = value;
      });
      record.history.push({ kind: 'style', payload: stepBefore });
      scheduleBoxUpdate();
      postAck(message.requestId, true, undefined, buildSnapshot(element));
    }

    function applyText(message) {
      var element = resolveElement(message);
      if (!element || typeof message.value !== 'string' || message.value.length > 5000) {
        postAck(message.requestId, false, 'Texto invalido');
        return;
      }
      if (!hasOnlyTextChildren(element)) {
        postAck(message.requestId, false, 'El texto solo se edita en nodos sin hijos');
        return;
      }
      var record = ensureTempRecord(element);
      if (!record.text) record.text = { value: element.textContent || '' };
      record.history.push({ kind: 'text', payload: element.textContent || '' });
      element.textContent = message.value;
      scheduleBoxUpdate();
      postAck(message.requestId, true, undefined, buildSnapshot(element));
    }

    function isSafeUrlValue(value) {
      var normalized = String(value || '').trim().toLowerCase();
      return normalized.indexOf('javascript:') !== 0 && normalized.indexOf('data:text/html') !== 0;
    }

    function applyAttribute(message) {
      var element = resolveElement(message);
      var name = message.name;
      var value = typeof message.value === 'string' ? message.value.slice(0, MAX_ATTR_LENGTH) : '';
      if (!element || !SAFE_WRITE_ATTRIBUTES[name]) { postAck(message.requestId, false, 'Atributo invalido'); return; }
      if ((name === 'src' || name === 'srcset' || name === 'href' || name === 'backgroundImage') && !isSafeUrlValue(value)) {
        postAck(message.requestId, false, 'URL invalida');
        return;
      }
      var record = ensureTempRecord(element);
      if (name === 'backgroundImage') {
        if (!Object.prototype.hasOwnProperty.call(record.styles, 'backgroundImage')) {
          record.styles.backgroundImage = element.style.backgroundImage || '';
        }
        record.history.push({
          kind: 'attr', name: 'backgroundImage',
          payload: { kind: 'style', value: element.style.backgroundImage || '' },
        });
        element.style.backgroundImage = value.indexOf('url(') === 0 ? value : 'url("' + value.replace(/"/g, '\\"') + '")';
      } else {
        if (!Object.prototype.hasOwnProperty.call(record.attrs, name)) {
          record.attrs[name] = { had: element.hasAttribute(name), value: element.getAttribute(name) || '' };
        }
        record.history.push({
          kind: 'attr', name: name,
          payload: { kind: 'attr', had: element.hasAttribute(name), value: element.getAttribute(name) || '' },
        });
        element.setAttribute(name, value);
      }
      scheduleBoxUpdate();
      postAck(message.requestId, true, undefined, buildSnapshot(element));
    }

    function undoLastPatch(message) {
      var element = resolveElement(message);
      if (!element) { postAck(message.requestId, false, 'Elemento no encontrado'); return; }
      var record = temporaryEdits.get(getElementId(element));
      if (!record || record.history.length === 0) { postAck(message.requestId, false, 'Sin historial'); return; }
      var step = record.history.pop();
      if (step.kind === 'style') {
        Object.keys(step.payload).forEach(function (prop) { element.style[prop] = step.payload[prop]; });
      } else if (step.kind === 'text') {
        element.textContent = step.payload;
      } else if (step.kind === 'attr') {
        var data = step.payload;
        if (data.kind === 'style') element.style[step.name] = data.value;
        else if (data.had) element.setAttribute(step.name, data.value);
        else element.removeAttribute(step.name);
      }
      scheduleBoxUpdate();
      postAck(message.requestId, true, undefined, buildSnapshot(element));
    }

    function clearTemporaryEdits(message) {
      var target = resolveElement(message || {});
      var targetId = target ? getElementId(target) : null;
      temporaryEdits.forEach(function (record, id) {
        if (targetId && targetId !== id) return;
        Object.keys(record.styles).forEach(function (prop) { record.element.style[prop] = record.styles[prop]; });
        Object.keys(record.attrs).forEach(function (name) {
          var previous = record.attrs[name];
          if (previous.had) record.element.setAttribute(name, previous.value);
          else record.element.removeAttribute(name);
        });
        if (record.text) record.element.textContent = record.text.value;
        temporaryEdits.delete(id);
      });
      scheduleBoxUpdate();
      postAck(message && message.requestId, true, undefined, target ? buildSnapshot(target) : undefined);
    }

    function inspectElement(message) {
      var element = resolveElement(message);
      if (!element) {
        post('XTAR_STUDIO_ERROR', { requestId: message.requestId, reason: 'Elemento no encontrado' });
        return;
      }
      selectedElement = element;
      hoverElement = element;
      lastSelectedSnapshotKey = snapshotKey(element);
      scheduleBoxUpdate();
      post('XTAR_STUDIO_SELECT', { requestId: message.requestId, snapshot: buildSnapshot(element) });
    }

    function multiInspect(message) {
      var ids = Array.isArray(message.elementIds) ? message.elementIds : [];
      multiElements = ids
        .map(function (id) { return elementsById.get(id); })
        .filter(function (element) { return element && document.contains(element); });
      refreshMultiBoxes();
      post('XTAR_STUDIO_MULTI_SELECT', {
        requestId: message.requestId,
        snapshots: multiElements.map(function (element) { return buildSnapshot(element); }),
      });
    }

    function startInlineTextFromMessage(message) {
      var element = resolveElement(message);
      if (!startInlineText(element)) {
        post('XTAR_STUDIO_ERROR', { requestId: message.requestId, reason: 'El elemento no permite edicion inline segura' });
      }
    }

    function handleMessage(event) {
      if (window.parent === window) return;
      var data = event.data;
      if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
      if (data.type.indexOf(MESSAGE_PREFIX) !== 0 || data.source !== 'xtarify-studio') return;
      if (event.source && event.source !== window.parent) return;
      if (!isAllowedParentOrigin(event.origin)) return;
      parentOrigin = event.origin;
      try {
        switch (data.type) {
          case 'XTAR_STUDIO_ENABLE': enable(); break;
          case 'XTAR_STUDIO_DISABLE': disable(); break;
          case 'XTAR_STUDIO_PING':
            post('XTAR_STUDIO_READY', { requestId: data.requestId, url: window.location.href, warmStart: active });
            break;
          case 'XTAR_STUDIO_INSPECT': inspectElement(data); break;
          case 'XTAR_STUDIO_MULTI_INSPECT': multiInspect(data); break;
          case 'XTAR_STUDIO_STYLE_PATCH': applyStylePatch(data); break;
          case 'XTAR_STUDIO_APPLY_TEXT': applyText(data); break;
          case 'XTAR_STUDIO_APPLY_ATTR': applyAttribute(data); break;
          case 'XTAR_STUDIO_UNDO_PATCH': undoLastPatch(data); break;
          case 'XTAR_STUDIO_CLEAR_TEMP': clearTemporaryEdits(data); break;
          case 'XTAR_STUDIO_TREE_REQUEST': postLayerTree(data.requestId); break;
          case 'XTAR_STUDIO_ASSETS_REQUEST': postDetectedAssets(data.requestId); break;
          case 'XTAR_STUDIO_GUIDES_REQUEST': postGuides(data.requestId, data); break;
          case 'XTAR_STUDIO_INLINE_TEXT_START': startInlineTextFromMessage(data); break;
          case 'XTAR_STUDIO_INLINE_TEXT_COMMIT': finishInlineText(true); break;
          case 'XTAR_STUDIO_INLINE_TEXT_CANCEL': finishInlineText(false); break;
          case 'XTAR_STUDIO_BREAKPOINT_HINT': break;
          case 'XTAR_STUDIO_DARK_MODE': break;
        }
      } catch (error) {
        post('XTAR_STUDIO_ERROR', {
          requestId: data.requestId,
          error: error && error.message ? error.message : 'Studio Bridge error',
        });
      }
    }

    window.addEventListener('message', handleMessage);
    window.XTAR_STUDIO_BRIDGE_VERSION = VERSION;
    window.XTAR_STUDIO_BRIDGE_PROTOCOL = '0.2.0';
  })();

  // ====================================================================
  // 2) ERROR SYSTEM (Eye of Sauron) v1.0.0
  // --------------------------------------------------------------------
  // Captura runtime errors, unhandled promises, console.error (batched),
  // fetch failures, blank-screen fallback HTML, y reportes desde React
  // (via window.XtarErrorSystem.reportReact, llamado por ErrorBoundary).
  // Origen del parent: allowlist + autodeteccion via document.referrer.
  // ====================================================================
  (function errorSystem() {
    var EYE_OF_SAURON_VERSION = '1.0.0';
    var MESSAGE_TYPE = 'XTAR_ERROR_REPORT';
    var SOURCE = 'xtarify-eye-of-sauron';
    var DEDUP_TTL_MS = 5000;
    var CONSOLE_BATCH_MS = 250;
    var BLANK_SCREEN_CHECK_DELAY_MS = 3000;
    var MAX_STRING_LENGTH = 4000;

    var initialized = false;
    var parentOrigin = null;
    var errorsReported = 0;
    var fallbackInjected = false;
    var dedupCache = new Map();
    var consoleBuffer = [];
    var consoleFlushTimer = null;
    // Ultimo detalle de error real capturado (runtime/promise/console). Se
    // adjunta al reporte kind:'react' de watchRootForCrash para que cada crash
    // distinto tenga una FIRMA distinta (el auto-fix del IDE capea 2 intentos
    // por firma; con un mensaje constante todos los crashes compartirian UN
    // solo presupuesto) y para que el agente vea la causa concreta.
    var lastErrorDetail = '';
    var appReadyNotified = false;

    function rememberErrorDetail(message) {
      try {
        var text = typeof message === 'string' ? message.replace(/\s+/g, ' ').trim() : '';
        if (text) lastErrorDetail = text.slice(0, 300);
      } catch (_error) { /* fail-safe */ }
    }

    // "El root tiene contenido" = tiene hijos Element O texto visible.
    // root.children ignora text nodes: una app cuyo componente raiz renderiza
    // texto pelado se veria como "vacia" y disparaba blank-screen/overlay
    // sobre contenido visible.
    function rootHasContent(root) {
      if (!root) return false;
      if (root.children.length > 0) return true;
      var text = root.textContent;
      return !!(text && text.replace(/\s+/g, '').length > 0);
    }

    // Avisa al IDE (una sola vez) que la app del usuario ya monto contenido.
    // PreviewIframe usa esta senal para quitar el loader del preview sin
    // esperar el evento load del iframe (que espera TODAS las subresources:
    // una imagen/video de terceros colgado lo posterga minutos). Payload sin
    // datos sensibles => '*' como el route reporter.
    function notifyAppReady() {
      if (appReadyNotified) return;
      appReadyNotified = true;
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'XTAR_APP_READY', source: SOURCE }, '*');
        }
      } catch (_error) { /* fail-safe */ }
    }

    function truncate(value, limit) {
      var max = limit || MAX_STRING_LENGTH;
      if (value == null) return '';
      var str = typeof value === 'string' ? value : safeStringify(value);
      return str.length > max ? str.slice(0, max) + '...[truncated]' : str;
    }

    function safeStringify(value) {
      try {
        return JSON.stringify(value, function (_key, v) {
          if (typeof v === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
          if (v instanceof Error) return { message: v.message, stack: v.stack };
          return v;
        });
      } catch (_e1) {
        try { return String(value); } catch (_e2) { return '[unserializable]'; }
      }
    }

    function getConfiguredOrigins() {
      var list = window.XTAR_ERROR_ALLOWED_ORIGINS;
      return Array.isArray(list) ? list.filter(function (v) { return typeof v === 'string'; }) : [];
    }

    function isAllowedParentOrigin(origin) {
      if (!origin || origin === 'null') return false;
      if (getConfiguredOrigins().indexOf(origin) !== -1) return true;
      try {
        var url = new URL(origin);
        var host = url.hostname.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
        return (
          host === 'xtarify.com' ||
          host === 'www.xtarify.com' ||
          host === 'xtarify.app' ||
          host === 'www.xtarify.app' ||
          host === 'xtar.dev' ||
          host === 'www.xtar.dev' ||
          host.endsWith('.xtarify.com') ||
          host.endsWith('.xtarify.app') ||
          host.endsWith('.xtar.dev')
        );
      } catch (_error) {
        return false;
      }
    }

    function detectParentOrigin() {
      if (window.parent === window) return null;
      try {
        if (document.referrer) {
          var url = new URL(document.referrer);
          var candidate = url.protocol + '//' + url.host;
          if (isAllowedParentOrigin(candidate)) return candidate;
        }
      } catch (_error) { /* ignore */ }
      return null;
    }

    function postToParent(report) {
      if (window.parent === window) return;
      if (!parentOrigin) parentOrigin = detectParentOrigin();
      if (!parentOrigin) return;
      try { window.parent.postMessage(report, parentOrigin); } catch (_error) { /* never throw */ }
    }

    function shouldDedupe(key) {
      var now = Date.now();
      dedupCache.forEach(function (ts, k) {
        if (now - ts > DEDUP_TTL_MS) dedupCache.delete(k);
      });
      if (dedupCache.has(key)) return true;
      dedupCache.set(key, now);
      return false;
    }

    function emit(partial) {
      try {
        var full = {
          type: MESSAGE_TYPE,
          version: EYE_OF_SAURON_VERSION,
          source: SOURCE,
          timestamp: Date.now(),
        };
        for (var k in partial) {
          if (Object.prototype.hasOwnProperty.call(partial, k)) full[k] = partial[k];
        }
        var dedupKey = full.kind + '|' + full.message + '|' + (full.filename || '') + '|' + (full.lineno || '');
        if (shouldDedupe(dedupKey)) return;
        errorsReported += 1;
        postToParent(full);
      } catch (_error) { /* fail-safe */ }
    }

    function handleRuntimeError(event) {
      try {
        // Los fallos de carga de recursos (<img>/<script>/<link> caidos)
        // llegan a este listener capture-phase como Event pelado, sin .error
        // ni .message. No son errores de la app: sin este guard, cada asset
        // remoto roto pintaba un card rojo "Runtime error" sin detalle en el
        // IDE sobre una pagina perfectamente sana.
        if (!event || (!event.error && !event.message)) return;
        var err = event.error;
        rememberErrorDetail((err && err.message) || event.message || '');
        emit({
          kind: 'runtime',
          message: truncate((err && err.message) || event.message || 'Runtime error'),
          stack: err && err.stack ? truncate(err.stack) : undefined,
          filename: event.filename || undefined,
          lineno: event.lineno || undefined,
          colno: event.colno || undefined,
        });
      } catch (_error) { /* fail-safe */ }
    }

    function handleRejection(event) {
      try {
        var reason = event.reason;
        var isError = reason instanceof Error;
        rememberErrorDetail(isError ? reason.message : safeStringify(reason));
        emit({
          kind: 'promise',
          message: truncate(isError ? reason.message : safeStringify(reason)),
          stack: isError ? truncate(reason.stack || '') : undefined,
        });
      } catch (_error) { /* fail-safe */ }
    }

    function flushConsoleBuffer() {
      consoleFlushTimer = null;
      if (consoleBuffer.length === 0) return;
      var items = consoleBuffer.splice(0, consoleBuffer.length);
      try {
        var message = items
          .map(function (entry) { return entry.args.map(function (a) { return safeStringify(a); }).join(' '); })
          .join('\n');
        // React 19 reporta los errores de render por console.error (via su
        // onUncaughtError default en algunos paths); recordarlo alimenta la
        // firma del reporte kind:'react'.
        rememberErrorDetail(message);
        emit({ kind: 'console', message: truncate(message) });
      } catch (_error) { /* fail-safe */ }
    }

    function wrapConsoleError() {
      var original = console.error;
      console.error = function patched() {
        var args = Array.prototype.slice.call(arguments);
        try {
          consoleBuffer.push({ args: args, at: Date.now() });
          if (!consoleFlushTimer) consoleFlushTimer = setTimeout(flushConsoleBuffer, CONSOLE_BATCH_MS);
        } catch (_error) { /* fail-safe */ }
        try { original.apply(console, args); } catch (_e) { /* ignore */ }
      };
    }

    function wrapFetch() {
      if (typeof window.fetch !== 'function') return;
      var originalFetch = window.fetch.bind(window);
      window.fetch = function patched(input, init) {
        return originalFetch(input, init).then(function (response) {
          if (!response.ok) {
            try {
              var url = typeof input === 'string'
                ? input
                : input instanceof URL ? input.toString() : input.url;
              emit({
                kind: 'network',
                message: truncate('fetch failed ' + response.status + ' ' + response.statusText),
                url: truncate(url, 1000),
                status: response.status,
              });
            } catch (_e) { /* fail-safe */ }
          }
          return response;
        }, function (error) {
          try {
            var url = typeof input === 'string'
              ? input
              : input instanceof URL ? input.toString() : input.url;
            emit({
              kind: 'network',
              message: truncate(error instanceof Error ? error.message : 'fetch threw'),
              stack: error instanceof Error && error.stack ? truncate(error.stack) : undefined,
              url: truncate(url, 1000),
            });
          } catch (_e) { /* fail-safe */ }
          throw error;
        });
      };
    }

    function injectFallbackErrorScreen() {
      if (fallbackInjected) return;
      try {
        var body = document.body;
        if (!body) return;
        var root = document.getElementById('root');
        if (rootHasContent(root)) return;
        fallbackInjected = true;

        var overlay = document.createElement('div');
        overlay.id = 'xtar-fallback-error-screen';
        overlay.setAttribute('role', 'alert');
        overlay.style.cssText = [
          'position:fixed', 'inset:0', 'z-index:2147483645',
          'display:flex', 'align-items:center', 'justify-content:center',
          'padding:1rem', 'background:var(--background,#fff)',
          'color:var(--foreground,#111)',
          'font:15px/1.5 system-ui,-apple-system,sans-serif',
        ].join(';');

        overlay.innerHTML =
          '<div style="max-width:28rem;text-align:center">' +
          '<h1 style="font-size:1.25rem;font-weight:600;margin:0 0 0.5rem;letter-spacing:-0.01em">' +
          'Esta pagina no cargo' +
          '</h1>' +
          '<p style="color:var(--muted-foreground,#6b7280);margin:0 0 1.5rem">' +
          'Algo salio mal de nuestro lado. Puedes intentar recargar o volver al inicio.' +
          '</p>' +
          '<div style="display:flex;gap:0.5rem;justify-content:center;flex-wrap:wrap">' +
          '<button type="button" id="xtar-fallback-retry" ' +
          'style="padding:0.5rem 1rem;border-radius:0.375rem;font:inherit;font-weight:500;' +
          'cursor:pointer;border:0;background:var(--primary,#111);color:var(--primary-foreground,#fff)">' +
          'Intentar de nuevo' +
          '</button>' +
          '<a href="/" ' +
          'style="padding:0.5rem 1rem;border-radius:0.375rem;font:inherit;font-weight:500;' +
          'text-decoration:none;border:1px solid var(--border,#e5e7eb);' +
          'background:var(--background,#fff);color:var(--foreground,#111)">' +
          'Ir al inicio' +
          '</a>' +
          '</div>' +
          '</div>';

        body.appendChild(overlay);

        var retry = overlay.querySelector('#xtar-fallback-retry');
        if (retry) {
          retry.addEventListener('click', function () {
            try { window.location.reload(); } catch (_e) { /* ignored */ }
          });
        }
      } catch (_error) { /* fail-safe */ }
    }

    // Contraparte de injectFallbackErrorScreen: si la app se RECUPERA (el
    // auto-fix del agente llego via HMR, un remount tardio, o el crash fue un
    // falso positivo), la pantalla de error NO debe quedar tapando la app
    // sana. La llama el observer de watchRootForCrash al ver contenido.
    function removeFallbackErrorScreen() {
      try {
        var overlay = document.getElementById('xtar-fallback-error-screen');
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        fallbackInjected = false;
      } catch (_error) { /* fail-safe */ }
    }

    function checkBlankScreen() {
      try {
        var body = document.body;
        if (!body) return;
        // Si watchRootForCrash ya reporto el crash e inyecto la pantalla, no
        // emitir un SEGUNDO error auto-fixeable (blank-screen) por el mismo
        // incidente: quemaria el presupuesto de auto-fix del IDE dos veces.
        if (fallbackInjected) return;
        var root = document.getElementById('root');
        if (rootHasContent(root)) {
          notifyAppReady();
          return;
        }
        emit({
          kind: 'blank-screen',
          message: errorsReported > 0
            ? 'Preview rendered with empty body after 3s (' + errorsReported + ' errors detected)'
            : 'Preview rendered with empty body after 3s',
        });
        injectFallbackErrorScreen();
      } catch (_error) { /* fail-safe */ }
    }

    function reportReact(error, componentStack) {
      emit({
        kind: 'react',
        message: truncate((error && error.message) || 'React error'),
        stack: error && error.stack ? truncate(error.stack) : undefined,
        componentStack: componentStack ? truncate(componentStack) : undefined,
      });
    }

    // Cuando React monta y luego CRASHEA en un render sin error boundary, React
    // desmonta todo el arbol y #root queda vacio. Observamos esa transicion
    // (tenia contenido -> quedo vacio) y mostramos la pantalla de error vanilla.
    // Esto reemplaza al viejo <ErrorBoundary>/<ErrorScreen> de React: el
    // proyecto ya no trae ese componente; el fallback + el reporte viven aca.
    // El MISMO observer ademas: (a) avisa XTAR_APP_READY al IDE cuando el root
    // gana contenido por primera vez (senal de "quita el loader"), y (b) si la
    // app se RECUPERA (HMR del auto-fix, remount tardio, falso positivo)
    // REMUEVE la pantalla de error en vez de dejarla tapando la app sana.
    function watchRootForCrash() {
      try {
        if (typeof MutationObserver === 'undefined') return;
        var root = document.getElementById('root');
        if (!root) {
          // Con carga async el script puede ejecutar antes de que el body este
          // parseado: reintentar una vez cuando el DOM este listo.
          if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', watchRootForCrash, { once: true });
          }
          return;
        }
        var hadContent = rootHasContent(root);
        if (hadContent) notifyAppReady();
        var observer = new MutationObserver(function () {
          if (rootHasContent(root)) {
            hadContent = true;
            notifyAppReady();
            if (fallbackInjected) removeFallbackErrorScreen();
            return;
          }
          if (!hadContent || fallbackInjected) return;
          // Re-chequear tras un tick evita falsos positivos por transiciones
          // breves donde el root queda vacio por un instante. Si aun asi se
          // colara un falso positivo (patron raro tipo clear-then-remount
          // lento), la rama de recuperacion de arriba lo auto-sana.
          setTimeout(function () {
            if (fallbackInjected) return;
            var current = document.getElementById('root');
            if (current && !rootHasContent(current)) {
              emit({
                kind: 'react',
                message: truncate(
                  'React tree unmounted to an empty #root (uncaught render error)' +
                    (lastErrorDetail ? ' :: ' + lastErrorDetail : '')
                ),
              });
              injectFallbackErrorScreen();
            }
          }, 160);
        });
        observer.observe(root, { childList: true });
      } catch (_error) { /* fail-safe */ }
    }

    function init() {
      if (initialized) return;
      initialized = true;
      try {
        parentOrigin = detectParentOrigin();
        window.addEventListener('error', handleRuntimeError, true);
        window.addEventListener('unhandledrejection', handleRejection, true);
        wrapConsoleError();
        wrapFetch();
        watchRootForCrash();
        var scheduleBlankCheck = function () { setTimeout(checkBlankScreen, BLANK_SCREEN_CHECK_DELAY_MS); };
        if (document.readyState === 'complete') scheduleBlankCheck();
        else window.addEventListener('load', scheduleBlankCheck, { once: true });
      } catch (_error) { /* fail-safe */ }
    }

    // Init inmediato — los listeners de error tienen que estar enganchados
    // antes de que React intente montar. reportReact() sigue expuesto en
    // window.XtarErrorSystem por compatibilidad, pero el proyecto ya no monta
    // un ErrorBoundary: los crashes de React se detectan aca (watchRootForCrash
    // + blank-screen) y se reportan al IDE igual que antes.
    init();

    window.XtarErrorSystem = {
      version: EYE_OF_SAURON_VERSION,
      reportReact: reportReact,
    };
  })();

  // ====================================================================
  // 3) XTAR BADGE v2.0.0
  // --------------------------------------------------------------------
  // Sello "Hecho con Xtarify" en bottom-right. Pill BLANCO, borde gris,
  // sombra leve (offset 5px hacia abajo). Todo el texto usa Poppins; la
  // palabra "Xtarify" se renderiza como wordmark SVG (mismo glyph set del
  // componente oficial) con el punto de la "i" en azul + glow. SIN la
  // animacion de caida del componente: aca el wordmark es estatico.
  //
  // Hover (se activa sobre el tamano QUE TENDRA: el pill ya crecido 20% + la
  // zona del mascota, via un ::before transparente en .xtar-anchor; no solo
  // sobre el pill chico => no hay que apuntar fino ni hay flicker):
  //   - el conjunto crece 20% desde el centro-inferior (transform-origin
  //     50% 100% => se expande a AMBOS lados, no solo a la izquierda);
  //   - el scale va en .xtar-anchor (pill + cuerpo + manos) => todo crece en
  //     LOCKSTEP: las manos siguen al borde y el cuerpo sigue centrado;
  //   - arc_hands aparece INSTANTANEO agarrando el borde superior del pill
  //     (capa por DELANTE del pill);
  //   - arc_body SUBE rapido desde el centro del pill hasta su posicion
  //     final (capa por DETRAS del pill, se asoma por arriba);
  //   - ambas imagenes terminan al MISMO tamano y la MISMA posicion (son
  //     dos capas del mismo lienzo 1487x1058).
  //
  // Suprimido en iframes (IDE preview / Studio canvas) y headless agents.
  // Boton de cerrar (x) en la esquina superior derecha del PILL (no del
  // mascota), por ENCIMA de todo (z-index alto) para que sea clickeable:
  // al cerrarlo la persona ve como se veria su pagina SIN el sello. NO se
  // persiste el cierre: al refrescar la pagina el sello vuelve a aparecer.
  //
  // Assets del mascota (PNG): se sirven por URL ABSOLUTA desde la web de
  // Xtarify (production), via ARC_ASSET_BASE. NO se bundlean en public/arc del
  // proyecto y NO hay fallback a carpeta local; viven solo en xtarify.com.
  // ====================================================================
  (function xtarBadge() {
    // Hidden inside iframes (IDE preview, studio canvas).
    try { if (window.self !== window.top) return; } catch (_e) { return; }

    var ua = (navigator && navigator.userAgent) || '';
    if (/puppeteer|HeadlessChrome|playwright|jsdom/i.test(ua)) return;

    // --- Config (unico lugar para tunear) --------------------------------
    // ARC_ASSET_BASE: los PNG del mascota se sirven desde la web de Xtarify
    // (PRODUCTION), mismo origen que el favicon. Asi el badge funciona en TODOS
    // los proyectos (nuevos y viejos) sin bundlear /arc en cada proyecto. NO hay
    // fallback a carpeta local: los assets viven SOLO en xtarify.com.
    // Requisito de deploy: website/public/arc/ desplegado a xtarify.com/arc/.
    var ARC_ASSET_BASE = 'https://xtarify.com/arc';
    var POPPINS_HREF =
      'https://fonts.googleapis.com/css2?family=Poppins:wght@500;600&display=swap';
    var WORDMARK_INK = '#0b1220'; // letras (oscuro sobre el pill blanco)
    var WORDMARK_DOT = '#3b82f6'; // punto azul de la "i" (el glow es celeste)

    function buildWordmark() {
      // Mismo set de letras/posiciones del componente React (estatico).
      var letters = [
        ['X', 295, false],
        ['t', 336, false],
        ['a', 377, false],
        ['r', 415, false],
        [String.fromCharCode(0x131), 441, true], // i (dotless, U+0131) -> punto azul aparte
        ['f', 466, false],
        ['y', 503, false]
      ];
      var glyphs = '';
      for (var i = 0; i < letters.length; i += 1) {
        var c = letters[i][0];
        var x = letters[i][1];
        var dot = letters[i][2];
        glyphs +=
          '<g transform="translate(' + x + ',125)">' +
          '<text>' + c + '</text>' +
          (dot
            ? '<circle cx="0" cy="-28" r="7" fill="' + WORDMARK_DOT +
              '" filter="url(#xtar-wm-glow)"></circle>'
            : '') +
          '</g>';
      }
      return (
        '<svg class="xtar-wm" xmlns="http://www.w3.org/2000/svg" ' +
        'viewBox="270 70 260 110" role="img" aria-label="Xtarify">' +
        // glow celeste suave y pequeño alrededor del punto de la "i":
        // se difumina el alpha del punto, se tinta celeste (#7dd3fc) y se pone
        // DETRAS del punto original (que queda nitido encima).
        '<defs><filter id="xtar-wm-glow" x="-160%" y="-160%" width="420%" height="420%">' +
        '<feGaussianBlur in="SourceAlpha" stdDeviation="2.3" result="blur"></feGaussianBlur>' +
        '<feFlood flood-color="#7dd3fc" flood-opacity="0.9" result="c"></feFlood>' +
        '<feComposite in="c" in2="blur" operator="in" result="glow"></feComposite>' +
        '<feMerge><feMergeNode in="glow"></feMergeNode><feMergeNode in="glow"></feMergeNode>' +
        '<feMergeNode in="SourceGraphic"></feMergeNode></feMerge>' +
        '</filter></defs>' +
        '<g>' + glyphs + '</g>' +
        '</svg>'
      );
    }

    function css() {
      return [
        // wrapper: posiciona en la esquina (con aire para crecer), no bloquea
        // la pagina y NO recorta el mascota (overflow visible por defecto)
        '#xtar-badge-root{position:fixed;right:28px;bottom:24px;z-index:9999;',
        'pointer-events:none;opacity:0;transition:opacity 240ms ease;',
        "font-family:'Poppins',system-ui,-apple-system,'Segoe UI',sans-serif;",
        '--xtar-arc-w:112px;--xtar-arc-overlap:16px;--xtar-grow:1.2;}',
        '#xtar-badge-root[data-ready="1"]{opacity:1;}',
        // anchor = caja del pill + mascota. EL HOVER ES SOLO SOBRE EL PILL: el
        // mascota es absoluto + pointer-events:none, asi que no agranda el area
        // y la caja del anchor == la del pill. Crece 20% desde el centro-inferior
        // (origin 50% 100%) => se expande a ambos lados, no solo a la izquierda.
        '#xtar-badge-root .xtar-anchor{position:relative;display:inline-block;',
        'pointer-events:auto;transform:scale(1);transform-origin:50% 100%;',
        'will-change:transform;transition:transform 260ms cubic-bezier(.16,1,.3,1);}',
        // hit-area extendida: el hover se activa sobre el tamano QUE TENDRA (el
        // pill ya crecido 20% + la zona del mascota), no solo sobre el pill chico.
        // Es un ::before transparente DETRAS de todo (z auto) => no bloquea el
        // link del pill ni tapa el mascota; solo capta el hover en esa area.
        // El +8px (antes -22px) arranca el hover ~30px MAS ABAJO: recorta el
        // espacio vacio de arriba sin dejar de cubrir la cabeza del mascota.
        '#xtar-badge-root .xtar-anchor::before{content:"";position:absolute;',
        'left:-20px;right:-20px;bottom:0;',
        'top:calc((var(--xtar-arc-overlap) - var(--xtar-arc-w) / 1.405) * var(--xtar-grow) + 8px);}',
        '#xtar-badge-root .xtar-anchor:hover{transform:scale(var(--xtar-grow));}',
        // pill: blanco, SIN borde, esquinas 8px, sombra leve (offset 5px)
        '#xtar-badge-root .xtar-pill{position:relative;z-index:2;',
        'display:inline-flex;align-items:center;gap:8px;padding:9px 15px;',
        'background:#ffffff;border:0;border-radius:8px;',
        'box-shadow:0 5px 14px rgba(2,6,23,0.13),0 1px 2px rgba(2,6,23,0.06);',
        'color:#0b1220;text-decoration:none;white-space:nowrap;cursor:pointer;',
        'font-size:14px;font-weight:500;line-height:1;letter-spacing:.005em;',
        'transition:box-shadow 260ms ease;}',
        // (el crecimiento 20% lo hace .xtar-anchor; aca solo realzamos la sombra)
        '#xtar-badge-root .xtar-anchor:hover .xtar-pill{',
        'box-shadow:0 12px 28px rgba(2,6,23,0.18),0 2px 5px rgba(2,6,23,0.08);}',
        '#xtar-badge-root .xtar-made{color:#5b6573;font-weight:500;}',
        '#xtar-badge-root .xtar-wm{height:20px;width:auto;display:block;overflow:visible;}',
        "#xtar-badge-root .xtar-wm text{font-family:'Poppins',system-ui,sans-serif;",
        'font-weight:600;font-size:84px;fill:' + WORDMARK_INK + ';',
        'text-anchor:middle;dominant-baseline:central;}',
        // mascota: dos capas del mismo lienzo, misma caja y posicion final.
        // Hijas del anchor => escalan EN LOCKSTEP con el pill en hover (las
        // manos siguen al borde, el cuerpo sigue centrado).
        '#xtar-badge-root .xtar-arc{position:absolute;left:50%;',
        'bottom:calc(100% - var(--xtar-arc-overlap));width:var(--xtar-arc-w);height:auto;',
        'pointer-events:none;user-select:none;-webkit-user-drag:none;',
        'transform:translateX(-50%);}',
        // cuerpo: DETRAS del pill (z bajo), sube desde el centro
        '#xtar-badge-root .xtar-arc-body{z-index:1;opacity:0;',
        'transform:translateX(-50%) translateY(54%) scale(.95);',
        'transition:transform 380ms cubic-bezier(.16,1,.3,1),opacity 220ms ease;}',
        // manos: DELANTE del pill (z alto), aparecen instantaneo
        '#xtar-badge-root .xtar-arc-hands{z-index:3;opacity:0;transition:none;}',
        '#xtar-badge-root .xtar-anchor:hover .xtar-arc-body{opacity:1;',
        'transform:translateX(-50%) translateY(0) scale(1);}',
        '#xtar-badge-root .xtar-anchor:hover .xtar-arc-hands{opacity:1;}',
        // link invisible sobre la cabeza del mascota (la parte que asoma POR
        // ENCIMA del pill): en hover (mascota visible) hace que click /
        // click-medio / ctrl-click en la IMAGEN tambien lleve a xtarify (anchor
        // real => pestaña nueva con rueda/ctrl/click-derecho). z4; pe:none en
        // reposo para no capturar clicks con el mascota oculto. La zona del pill
        // la sigue cubriendo a.xtar-pill (mismo destino), no este link.
        '#xtar-badge-root .xtar-arc-link{position:absolute;left:50%;',
        'bottom:100%;width:var(--xtar-arc-w);',
        'height:calc(var(--xtar-arc-w) / 1.405 - var(--xtar-arc-overlap));',
        'transform:translateX(-50%);z-index:4;pointer-events:none;}',
        '#xtar-badge-root .xtar-anchor:hover .xtar-arc-link{pointer-events:auto;cursor:pointer;}',
        // boton de cerrar (x): esquina superior derecha del PILL. Oculto en
        // reposo, visible SOLO en hover del badge (pedido del owner 2026-07-06;
        // antes era siempre-visible). pointer-events:none en reposo para que un
        // click en esa esquina no caiga en un boton invisible. En touch
        // (hover:none, mas abajo) queda siempre visible: sin hover real un
        // boton oculto seria inalcanzable. Por ENCIMA de todo
        // (z6 > manos z3 > link z4) => clickeable. Es hermano del pill (no
        // puede ir dentro del <a>) y vive dentro del anchor, asi escala en
        // lockstep con el pill en hover.
        '#xtar-badge-root .xtar-close{position:absolute;top:-9px;right:-9px;z-index:6;',
        'width:19px;height:19px;margin:0;padding:0;box-sizing:border-box;',
        'display:flex;align-items:center;justify-content:center;',
        'border-radius:50%;border:1px solid rgba(2,6,23,0.10);background:#ffffff;',
        'color:#64748b;cursor:pointer;opacity:0;pointer-events:none;',
        'box-shadow:0 2px 6px rgba(2,6,23,0.18);',
        '-webkit-tap-highlight-color:transparent;-webkit-appearance:none;appearance:none;',
        'transition:color 160ms ease,background 160ms ease,transform 160ms ease,',
        'opacity 160ms ease;}',
        // reveal de la x: hover sobre el badge (el ::before del anchor extiende
        // la zona, asi que apuntar a la esquina tambien la revela)
        '#xtar-badge-root .xtar-anchor:hover .xtar-close{opacity:1;pointer-events:auto;}',
        // hit-area extendida del boton (~35px de target tactil sin cambiar el
        // visual de 19px): un tap apenas errado cae en el boton y NO en el
        // pill de al lado (que navega a xtarify.com en pestana nueva).
        '#xtar-badge-root .xtar-close::after{content:"";position:absolute;inset:-8px;border-radius:50%;}',
        '#xtar-badge-root .xtar-close:hover{background:#0b1220;color:#ffffff;transform:scale(1.08);}',
        // teclado: al enfocar la x (Tab) tambien se revela, aunque no haya hover
        '#xtar-badge-root .xtar-close:focus-visible{opacity:1;pointer-events:auto;',
        'outline:2px solid #3b82f6;outline-offset:2px;}',
        '#xtar-badge-root .xtar-close svg{width:9px;height:9px;display:block;pointer-events:none;}',
        // touch: sin mascota ni hit-area extendida (no hay hover real); solo
        // el pill + la x. Ademas se neutraliza el :hover EMULADO de los
        // browsers tactiles (queda sticky tras un tap): sin esto el badge
        // quedaba "crecido" 1.2x con la x corrida, y el link invisible del
        // mascota quedaba armado sobre un area donde no se ve nada.
        '@media (hover:none){#xtar-badge-root .xtar-arc{display:none;}',
        '#xtar-badge-root .xtar-anchor::before{display:none;}',
        '#xtar-badge-root .xtar-anchor:hover{transform:none;}',
        // touch: sin hover real no hay forma de revelar la x => queda visible
        '#xtar-badge-root .xtar-close{opacity:1;pointer-events:auto;}',
        '#xtar-badge-root .xtar-arc-link{display:none;}}',
        // reduced motion: revelar sin transform animado
        '@media (prefers-reduced-motion:reduce){',
        '#xtar-badge-root .xtar-anchor,#xtar-badge-root .xtar-arc-body{',
        'transition:opacity 160ms ease;}',
        '#xtar-badge-root .xtar-anchor:hover .xtar-arc-body{',
        'transform:translateX(-50%) translateY(0) scale(1);}}',
        // mobile chico
        '@media (max-width:480px){#xtar-badge-root{right:16px;bottom:16px;}',
        '#xtar-badge-root .xtar-pill{padding:8px 12px;font-size:13px;}',
        '#xtar-badge-root .xtar-wm{height:18px;}}'
      ].join('');
    }

    function inject() {
      if (document.getElementById('xtar-badge-root')) return;

      // Poppins (una sola vez). Fail-safe: si no carga, cae al fallback.
      if (!document.getElementById('xtar-poppins-font')) {
        var font = document.createElement('link');
        font.id = 'xtar-poppins-font';
        font.rel = 'stylesheet';
        font.href = POPPINS_HREF;
        document.head.appendChild(font);
      }

      var style = document.createElement('style');
      style.setAttribute('data-xtar-badge', 'true');
      style.textContent = css();
      document.head.appendChild(style);

      var root = document.createElement('div');
      root.id = 'xtar-badge-root';
      root.setAttribute('role', 'complementary');
      root.setAttribute('aria-label', 'Hecho con Xtarify');
      root.innerHTML =
        '<div class="xtar-anchor">' +
        '<img class="xtar-arc xtar-arc-body" alt="" aria-hidden="true" decoding="async" ' +
        'src="' + ARC_ASSET_BASE + '/arc_body.png">' +
        '<a class="xtar-pill" href="https://xtarify.com" target="_blank" rel="noopener">' +
        '<span class="xtar-made">Hecho con</span>' +
        buildWordmark() +
        '</a>' +
        '<img class="xtar-arc xtar-arc-hands" alt="" aria-hidden="true" decoding="async" ' +
        'src="' + ARC_ASSET_BASE + '/arc_hands.png">' +
        // link invisible sobre la imagen (mismo destino que el pill)
        '<a class="xtar-arc-link" href="https://xtarify.com" target="_blank" ' +
        'rel="noopener" aria-hidden="true" tabindex="-1"></a>' +
        // boton de cerrar (x) en la esquina superior derecha del pill
        '<button class="xtar-close" type="button" aria-label="Ocultar el sello de Xtarify" ' +
        'title="Ocultar el sello">' +
        '<svg viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
        '<path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" stroke-width="1.6" ' +
        'stroke-linecap="round"></path></svg>' +
        '</button>' +
        '</div>';

      // Si el PNG no carga (p.ej. xtarify.com inaccesible), ocultar la imagen
      // para no mostrar el icono de imagen rota en el hover. NO hay fallback a
      // carpeta local: los assets viven solo en la web de Xtarify.
      var imgs = root.querySelectorAll('.xtar-arc');
      for (var i = 0; i < imgs.length; i += 1) {
        imgs[i].addEventListener('error', function () { this.style.display = 'none'; });
      }

      // Cerrar el sello: fade-out + remove. NO se persiste (sessionStorage /
      // localStorage) a proposito => al refrescar la pagina el sello vuelve.
      var closeBtn = root.querySelector('.xtar-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          root.style.opacity = '0';
          setTimeout(function () {
            if (root && root.parentNode) root.parentNode.removeChild(root);
          }, 260);
        });
      }

      document.body.appendChild(root);

      // Revelar recien cuando Poppins este lista: el wordmark tiene posiciones
      // por-glifo calibradas para Poppins, asi evitamos el flash/reflow en la
      // fuente de fallback. Probe via FontFaceSet (solo revela si Poppins
      // REALMENTE cargo, no en la resolucion vacia temprana) + re-probe en el
      // onload del <link> (carrera CSS) + onerror + timeout 1200ms de seguridad.
      var revealed = false;
      var reveal = function () {
        if (revealed) return;
        revealed = true;
        requestAnimationFrame(function () { root.setAttribute('data-ready', '1'); });
      };
      var probeFont = function () {
        if (!(document.fonts && typeof document.fonts.load === 'function')) { reveal(); return; }
        try {
          document.fonts.load('600 84px "Poppins"').then(function (faces) {
            if (faces && faces.length) reveal();
          }, reveal);
        } catch (_e) { reveal(); }
      };
      var linkEl = document.getElementById('xtar-poppins-font');
      if (linkEl) {
        linkEl.addEventListener('load', probeFont);
        linkEl.addEventListener('error', reveal);
      }
      probeFont();
      setTimeout(reveal, 1200);
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', inject, { once: true });
    } else {
      inject();
    }
  })();

})();
