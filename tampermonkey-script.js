// ==UserScript==
// @name         Coursology Deep Article Extractor (With Figures & Tables)
// @namespace    http://tampermonkey.net/
// @version      32.1
// @description  Clicks each figure/table popup to capture dynamic content, then exports as clean Markdown.
// @match        *://*/*
// @include      http://*/*
// @include      https://*/*
// @connect      cdn.coursology-qbank.com
// @connect      *
// @require      https://unpkg.com/turndown/dist/turndown.js
// @require      https://unpkg.com/turndown-plugin-gfm/dist/turndown-plugin-gfm.js
// @require      https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = 'v32.0 (CORS-Bypass Embedded)';

    // ─── Library Loader Helper ──────────────────────────────────────────────
    async function ensureLibrariesLoaded() {
        if (typeof TurndownService === 'undefined') {
            await loadScript('https://unpkg.com/turndown/dist/turndown.js');
        }
        if (typeof turndownPluginGfm === 'undefined') {
            await loadScript('https://unpkg.com/turndown-plugin-gfm/dist/turndown-plugin-gfm.js');
        }
        if (typeof html2canvas === 'undefined') {
            await loadScript('https://unpkg.com/html2canvas@1.4.1/dist/html2canvas.min.js');
        }
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    // Helper sleep function
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ─── Convert Canvas / Image element to Data URL ─────────────────────────
    function convertViaCanvas(url) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'Anonymous';
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth || img.width || 600;
                    canvas.height = img.naturalHeight || img.height || 400;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    resolve(canvas.toDataURL('image/png'));
                } catch (e) {
                    resolve(url);
                }
            };
            img.onerror = () => resolve(url);
            img.src = url;
        });
    }

    // ─── Fetch image URL → base64 data URI (Bypasses CORS via GM_xmlhttpRequest) ─
    function imgUrlToBase64(url) {
        if (!url || url.startsWith('data:')) return Promise.resolve(url);

        return new Promise((resolve) => {
            // Priority 1: Tampermonkey GM_xmlhttpRequest (Bypasses CORS entirely)
            if (typeof GM_xmlhttpRequest !== 'undefined') {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    responseType: 'blob',
                    onload: function(response) {
                        if (response.status >= 200 && response.status < 300 && response.response) {
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result);
                            reader.onerror = async () => resolve(await convertViaCanvas(url));
                            reader.readAsDataURL(response.response);
                        } else {
                            convertViaCanvas(url).then(resolve);
                        }
                    },
                    onerror: function() {
                        convertViaCanvas(url).then(resolve);
                    }
                });
                return;
            }

            // Priority 2: Standard fetch fallback
            fetch(url, { mode: 'cors', credentials: 'include' })
                .then(res => res.blob())
                .then(blob => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = async () => resolve(await convertViaCanvas(url));
                    reader.readAsDataURL(blob);
                })
                .catch(async () => resolve(await convertViaCanvas(url)));
        });
    }

    // ─── Turndown Config ────────────────────────────────────────────────────
    function createTurndownInstance() {
        if (typeof TurndownService === 'undefined') return null;

        const turndownService = new TurndownService({
            headingStyle: 'atx',
            hr: '---',
            bulletListMarker: '-',
            codeBlockStyle: 'fenced',
            emDelimiter: '*'
        });

        if (typeof turndownPluginGfm !== 'undefined') {
            turndownService.use(turndownPluginGfm.gfm);
        }

        // Keep tables as clean raw HTML if not converted to images
        turndownService.addRule('preserveTables', {
            filter: ['table'],
            replacement: function(content, node) {
                const clone = node.cloneNode(true);
                clone.querySelectorAll('*').forEach(el => el.removeAttribute('class'));
                return '\n\n' + clone.outerHTML + '\n\n';
            }
        });

        // Strip UI artifacts
        turndownService.addRule('stripButtonsAndIcons', {
            filter: function(node) {
                if (node.tagName.toLowerCase() === 'button') return true;
                if (node.tagName.toLowerCase() === 'svg') return true;
                if (node.classList && (
                    node.classList.contains('fa') ||
                    node.classList.contains('fas') ||
                    node.classList.contains('far')
                )) return true;
                return false;
            },
            replacement: function() { return ''; }
        });

        return turndownService;
    }

    function triggerClick(el) {
        if (!el) return;
        try {
            el.scrollIntoView({ block: 'center', inline: 'center' });
        } catch (e) {}

        const targets = [el, el.parentElement, el.closest('span'), el.closest('[data-is-open]')].filter(Boolean);
        for (const t of targets) {
            try {
                if (typeof t.click === 'function') t.click();
            } catch (e) {}

            const opts = { bubbles: true, cancelable: true, view: window, composed: true };
            try {
                t.dispatchEvent(new PointerEvent('pointerdown', opts));
                t.dispatchEvent(new MouseEvent('mousedown', opts));
                t.dispatchEvent(new PointerEvent('pointerup', opts));
                t.dispatchEvent(new MouseEvent('mouseup', opts));
                t.dispatchEvent(new MouseEvent('click', opts));
            } catch (e) {}

            const reactKey = Object.keys(t).find(k => k.startsWith('__reactProps$') || k.startsWith('__reactEventHandlers$'));
            if (reactKey && t[reactKey] && typeof t[reactKey].onClick === 'function') {
                try {
                    t[reactKey].onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: t, currentTarget: t });
                } catch (e) {}
            }
        }
    }

    function getTitle() {
        let title = '';
        const titleSpan = document.querySelector('span[class*="text-3xl"]');
        if (titleSpan) title = titleSpan.innerText.trim();
        if (!title || title.toLowerCase() === 'medical library') {
            title = document.title.replace('Coursology', '').trim() || 'Medical Article';
        }
        return title;
    }

    // ─── Exhibit Media Formatter ─────────────────────────────────────────────
    function formatMediaHTML(mediaNode, btnText) {
        const clone = mediaNode.cloneNode(true);
        if (clone.tagName.toLowerCase() === 'img') {
            const rawSrc = clone.getAttribute('src') || clone.getAttribute('data-src') || clone.src;
            if (rawSrc) {
                clone.src = new URL(rawSrc, window.location.href).href;
            }
            clone.setAttribute('alt', btnText);
            clone.setAttribute('title', btnText);
            clone.removeAttribute('srcset');
            clone.removeAttribute('class');
            clone.removeAttribute('style');
            return `<div class="figure-container" style="text-align:center; margin: 20px 0;"><img src="${clone.src}" alt="${btnText}" style="max-width:100%; border:1px solid #cbd5e1; border-radius:8px;"><p style="font-weight:bold; margin-top:8px;">${btnText}</p></div>`;
        } else if (clone.tagName.toLowerCase() === 'table') {
            clone.querySelectorAll('*').forEach(el => el.removeAttribute('class'));
            return `<div class="table-container" style="margin: 20px 0;">${clone.outerHTML}</div>`;
        }
        return clone.outerHTML;
    }

    // ─── Main Extraction ─────────────────────────────────────────────────────
    async function extractArticleMarkdown() {
        await ensureLibrariesLoaded();
        const turndownService = createTurndownInstance();
        if (!turndownService) {
            alert('Turndown library failed to load. Please check your internet connection.');
            return null;
        }

        const title = getTitle();

        // 1. Target article content
        const articleContent = document.getElementById('article-content')
                            || document.querySelector('article')
                            || document.querySelector('[class*="article"]')
                            || document.querySelector('main')
                            || document.body;

        if (!articleContent) {
            alert('Could not find article content on this page.');
            return null;
        }

        // 2. Pre-expand each exhibit one at a time, snapshot PNG immediately while popup is live
        const exhibitTriggers = Array.from(
            document.querySelectorAll('button[id^="exhibit-"]')
        );

        // Map: button.id  →  { imgDataUrl, btnText }
        const capturedPngMap = new Map();

        const overlay = document.createElement('div');
        overlay.id = 'coursology-overlay';
        overlay.style.cssText = `
            position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
            background: #0f172a; color: #ffffff; padding: 12px 24px; border-radius: 8px;
            z-index: 2147483647; font-family: -apple-system, BlinkMacSystemFont, Arial, sans-serif; font-size: 14px; font-weight: bold;
            box-shadow: 0 4px 16px rgba(0,0,0,0.4);
        `;
        document.body.appendChild(overlay);

        console.log(`[Coursology Extractor] Starting extraction. Found ${exhibitTriggers.length} exhibit triggers.`);

        for (let i = 0; i < exhibitTriggers.length; i++) {
            const btn = exhibitTriggers[i];
            const btnText = btn.innerText.trim() || `exhibit ${i + 1}`;
            overlay.innerText = `Capturing ${i + 1}/${exhibitTriggers.length}: ${btnText}...`;

            console.log(`\n--- [Exhibit ${i + 1}/${exhibitTriggers.length}] ${btnText} (ID: ${btn.id}) ---`);

            // Snapshot DOM state before clicking
            const tablesBefore = Array.from(document.querySelectorAll('table'));
            const imgsBefore = new Set(Array.from(document.querySelectorAll('img')).map(img => img.src));

            // Trigger click on element and parent wrappers
            triggerClick(btn);

            let newTable = null;
            let newImg = null;

            // Poll DOM up to 4 times (1.2s max) to detect newly mounted table or image
            for (let attempt = 1; attempt <= 4; attempt++) {
                await sleep(300);

                const tablesAfter = Array.from(document.querySelectorAll('table'));
                const imgsAfter = Array.from(document.querySelectorAll('img'));

                newTable = tablesAfter.find(t => !tablesBefore.includes(t)) 
                        || document.querySelector('[data-is-open="true"] table')
                        || document.querySelector('[role="dialog"] table')
                        || document.querySelector('table');

                newImg = imgsAfter.find(img => !imgsBefore.has(img.src) && img.src.includes('coursology'))
                      || imgsAfter.find(img => !imgsBefore.has(img.src) && !img.src.includes('logo'))
                      || document.querySelector('[data-is-open="true"] img')
                      || document.querySelector('[role="dialog"] img');

                if (newTable || newImg) {
                    console.log(`[Coursology Extractor] Detected popup content on attempt ${attempt}!`);
                    break;
                }
            }

            if (newTable && typeof html2canvas !== 'undefined') {
                console.log(`[Coursology Extractor] Found table for ${btnText}. Snapshotting with html2canvas...`);
                try {
                    // Enforce generous width, padding and spacing on table before snapshot
                    newTable.style.minWidth = '650px';
                    newTable.style.width = '100%';
                    newTable.style.backgroundColor = '#ffffff';
                    newTable.style.borderCollapse = 'collapse';
                    newTable.querySelectorAll('td, th').forEach(cell => {
                        cell.style.padding = '12px 16px';
                        cell.style.lineHeight = '1.5';
                        cell.style.fontSize = '14px';
                    });

                    const canvas = await html2canvas(newTable, {
                        backgroundColor: '#ffffff',
                        scale: 2,
                        logging: false,
                        useCORS: true
                    });
                    const dataUrl = canvas.toDataURL('image/png');
                    capturedPngMap.set(btn.id, { imgDataUrl: dataUrl, btnText });
                    capturedPngMap.set(btnText.toLowerCase(), { imgDataUrl: dataUrl, btnText });
                    console.log(`[Coursology Extractor] SUCCESS: Snapshotted table for ${btnText} (${dataUrl.slice(0, 50)}...)`);
                } catch (e) {
                    console.warn(`[Coursology Extractor] html2canvas failed for ${btnText}, saving raw HTML table:`, e);
                    capturedPngMap.set(btn.id, { rawTable: newTable.cloneNode(true), btnText });
                    capturedPngMap.set(btnText.toLowerCase(), { rawTable: newTable.cloneNode(true), btnText });
                }
            } else if (newImg) {
                const absSrc = new URL(newImg.getAttribute('src') || newImg.src, window.location.href).href;
                console.log(`[Coursology Extractor] Fetching & embedding image for ${btnText}: ${absSrc}`);
                const base64Src = await imgUrlToBase64(absSrc);
                capturedPngMap.set(btn.id, { imgSrc: base64Src, btnText });
                capturedPngMap.set(btnText.toLowerCase(), { imgSrc: base64Src, btnText });
                console.log(`[Coursology Extractor] Embedded figure image for ${btnText} (${base64Src.slice(0, 40)}...)`);
            } else {
                console.log(`[Coursology Extractor] No popup table or image found in DOM for ${btnText}. Checking container fallback...`);
            }

            // Fallback: extract CDN URL directly from THIS button's container in the live DOM
            if (!capturedPngMap.has(btn.id)) {
                const btnContainer = btn.closest('[data-is-open]') || btn.parentElement || btn;
                const containerHtml = btnContainer ? btnContainer.outerHTML : '';
                const cdnMatch = containerHtml.match(/https:\/\/cdn\.coursology-qbank\.com\/media\/[a-zA-Z0-9_\-\.]+\.(?:png|jpg|jpeg|webp|gif|svg)/i);
                if (cdnMatch) {
                    console.log(`[Coursology Extractor] Fetching & embedding CDN fallback for ${btnText}: ${cdnMatch[0]}`);
                    const base64Src = await imgUrlToBase64(cdnMatch[0]);
                    capturedPngMap.set(btn.id, { imgSrc: base64Src, btnText });
                    capturedPngMap.set(btnText.toLowerCase(), { imgSrc: base64Src, btnText });
                    console.log(`[Coursology Extractor] Embedded CDN fallback for ${btnText} (${base64Src.slice(0, 40)}...)`);
                } else {
                    console.warn(`[Coursology Extractor] Nothing captured for: ${btnText}`);
                }
            }

            // Close popup (toggle)
            triggerClick(btn);
            await sleep(250);
        }

        overlay.innerText = `Finalizing...`;
        await sleep(300);

        // 3. Clone article content
        const clone = articleContent.cloneNode(true);
        clone.querySelectorAll('svg, style, script').forEach(el => el.remove());

        // 4. Scan CDN image URLs from page source (fallback for figures)
        const pageHtml = document.documentElement.innerHTML;
        const pageMediaUrls = Array.from(new Set(
            Array.from(pageHtml.matchAll(/https:\/\/cdn\.coursology-qbank\.com\/media\/[a-zA-Z0-9_\-\.]+\.(?:png|jpg|jpeg|webp|gif|svg)/gi), m => m[0])
        ));

        // 4. Normalize section headers explicitly for Markdown:
        // Main section headers (section[data-section-id] h1) -> <h1>
        // Native subheadings (h2/h3/h4 or p>strong) -> <h2>

        clone.querySelectorAll('section[data-section-id]').forEach(sec => {
            const h1 = sec.querySelector('h1, button h1, [class*="font-medium"][class*="uppercase"]');
            if (h1) {
                const text = h1.innerText.trim();
                if (text && text.length < 90) {
                    const cleanH1 = document.createElement('h1');
                    cleanH1.innerText = text;
                    sec.prepend(cleanH1);
                }
            }
            // Remove duplicate H1 inside accordion buttons so turndown doesn't duplicate headers
            sec.querySelectorAll('button[aria-controls^="section-body"]').forEach(btn => {
                btn.querySelectorAll('h1').forEach(h => h.remove());
            });
        });

        // Ensure native subheadings (h2, h3, h4) become crisp <h2> subheadings
        clone.querySelectorAll('h2, h3, h4').forEach(h => {
            const text = h.innerText.trim();
            if (!text || text.length > 90) return;
            const cleanH2 = document.createElement('h2');
            cleanH2.innerText = text;
            h.replaceWith(cleanH2);
        });

        // Convert <p><strong>Subheading</strong></p> inside section body into <h2> subheadings
        clone.querySelectorAll('p, div').forEach(el => {
            if (el.children.length === 1 && el.children[0].tagName === 'STRONG') {
                const text = el.children[0].innerText.trim();
                if (text && text.length > 2 && text.length < 80 && !text.endsWith('.')) {
                    const h2 = document.createElement('h2');
                    h2.innerText = text;
                    el.replaceWith(h2);
                }
            }
        });

        // 5. Replace exhibit buttons in clone with text reference + hidden image asset for Lightbox modal
        const exhibitButtonsInClone = Array.from(clone.querySelectorAll('button[id^="exhibit-"]'));
        let imgFallbackIdx = 0;

        for (let idx = 0; idx < exhibitButtonsInClone.length; idx++) {
            const btn = exhibitButtonsInClone[idx];
            const btnText = btn.innerText.trim() || `exhibit ${idx + 1}`;
            // Target ONLY the exhibit button itself or immediate button wrapper (never section containers)
            let targetToReplace = (btn.parentElement && btn.parentElement.tagName === 'SPAN') ? btn.parentElement : btn;

            const captured = capturedPngMap.get(btn.id) || capturedPngMap.get(btnText.toLowerCase());

            const figureWrapper = document.createElement('span');
            figureWrapper.className = 'exhibit-ref-wrapper';

            let imgSrc = '';
            if (captured && captured.imgDataUrl) imgSrc = captured.imgDataUrl;
            else if (captured && captured.imgSrc) imgSrc = captured.imgSrc;
            else if (pageMediaUrls[imgFallbackIdx]) {
                const rawFallbackUrl = new URL(pageMediaUrls[imgFallbackIdx], window.location.href).href;
                imgFallbackIdx++;
                imgSrc = await imgUrlToBase64(rawFallbackUrl);
            }

            if (imgSrc) {
                figureWrapper.innerHTML = `<span>(${btnText})</span><img src="${imgSrc}" alt="${btnText}" class="article-media-asset" style="display:none;" />`;
            } else if (captured && captured.rawTable) {
                const cleanTbl = captured.rawTable.cloneNode(true);
                cleanTbl.removeAttribute('class');
                cleanTbl.style.display = 'none';
                figureWrapper.innerHTML = `<span>(${btnText})</span>` + cleanTbl.outerHTML;
            } else {
                figureWrapper.innerHTML = `<span>(${btnText})</span>`;
            }

            targetToReplace.replaceWith(figureWrapper);
        }

        document.getElementById('coursology-overlay')?.remove();

        // 5. Convert all remaining images in clone to offline base64 data URIs
        const remainingImgs = Array.from(clone.querySelectorAll('img'));
        for (const img of remainingImgs) {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || img.src;
            if (src && !src.startsWith('data:')) {
                const absUrl = new URL(src, window.location.href).href;
                console.log(`[Coursology Extractor] Embedding inline article image as base64: ${absUrl}`);
                const b64 = await imgUrlToBase64(absUrl);
                img.src = b64;
                img.removeAttribute('srcset');
                img.removeAttribute('data-src');
            }
        }

        // 6. Convert to Markdown
        let markdownBody = turndownService.turndown(clone.innerHTML);

        markdownBody = markdownBody.replace(/Collapse All/gi, '');
        markdownBody = markdownBody.replace(/\n{3,}/g, '\n\n').trim();

        // Strip duplicate top heading matching title if turndown generated it
        const normTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '');
        markdownBody = markdownBody.replace(/^\s*#+\s+([^\n]+)/, (full, hText) => {
            const normH = hText.toLowerCase().replace(/[^a-z0-9]/g, '');
            return (normH === normTitle) ? '' : full;
        }).trim();

        const fullMarkdown = `---
title: "${title.replace(/"/g, '\\"')}"
url: "${window.location.href}"
date: "${new Date().toLocaleDateString()}"
---

# ${title}

${markdownBody}
`;

        return { title, fullMarkdown };
    }

    // ─── Button Click Handler ─────────────────────────────────────────────────
    async function doCopyMarkdown() {
        const btn = document.getElementById('coursology-extract-btn');
        if (btn) {
            btn.innerHTML = 'Extracting...';
            btn.disabled = true;
        }

        try {
            const result = await extractArticleMarkdown();
            if (!result) return;

            const { title, fullMarkdown } = result;
            if (typeof GM_setClipboard !== 'undefined') {
                GM_setClipboard(fullMarkdown);
            } else {
                navigator.clipboard.writeText(fullMarkdown);
            }
            alert(`Done!\nTitle: "${title}"\nFigures & tables captured.\n\nReady to paste into your Medical Library!`);
        } catch (e) {
            console.error('Extraction error:', e);
            alert('Extraction failed: ' + e.message);
        } finally {
            if (btn) {
                btn.innerHTML = `Copy Article MD (${SCRIPT_VERSION})`;
                btn.disabled = false;
            }
        }
    }

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Copy Clean Markdown', doCopyMarkdown);
    }

    // ─── Inject Button Unconditionally ───────────────────────────────────────
    function injectButton() {
        if (document.getElementById('coursology-extract-btn')) return;
        if (!document.body) return;

        const btn = document.createElement('button');
        btn.id = 'coursology-extract-btn';
        btn.innerHTML = `Copy Article MD (${SCRIPT_VERSION})`;
        btn.style.cssText = `
            position: fixed !important;
            bottom: 25px !important;
            right: 25px !important;
            z-index: 2147483647 !important;
            padding: 14px 24px !important;
            background: #2563eb !important;
            color: #FFFFFF !important;
            font-family: -apple-system, BlinkMacSystemFont, Arial, sans-serif !important;
            font-size: 15px !important;
            font-weight: bold !important;
            border: 2px solid #FFFFFF !important;
            border-radius: 50px !important;
            cursor: pointer !important;
            box-shadow: 0 8px 25px rgba(0,0,0,0.4) !important;
            min-width: 170px !important;
            text-align: center !important;
            line-height: 1 !important;
            pointer-events: auto !important;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
        `;

        btn.onclick = doCopyMarkdown;
        document.body.appendChild(btn);
    }

    setInterval(injectButton, 1000);
    injectButton();

})();
