// ==UserScript==
// @name         外币自动转换人民币助手
// @namespace    http://tampermonkey.net/
// @version      0.3.0
// @description  自动检测网页中的外币价格，实时转换为人民币显示。支持替换模式和附加模式，支持白名单/黑名单，支持汇率自动刷新。
// @author       Currency Converter Team
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      api.exchangerate-api.com
// @connect      open.er-api.com
// @run-at       document-idle
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '0.3.0';
    const PROCESSED_ATTR = 'data-cc-done';
    const CONVERTED_CLASS = 'cc-converted';
    const CONVERTED_GROUP_CLASS = 'cc-converted-group';

    const DEFAULT_CONFIG = {
        mode: 'append',
        enabled: true,
        decimalPlaces: 2,
        cacheDuration: 6 * 3600 * 1000,
        showStatusIndicator: false,
        listMode: 'none',
        whitelist: [],
        blacklist: [],
        autoRefreshOnModeChange: true,
        autoRefreshRates: true,
        autoRefreshInterval: 120,
        debugMode: false
    };

    const CACHE_DURATION = 30 * 60 * 1000;
    let rateCache = { data: null, timestamp: null };

    const MATCHERS = [
        { re: /HK\$\s?([\d,]+(?:\.\d+)?)/gi, code: 'HKD' },
        { re: /NT\$\s?([\d,]+(?:\.\d+)?)/gi, code: 'TWD' },
        { re: /US\$\s?([\d,]+(?:\.\d+)?)/gi, code: 'USD' },
        { re: /A\$\s?([\d,]+(?:\.\d+)?)/gi, code: 'AUD' },
        { re: /C\$\s?([\d,]+(?:\.\d+)?)/gi, code: 'CAD' },
        { re: /S\$\s?([\d,]+(?:\.\d+)?)/gi, code: 'SGD' },
        { re: /R\$\s?([\d,]+(?:\.\d+)?)/gi, code: 'BRL' },
        { re: /USD\s?([\d,]+(?:\.\d+)?)/gi, code: 'USD' },
        { re: /EUR\s?([\d,]+(?:\.\d+)?)/gi, code: 'EUR' },
        { re: /GBP\s?([\d,]+(?:\.\d+)?)/gi, code: 'GBP' },
        { re: /JPY\s?([\d,]+(?:\.\d+)?)/gi, code: 'JPY' },
        { re: /HKD\s?([\d,]+(?:\.\d+)?)/gi, code: 'HKD' },
        { re: /KRW\s?([\d,]+(?:\.\d+)?)/gi, code: 'KRW' },
        { re: /AUD\s?([\d,]+(?:\.\d+)?)/gi, code: 'AUD' },
        { re: /CAD\s?([\d,]+(?:\.\d+)?)/gi, code: 'CAD' },
        { re: /TWD\s?([\d,]+(?:\.\d+)?)/gi, code: 'TWD' },
        { re: /SGD\s?([\d,]+(?:\.\d+)?)/gi, code: 'SGD' },
        { re: /CHF\s?([\d,]+(?:\.\d+)?)/gi, code: 'CHF' },
    ];

    const SYMBOL_MATCHERS = [
        { re: /€\s?([\d,]+(?:\.\d+)?)/g, code: 'EUR' },
        { re: /£\s?([\d,]+(?:\.\d+)?)/g, code: 'GBP' },
        { re: /₩\s?([\d,]+(?:\.\d+)?)/g, code: 'KRW' },
    ];

    const DOLLAR_RE = /\$\s?([\d,]+(?:\.\d+)?)/g;
    const DOLLAR_PREFIX_RE = /[A-Za-z]$/;

    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
        'CODE', 'PRE', 'KBD', 'SAMP',
        'NOSCRIPT', 'IFRAME', 'SVG', 'MATH', 'CANVAS',
        'VIDEO', 'AUDIO', 'IMG', 'BR', 'HR',
        'META', 'LINK', 'HEAD', 'TITLE',
    ]);
    const FALLBACK_CONTAINER_TAGS = new Set(['SPAN', 'A', 'STRONG', 'B', 'EM', 'SMALL', 'DIV', 'P']);

    let statusIndicator = null;
    let isProcessing = false;
    let isModifying = false;
    let observer = null;
    let autoRefreshTimer = null;
    let processPageTimer = null;
    let interactionRescanTimers = [];
    let debugScanState = null;

    function getConfig() {
        const stored = GM_getValue('currencyConverterConfig', null);
        if (stored) {
            return { ...DEFAULT_CONFIG, ...stored };
        }
        return { ...DEFAULT_CONFIG };
    }

    function saveConfig(config) {
        GM_setValue('currencyConverterConfig', config);
    }

    function isDebugEnabled() {
        return !!getConfig().debugMode;
    }

    function debugLog(...args) {
        if (!isDebugEnabled()) return;
        console.log('[CC DEBUG]', ...args);
    }

    function previewText(text, maxLen = 80) {
        if (!text) return '';
        return text.replace(/\s+/g, ' ').trim().slice(0, maxLen);
    }

    function startDebugScan(reason = 'manual') {
        if (!isDebugEnabled()) {
            debugScanState = null;
            return;
        }

        debugScanState = {
            reason,
            startedAt: Date.now(),
            visited: 0,
            skipped: 0,
            quickRejected: 0,
            matched: 0,
            converted: 0,
            restoredGroups: 0,
            samples: {
                skipped: [],
                quickRejected: [],
                matched: [],
                converted: [],
                currencyCandidates: [],
                combinedElements: [],
                parentFallbacks: [],
                ancestorFallbacks: [],
                renderedElements: []
            }
        };
        debugLog('start scan', reason);
    }

    function pushDebugSample(bucket, value, limit = 8) {
        if (!debugScanState) return;
        const list = debugScanState.samples[bucket];
        if (!list || list.length >= limit) return;
        list.push(value);
    }

    function endDebugScan() {
        if (!debugScanState) return;

        const summary = {
            reason: debugScanState.reason,
            durationMs: Date.now() - debugScanState.startedAt,
            visited: debugScanState.visited,
            skipped: debugScanState.skipped,
            quickRejected: debugScanState.quickRejected,
            matched: debugScanState.matched,
            converted: debugScanState.converted,
            restoredGroups: debugScanState.restoredGroups
        };

        console.groupCollapsed('[CC DEBUG] scan summary');
        console.log(summary);
        console.log('currency candidate samples:', debugScanState.samples.currencyCandidates);
        console.log('combined element samples:', debugScanState.samples.combinedElements);
        console.log('parent fallback samples:', debugScanState.samples.parentFallbacks);
        console.log('ancestor fallback samples:', debugScanState.samples.ancestorFallbacks);
        console.log('rendered element samples:', debugScanState.samples.renderedElements);
        console.log('matched samples:', debugScanState.samples.matched);
        console.log('converted samples:', debugScanState.samples.converted);
        console.log('skipped samples:', debugScanState.samples.skipped);
        console.log('quick rejected samples:', debugScanState.samples.quickRejected);
        console.groupEnd();

        debugScanState = null;
    }

    function parseAmount(s) {
        const n = parseFloat(s.replace(/,/g, ''));
        return (isNaN(n) || n <= 0) ? null : n;
    }

    function formatPrice(amt) {
        const d = getConfig().decimalPlaces || 2;
        if (amt >= 100000) return '≈¥' + (amt / 10000).toFixed(1) + '万';
        if (amt >= 10000) return '≈¥' + (amt / 10000).toFixed(d) + '万';
        return '≈¥' + amt.toFixed(d);
    }

    function quickCheck(text) {
        if (/≈¥/.test(text)) return false;
        if (/[\$€£₩]/.test(text)) return true;
        if (/\b(?:USD|EUR|GBP|JPY|HKD|KRW|AUD|CAD|TWD|SGD|CHF)\b/i.test(text)) return true;
        return false;
    }

    function findAllMatches(text) {
        const hits = [];

        for (const m of MATCHERS) {
            m.re.lastIndex = 0;
            let match;
            while ((match = m.re.exec(text)) !== null) {
                const amt = parseAmount(match[1]);
                if (amt !== null) {
                    hits.push({
                        index: match.index,
                        length: match[0].length,
                        code: m.code,
                        amount: amt,
                        fullMatch: match[0]
                    });
                }
            }
        }

        for (const m of SYMBOL_MATCHERS) {
            m.re.lastIndex = 0;
            let match;
            while ((match = m.re.exec(text)) !== null) {
                const amt = parseAmount(match[1]);
                if (amt !== null) {
                    hits.push({
                        index: match.index,
                        length: match[0].length,
                        code: m.code,
                        amount: amt,
                        fullMatch: match[0]
                    });
                }
            }
        }

        DOLLAR_RE.lastIndex = 0;
        let dm;
        while ((dm = DOLLAR_RE.exec(text)) !== null) {
            const idx = dm.index;
            if (idx > 0 && DOLLAR_PREFIX_RE.test(text[idx - 1])) continue;

            const amt = parseAmount(dm[1]);
            if (amt !== null) {
                hits.push({
                    index: idx,
                    length: dm[0].length,
                    code: 'USD',
                    amount: amt,
                    fullMatch: dm[0]
                });
            }
        }

        if (hits.length === 0) return [];

        hits.sort((a, b) => a.index - b.index || b.length - a.length);

        const result = [];
        let lastEnd = -1;
        for (const h of hits) {
            if (h.index >= lastEnd) {
                result.push(h);
                lastEnd = h.index + h.length;
            }
        }

        return result;
    }

    const API_ENDPOINTS = [
        'https://open.er-api.com/v6/latest/USD',
        'https://api.exchangerate-api.com/v4/latest/USD'
    ];

    async function fetchExchangeRates() {
        console.log('[CC] fetchExchangeRates - checking cache...');
        if (rateCache.data && rateCache.timestamp &&
            (Date.now() - rateCache.timestamp) < CACHE_DURATION) {
            console.log('[CC] using cached rates');
            return rateCache.data;
        }

        for (const apiUrl of API_ENDPOINTS) {
            try {
                console.log('[CC] fetching from:', apiUrl);
                updateStatus('正在获取汇率...', 'loading');
                const response = await fetchWithGM(apiUrl);
                console.log('[CC] response:', response ? 'got data' : 'null');

                if (response && response.rates) {
                    rateCache.data = response.rates;
                    rateCache.timestamp = Date.now();
                    updateStatus('汇率已更新', 'success');
                    console.log('[CC] rates loaded, CNY:', response.rates.CNY);
                    return response.rates;
                }
            } catch (error) {
                console.error('[CurrencyConverter] API请求失败:', error);
                continue;
            }
        }

        updateStatus('汇率获取失败', 'error');
        return null;
    }

    function fetchWithGM(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                timeout: 10000,
                onload: function(response) {
                    try {
                        const data = JSON.parse(response.responseText);
                        resolve(data);
                    } catch (e) {
                        reject(e);
                    }
                },
                onerror: function(error) {
                    reject(error);
                },
                ontimeout: function() {
                    reject(new Error('请求超时'));
                }
            });
        });
    }

    function convertCurrency(amount, fromCurrency) {
        if (!rateCache.data) return null;

        const rates = rateCache.data;

        if (fromCurrency === 'CNY') return amount;

        if (rates[fromCurrency] && rates['CNY']) {
            const inUSD = amount / rates[fromCurrency];
            return inUSD * rates['CNY'];
        }

        return null;
    }

    function isSkippedElement(el) {
        if (!el) return true;
        if (SKIP_TAGS.has(el.tagName)) return true;
        if (el.isContentEditable) return true;
        if (el.classList && el.classList.contains(CONVERTED_CLASS)) return true;
        if (el.classList && el.classList.contains(CONVERTED_GROUP_CLASS)) return true;
        if (el.closest && (el.closest('.' + CONVERTED_CLASS) || el.closest('.' + CONVERTED_GROUP_CLASS))) return true;
        return false;
    }

    function skip(node) {
        if (!node) return true;
        const el = node.nodeType === 3 ? node.parentElement : node;
        return isSkippedElement(el);
    }

    function getConvertedGroupBaseText(group) {
        let text = '';
        for (const child of group.childNodes) {
            if (child.nodeType === 3) {
                text += child.nodeValue;
                continue;
            }

            if (child.nodeType === 1) {
                const childEl = child;
                if (childEl.classList && childEl.classList.contains(CONVERTED_CLASS)) {
                    continue;
                }
                text += childEl.textContent || '';
            }
        }
        return text;
    }

    function unwrapConvertedGroup(group) {
        if (!group || !group.parentNode) return null;

        const baseText = getConvertedGroupBaseText(group);
        const textNode = document.createTextNode(baseText);
        group.parentNode.replaceChild(textNode, group);
        return textNode;
    }

    function cleanupConvertedGroupsInSubtree(root) {
        if (!root || root.nodeType !== 1) return;

        const groups = [];
        if (root.classList && root.classList.contains(CONVERTED_GROUP_CLASS)) {
            groups.push(root);
        }

        if (root.querySelectorAll) {
            root.querySelectorAll('.' + CONVERTED_GROUP_CLASS).forEach((group) => groups.push(group));
        }

        for (const group of groups) {
            unwrapConvertedGroup(group);
        }
    }

    function restoreConvertedContent(root = document.body) {
        if (!root || !root.querySelectorAll) return;

        const groups = Array.from(root.querySelectorAll('.' + CONVERTED_GROUP_CLASS));
        if (groups.length === 0) return;

        isModifying = true;
        try {
            for (const group of groups) {
                unwrapConvertedGroup(group);
            }
            if (debugScanState) {
                debugScanState.restoredGroups += groups.length;
            }
        } finally {
            isModifying = false;
        }
    }

    function recoverNodeForProcessing(node) {
        if (!node) return node;

        if (node.nodeType === 3) {
            const parent = node.parentElement;
            const group = parent && parent.closest ? parent.closest('.' + CONVERTED_GROUP_CLASS) : null;
            return group ? unwrapConvertedGroup(group) : node;
        }

        if (node.nodeType === 1) {
            const group = node.closest ? node.closest('.' + CONVERTED_GROUP_CLASS) : null;
            if (group) {
                const recoveredTextNode = unwrapConvertedGroup(group);
                return recoveredTextNode || group.parentNode;
            }

            cleanupConvertedGroupsInSubtree(node);
        }

        return node;
    }

    function walkDOM(root) {
        if (!root) return;

        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    if (skip(node)) return NodeFilter.FILTER_REJECT;
                    if (!node.nodeValue || node.nodeValue.trim().length === 0) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);

        debugLog('walkDOM text nodes:', nodes.length);
        for (const n of nodes) {
            try { processTextNode(n); } catch (e) { console.error('[CC] processTextNode error:', e); }
        }

        processCombinedTextElements(root);
    }

    function hasConvertedDescendant(el) {
        if (!el || !el.querySelector) return false;
        return !!el.querySelector('.' + CONVERTED_CLASS + ', .' + CONVERTED_GROUP_CLASS);
    }

    function isVisibleElement(el) {
        if (!el || !el.isConnected) return false;
        if (el.hidden) return false;
        const style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0;
    }

    function getRenderedText(el) {
        if (!el) return '';
        return (el.innerText || '').replace(/\s+/g, ' ').trim();
    }

    function hasSmallerMatchingChild(el) {
        if (!el || !el.children || el.children.length === 0) return false;

        for (const child of el.children) {
            if (!isVisibleElement(child)) continue;
            if (skip(child)) continue;
            const text = getRenderedText(child);
            if (!text || text.length < 2 || text.length > 120) continue;
            if (!quickCheck(text)) continue;
            if (findAllMatches(text).length > 0) return true;
        }

        return false;
    }

    function processRenderedTextElements(root) {
        if (!root) return;

        const candidates = [];
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT,
            {
                acceptNode: (node) => {
                    if (skip(node)) return NodeFilter.FILTER_REJECT;
                    if (!isVisibleElement(node)) return NodeFilter.FILTER_SKIP;
                    if (hasConvertedDescendant(node)) return NodeFilter.FILTER_SKIP;
                    if (!FALLBACK_CONTAINER_TAGS.has(node.tagName)) return NodeFilter.FILTER_SKIP;

                    const text = getRenderedText(node);
                    if (!text || text.length < 2 || text.length > 120) return NodeFilter.FILTER_SKIP;
                    if (!quickCheck(text)) return NodeFilter.FILTER_SKIP;
                    if (findAllMatches(text).length === 0) return NodeFilter.FILTER_SKIP;
                    if (hasSmallerMatchingChild(node)) return NodeFilter.FILTER_SKIP;

                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        while (walker.nextNode()) {
            candidates.push(walker.currentNode);
        }

        debugLog('rendered element candidates:', candidates.length);
        for (const el of candidates) {
            try { processRenderedTextElement(el); } catch (e) { console.error('[CC] processRenderedTextElement error:', e); }
        }
    }

    function processRenderedTextElement(el) {
        if (!el || skip(el) || hasConvertedDescendant(el) || !isVisibleElement(el)) return;

        const text = getRenderedText(el);
        if (!text || text.length < 2 || text.length > 120) return;
        if (!quickCheck(text)) return;

        const matches = findAllMatches(text);
        if (matches.length === 0) return;

        if (debugScanState) {
            pushDebugSample('renderedElements', {
                text: previewText(text),
                tag: el.tagName,
                matches: matches.map((m) => m.fullMatch)
            }, 20);
            debugScanState.matched += 1;
            pushDebugSample('matched', {
                text: previewText(text),
                tag: el.tagName,
                matches: matches.map((m) => m.fullMatch),
                source: 'rendered-element'
            });
        }

        const config = getConfig();
        isModifying = true;

        try {
            if (config.mode === 'replace') {
                const newText = buildReplaceText(text, matches);
                if (newText !== null) {
                    el.textContent = newText;
                    if (debugScanState) {
                        debugScanState.converted += 1;
                        pushDebugSample('converted', {
                            from: previewText(text),
                            to: previewText(newText),
                            source: 'rendered-element'
                        });
                    }
                }
                return;
            }

            const fragment = buildAppendFragment(text, matches);
            if (fragment) {
                el.replaceChildren(fragment);
                if (debugScanState) {
                    debugScanState.converted += 1;
                    pushDebugSample('converted', {
                        from: previewText(text),
                        mode: 'append',
                        source: 'rendered-element'
                    });
                }
            }
        } finally {
            isModifying = false;
        }
    }

    function tryProcessContainerFallback(el, source = 'parent-fallback') {
        if (!el || skip(el)) return false;
        if (!FALLBACK_CONTAINER_TAGS.has(el.tagName)) return false;
        if (hasConvertedDescendant(el)) return false;

        const text = el.textContent || '';
        if (!text || text.length < 2 || text.length > 80) return false;
        if (!quickCheck(text)) return false;

        const matches = findAllMatches(text);
        if (matches.length === 0) return false;

        if (debugScanState) {
            if (source === 'parent-fallback') {
                pushDebugSample('parentFallbacks', {
                    text: previewText(text),
                    tag: el.tagName,
                    matches: matches.map((m) => m.fullMatch)
                }, 20);
            } else {
                pushDebugSample('ancestorFallbacks', {
                    text: previewText(text),
                    tag: el.tagName,
                    matches: matches.map((m) => m.fullMatch)
                }, 20);
            }
            debugScanState.matched += 1;
            pushDebugSample('matched', {
                text: previewText(text),
                tag: el.tagName,
                matches: matches.map((m) => m.fullMatch),
                source
            });
        }

        const config = getConfig();
        isModifying = true;

        try {
            if (config.mode === 'replace') {
                const newText = buildReplaceText(text, matches);
                if (newText !== null) {
                    el.textContent = newText;
                    if (debugScanState) {
                        debugScanState.converted += 1;
                        pushDebugSample('converted', {
                            from: previewText(text),
                            to: previewText(newText),
                            source
                        });
                    }
                    return true;
                }
                return false;
            }

            const fragment = buildAppendFragment(text, matches);
            if (fragment) {
                el.replaceChildren(fragment);
                if (debugScanState) {
                    debugScanState.converted += 1;
                    pushDebugSample('converted', {
                        from: previewText(text),
                        mode: 'append',
                        source
                    });
                }
                return true;
            }
        } finally {
            isModifying = false;
        }

        return false;
    }

    function tryProcessAncestorFallback(startEl) {
        let current = startEl;
        let depth = 0;

        while (current && depth < 4) {
            if (tryProcessContainerFallback(current, depth === 0 ? 'parent-fallback' : 'ancestor-fallback')) {
                return true;
            }
            current = current.parentElement;
            depth += 1;
        }

        return false;
    }

    function processCombinedTextElements(root) {
        if (!root) return;

        const candidates = [];
        const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT,
            {
                acceptNode: (node) => {
                    if (skip(node)) return NodeFilter.FILTER_REJECT;
                    if (!node.childNodes || node.childNodes.length < 2) return NodeFilter.FILTER_REJECT;
                    if (node.children && node.children.length > 0) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        while (walker.nextNode()) {
            candidates.push(walker.currentNode);
        }

        debugLog('combined element candidates:', candidates.length);

        for (const el of candidates) {
            try { processCombinedTextElement(el); } catch (e) { console.error('[CC] processCombinedTextElement error:', e); }
        }
    }

    function processCombinedTextElement(el) {
        if (!el || skip(el)) return;
        if (hasConvertedDescendant(el)) return;

        const textNodes = Array.from(el.childNodes).filter((node) => node.nodeType === 3 && node.nodeValue && node.nodeValue.trim().length > 0);
        if (textNodes.length < 2) return;

        const combinedText = textNodes.map((node) => node.nodeValue).join('');
        if (!combinedText || !quickCheck(combinedText)) return;

        const matches = findAllMatches(combinedText);
        if (matches.length === 0) return;

        if (debugScanState) {
            pushDebugSample('combinedElements', {
                text: previewText(combinedText),
                tag: el.tagName,
                childTextCount: textNodes.length,
                matches: matches.map((m) => m.fullMatch)
            }, 20);
            debugScanState.matched += 1;
            pushDebugSample('matched', {
                text: previewText(combinedText),
                matches: matches.map((m) => m.fullMatch),
                source: 'combined-element'
            });
        }

        const config = getConfig();
        isModifying = true;

        try {
            if (config.mode === 'replace') {
                const newText = buildReplaceText(combinedText, matches);
                if (newText !== null) {
                    el.textContent = newText;
                    if (debugScanState) {
                        debugScanState.converted += 1;
                        pushDebugSample('converted', {
                            from: previewText(combinedText),
                            to: previewText(newText),
                            source: 'combined-element'
                        });
                    }
                }
                return;
            }

            const fragment = buildAppendFragment(combinedText, matches);
            if (fragment) {
                el.replaceChildren(fragment);
                if (debugScanState) {
                    debugScanState.converted += 1;
                    pushDebugSample('converted', {
                        from: previewText(combinedText),
                        mode: 'append',
                        source: 'combined-element'
                    });
                }
            }
        } finally {
            isModifying = false;
        }
    }

    function buildAppendFragment(text, matches) {
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        let changed = false;

        for (const m of matches) {
            const cny = convertCurrency(m.amount, m.code);
            if (cny === null) continue;

            changed = true;
            const end = m.index + m.length;
            if (m.index > cursor) {
                fragment.appendChild(document.createTextNode(text.slice(cursor, m.index)));
            }

            const group = document.createElement('span');
            group.className = CONVERTED_GROUP_CLASS;
            group.setAttribute(PROCESSED_ATTR, '1');
            group.style.cssText = 'display:inline;';

            group.appendChild(document.createTextNode(text.slice(m.index, end)));

            const span = document.createElement('span');
            span.className = CONVERTED_CLASS;
            span.setAttribute(PROCESSED_ATTR, '1');
            span.style.cssText = 'color:#e74c3c;font-weight:500;margin-left:2px;font-size:0.9em;';
            span.textContent = formatPrice(cny);
            group.appendChild(span);
            fragment.appendChild(group);

            cursor = end;
        }

        if (!changed) return null;
        if (cursor < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(cursor)));
        }

        return fragment;
    }

    function buildReplaceText(text, matches) {
        let newText = text;
        let offset = 0;

        for (const m of matches) {
            const cny = convertCurrency(m.amount, m.code);
            if (cny === null) continue;

            const cnyText = formatPrice(cny);
            const start = m.index + offset;
            newText = newText.substring(0, start) + cnyText + newText.substring(start + m.length);
            offset += cnyText.length - m.length;
        }

        return newText === text ? null : newText;
    }

    function processTextNode(node) {
        if (!node || node.nodeType !== 3) return;
        const text = node.nodeValue;

        if (debugScanState && text && /[$€£₩]|\b(?:USD|EUR|GBP|JPY|HKD|KRW|AUD|CAD|TWD|SGD|CHF)\b/i.test(text)) {
            pushDebugSample('currencyCandidates', {
                text: previewText(text),
                parent: node.parentElement ? node.parentElement.tagName + (node.parentElement.className ? '.' + String(node.parentElement.className).trim().replace(/\s+/g, '.') : '') : 'NO_PARENT'
            }, 20);
        }

        if (debugScanState) {
            debugScanState.visited += 1;
        }

        if (skip(node)) {
            if (debugScanState) {
                debugScanState.skipped += 1;
                pushDebugSample('skipped', {
                    text: previewText(text || ''),
                    reason: 'skip(node)',
                    parent: node.parentElement ? node.parentElement.tagName : 'NO_PARENT'
                });
            }
            return;
        }

        if (!text || text.length < 2) return;
        if (!quickCheck(text)) {
            if (debugScanState) {
                debugScanState.quickRejected += 1;
                pushDebugSample('quickRejected', {
                    text: previewText(text),
                    reason: 'quickCheck=false'
                });
            }
            return;
        }

        const matches = findAllMatches(text);
        if (matches.length === 0) {
            if (/[$€£₩]|\b(?:USD|EUR|GBP|JPY|HKD|KRW|AUD|CAD|TWD|SGD|CHF)\b/i.test(text)) {
                if (tryProcessAncestorFallback(node.parentElement)) {
                    return;
                }
            }
            if (debugScanState) {
                pushDebugSample('quickRejected', {
                    text: previewText(text),
                    reason: 'findAllMatches=0'
                });
            }
            return;
        }

        if (debugScanState) {
            debugScanState.matched += 1;
            pushDebugSample('matched', {
                text: previewText(text),
                matches: matches.map((m) => m.fullMatch)
            });
        }

        debugLog('TEXT TARGET:', JSON.stringify(text.substring(0, 100)), 'matches:', matches.length);

        const config = getConfig();
        isModifying = true;

        try {
            if (config.mode === 'replace') {
                const newText = buildReplaceText(text, matches);
                if (newText !== null) {
                    node.nodeValue = newText;
                    if (debugScanState) {
                        debugScanState.converted += 1;
                        pushDebugSample('converted', {
                            from: previewText(text),
                            to: previewText(newText)
                        });
                    }
                }
                return;
            }

            const fragment = buildAppendFragment(text, matches);
            if (fragment && node.parentNode) {
                node.parentNode.replaceChild(fragment, node);
                if (debugScanState) {
                    debugScanState.converted += 1;
                    pushDebugSample('converted', {
                        from: previewText(text),
                        mode: 'append'
                    });
                }
            }
        } finally {
            isModifying = false;
        }
    }

    function processPage(reason = 'manual') {
        if (isProcessing) return;

        const config = getConfig();
        console.log('[CC] processPage - enabled:', config.enabled, 'rates:', !!rateCache.data);

        if (!config.enabled || !rateCache.data) {
            console.log('[CC] processPage skipped - enabled:', config.enabled, 'rates:', !!rateCache.data);
            return;
        }

        isProcessing = true;
        startDebugScan(reason);

        try {
            restoreConvertedContent(document.body);
            processRenderedTextElements(document.body);
            walkDOM(document.body);
        } finally {
            isProcessing = false;
            endDebugScan();
        }
    }

    function scheduleProcessPage(delay = 300, reason = 'scheduled') {
        clearTimeout(processPageTimer);
        processPageTimer = setTimeout(() => {
            processPage(reason);
        }, delay);
    }

    function scheduleInteractionRescans() {
        for (const timer of interactionRescanTimers) {
            clearTimeout(timer);
        }
        interactionRescanTimers = [];

        const delays = [120, 400, 900, 1600];
        for (const delay of delays) {
            const timer = setTimeout(() => {
                scheduleProcessPage(0, `interaction-${delay}ms`);
            }, delay);
            interactionRescanTimers.push(timer);
        }
    }

    function getCurrentHostname() {
        try {
            return window.location.hostname;
        } catch (e) {
            return '';
        }
    }

    function isUrlInList(hostname, list) {
        if (!list || list.length === 0) return false;
        for (const item of list) {
            if (!item) continue;
            const pattern = item.replace(/\./g, '\\.').replace(/\*/g, '.*');
            const regex = new RegExp('^' + pattern + '$', 'i');
            if (regex.test(hostname)) return true;
        }
        return false;
    }

    function shouldRunOnCurrentSite() {
        const config = getConfig();
        const hostname = getCurrentHostname();

        if (config.listMode === 'whitelist') {
            return isUrlInList(hostname, config.whitelist || []);
        } else if (config.listMode === 'blacklist') {
            return !isUrlInList(hostname, config.blacklist || []);
        }

        return true;
    }

    function createStatusIndicator() {
        const config = getConfig();

        if (!config.showStatusIndicator) {
            return null;
        }

        const indicator = document.createElement('div');
        indicator.id = 'currency-converter-status';
        indicator.style.cssText = `
            position: fixed !important;
            bottom: 20px !important;
            right: 20px !important;
            background: white !important;
            border: 1px solid #ddd !important;
            border-radius: 8px !important;
            padding: 10px 15px !important;
            font-size: 12px !important;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1) !important;
            z-index: 2147483647 !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
            cursor: pointer !important;
            user-select: none !important;
        `;
        document.body.appendChild(indicator);
        indicator.addEventListener('click', showConfigPanel);
        return indicator;
    }

    function updateStatus(message, type = 'info') {
        if (!statusIndicator) return;

        const colors = {
            loading: '#007bff',
            success: '#28a745',
            error: '#dc3545',
            info: '#6c757d'
        };

        statusIndicator.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: ${colors[type]};
                "></span>
                <span style="color: #333;">${message}</span>
            </div>
        `;
    }

    function showConfigPanel() {
        const config = getConfig();

        const panel = document.createElement('div');
        panel.id = 'currency-converter-panel';
        panel.style.cssText = `
            position: fixed !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            background: white !important;
            border-radius: 12px !important;
            padding: 25px !important;
            min-width: 400px !important;
            max-width: 500px !important;
            max-height: 80vh !important;
            overflow-y: auto !important;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2) !important;
            z-index: 2147483647 !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
        `;

        const overlay = document.createElement('div');
        overlay.id = 'currency-converter-overlay';
        overlay.style.cssText = `
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            bottom: 0 !important;
            background: rgba(0,0,0,0.5) !important;
            z-index: 2147483646 !important;
        `;

        overlay.addEventListener('click', () => {
            panel.remove();
            overlay.remove();
        });

        const ratesInfo = rateCache.data ? JSON.stringify(rateCache.data, null, 2) : '未加载';
        const timeInfo = rateCache.timestamp ? new Date(rateCache.timestamp).toLocaleString() : '无';
        const currentHost = getCurrentHostname();
        const whitelistStr = (config.whitelist || []).join('\n');
        const blacklistStr = (config.blacklist || []).join('\n');

        panel.innerHTML = `
            <div style="margin-bottom: 20px;">
                <h3 style="margin: 0 0 10px 0; color: #333; font-size: 18px;">
                    外币转换助手设置
                </h3>
                <p style="margin: 0; color: #666; font-size: 13px;">
                    版本: ${SCRIPT_VERSION} | 当前网站: ${currentHost}
                </p>
            </div>

            <div style="margin-bottom: 15px; padding: 12px; background: #f8f9fa; border-radius: 8px;">
                <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                    <input type="checkbox" id="cc-enabled"
                        ${config.enabled ? 'checked' : ''}
                        style="width: 18px; height: 18px; cursor: pointer;">
                    <span style="font-size: 14px; color: #333; font-weight: 500;">启用货币转换</span>
                </label>
            </div>

            <div style="margin-bottom: 15px; padding: 12px; background: #f8f9fa; border-radius: 8px;">
                <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                    <input type="checkbox" id="cc-show-indicator"
                        ${config.showStatusIndicator ? 'checked' : ''}
                        style="width: 18px; height: 18px; cursor: pointer;">
                    <span style="font-size: 14px; color: #333;">显示右下角状态指示器</span>
                </label>
            </div>

            <div style="margin-bottom: 15px; padding: 12px; background: #f8f9fa; border-radius: 8px;">
                <label style="display: flex; align-items: center; gap: 10px; cursor: pointer;">
                    <input type="checkbox" id="cc-auto-refresh"
                        ${config.autoRefreshOnModeChange ? 'checked' : ''}
                        style="width: 18px; height: 18px; cursor: pointer;">
                    <span style="font-size: 14px; color: #333;">切换模式后自动刷新页面</span>
                </label>
            </div>

            <div style="margin-bottom: 15px; padding: 12px; background: #f8f9fa; border-radius: 8px;">
                <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; margin-bottom: 8px;">
                    <input type="checkbox" id="cc-auto-refresh-rates"
                        ${config.autoRefreshRates ? 'checked' : ''}
                        style="width: 18px; height: 18px; cursor: pointer;">
                    <span style="font-size: 14px; color: #333;">自动刷新汇率</span>
                </label>
                <div style="display: flex; align-items: center; gap: 8px; margin-left: 28px;">
                    <span style="font-size: 13px; color: #666;">每</span>
                    <input type="number" id="cc-refresh-interval" value="${config.autoRefreshInterval || 120}" min="10" max="1440" step="10"
                        style="width: 70px; padding: 4px 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; text-align: center;"
                        ${!config.autoRefreshRates ? 'disabled' : ''}>
                    <span style="font-size: 13px; color: #666;">分钟刷新一次（10-1440分钟）</span>
                </div>
            </div>

            <div style="margin-bottom: 15px;">
                <p style="margin: 0 0 10px 0; font-size: 14px; color: #333; font-weight: 500;">
                    显示模式
                </p>
                <div style="display: flex; flex-direction: column; gap: 8px;">
                    <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
                        <input type="radio" name="cc-mode" value="replace"
                            ${config.mode === 'replace' ? 'checked' : ''}
                            style="margin-top: 3px; cursor: pointer;">
                        <div>
                            <span style="font-size: 14px; color: #333;">替换模式</span>
                            <p style="margin: 3px 0 0 0; font-size: 12px; color: #666;">
                                直接将外币价格替换为人民币
                            </p>
                        </div>
                    </label>
                    <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
                        <input type="radio" name="cc-mode" value="append"
                            ${config.mode === 'append' ? 'checked' : ''}
                            style="margin-top: 3px; cursor: pointer;">
                        <div>
                            <span style="font-size: 14px; color: #333;">附加模式</span>
                            <p style="margin: 3px 0 0 0; font-size: 12px; color: #666;">
                                在原价格后显示转换后的人民币
                            </p>
                        </div>
                    </label>
                </div>
            </div>

            <div style="margin-bottom: 15px;">
                <p style="margin: 0 0 10px 0; font-size: 14px; color: #333; font-weight: 500;">
                    网站过滤模式
                </p>
                <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px;">
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="radio" name="cc-listmode" value="none"
                            ${config.listMode === 'none' ? 'checked' : ''}
                            style="cursor: pointer;">
                        <span style="font-size: 14px; color: #333;">所有网站运行</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="radio" name="cc-listmode" value="whitelist"
                            ${config.listMode === 'whitelist' ? 'checked' : ''}
                            style="cursor: pointer;">
                        <span style="font-size: 14px; color: #333;">仅白名单网站运行</span>
                    </label>
                    <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                        <input type="radio" name="cc-listmode" value="blacklist"
                            ${config.listMode === 'blacklist' ? 'checked' : ''}
                            style="cursor: pointer;">
                        <span style="font-size: 14px; color: #333;">黑名单网站不运行</span>
                    </label>
                </div>
                <div id="cc-whitelist-container" style="display: ${config.listMode === 'whitelist' ? 'block' : 'none'}; margin-top: 10px;">
                    <p style="margin: 0 0 5px 0; font-size: 12px; color: #666;">白名单（每行一个域名，支持 * 通配符）:</p>
                    <textarea id="cc-whitelist" rows="3" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical; box-sizing: border-box;">${whitelistStr}</textarea>
                </div>
                <div id="cc-blacklist-container" style="display: ${config.listMode === 'blacklist' ? 'block' : 'none'}; margin-top: 10px;">
                    <p style="margin: 0 0 5px 0; font-size: 12px; color: #666;">黑名单（每行一个域名，支持 * 通配符）:</p>
                    <textarea id="cc-blacklist" rows="3" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical; box-sizing: border-box;">${blacklistStr}</textarea>
                </div>
            </div>

            <div style="margin-bottom: 15px;">
                <p style="margin: 0 0 10px 0; font-size: 14px; color: #333; font-weight: 500;">
                    汇率信息
                </p>
                <div style="background: #f8f9fa; padding: 12px; border-radius: 6px; font-size: 13px; color: #666;">
                    <p style="margin: 0 0 5px 0;">
                        ${rateCache.data ? '✅ 汇率已加载' : '❌ 汇率未加载'}
                    </p>
                    <p style="margin: 0 0 5px 0;">
                        更新时间: ${timeInfo}
                    </p>
                    <details>
                        <summary style="cursor: pointer; color: #007bff;">查看汇率详情</summary>
                        <pre style="font-size: 10px; overflow: auto; max-height: 150px; margin-top: 5px;">${ratesInfo}</pre>
                    </details>
                </div>
            </div>

            <div style="display: flex; gap: 10px;">
                <button id="cc-refresh" style="
                    flex: 1;
                    padding: 10px 15px;
                    background: #007bff;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                ">
                    刷新汇率
                </button>
                <button id="cc-close" style="
                    flex: 1;
                    padding: 10px 15px;
                    background: #6c757d;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 14px;
                ">
                    关闭
                </button>
            </div>
        `;

        document.body.appendChild(overlay);
        document.body.appendChild(panel);

        function updateListVisibility() {
            const mode = document.querySelector('input[name="cc-listmode"]:checked').value;
            document.getElementById('cc-whitelist-container').style.display = mode === 'whitelist' ? 'block' : 'none';
            document.getElementById('cc-blacklist-container').style.display = mode === 'blacklist' ? 'block' : 'none';
        }

        document.querySelectorAll('input[name="cc-listmode"]').forEach(radio => {
            radio.addEventListener('change', updateListVisibility);
        });

        document.getElementById('cc-enabled').addEventListener('change', (e) => {
            config.enabled = e.target.checked;
            saveConfig(config);
            if (config.enabled) {
                processPage();
            }
        });

        document.getElementById('cc-show-indicator').addEventListener('change', (e) => {
            config.showStatusIndicator = e.target.checked;
            saveConfig(config);
            if (statusIndicator) {
                statusIndicator.style.display = config.showStatusIndicator ? 'block' : 'none';
            }
        });

        document.getElementById('cc-auto-refresh').addEventListener('change', (e) => {
            config.autoRefreshOnModeChange = e.target.checked;
            saveConfig(config);
        });

        const autoRefreshRatesCheckbox = document.getElementById('cc-auto-refresh-rates');
        const refreshIntervalInput = document.getElementById('cc-refresh-interval');

        autoRefreshRatesCheckbox.addEventListener('change', (e) => {
            config.autoRefreshRates = e.target.checked;
            saveConfig(config);
            refreshIntervalInput.disabled = !config.autoRefreshRates;
            setupAutoRefreshTimer();
        });

        refreshIntervalInput.addEventListener('change', (e) => {
            let val = parseInt(e.target.value, 10);
            if (isNaN(val) || val < 10) val = 10;
            if (val > 1440) val = 1440;
            e.target.value = val;
            config.autoRefreshInterval = val;
            saveConfig(config);
            setupAutoRefreshTimer();
        });

        document.querySelectorAll('input[name="cc-mode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const oldMode = config.mode;
                config.mode = e.target.value;
                saveConfig(config);

                if (config.autoRefreshOnModeChange && oldMode !== config.mode) {
                    panel.remove();
                    overlay.remove();
                    location.reload();
                } else {
                    processPage();
                }
            });
        });

        document.querySelectorAll('input[name="cc-listmode"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                config.listMode = e.target.value;
                saveConfig(config);
            });
        });

        document.getElementById('cc-whitelist').addEventListener('change', (e) => {
            const text = e.target.value.trim();
            config.whitelist = text ? text.split('\n').map(s => s.trim()).filter(s => s) : [];
            saveConfig(config);
        });

        document.getElementById('cc-blacklist').addEventListener('change', (e) => {
            const text = e.target.value.trim();
            config.blacklist = text ? text.split('\n').map(s => s.trim()).filter(s => s) : [];
            saveConfig(config);
        });

        document.getElementById('cc-refresh').addEventListener('click', async () => {
            rateCache.data = null;
            rateCache.timestamp = null;
            await fetchExchangeRates();
            if (getConfig().enabled) {
                processPage('manual-refresh');
            }
            panel.remove();
            overlay.remove();
        });

        document.getElementById('cc-close').addEventListener('click', () => {
            panel.remove();
            overlay.remove();
        });
    }

    function setupAutoRefreshTimer() {
        if (autoRefreshTimer) {
            clearInterval(autoRefreshTimer);
            autoRefreshTimer = null;
        }

        const config = getConfig();
        if (!config.autoRefreshRates || !config.enabled) {
            console.log('[CC] 自动刷新汇率已禁用');
            return;
        }

        const intervalMinutes = config.autoRefreshInterval || 120;
        const intervalMs = intervalMinutes * 60 * 1000;

        console.log(`[CC] 设置汇率自动刷新: 每 ${intervalMinutes} 分钟`);

        autoRefreshTimer = setInterval(async () => {
            console.log('[CC] 自动刷新汇率...');
            rateCache.data = null;
            rateCache.timestamp = null;
            await fetchExchangeRates();
            if (getConfig().enabled) {
                processPage('auto-refresh-rates');
            }
        }, intervalMs);
    }

    function setupObserver() {
        if (observer) observer.disconnect();

        observer = new MutationObserver((muts) => {
            if (!getConfig().enabled || isModifying) return;

            for (const mut of muts) {
                if (mut.type === 'characterData') {
                    scheduleProcessPage(250, 'mutation-characterData');
                    continue;
                }

                if (mut.type === 'attributes') {
                    if (mut.target && mut.target.nodeType === 1) {
                        const el = mut.target;
                        if (el.id === 'currency-converter-status' ||
                            el.id === 'currency-converter-panel' ||
                            el.id === 'currency-converter-overlay') continue;
                        scheduleProcessPage(250, 'mutation-attributes');
                    }
                    continue;
                }

                if (mut.type !== 'childList') continue;

                for (const n of mut.addedNodes) {
                    if (n.nodeType === 1) {
                        if (n.id === 'currency-converter-status' ||
                            n.id === 'currency-converter-panel' ||
                            n.id === 'currency-converter-overlay') continue;
                        scheduleProcessPage(250, 'mutation-childList-element');
                        break;
                    } else if (n.nodeType === 3) {
                        scheduleProcessPage(250, 'mutation-childList-text');
                        break;
                    }
                }
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-state', 'data-selected']
        });

        return observer;
    }

    function setupInteractionTriggers() {
        const triggerRescan = () => {
            if (!getConfig().enabled || isModifying) return;
            scheduleInteractionRescans();
        };

        document.addEventListener('click', triggerRescan, true);
        document.addEventListener('change', triggerRescan, true);
        window.addEventListener('focus', triggerRescan);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                triggerRescan();
            }
        });
    }

    async function init() {
        console.log('========== 外币转换助手初始化 ==========');
        console.log(`版本: ${SCRIPT_VERSION}`);

        const config = getConfig();

        if (!shouldRunOnCurrentSite()) {
            console.log('[CC] 当前网站不在运行列表中，跳过');
            return;
        }

        statusIndicator = createStatusIndicator();
        if (statusIndicator) {
            updateStatus('正在获取汇率...', 'loading');
        }

        await fetchExchangeRates();

        if (config.enabled) {
            setTimeout(() => processPage('init'), 500);
        }

        setupObserver();
        setupInteractionTriggers();
        setupAutoRefreshTimer();

        GM_registerMenuCommand('🎯 打开外币转换设置', showConfigPanel);
        GM_registerMenuCommand(config.showStatusIndicator ? '🔴 隐藏状态指示器' : '🟢 显示状态指示器', () => {
            config.showStatusIndicator = !config.showStatusIndicator;
            saveConfig(config);
            if (statusIndicator) {
                statusIndicator.remove();
                statusIndicator = null;
            }
            if (config.showStatusIndicator) {
                statusIndicator = createStatusIndicator();
                if (statusIndicator && rateCache.data) {
                    updateStatus('汇率已更新', 'success');
                }
            }
        });
        GM_registerMenuCommand(config.debugMode ? '🐞 关闭调试日志' : '🪵 开启调试日志', () => {
            config.debugMode = !config.debugMode;
            saveConfig(config);
            console.log('[CC] debugMode =', config.debugMode);
        });
        GM_registerMenuCommand('🔄 手动执行整页重算', () => {
            processPage('menu-manual-rescan');
        });

        console.log('========== 初始化完成 ==========');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
