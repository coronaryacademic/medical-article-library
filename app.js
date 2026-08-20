// Configure marked.js to allow raw HTML (critical for tables embedded in Markdown)
if (typeof marked !== 'undefined') {
  marked.setOptions({
    html: true,        // Allow raw HTML tables/figures to pass through untouched
    breaks: true,      // Convert single newlines to <br>
    gfm: true,         // GitHub Flavored Markdown (bold, lists, etc.)
  });
}

// IndexedDB config (replaces localStorage — no size limit)
const DB_NAME = 'CoursologyLibrary';
const DB_VERSION = 1;
const STORE_NAME = 'articles';
const STORAGE_KEY = 'coursology_markdown_articles_db'; // kept for localStorage migration
const INITIALIZED_KEY = 'coursology_library_initialized';

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbPut(article) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(article);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

// Application State
let articles = [];
let activeArticleId = null;

// Lightbox / Gallery State & Zoom Tools
let currentFigureList = []; // Array of { src, caption, element, alt, index }
let currentFigureIndex = 0;
let currentArticleToc = []; // [{ id, text, level }]
let activeTocCollapsed = false; // Tracks if active article TOC is collapsed in sidebar

// Pan & Zoom State
let imgZoom = 1.0;
let imgRotation = 0;
let imgPanX = 0;
let imgPanY = 0;
let isPanning = false;
let startPanX = 0;
let startPanY = 0;

function updateImageTransform() {
  if (!lightboxImg) return;
  lightboxImg.style.transform = `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom}) rotate(${imgRotation}deg)`;
}

function resetImageTransform() {
  imgZoom = 1.0;
  imgRotation = 0;
  imgPanX = 0;
  imgPanY = 0;
  updateImageTransform();
}

// DOM Elements
const pasteBtn = document.getElementById('paste-btn');
const welcomePasteBtn = document.getElementById('welcome-paste-btn');
const fileInput = document.getElementById('file-input');
const searchInput = document.getElementById('search-input');
const articleCount = document.getElementById('article-count');
const clearAllBtn = document.getElementById('clear-all-btn');
const exportAllBtn = document.getElementById('export-all-btn');

const articleFlatList = document.getElementById('article-flat-list');

const welcomeState = document.getElementById('welcome-state');
const articleContent = document.getElementById('article-content');
const articleTitle = document.getElementById('article-title');
const articleDate = document.getElementById('article-date');
const articleBody = document.getElementById('article-body');

const articleCollapseAllBtn = document.getElementById('article-collapse-all-btn');
const articleExpandAllBtn = document.getElementById('article-expand-all-btn');

const mediaSidebar = document.getElementById('media-sidebar');
const mediaFiguresGrid = document.getElementById('media-figures-grid');
const mediaTablesGrid = document.getElementById('media-tables-grid');

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxCaption = document.getElementById('lightbox-caption');
const lightboxCounter = document.getElementById('lightbox-counter');
const lightboxPrev = document.getElementById('lightbox-prev');
const lightboxNext = document.getElementById('lightbox-next');

// Initialize Application (async — IndexedDB requires awaiting)
async function init() {
  if (typeof marked !== 'undefined') {
    marked.setOptions({ html: true, breaks: true, gfm: true });
  }
  await loadArticles();
  setupEventListeners();
  setupPanAndZoom();
  setupWindowControls();
  setupScrollSpy();
  renderSidebar();

  if (articles.length > 0) {
    displayArticle(articles[0].id);
  }
}

// Load articles from IndexedDB (migrates from localStorage on first upgrade)
async function loadArticles() {
  try {
    // One-time migration: if old localStorage data exists, import it into IndexedDB
    const oldData = localStorage.getItem(STORAGE_KEY);
    if (oldData) {
      try {
        const oldArticles = JSON.parse(oldData);
        for (const a of oldArticles) { await dbPut(a); }
        localStorage.removeItem(STORAGE_KEY);
        console.log('[Coursology] Migrated', oldArticles.length, 'articles from localStorage → IndexedDB');
      } catch (e) {
        console.warn('[Coursology] localStorage migration failed:', e);
      }
    }

    articles = await dbGetAll();
    // Sort newest first (matching original order)
    articles.sort((a, b) => (b.id > a.id ? 1 : -1));

    // Seed sample articles only on absolute first launch
    if (articles.length === 0 && !localStorage.getItem(INITIALIZED_KEY)) {
      articles = [getSampleArticle(), getSampleArticle2()];
      localStorage.setItem(INITIALIZED_KEY, 'true');
      for (const a of articles) { await dbPut(a); }
    }
  } catch (e) {
    console.error('[Coursology] Failed to load articles from IndexedDB:', e);
    articles = [];
  }
}

// Sample article 1
function getSampleArticle() {
  return {
    id: 'art-sample-1',
    title: 'Insomnia And Medications For Sleep',
    extractedAt: new Date().toLocaleDateString(),
    markdown: `
# Introduction

Insomnia is the most prevalent sleep disorder encountered in clinical practice, characterized by persistent difficulty with sleep initiation, duration, consolidation, or quality despite adequate opportunity for sleep.

# Relevant Physiology

## Wakefulness System
Arousal is driven by ascending monoaminergic pathways (norepinephrine, histamine, serotonin, dopamine) and peptidergic systems (orexin/hypocretin) originating in the brainstem and hypothalamus.

## Inhibitory System
Sleep onset requires active inhibition of arousal centers, primarily mediated by gamma-aminobutyric acid (GABA) and galanin-releasing neurons in the ventrolateral preoptic nucleus (VLPO).

## Principles Of Sleep Medicine
Management targets specific neurochemical systems to promote sleep onset, sleep maintenance, or balance circadian rhythms.

# Benzodiazepines

## Mechanism
Bind to GABAA receptor gamma subunit, enhancing GABA-induced chloride influx and neuronal hyperpolarization.

## Use
Short-term management of acute insomnia when severe; less preferred due to tolerance and dependance.

## Adverse Effects
Sedation, anterograde amnesia, motor impairment, rebound insomnia, tolerance, and physical dependence.

# Nonbenzodiazepines (GABAergic Z-drugs)

## Mechanism
Selective agonists at GABAA receptors containing alpha-1 subunits (zolpidem, zaleplon, eszopiclone).

## Use
First-line sleep pharmacotherapy for short-term use.

## Adverse Effects
Complex sleep behaviors (sleep-walking, sleep-driving), morning sedation, and dizziness.

# Melatonin Receptor Agonists

## Mechanism
Ramelteon acts as a selective agonist at MT1 and MT2 receptors in the suprachiasmatic nucleus.

## Use
Insomnia characterized by difficulty with sleep onset.

## Adverse Effects
Headache, somnolence, fatigue, no risk of abuse or dependence.

# Orexin Receptor Antagonists

## Mechanism
Dual orexin receptor antagonists (DORAs) like suvorexant and lemborexant block OX1R and OX2R, inhibiting wakefulness.

## Indications
Insomnia characterized by difficulty with sleep onset and/or sleep maintenance.

## Adverse Effects
Somnolence, abnormal dreams, sleep paralysis, and worsening depression.

# Nonspecific Medications

## Antihistamines
First-generation H1 antagonists (diphenhydramine, doxylamine) cross blood-brain barrier causing sedation.

## Sedating Antidepressants
Low-dose trazodone, doxepin, or mirtazapine used for insomnia with comorbid mood disorders.

## Atypical Antipsychotics
Low-dose quetiapine utilized off-label; limited by metabolic adverse effects.

# General Approach

## Before Medications
Always initiate cognitive behavioral therapy for insomnia (CBT-I) and optimize sleep hygiene first.

## Medications
Select agents based on targeted sleep complaint (onset vs maintenance) and patient comorbidity profile.

# Summary

Insomnia therapy requires a structured diagnostic and therapeutic approach, combining CBT-I with targeted pharmacotherapy when appropriate.
`
  };
}

// Sample article 2
function getSampleArticle2() {
  return {
    id: 'art-sample-2',
    title: 'Acute Pericarditis & Cardiac Tamponade Overview',
    extractedAt: new Date().toLocaleDateString(),
    markdown: `
# Introduction
Acute pericarditis is an inflammatory syndrome of the pericardium presenting with acute pleuritic chest pain.

# Clinical Presentation
Chest pain characteristically improves when leaning forward and worsens when supine. High-pitched friction rub on auscultation.

# Diagnostic Findings
Diffuse PR-segment depression and concave ST-segment elevation across leads (Figure 1).

Chest radiography in tamponade demonstrates cardiomegaly with a classic "water-bottle" heart silhouette (Figure 2).

# Comparison Table

| Feature | Acute Pericarditis | Cardiac Tamponade |
| --- | --- | --- |
| **ECG Findings** | Diffuse ST elevation, PR depression | Electrical alternans, low voltage |
| **Physical Exam** | Pericardial friction rub | Beck triad |

![Figure 1: Diffuse ST-segment elevation in acute pericarditis](https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/Pericarditis_ECG.png/640px-Pericarditis_ECG.png)

![Figure 2: Water-bottle sign on chest radiography](https://upload.wikimedia.org/wikipedia/commons/thumb/c/c2/Chest_Xray_water_bottle_sign.jpg/640px-Chest_Xray_water_bottle_sign.jpg)
`
  };
}

// Save a single article to IndexedDB (called per-article, not full array dump)
async function saveArticles(articleToSave) {
  try {
    if (articleToSave) {
      await dbPut(articleToSave);
    } else {
      // Full re-sync: put all current articles
      for (const a of articles) { await dbPut(a); }
    }
  } catch (e) {
    console.error('[Coursology] IndexedDB save failed:', e);
    alert('Warning: Could not save article to local storage. IndexedDB error: ' + e.message);
  }
  renderSidebar();
}

const importJsonInput = document.getElementById('import-json-input');

// Setup Event Listeners
function setupEventListeners() {
  if (pasteBtn) pasteBtn.addEventListener('click', handleClipboardPaste);
  if (welcomePasteBtn) welcomePasteBtn.addEventListener('click', handleClipboardPaste);

  if (fileInput) fileInput.addEventListener('change', handleFileInput);
  if (importJsonInput) importJsonInput.addEventListener('change', handleJsonImport);
  if (searchInput) searchInput.addEventListener('input', renderSidebar);
  if (clearAllBtn) clearAllBtn.addEventListener('click', handleClearAll);
  if (exportAllBtn) exportAllBtn.addEventListener('click', handleExportBackup);

  if (articleCollapseAllBtn) articleCollapseAllBtn.addEventListener('click', collapseAllArticleSections);
  if (articleExpandAllBtn) articleExpandAllBtn.addEventListener('click', expandAllArticleSections);

  const scriptModalBtn = document.getElementById('script-modal-btn');
  const scriptModalClose = document.getElementById('script-modal-close');
  const copyScriptCodeBtn = document.getElementById('copy-script-code-btn');

  if (scriptModalBtn) scriptModalBtn.addEventListener('click', openScriptModal);
  if (scriptModalClose) scriptModalClose.addEventListener('click', closeScriptModal);
  if (copyScriptCodeBtn) copyScriptCodeBtn.addEventListener('click', copyScriptCode);

  const lightboxCloseBtn = document.getElementById('lightbox-close-btn');
  if (lightboxCloseBtn) lightboxCloseBtn.addEventListener('click', closeLightbox);
  if (lightboxPrev) lightboxPrev.addEventListener('click', showPrevFigure);
  if (lightboxNext) lightboxNext.addEventListener('click', showNextFigure);

  if (lightbox) {
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeLightbox();
    });
  }

  const tableLightboxClose = document.getElementById('table-lightbox-close');
  const tableLightboxModal = document.getElementById('table-lightbox');
  if (tableLightboxClose) tableLightboxClose.addEventListener('click', closeTableLightbox);
  if (tableLightboxModal) {
    tableLightboxModal.addEventListener('click', (e) => {
      if (e.target === tableLightboxModal) closeTableLightbox();
    });
  }

  setupSidebarResizingAndToggles();

  // Global Keyboard listener for Lightbox navigation
  document.addEventListener('keydown', (e) => {
    const scriptModal = document.getElementById('script-modal');
    if (scriptModal && !scriptModal.classList.contains('hidden') && e.key === 'Escape') {
      closeScriptModal();
      return;
    }

    const tableLightboxModal = document.getElementById('table-lightbox');
    if (tableLightboxModal && !tableLightboxModal.classList.contains('hidden') && e.key === 'Escape') {
      closeTableLightbox();
      return;
    }

    if (lightbox && lightbox.classList.contains('hidden')) return;

    if (e.key === 'Escape') {
      closeLightbox();
    } else if (e.key === 'ArrowRight') {
      showNextFigure();
    } else if (e.key === 'ArrowLeft') {
      showPrevFigure();
    }
  });
}

// Resizable & Collapsible Sidebars Setup
function setupSidebarResizingAndToggles() {
  const leftSidebar = document.getElementById('left-sidebar');
  const leftResizer = document.getElementById('left-resizer');
  const toggleLeftBtn = document.getElementById('toggle-left-sidebar-btn');

  const mediaSidebar = document.getElementById('media-sidebar');
  const rightResizer = document.getElementById('right-resizer');
  const toggleRightBtn = document.getElementById('toggle-right-sidebar-btn');

  // Left Sidebar Toggle
  if (toggleLeftBtn && leftSidebar) {
    toggleLeftBtn.addEventListener('click', () => {
      const isCollapsing = !leftSidebar.classList.contains('collapsed');
      leftSidebar.classList.toggle('collapsed');
      toggleLeftBtn.classList.toggle('collapsed');
      if (isCollapsing) {
        toggleLeftBtn.style.left = '8px';
      } else {
        const curWidth = parseInt(leftSidebar.style.width) || 320;
        toggleLeftBtn.style.left = `${curWidth - 14}px`;
      }
    });
  }

  // Right Sidebar Toggle
  if (toggleRightBtn && mediaSidebar) {
    toggleRightBtn.addEventListener('click', () => {
      const isCollapsing = !mediaSidebar.classList.contains('collapsed');
      mediaSidebar.classList.toggle('collapsed');
      toggleRightBtn.classList.toggle('collapsed');
      if (isCollapsing) {
        toggleRightBtn.style.right = '8px';
      } else {
        const curWidth = parseInt(mediaSidebar.style.width) || 260;
        toggleRightBtn.style.right = `${curWidth - 14}px`;
      }
    });
  }

  // Left Resizer Dragging
  if (leftResizer && leftSidebar && toggleLeftBtn) {
    let isDragging = false;
    leftResizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isDragging = true;
      leftResizer.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      let newWidth = e.clientX;
      if (newWidth < 180) newWidth = 180;
      if (newWidth > 500) newWidth = 500;
      leftSidebar.style.width = `${newWidth}px`;
      toggleLeftBtn.style.left = `${newWidth - 16}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        leftResizer.classList.remove('resizing');
        document.body.style.cursor = '';
      }
    });
  }

  // Right Resizer Dragging
  if (rightResizer && mediaSidebar && toggleRightBtn) {
    let isDraggingRight = false;
    rightResizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isDraggingRight = true;
      rightResizer.classList.add('resizing');
      document.body.style.cursor = 'col-resize';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDraggingRight) return;
      let newWidth = window.innerWidth - e.clientX;
      if (newWidth < 160) newWidth = 160;
      if (newWidth > 450) newWidth = 450;
      mediaSidebar.style.width = `${newWidth}px`;
      toggleRightBtn.style.right = `${newWidth - 16}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDraggingRight) {
        isDraggingRight = false;
        rightResizer.classList.remove('resizing');
        document.body.style.cursor = '';
      }
    });
  }
}

// Script Modal Helpers
async function openScriptModal() {
  const scriptModal = document.getElementById('script-modal');
  const scriptCodeTextarea = document.getElementById('script-code-textarea');

  if (scriptModal) scriptModal.classList.remove('hidden');
  if (scriptCodeTextarea) {
    try {
      const res = await fetch('tampermonkey-script.js');
      const text = await res.text();
      scriptCodeTextarea.value = text;
    } catch (e) {
      console.error('Could not load tampermonkey-script.js:', e);
    }
  }
}

function closeScriptModal() {
  const scriptModal = document.getElementById('script-modal');
  if (scriptModal) scriptModal.classList.add('hidden');
}

async function copyScriptCode() {
  const scriptCodeTextarea = document.getElementById('script-code-textarea');
  const copyScriptCodeBtn = document.getElementById('copy-script-code-btn');
  if (!scriptCodeTextarea || !scriptCodeTextarea.value) return;

  try {
    await navigator.clipboard.writeText(scriptCodeTextarea.value);
    const origText = copyScriptCodeBtn.innerText;
    copyScriptCodeBtn.innerText = 'Copied Code to Clipboard!';
    setTimeout(() => { copyScriptCodeBtn.innerText = origText; }, 2500);
  } catch (err) {
    scriptCodeTextarea.select();
    document.execCommand('copy');
    alert('Copied Tampermonkey script code to clipboard!');
  }
}

// Handle Clipboard Paste
async function handleClipboardPaste() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) {
      alert('Clipboard is empty! Click "Copy Article MD" on Coursology first.');
      return;
    }

    await parseAndAddMarkdown(text);
  } catch (err) {
    const manualText = prompt('Paste your copied Markdown text here:');
    if (manualText) {
      await parseAndAddMarkdown(manualText);
    }
  }
}

// Parse Markdown frontmatter & clean body
async function parseAndAddMarkdown(mdText) {
  let title = 'Medical Article';
  let date = new Date().toLocaleDateString();

  const titleMatch = mdText.match(/title:\s*"([^"]+)"/);
  if (titleMatch && titleMatch[1] && titleMatch[1].toLowerCase() !== 'medical library') {
    title = titleMatch[1].trim();
  }

  let cleanMarkdown = mdText.replace(/^---[\s\S]*?---\s*/, '');

  const articleObj = {
    id: 'art-' + Date.now(),
    title: title,
    extractedAt: date,
    markdown: cleanMarkdown
  };

  await addArticle(articleObj);
}

// Handle File Input (.md files)
function handleFileInput(e) {
  const files = Array.from(e.target.files);
  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = async (event) => {
      await parseAndAddMarkdown(event.target.result);
    };
    reader.readAsText(file);
  });
}

// Base64 Image Compression Helper (Reduces base64 size with 100% safety fallback)
function compressBase64(dataUrl, maxDimension = 1200, quality = 0.75) {
  return new Promise((resolve) => {
    if (!dataUrl || !dataUrl.startsWith('data:image')) {
      return resolve(dataUrl);
    }
    
    // 3s Safety timeout: If canvas hangs or fails, return original untouched
    const timeout = setTimeout(() => resolve(dataUrl), 3000);

    const img = new Image();
    img.onload = () => {
      clearTimeout(timeout);
      try {
        let width = img.naturalWidth || img.width;
        let height = img.naturalHeight || img.height;
        if (!width || !height) return resolve(dataUrl);

        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        const compressed = canvas.toDataURL('image/jpeg', quality);
        if (compressed && compressed.startsWith('data:image') && compressed.length < dataUrl.length) {
          resolve(compressed);
        } else {
          resolve(dataUrl);
        }
      } catch (e) {
        resolve(dataUrl);
      }
    };
    img.onerror = () => {
      clearTimeout(timeout);
      resolve(dataUrl);
    };
    img.src = dataUrl;
  });
}

async function optimizeMarkdownImages(mdText) {
  if (!mdText || !mdText.includes('data:image')) {
    return mdText;
  }

  try {
    const dataUriRegex = /data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/g;
    const matches = mdText.match(dataUriRegex);
    if (!matches || matches.length === 0) return mdText;

    const uniqueUris = Array.from(new Set(matches));
    let updatedMd = mdText;

    for (const originalUri of uniqueUris) {
      if (originalUri.length > 300000) {
        try {
          const compressedUri = await compressBase64(originalUri);
          if (compressedUri && compressedUri.startsWith('data:image') && compressedUri.length < originalUri.length) {
            updatedMd = updatedMd.split(originalUri).join(compressedUri);
          }
        } catch (singleErr) {
          console.warn('Single image compression skipped safely:', singleErr);
        }
      }
    }
    return updatedMd;
  } catch (err) {
    console.warn('Image optimization skipped due to safety guard:', err);
    return mdText;
  }
}

// Add or update article
async function addArticle(articleData, autoSave = true) {
  if (articleData && articleData.markdown) {
    articleData.markdown = await optimizeMarkdownImages(articleData.markdown);
  }
  const existingIdx = articles.findIndex(a => a.title === articleData.title);
  if (existingIdx >= 0) {
    articles[existingIdx] = articleData;
  } else {
    articles.unshift(articleData);
  }

  if (autoSave) await saveArticles(articleData);
  displayArticle(articleData.id);
}

// Render Clean Flat Article List & Expandable/Collapsible Active Article TOC
function renderSidebar() {
  const query = searchInput.value.toLowerCase().trim();
  articleFlatList.innerHTML = '';

  const filtered = articles.filter(a => 
    a.title.toLowerCase().includes(query) || 
    (a.markdown && a.markdown.toLowerCase().includes(query))
  );

  articleCount.innerText = `${articles.length} article${articles.length === 1 ? '' : 's'}`;

  if (filtered.length === 0) {
    articleFlatList.innerHTML = `<div style="font-size:0.85rem; color:#94a3b8; text-align:center; padding:12px;">No articles found</div>`;
    if (articles.length === 0) {
      welcomeState.classList.remove('hidden');
      articleContent.classList.add('hidden');
      if (mediaSidebar) mediaSidebar.classList.add('hidden');
      const toggleRightBtn = document.getElementById('toggle-right-sidebar-btn');
      if (toggleRightBtn) toggleRightBtn.classList.add('hidden');
    }
    return;
  }

  const chevronSvg = `<svg class="toc-toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

  filtered.forEach(article => {
    const li = document.createElement('li');
    const isActive = article.id === activeArticleId;
    if (isActive) {
      li.className = 'active' + (activeTocCollapsed ? ' toc-collapsed' : '');
    }

    const rowDiv = document.createElement('div');
    rowDiv.className = 'article-row-item';

    const titleWrapper = document.createElement('div');
    titleWrapper.className = 'article-title-wrapper';

    if (isActive) {
      titleWrapper.innerHTML = `${chevronSvg}<span class="article-title-text">${article.title}</span>`;
    } else {
      titleWrapper.innerHTML = `<span class="article-title-text">${article.title}</span>`;
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-item';
    deleteBtn.innerHTML = '&times;';
    deleteBtn.title = 'Delete article';
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      deleteArticle(article.id);
    };

    rowDiv.appendChild(titleWrapper);
    rowDiv.appendChild(deleteBtn);
    li.appendChild(rowDiv);

    // Render Expandable/Collapsible Table of Contents under ACTIVE article
    if (isActive && currentArticleToc && currentArticleToc.length > 0) {
      const tocDiv = document.createElement('div');
      tocDiv.className = 'sidebar-toc' + (activeTocCollapsed ? ' collapsed' : '');

      currentArticleToc.forEach(item => {
        const h1Link = document.createElement('a');
        h1Link.className = 'toc-item level-main';
        h1Link.dataset.sectionId = item.id;
        h1Link.innerText = item.text;

        const subGroup = document.createElement('div');
        subGroup.className = 'sidebar-subgroup';
        subGroup.dataset.subgroupFor = item.id;

        if (item.children && item.children.length > 0) {
          item.children.forEach(sub => {
            const subLink = document.createElement('a');
            subLink.className = 'toc-item level-sub';
            subLink.dataset.sectionId = sub.id;
            subLink.innerHTML = `<span class="toc-bullet">•</span> <span>${sub.text}</span>`;

            subLink.onclick = (e) => {
              e.stopPropagation();
              e.preventDefault();
              const secEl = document.getElementById(sub.id);
              if (secEl) {
                // Ensure parent H1 main section is uncollapsed
                const parentH1 = document.getElementById(item.id);
                if (parentH1) {
                  parentH1.classList.remove('collapsed');
                  const h1Body = parentH1.nextElementSibling;
                  if (h1Body && h1Body.classList.contains('h1-section-body')) {
                    h1Body.classList.remove('collapsed');
                  }
                }
                secEl.classList.remove('collapsed');
                const subBody = secEl.nextElementSibling;
                if (subBody && subBody.classList.contains('h2-section-body')) {
                  subBody.classList.remove('collapsed');
                }
                secEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
                document.querySelectorAll('.toc-item').forEach(el => el.classList.remove('active'));
                subLink.classList.add('active');
              }
            };
            subGroup.appendChild(subLink);
          });
        }

        h1Link.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          const secEl = document.getElementById(item.id);
          if (secEl) {
            secEl.classList.remove('collapsed');
            const h1Body = secEl.nextElementSibling;
            if (h1Body && h1Body.classList.contains('h1-section-body')) {
              h1Body.classList.remove('collapsed');
            }
            subGroup.classList.remove('collapsed');
            secEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            document.querySelectorAll('.toc-item').forEach(el => el.classList.remove('active'));
            h1Link.classList.add('active');
          }
        };

        tocDiv.appendChild(h1Link);
        if (item.children && item.children.length > 0) {
          tocDiv.appendChild(subGroup);
        }
      });

      li.appendChild(tocDiv);
    }

    rowDiv.onclick = () => {
      if (isActive) {
        activeTocCollapsed = !activeTocCollapsed;
        renderSidebar();
      } else {
        activeTocCollapsed = false;
        displayArticle(article.id);
      }
    };

    articleFlatList.appendChild(li);
  });
}

// ScrollSpy: highlight active sidebar TOC item as user scrolls article
function setupScrollSpy() {
  const mainViewer = document.querySelector('.main-viewer');
  if (!mainViewer) return;

  mainViewer.addEventListener('scroll', () => {
    if (!currentArticleToc || currentArticleToc.length === 0) return;

    const headings = currentArticleToc.map(t => document.getElementById(t.id)).filter(Boolean);
    let activeId = null;

    for (let i = 0; i < headings.length; i++) {
      const rect = headings[i].getBoundingClientRect();
      if (rect.top <= 160) {
        activeId = headings[i].id;
      }
    }

    if (activeId) {
      document.querySelectorAll('.toc-item').forEach(item => {
        if (item.dataset.sectionId === activeId) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
    }
  });
}

// Format and Hide Inline Tables (Viewable only via exhibit pill buttons & media sidebar)
function processTables(container) {
  const tables = container.querySelectorAll('table');
  tables.forEach(table => {
    if (!table.parentElement || !table.parentElement.classList.contains('table-wrapper')) {
      const wrapper = document.createElement('div');
      wrapper.className = 'table-wrapper';
      wrapper.style.display = 'none';
      table.parentNode.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    } else if (table.parentElement) {
      table.parentElement.style.display = 'none';
    }

    table.style.display = 'none';
    table.classList.add('coursology-medical-table');
    table.setAttribute('data-exhibit-asset', 'true');

    table.querySelectorAll('th, td').forEach(cell => {
      cell.style.padding = '12px 18px';
      cell.style.lineHeight = '1.5';
      cell.style.wordBreak = 'normal';
      cell.style.overflowWrap = 'break-word';
    });
  });
}

// Display Selected Article
function displayArticle(id) {
  const article = articles.find(a => a.id === id);
  if (!article) return;

  activeArticleId = id;

  welcomeState.classList.add('hidden');
  articleContent.classList.remove('hidden');

  articleTitle.innerText = article.title;
  articleDate.innerText = `Extracted: ${article.extractedAt}`;

  let cleanMd = article.markdown || '';
  const normTitle = article.title.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  // Remove leading `# Title` matching article title to prevent duplication
  cleanMd = cleanMd.replace(/^\s*#+\s+([^\n]+)/, (full, hText) => {
    const normH = hText.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (normH === normTitle) ? '' : full;
  }).trim();

  // Parse Markdown to HTML using Marked library
  if (typeof marked !== 'undefined') {
    articleBody.innerHTML = marked.parse(cleanMd);
  } else {
    articleBody.innerText = cleanMd;
  }

  // Ensure Opening Paragraphs have an "Introduction" Heading if no heading exists at top
  ensureIntroductionHeading(articleBody);

  // 1. Setup Collapsible Headings & generate Table of Contents list
  currentArticleToc = setupCollapsibleHeadings(articleBody, article.title);

  // 2. Format Tables wide & spacious
  processTables(articleBody);

  // 3. Collect Lightbox Gallery from ALL images BEFORE removing them
  setupLightboxGallery(articleBody, article.title);

  // 4. Strip ALL visible inline images — exhibits shown only via pill button popup
  articleBody.querySelectorAll('img:not([data-exhibit-asset])').forEach(img => img.remove());

  // 5. Convert exhibit text refs into pill buttons (uses gallery built above)
  processFigureAndTableLinks(articleBody);

  // 6. Render Sidebar & Right Media Sidebar
  renderSidebar();
  renderMediaSidebar(articleBody);
}

// Ensure first section has an "Introduction" heading if missing
function ensureIntroductionHeading(container) {
  const firstChild = container.firstElementChild;
  if (!firstChild) return;

  // Check if article starts with a heading tag (h1-h6)
  if (/^H[1-6]$/i.test(firstChild.tagName)) {
    return;
  }

  // Otherwise, wrap top opening paragraphs under an "Introduction" H1 heading
  const introH1 = document.createElement('h1');
  introH1.innerText = 'Introduction';
  container.insertBefore(introH1, firstChild);
}

// Make H1 Main Headings and H2 Subheadings collapsible with true nesting & build TOC
function setupCollapsibleHeadings(container, mainTitleText = '') {
  const normMainTitle = (mainTitleText || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // Query native headings H1, H2, H3, H4
  const rawHeadings = Array.from(container.querySelectorAll('h1, h2, h3, h4'));
  const headingElements = [];

  rawHeadings.forEach(h => {
    const text = h.innerText.trim();
    if (!text || text.length > 90) return;
    const normText = text.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normText === normMainTitle && (h.tagName === 'H1' || headingElements.length === 0)) {
      h.remove();
      return;
    }
    headingElements.push(h);
  });

  if (headingElements.length === 0) return [];

  // Determine top-level main headings (H1, or min tag level)
  const tagNums = headingElements.map(h => parseInt(h.tagName.charAt(1), 10));
  const minTagNum = Math.min(...tagNums);

  const topHeadings = headingElements.filter(h => parseInt(h.tagName.charAt(1), 10) === minTagNum);

  // Add chevron arrow & collapsible-heading class to all headings
  headingElements.forEach((heading, idx) => {
    heading.id = `sec-heading-${idx + 1}`;
    heading.classList.add('collapsible-heading');
    if (heading.tagName === 'H1' || parseInt(heading.tagName.charAt(1), 10) === minTagNum) {
      heading.classList.add('level-main');
    } else {
      heading.classList.add('level-sub');
    }

    if (!heading.querySelector('.heading-arrow')) {
      const arrowSpan = document.createElement('span');
      arrowSpan.className = 'heading-arrow';
      arrowSpan.innerText = '›';
      heading.prepend(arrowSpan);
    }
  });

  const tocTree = [];

  topHeadings.forEach((h1Heading) => {
    const h1Id = h1Heading.id;
    const h1Text = h1Heading.innerText.replace(/^›\s*/, '').trim();

    // Collect all elements until the NEXT top-level main heading
    const sectionNodes = [];
    let nextEl = h1Heading.nextElementSibling;
    while (nextEl) {
      if (topHeadings.includes(nextEl)) break;
      sectionNodes.push(nextEl);
      nextEl = nextEl.nextElementSibling;
    }

    const mainSectionWrapper = document.createElement('div');
    mainSectionWrapper.className = 'h1-section-body';

    if (sectionNodes.length > 0) {
      h1Heading.parentNode.insertBefore(mainSectionWrapper, sectionNodes[0]);
      sectionNodes.forEach(node => mainSectionWrapper.appendChild(node));
    }

    // Click H1 Main Section: Toggle section body (hides/shows ALL child subheadings & content!)
    h1Heading.onclick = (e) => {
      if (e.target.closest('a, button')) return;
      h1Heading.classList.toggle('collapsed');
      mainSectionWrapper.classList.toggle('collapsed');

      // Sync sidebar subgroup collapse
      const sidebarSubgroup = document.querySelector(`[data-subgroup-for="${h1Id}"]`);
      if (sidebarSubgroup) {
        sidebarSubgroup.classList.toggle('collapsed');
      }
    };

    // Process H2 subheadings inside this mainSectionWrapper
    const childH2s = Array.from(mainSectionWrapper.querySelectorAll('h2, h3, h4'));
    const subTocItems = [];

    childH2s.forEach((h2Heading) => {
      const h2Id = h2Heading.id;
      const h2Text = h2Heading.innerText.replace(/^›\s*/, '').trim();

      const subNodes = [];
      let subNext = h2Heading.nextElementSibling;
      while (subNext) {
        if (childH2s.includes(subNext)) break;
        subNodes.push(subNext);
        subNext = subNext.nextElementSibling;
      }

      if (subNodes.length > 0) {
        const subWrapper = document.createElement('div');
        subWrapper.className = 'h2-section-body';
        h2Heading.parentNode.insertBefore(subWrapper, subNodes[0]);
        subNodes.forEach(n => subWrapper.appendChild(n));

        h2Heading.onclick = (e) => {
          if (e.target.closest('a, button')) return;
          h2Heading.classList.toggle('collapsed');
          subWrapper.classList.toggle('collapsed');
        };
      }

      subTocItems.push({
        id: h2Id,
        text: h2Text,
        level: 2
      });
    });

    tocTree.push({
      id: h1Id,
      text: h1Text,
      level: 1,
      children: subTocItems
    });
  });

  return tocTree;
}

// Article Header Controls: Collapse All Sections
function collapseAllArticleSections() {
  const headings = document.querySelectorAll('#article-body .collapsible-heading');
  const h1Blocks = document.querySelectorAll('#article-body .h1-section-body');
  const h2Blocks = document.querySelectorAll('#article-body .h2-section-body');
  const legacyBlocks = document.querySelectorAll('#article-body .heading-content-block');
  const sidebarSubgroups = document.querySelectorAll('.sidebar-subgroup');

  headings.forEach(h => h.classList.add('collapsed'));
  h1Blocks.forEach(b => b.classList.add('collapsed'));
  h2Blocks.forEach(b => b.classList.add('collapsed'));
  legacyBlocks.forEach(b => b.classList.add('collapsed'));
  sidebarSubgroups.forEach(sg => sg.classList.add('collapsed'));
}

// Article Header Controls: Expand All Sections
function expandAllArticleSections() {
  const headings = document.querySelectorAll('#article-body .collapsible-heading');
  const h1Blocks = document.querySelectorAll('#article-body .h1-section-body');
  const h2Blocks = document.querySelectorAll('#article-body .h2-section-body');
  const legacyBlocks = document.querySelectorAll('#article-body .heading-content-block');
  const sidebarSubgroups = document.querySelectorAll('.sidebar-subgroup');

  headings.forEach(h => h.classList.remove('collapsed'));
  h1Blocks.forEach(b => b.classList.remove('collapsed'));
  h2Blocks.forEach(b => b.classList.remove('collapsed'));
  legacyBlocks.forEach(b => b.classList.remove('collapsed'));
  sidebarSubgroups.forEach(sg => sg.classList.remove('collapsed'));
}

// Render Coursology-Style Right Media Sidebar (Figures & Tables)
function renderMediaSidebar(container) {
  if (!mediaSidebar || !mediaFiguresGrid || !mediaTablesGrid) return;

  mediaFiguresGrid.innerHTML = '';
  mediaTablesGrid.innerHTML = '';

  const tableSvgIcon = `<svg aria-hidden="true" focusable="false" data-prefix="fas" data-icon="table" class="media-thumb-icon" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M64 256l0-96 160 0 0 96L64 256zm0 64l160 0 0 96L64 416l0-96zm224 96l0-96 160 0 0 96-160 0zM448 256l-160 0 0-96 160 0 0 96zM64 32C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32z"></path></svg>`;

  const figuresList = [];
  const tablesList = [];

  // Categorize images into figures vs captured table images
  currentFigureList.forEach((item, idx) => {
    const isTableImg = item.alt && /table|tbl/i.test(item.alt);
    if (isTableImg) {
      tablesList.push({ ...item, type: 'img' });
    } else {
      figuresList.push({ ...item, type: 'img' });
    }
  });

  // Collect raw HTML tables
  const htmlTables = Array.from(container.querySelectorAll('table'));
  htmlTables.forEach((tbl, idx) => {
    const tblNum = idx + 1;
    tablesList.push({
      type: 'table',
      element: tbl,
      caption: tbl.querySelector('caption')?.innerText?.trim() || `Table ${tblNum}`,
      label: `table ${tblNum}`
    });
  });

  // Render Figures Section
  figuresList.forEach((fig, i) => {
    const defaultNum = i + 1;
    let labelText = (fig.alt || fig.title || '').trim();
    if (!labelText) {
      labelText = `figure ${defaultNum}`;
    }
    labelText = labelText.replace(/^[\(\[\s]+|[\)\]\s]+$/g, '');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'media-thumb-btn';
    btn.innerHTML = `
      <div class="media-thumb-box">
        <img src="${fig.src}" alt="${labelText}" loading="lazy" class="media-thumb-img">
      </div>
      <p class="media-thumb-label">${labelText}</p>
    `;
    btn.onclick = () => {
      openLightbox(fig.index);
    };
    mediaFiguresGrid.appendChild(btn);
  });

  // Render Tables Section
  tablesList.forEach((tbl, i) => {
    const tblNum = i + 1;
    const labelText = tbl.label || `table ${tblNum}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'media-thumb-btn';

    if (tbl.type === 'img') {
      btn.innerHTML = `
        <div class="media-thumb-box">
          <img src="${tbl.src}" alt="${labelText}" loading="lazy" class="media-thumb-img">
        </div>
        <p class="media-thumb-label">${labelText}</p>
      `;
      btn.onclick = () => {
        openLightbox(tbl.index);
      };
    } else {
      btn.innerHTML = `
        <div class="media-thumb-box">
          ${tableSvgIcon}
        </div>
        <p class="media-thumb-label">${labelText}</p>
      `;
      btn.onclick = () => {
        openTableLightbox(tbl.element, tbl.caption || labelText);
      };
    }

    mediaTablesGrid.appendChild(btn);
  });

  mediaSidebar.classList.remove('hidden');
  const toggleRightBtn = document.getElementById('toggle-right-sidebar-btn');
  if (toggleRightBtn) toggleRightBtn.classList.remove('hidden');
}

// Setup Lightbox Gallery Items - scans ALL images including hidden exhibit assets
function setupLightboxGallery(container, defaultTitle) {
  currentFigureList = [];

  // Select both regular images AND hidden exhibit asset images embedded by tampermonkey script
  const images = Array.from(container.querySelectorAll('img'));
  images.forEach((img, index) => {
    const figNum = index + 1;
    const altText = (img.alt || img.getAttribute('title') || '').trim();
    const caption = altText || `Figure ${figNum}: ${defaultTitle}`;

    // Mark as an exhibit asset so the removal step below skips it
    img.setAttribute('data-exhibit-asset', 'true');
    if (!img.id) img.id = `fig-img-${figNum}`;

    const figItem = {
      src: img.src,
      caption: caption,
      element: img,
      alt: altText,
      index: index
    };

    currentFigureList.push(figItem);
  });
}

// Convert "(Figure X)" / "(Table X)" text references into sleek Coursology Exhibit Pill Buttons
function processFigureAndTableLinks(container) {
  const figureMap = {};

  // 1. Build map for figure images
  currentFigureList.forEach((item, index) => {
    const figNum = index + 1;

    figureMap[`figure ${figNum}`] = item;
    figureMap[`fig ${figNum}`] = item;
    figureMap[`fig. ${figNum}`] = item;
    figureMap[`image ${figNum}`] = item;
    figureMap[`img ${figNum}`] = item;
    figureMap[`img. ${figNum}`] = item;
    figureMap[`exhibit ${figNum}`] = item;
    figureMap[String(figNum)] = item;

    if (item.alt) {
      const match = item.alt.match(/(?:Figure|Fig\.?|Table|Tbl\.?|Image|Img\.?|Exhibit)\s*(\d+[A-Za-z]?)/i);
      if (match) {
        const keyNum = match[1].toLowerCase();
        const isTab = match[0].toLowerCase().startsWith('tab');
        const prefixStr = isTab ? 'table ' : 'figure ';
        figureMap[`${prefixStr}${keyNum}`] = item;
        figureMap[`image ${keyNum}`] = item;
        figureMap[`img ${keyNum}`] = item;
        figureMap[`img. ${keyNum}`] = item;
        if (isTab) {
          figureMap[`tbl ${keyNum}`] = item;
          figureMap[`tbl. ${keyNum}`] = item;
        } else {
          figureMap[`fig ${keyNum}`] = item;
          figureMap[`fig. ${keyNum}`] = item;
        }
      }
    }
  });

  // 2. Build map for HTML tables
  const tables = Array.from(container.querySelectorAll('table'));
  tables.forEach((tbl, index) => {
    const tblNum = index + 1;
    if (!tbl.id) tbl.id = `table-${tblNum}`;

    const caption = tbl.querySelector('caption')?.innerText?.trim() || `Table ${tblNum}`;
    const tableData = {
      isTable: true,
      caption: caption,
      element: tbl
    };

    figureMap[`table ${tblNum}`] = tableData;
    figureMap[`tbl ${tblNum}`] = tableData;
    figureMap[`tbl. ${tblNum}`] = tableData;
  });

  // 3. TreeWalker to process text nodes cleanly without breaking HTML structure
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        const parent = node.parentNode;
        if (!parent) return NodeFilter.FILTER_SKIP;
        const tag = parent.tagName.toUpperCase();

        if (['SCRIPT', 'STYLE', 'A', 'CODE', 'PRE', 'BUTTON', 'FIGCAPTION'].includes(tag)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.classList && (parent.classList.contains('figure-link') || parent.classList.contains('exhibit-btn'))) {
          return NodeFilter.FILTER_REJECT;
        }
        if (/(?:Figure|Fig\.?|Table|Tbl\.?|Image|Img\.?|Exhibit)\s*\d+/i.test(node.nodeValue)) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_SKIP;
      }
    }
  );

  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  const figRegex = /(?:\(\(|\(|\[)?\s*\b(Figure|Fig\.?|Table|Tbl\.?|Image|Img\.?|Exhibit)\s*(\d+[A-Za-z]?)\b\s*(?:\)\)|\)|\])?/gi;

  const cameraIconSvg = `<svg class="svg-icon-sm" viewBox="0 0 512 512" fill="currentColor"><path d="M149.1 64c-11.4 0-21.8 6.4-27.1 16.5L100.8 128H48C21.5 128 0 149.5 0 176V432c0 26.5 21.5 48 48 48H464c26.5 0 48-21.5 48-48V176c0-26.5-21.5-48-48-48H411.2l-21.2-47.5c-5.3-10.1-15.7-16.5-27.1-16.5H149.1zM256 208a96 96 0 1 1 0 192 96 96 0 1 1 0-192z"/></svg>`;
  const tableIconSvg = `<svg class="svg-icon-sm" viewBox="0 0 512 512" fill="currentColor"><path d="M64 256l0-96 160 0 0 96L64 256zm0 64l160 0 0 96L64 416l0-96zm224 96l0-96 160 0 0 96-160 0zM448 256l-160 0 0-96 160 0 0 96zM64 32C28.7 32 0 60.7 0 96V416c0 35.3 28.7 64 64 64l384 0c35.3 0 64-28.7 64-64l0-320c0-35.3-28.7-64-64-64L64 32z"/></svg>`;

  textNodes.forEach(node => {
    const text = node.nodeValue;
    if (!figRegex.test(text)) return;
    figRegex.lastIndex = 0;

    const fragment = document.createDocumentFragment();
    let lastIdx = 0;
    let match;

    while ((match = figRegex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        fragment.appendChild(document.createTextNode(text.substring(lastIdx, match.index)));
      }

      const fullMatch = match[0];
      const prefix = match[1];
      const num = match[2];
      const isTable = prefix.toLowerCase().startsWith('tab');
      const cleanLabel = `${prefix} ${num}`;

      const keyLower = `${prefix.toLowerCase()} ${num.toLowerCase()}`;
      let target = figureMap[keyLower]
        || figureMap[`image ${num.toLowerCase()}`]
        || figureMap[`figure ${num.toLowerCase()}`]
        || figureMap[`fig ${num.toLowerCase()}`]
        || figureMap[num.toLowerCase()];

      // Create High-Fidelity Exhibit Button
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = isTable ? 'exhibit-btn table-link' : 'exhibit-btn';
      btn.innerHTML = `${isTable ? tableIconSvg : cameraIconSvg}<span>${cleanLabel}</span>`;
      btn.title = `Click to view ${cleanLabel} popup`;

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        let foundTarget = target;

        if (!foundTarget) {
          foundTarget = currentFigureList.find(item => {
            const alt = (item.alt || '').toLowerCase();
            const searchKey = `${prefix.toLowerCase()} ${num.toLowerCase()}`;
            return alt.includes(searchKey) || 
                   (isTable && (alt.includes(`table ${num.toLowerCase()}`) || alt.includes(`tbl ${num.toLowerCase()}`)));
          });
        }

        if (!foundTarget && isTable) {
          const tblIdx = parseInt(num, 10) - 1;
          const allTables = Array.from(container.querySelectorAll('table'));
          if (allTables[tblIdx]) {
            foundTarget = { isTable: true, element: allTables[tblIdx], caption: `Table ${num}` };
          }
        }

        if (foundTarget && foundTarget.isTable) {
          openTableLightbox(foundTarget.element, foundTarget.caption || cleanLabel);
        } else if (foundTarget && typeof foundTarget.index === 'number') {
          openLightbox(foundTarget.index);
        } else if (currentFigureList.length > 0) {
          const fallbackNum = parseInt(num, 10);
          const safeIdx = !isNaN(fallbackNum) && fallbackNum > 0 ? Math.min(fallbackNum - 1, currentFigureList.length - 1) : 0;
          openLightbox(safeIdx);
        } else {
          alert(`Media for ${cleanLabel} popup is loading or was not found.`);
        }
      };

      fragment.appendChild(btn);

      lastIdx = figRegex.lastIndex;
    }

    if (lastIdx < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIdx)));
    }

    node.parentNode.replaceChild(fragment, node);
  });
}

// Setup Mouse Drag Pan & Scroll Zoom
function setupPanAndZoom() {
  const viewport = document.getElementById('lightbox-viewport');
  const zoomInBtn = document.getElementById('tool-zoom-in');
  const zoomOutBtn = document.getElementById('tool-zoom-out');
  const zoomResetBtn = document.getElementById('tool-zoom-reset');
  const rotateBtn = document.getElementById('tool-rotate');

  if (zoomInBtn) zoomInBtn.addEventListener('click', () => { imgZoom += 0.25; updateImageTransform(); });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => { imgZoom = Math.max(0.3, imgZoom - 0.25); updateImageTransform(); });
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', resetImageTransform);
  if (rotateBtn) rotateBtn.addEventListener('click', () => { imgRotation = (imgRotation + 90) % 360; updateImageTransform(); });

  if (viewport) {
    viewport.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        imgZoom += 0.15;
      } else {
        imgZoom = Math.max(0.3, imgZoom - 0.15);
      }
      updateImageTransform();
    }, { passive: false });

    viewport.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      isPanning = true;
      startPanX = e.clientX - imgPanX;
      startPanY = e.clientY - imgPanY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      imgPanX = e.clientX - startPanX;
      imgPanY = e.clientY - startPanY;
      updateImageTransform();
    });

    window.addEventListener('mouseup', () => {
      isPanning = false;
    });
  }
}

// Setup Draggable & Resizable Window Controls
function setupWindowControls() {
  const imgWindow = document.getElementById('lightbox-window');
  const imgHeader = document.getElementById('lightbox-header');
  const imgModal = document.getElementById('lightbox');
  const imgMin = document.getElementById('lightbox-min-btn');
  const imgMax = document.getElementById('lightbox-max-btn');
  const imgClose = document.getElementById('lightbox-close-btn');

  const tblWindow = document.getElementById('table-window');
  const tblHeader = document.getElementById('table-window-header');
  const tblModal = document.getElementById('table-lightbox');
  const tblMin = document.getElementById('table-min-btn');
  const tblMax = document.getElementById('table-max-btn');
  const tblClose = document.getElementById('table-lightbox-close');

  if (imgWindow && imgHeader) {
    makeWindowDraggableAndResizable(imgWindow, imgHeader, imgModal, imgMin, imgMax, imgClose, 'Exhibit Viewer');
  }

  if (tblWindow && tblHeader) {
    makeWindowDraggableAndResizable(tblWindow, tblHeader, tblModal, tblMin, tblMax, tblClose, 'Table Viewer');
  }
}

function makeWindowDraggableAndResizable(cardEl, headerEl, modalParentEl, minBtnEl, maxBtnEl, closeBtnEl, defaultTitle) {
  let isDragging = false;
  let startX = 0, startY = 0;
  let initialLeft = 0, initialTop = 0;

  cardEl.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  headerEl.addEventListener('mousedown', (e) => {
    if (e.target.closest('.win-btn')) return;
    if (cardEl.classList.contains('maximized')) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    
    const rect = cardEl.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;

    cardEl.style.left = `${initialLeft}px`;
    cardEl.style.top = `${initialTop}px`;
    cardEl.style.margin = '0';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    
    const newLeft = Math.max(0, Math.min(window.innerWidth - cardEl.offsetWidth, initialLeft + dx));
    const newTop = Math.max(0, Math.min(window.innerHeight - cardEl.offsetHeight, initialTop + dy));

    cardEl.style.left = `${newLeft}px`;
    cardEl.style.top = `${newTop}px`;
  });

  window.addEventListener('mouseup', () => {
    isDragging = false;
  });

  if (maxBtnEl) {
    maxBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      cardEl.classList.toggle('maximized');
      if (!cardEl.classList.contains('maximized')) {
        cardEl.style.left = '';
        cardEl.style.top = '';
        cardEl.style.margin = '';
      }
    });
  }

  if (minBtnEl) {
    minBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      modalParentEl.classList.add('hidden');
      const windowTitleText = cardEl.querySelector('.window-title-text')?.innerText || defaultTitle;
      addDockBadge(windowTitleText, () => {
        modalParentEl.classList.remove('hidden');
      });
    });
  }

  if (closeBtnEl) {
    closeBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      modalParentEl.classList.add('hidden');
    });
  }
}

function addDockBadge(label, onRestore) {
  const dock = document.getElementById('minimized-dock');
  if (!dock) return;
  dock.classList.remove('hidden');

  const badge = document.createElement('div');
  badge.className = 'dock-badge';
  badge.innerHTML = `<span>${label}</span> <span style="opacity:0.6;">✕</span>`;
  badge.onclick = () => {
    badge.remove();
    if (dock.children.length === 0) dock.classList.add('hidden');
    onRestore();
  };
  dock.appendChild(badge);
}

// Table Lightbox Modal Functions (Fits table auto-proportionally)
function openTableLightbox(tableElem, captionTitle) {
  const tableModal = document.getElementById('table-lightbox');
  const tableTitle = document.getElementById('table-lightbox-title');
  const tableContent = document.getElementById('table-lightbox-content');

  if (tableTitle) tableTitle.innerText = captionTitle || 'Table Viewer';
  if (tableContent && tableElem) {
    const cleanTbl = tableElem.cloneNode(true);
    cleanTbl.removeAttribute('id');
    cleanTbl.removeAttribute('width');
    cleanTbl.removeAttribute('height');
    cleanTbl.style.display = 'table';
    cleanTbl.style.width = '100%';
    cleanTbl.style.maxWidth = '100%';
    cleanTbl.style.height = 'auto';
    cleanTbl.querySelectorAll('[style]').forEach(el => {
      el.style.width = '';
      el.style.height = '';
      el.style.fontSize = '';
    });
    tableContent.innerHTML = '';
    tableContent.appendChild(cleanTbl);
  }
  if (tableModal) tableModal.classList.remove('hidden');
}

function closeTableLightbox() {
  const tableModal = document.getElementById('table-lightbox');
  if (tableModal) tableModal.classList.add('hidden');
}

// Lightbox Open Function (supports index or direct src/caption)
function openLightbox(val, captionOverride) {
  resetImageTransform();
  const windowTitleText = document.getElementById('window-title');

  if (typeof val === 'number') {
    if (!currentFigureList || currentFigureList.length === 0) return;
    currentFigureIndex = (val + currentFigureList.length) % currentFigureList.length;
    const item = currentFigureList[currentFigureIndex];

    lightboxImg.src = item.src;
    lightboxCaption.innerText = item.caption;

    if (lightboxCounter) {
      lightboxCounter.innerText = `Figure ${currentFigureIndex + 1} of ${currentFigureList.length}`;
    }

    if (windowTitleText) {
      windowTitleText.innerText = item.alt ? `Exhibit: ${item.alt}` : `Figure ${currentFigureIndex + 1} of ${currentFigureList.length}`;
    }

    if (lightboxPrev && lightboxNext) {
      const showNav = currentFigureList.length > 1;
      lightboxPrev.style.display = showNav ? 'flex' : 'none';
      lightboxNext.style.display = showNav ? 'flex' : 'none';
    }
  } else {
    lightboxImg.src = val;
    lightboxCaption.innerText = captionOverride || '';
    if (lightboxCounter) lightboxCounter.innerText = '';
    if (windowTitleText) windowTitleText.innerText = 'Exhibit Viewer';
    if (lightboxPrev && lightboxNext) {
      lightboxPrev.style.display = 'none';
      lightboxNext.style.display = 'none';
    }
  }

  lightbox.classList.remove('hidden');
}

function closeLightbox() {
  lightbox.classList.add('hidden');
}

function showNextFigure() {
  if (currentFigureList.length > 0) {
    openLightbox(currentFigureIndex + 1);
  }
}

function showPrevFigure() {
  if (currentFigureList.length > 0) {
    openLightbox(currentFigureIndex - 1);
  }
}

// Delete Article
function deleteArticle(id) {
  articles = articles.filter(a => a.id !== id);
  if (activeArticleId === id) {
    activeArticleId = articles.length > 0 ? articles[0].id : null;
  }
  saveArticles();
  if (activeArticleId) {
    displayArticle(activeArticleId);
  } else {
    welcomeState.classList.remove('hidden');
    articleContent.classList.add('hidden');
    if (mediaSidebar) mediaSidebar.classList.add('hidden');
    const toggleRightBtn = document.getElementById('toggle-right-sidebar-btn');
    if (toggleRightBtn) toggleRightBtn.classList.add('hidden');
  }
}

// Clear All Articles
async function handleClearAll() {
  if (confirm('Are you sure you want to delete all saved articles?')) {
    articles = [];
    activeArticleId = null;
    await dbClear();
    renderSidebar();
    welcomeState.classList.remove('hidden');
    articleContent.classList.add('hidden');
    if (mediaSidebar) mediaSidebar.classList.add('hidden');
    const toggleRightBtn = document.getElementById('toggle-right-sidebar-btn');
    if (toggleRightBtn) toggleRightBtn.classList.add('hidden');
  }
}

// Export All Backup (Supports GZIP CompressionStream)
async function handleExportBackup() {
  if (articles.length === 0) {
    alert('No articles to export.');
    return;
  }

  const jsonStr = JSON.stringify(articles);

  if (typeof CompressionStream !== 'undefined') {
    try {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const compressedStream = blob.stream().pipeThrough(new CompressionStream('gzip'));
      const compressedBlob = await new Response(compressedStream).blob();

      const url = URL.createObjectURL(compressedBlob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.href = url;
      downloadAnchor.download = `medical_library_backup_${Date.now()}.json.gz`;
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      URL.revokeObjectURL(url);
      return;
    } catch (e) {
      console.warn('Gzip compression export failed, falling back to JSON:', e);
    }
  }

  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const downloadAnchor = document.createElement('a');
  downloadAnchor.href = url;
  downloadAnchor.download = `medical_library_backup_${Date.now()}.json`;
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
  URL.revokeObjectURL(url);
}

// Import Backup (Supports .json & .json.gz DecompressionStream)
async function handleJsonImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  try {
    let jsonText = '';

    if (file.name.endsWith('.gz') || file.type.includes('gzip')) {
      if (typeof DecompressionStream !== 'undefined') {
        const decompressedStream = file.stream().pipeThrough(new DecompressionStream('gzip'));
        jsonText = await new Response(decompressedStream).text();
      } else {
        alert('Your browser does not support decompressing .gz files.');
        return;
      }
    } else {
      jsonText = await file.text();
    }

    const importedArticles = JSON.parse(jsonText);
    if (!Array.isArray(importedArticles)) {
      alert('Invalid JSON format: Expected an array of articles.');
      return;
    }

    let importedCount = 0;
    for (const art of importedArticles) {
      if (art && art.id && art.markdown) {
        await addArticle(art);
        importedCount++;
      }
    }

    alert(`Successfully imported ${importedCount} article(s)!`);
    if (articles.length > 0) {
      displayArticle(articles[0].id);
    }
  } catch (err) {
    alert('Error reading JSON backup file: ' + err.message);
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', init);
