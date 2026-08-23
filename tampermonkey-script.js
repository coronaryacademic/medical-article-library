// ==UserScript==
// @name         Coursology Deep Article Extractor (With Figures & Tables)
// @namespace    http://tampermonkey.net/
// @version      34.0
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

    const SCRIPT_VERSION = 'v42.0 (Base64 Offline Media Capture)';

    // Helper to fetch any CDN image as Base64 Data URI via GM_xmlhttpRequest
    function fetchImageAsBase64(url) {
        return new Promise((resolve) => {
            if (!url || url.startsWith('data:')) return resolve(url);
            if (typeof GM_xmlhttpRequest !== 'function') return resolve(url);

            GM_xmlhttpRequest({
                method: 'GET',
                url: url,
                responseType: 'blob',
                onload: function(resp) {
                    if (resp.status === 200 && resp.response) {
                        const reader = new FileReader();
                        reader.onloadend = function() {
                            resolve(reader.result || url);
                        };
                        reader.readAsDataURL(resp.response);
                    } else {
                        resolve(url);
                    }
                },
                onerror: function() {
                    resolve(url);
                }
            });
        });
    }

    // ─── Library Loader Helper ──────────────────────────────────────────────
    async function ensureLibrariesLoaded() {
        if (typeof TurndownService === 'undefined') {
            await loadScript('https://unpkg.com/turndown/dist/turndown.js');
        }
        if (typeof turndownPluginGfm === 'undefined') {
            await loadScript('https://unpkg.com/turndown-plugin-gfm/dist/turndown-plugin-gfm.js');
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
                if (node.getAttribute('data-exhibit-asset') === 'true' || node.style.display === 'none') {
                    return clone.outerHTML;
                }
                return '\n\n' + clone.outerHTML + '\n\n';
            }
        });

        // Exhibit reference spans like (Video 1) stay inline — no newlines
        turndownService.addRule('preserveExhibitRefSpans', {
            filter: function(node) {
                return node.classList && node.classList.contains('exhibit-ref-wrapper');
            },
            replacement: function(content, node) {
                return node.innerText || node.textContent || '';
            }
        });

        // Hidden exhibit media assets (img, video) preserved as raw HTML blocks
        turndownService.addRule('preserveExhibitMediaAssets', {
            filter: function(node) {
                const tag = node.tagName ? node.tagName.toLowerCase() : '';
                return (tag === 'img' || tag === 'video') && node.getAttribute('data-exhibit-asset') === 'true';
            },
            replacement: function(content, node) {
                return '\n\n' + node.outerHTML + '\n\n';
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

        let seqFigure = 0;
        let seqTable = 0;
        let seqVideo = 0;

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
            let newVideo = null;
            let newImg = null;

            // Poll DOM up to 4 times (1.2s max) to detect newly mounted table, video, or image
            for (let attempt = 1; attempt <= 4; attempt++) {
                await sleep(300);

                const tablesAfter = Array.from(document.querySelectorAll('table'));
                const imgsAfter = Array.from(document.querySelectorAll('img'));
                const videosAfter = Array.from(document.querySelectorAll('video, video source, iframe'));

                newTable = tablesAfter.find(t => !tablesBefore.includes(t)) 
                        || document.querySelector('[data-is-open="true"] table')
                        || document.querySelector('[role="dialog"] table')
                        || document.querySelector('table');

                newVideo = videosAfter.find(v => {
                    const src = v.getAttribute('src') || v.src || '';
                    return src.includes('coursology') || src.includes('.mp4') || src.includes('.webm') || src.includes('.mov') || src.includes('.m3u8');
                }) || document.querySelector('[data-is-open="true"] video')
                   || document.querySelector('[data-is-open="true"] source')
                   || document.querySelector('[data-is-open="true"] iframe')
                   || document.querySelector('[role="dialog"] video')
                   || document.querySelector('[role="dialog"] source');

                newImg = imgsAfter.find(img => !imgsBefore.has(img.src) && img.src.includes('coursology'))
                      || imgsAfter.find(img => !imgsBefore.has(img.src) && !img.src.includes('logo'))
                      || document.querySelector('[data-is-open="true"] img')
                      || document.querySelector('[role="dialog"] img');

                if (newTable || newVideo || newImg) {
                    console.log(`[Coursology Extractor] Detected popup content on attempt ${attempt}!`);
                    break;
                }
            }

            let popupTitle = '';
            const modalEl = document.querySelector('[data-is-open="true"]') || document.querySelector('[role="dialog"]');
            if (modalEl) {
                const heading = modalEl.querySelector('h1, h2, h3, h4, header, [class*="title"], figcaption');
                if (heading && heading.innerText.trim()) {
                    popupTitle = heading.innerText.trim();
                }
            }
            if (!popupTitle && newImg && (newImg.alt || newImg.title)) {
                popupTitle = (newImg.alt || newImg.title).trim();
            }

            const isTable = newTable || /table|tbl/i.test(btnText) || /table|tbl/i.test(popupTitle);
            const isVideo = newVideo || /video|play/i.test(btnText) || /video/i.test(popupTitle);

            let displayLabel = '';
            if (isTable) {
                seqTable++;
                displayLabel = `Table ${seqTable}`;
            } else if (isVideo) {
                seqVideo++;
                displayLabel = `Video ${seqVideo}`;
            } else {
                seqFigure++;
                displayLabel = `Figure ${seqFigure}`;
            }

            if (newTable) {
                console.log(`[Coursology Extractor] Found table for ${displayLabel}. Saving raw HTML table...`);
                const cleanTbl = newTable.cloneNode(true);
                cleanTbl.querySelectorAll('*').forEach(el => el.removeAttribute('class'));
                capturedPngMap.set(btn.id, { rawTable: cleanTbl, btnText, displayLabel });
                capturedPngMap.set(btnText.toLowerCase(), { rawTable: cleanTbl, btnText, displayLabel });
                console.log(`[Coursology Extractor] SUCCESS: Stored raw HTML table for ${displayLabel}`);
            } else if (newVideo) {
                let vSrc = newVideo.getAttribute('src') || newVideo.src || '';
                if (!vSrc && newVideo.tagName.toLowerCase() === 'video') {
                    const sourceChild = newVideo.querySelector('source');
                    if (sourceChild) vSrc = sourceChild.getAttribute('src') || sourceChild.src || '';
                }
                if (vSrc) {
                    const absSrc = new URL(vSrc, window.location.href).href;
                    capturedPngMap.set(btn.id, { videoSrc: absSrc, btnText, displayLabel });
                    capturedPngMap.set(btnText.toLowerCase(), { videoSrc: absSrc, btnText, displayLabel });
                    console.log(`[Coursology Extractor] SUCCESS: Stored CDN Video URL for ${displayLabel}: ${absSrc}`);
                }
            } else if (newImg) {
                const absSrc = new URL(newImg.getAttribute('src') || newImg.src, window.location.href).href;
                capturedPngMap.set(btn.id, { imgSrc: absSrc, btnText, displayLabel });
                capturedPngMap.set(btnText.toLowerCase(), { imgSrc: absSrc, btnText, displayLabel });
                console.log(`[Coursology Extractor] Stored CDN image URL for ${displayLabel}: ${absSrc}`);
            } else {
                console.log(`[Coursology Extractor] No popup table or image found in DOM for ${displayLabel}. Checking container fallback...`);
            }

            // Fallback: extract CDN URL directly from THIS button's container in the live DOM
            if (!capturedPngMap.has(btn.id)) {
                const btnContainer = btn.closest('[data-is-open]') || btn.parentElement || btn;
                const containerHtml = btnContainer ? btnContainer.outerHTML : '';
                const cdnMatch = containerHtml.match(/https:\/\/cdn\.coursology-qbank\.com\/media\/[a-zA-Z0-9_\-\.]+\.(?:mp4|webm|mov|m3u8|png|jpg|jpeg|webp|gif|svg)/i);
                if (cdnMatch) {
                    const absSrc = cdnMatch[0];
                    const isVidCdn = /\.(?:mp4|webm|mov|m3u8)/i.test(absSrc);
                    const assetObj = isVidCdn ? { videoSrc: absSrc, btnText, displayLabel } : { imgSrc: absSrc, btnText, displayLabel };
                    capturedPngMap.set(btn.id, assetObj);
                    capturedPngMap.set(btnText.toLowerCase(), assetObj);
                    console.log(`[Coursology Extractor] Stored CDN URL fallback for ${displayLabel}: ${absSrc}`);
                } else {
                    console.warn(`[Coursology Extractor] Nothing captured for: ${displayLabel}`);
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

        // Keep native subheadings clean without altering paragraph text

        // 5. Replace exhibit buttons in clone with inline text references, and isolate hidden assets at the end
        const exhibitButtonsInClone = Array.from(clone.querySelectorAll('button[id^="exhibit-"]'));
        let imgFallbackIdx = 0;

        const hiddenAssetsContainer = document.createElement('div');
        hiddenAssetsContainer.setAttribute('data-exhibit-assets', 'true');
        hiddenAssetsContainer.style.display = 'none';

        for (let idx = 0; idx < exhibitButtonsInClone.length; idx++) {
            const btn = exhibitButtonsInClone[idx];
            const btnText = btn.innerText.trim() || `exhibit ${idx + 1}`;
            // Target ONLY the exhibit button itself or immediate button wrapper (never section containers)
            let targetToReplace = (btn.parentElement && btn.parentElement.tagName === 'SPAN') ? btn.parentElement : btn;

            const captured = capturedPngMap.get(btn.id) || capturedPngMap.get(btnText.toLowerCase());
            const labelToShow = (captured && captured.displayLabel) ? captured.displayLabel : btnText;

            const textRefSpan = document.createElement('span');
            textRefSpan.className = 'exhibit-ref-wrapper';
            textRefSpan.innerText = `(${labelToShow})`;

            if (captured && captured.rawTable) {
                const cleanTbl = captured.rawTable.cloneNode(true);
                cleanTbl.removeAttribute('class');
                cleanTbl.setAttribute('data-exhibit-asset', 'true');
                cleanTbl.style.display = 'none';
                hiddenAssetsContainer.appendChild(cleanTbl);
            } else if (captured && captured.videoSrc) {
                const videoEl = document.createElement('video');
                videoEl.src = captured.videoSrc;
                videoEl.controls = true;
                videoEl.className = 'article-media-asset';
                videoEl.setAttribute('data-exhibit-asset', 'true');
                videoEl.setAttribute('data-is-video', 'true');
                videoEl.style.display = 'none';
                hiddenAssetsContainer.appendChild(videoEl);
            } else {
                let imgSrc = '';
                if (captured && captured.imgSrc) {
                    imgSrc = captured.imgSrc;
                } else if (!captured && pageMediaUrls[imgFallbackIdx]) {
                    imgSrc = new URL(pageMediaUrls[imgFallbackIdx], window.location.href).href;
                    imgFallbackIdx++;
                }

                if (imgSrc) {
                    const imgEl = document.createElement('img');
                    imgEl.src = imgSrc;
                    imgEl.alt = labelToShow;
                    imgEl.className = 'article-media-asset';
                    imgEl.setAttribute('data-exhibit-asset', 'true');
                    imgEl.style.display = 'none';
                    hiddenAssetsContainer.appendChild(imgEl);
                }
            }

            targetToReplace.replaceWith(textRefSpan);
        }

        if (hiddenAssetsContainer.children.length > 0) {
            clone.appendChild(hiddenAssetsContainer);
        }

        document.getElementById('coursology-overlay')?.remove();

        // 5. Resolve all remaining images in clone to clean CDN URLs
        const remainingImgs = Array.from(clone.querySelectorAll('img'));
        for (const img of remainingImgs) {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || img.src;
            if (src && !src.startsWith('data:')) {
                const absUrl = new URL(src, window.location.href).href;
                img.src = absUrl;
                img.setAttribute('data-cdn-src', absUrl);
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
                btn.innerHTML = `Copy MD (${SCRIPT_VERSION.split(' ')[0]})`;
                btn.disabled = false;
            }
        }
    }

    // ─── Site Tree Extractor Handler ─────────────────────────────────────────
    function doCopySiteTree() {
        const navContainer = document.querySelector('nav, aside, [class*="sidebar"], [class*="tree"]') || document.body;
        const candidates = Array.from(navContainer.querySelectorAll('button, a, div[class*="whitespace-nowrap"], div[class*="flex flex-row"], div[role="button"], li'));

        const folders = [];
        const foldersSet = new Set(["Uncategorized"]);
        const articles = [];
        const seenTitles = new Set();
        let currentFolder = "Uncategorized";
        let articleCount = 0;

        candidates.forEach(el => {
            const span = el.querySelector('span') || el;
            const text = (span.innerText || span.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
            if (!text || text.length > 150 || text.includes('\n')) return;
            if (["collapse all", "expand all", "home", "library", "search", "settings"].includes(text.toLowerCase())) return;

            const html = el.outerHTML ? el.outerHTML.toLowerCase() : '';
            const svg = el.querySelector('svg');
            const dataIcon = svg ? (svg.getAttribute('data-icon') || '').toLowerCase() : '';

            const isFolder = dataIcon.includes('folder') || html.includes('fa-folder') || (html.includes('folder') && !html.includes('newspaper') && !html.includes('file'));
            const isArticle = dataIcon.includes('newspaper') || dataIcon.includes('file') || html.includes('fa-newspaper') || html.includes('newspaper');

            if (isFolder) {
                currentFolder = text;
                if (!foldersSet.has(text)) {
                    folders.push(text);
                    foldersSet.add(text);
                }
            } else if (isArticle) {
                const norm = text.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (norm && !seenTitles.has(norm)) {
                    seenTitles.add(norm);
                    articleCount++;
                    articles.push({
                        id: `master-${String(articleCount).padStart(4, '0')}`,
                        title: text,
                        folderName: currentFolder,
                        fetched: false,
                        markdown: null
                    });
                }
            }
        });

        let outputStr = '';
        if (articles.length > 0) {
            outputStr = JSON.stringify({ folders: ["Uncategorized", ...folders], articles }, null, 2);
        } else {
            outputStr = navContainer ? navContainer.outerHTML : document.body.outerHTML;
        }

        if (typeof GM_setClipboard !== 'undefined') {
            GM_setClipboard(outputStr);
        } else {
            navigator.clipboard.writeText(outputStr);
        }
        alert(`✓ Extracted ${folders.length} folder(s) and ${articles.length} article(s)!\nData copied to clipboard.\nPaste into Medical Library "Import Site Tree" modal.`);
    }

    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('Copy Clean Markdown', doCopyMarkdown);
        GM_registerMenuCommand('Copy Site Navigation Tree HTML', doCopySiteTree);
    }

    // ─── Inject Floating Buttons ──────────────────────────────────────────────
    function injectButton() {
        if (document.getElementById('coursology-extract-btn')) return;
        if (!document.body) return;

        const btn = document.createElement('button');
        btn.id = 'coursology-extract-btn';
        btn.innerHTML = `Copy MD (${SCRIPT_VERSION.split(' ')[0]})`;
        btn.style.cssText = `
            position: fixed !important;
            top: 15px !important;
            left: 15px !important;
            z-index: 2147483647 !important;
            padding: 6px 12px !important;
            background: #2563eb !important;
            color: #FFFFFF !important;
            font-family: -apple-system, BlinkMacSystemFont, Arial, sans-serif !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            border: 1px solid rgba(255,255,255,0.8) !important;
            border-radius: 6px !important;
            cursor: pointer !important;
            box-shadow: 0 2px 6px rgba(0,0,0,0.25) !important;
            text-align: center !important;
            line-height: 1.2 !important;
            pointer-events: auto !important;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
        `;
        btn.onclick = doCopyMarkdown;
        document.body.appendChild(btn);

        const treeBtn = document.createElement('button');
        treeBtn.id = 'coursology-tree-btn';
        treeBtn.innerHTML = `Copy Tree HTML`;
        treeBtn.style.cssText = `
            position: fixed !important;
            top: 15px !important;
            left: 150px !important;
            z-index: 2147483647 !important;
            padding: 6px 12px !important;
            background: #166534 !important;
            color: #FFFFFF !important;
            font-family: -apple-system, BlinkMacSystemFont, Arial, sans-serif !important;
            font-size: 12px !important;
            font-weight: 600 !important;
            border: 1px solid rgba(255,255,255,0.8) !important;
            border-radius: 6px !important;
            cursor: pointer !important;
            box-shadow: 0 2px 6px rgba(0,0,0,0.25) !important;
            text-align: center !important;
            line-height: 1.2 !important;
            pointer-events: auto !important;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
        `;
        treeBtn.onclick = doCopySiteTree;
        document.body.appendChild(treeBtn);
    }

    setInterval(injectButton, 1000);
    injectButton();

})();
