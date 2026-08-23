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

let currentArticleToc = []; // [{ id, text, level }]
let activeTocCollapsed = false; // Tracks if active article TOC is collapsed in sidebar
let currentFigureList = []; // Array of { src, caption, element, alt, index }
let currentFigureIndex = 0;

// Local Media Blob Store & Folder Collapse State
const localBlobStore = new Map();
const folderCollapseState = new Set();

// Pan & Zoom State
let imgZoom = 1.0;
let imgRotation = 0;
let imgPanX = 0;
let imgPanY = 0;
let isPanning = false;
let startPanX = 0;
let startPanY = 0;

function updateImageTransform() {
  if (lightboxImg && lightboxImg.offsetParent !== null) {
    lightboxImg.style.transform = `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom}) rotate(${imgRotation}deg)`;
  }

  const tblViewport = document.getElementById('lb-table-viewport');
  if (tblViewport && tblViewport.offsetParent !== null) {
    const tblElem = tblViewport.querySelector('table');
    if (tblElem) {
      tblElem.style.transformOrigin = 'center top';
      tblElem.style.transform = `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom})`;
      tblElem.style.transition = 'transform 0.1s ease-out';
    }
  }

  const standTableContent = document.getElementById('table-lightbox-content');
  if (standTableContent && standTableContent.offsetParent !== null) {
    const tblElem = standTableContent.querySelector('table');
    if (tblElem) {
      tblElem.style.transformOrigin = 'center top';
      tblElem.style.transform = `translate(${imgPanX}px, ${imgPanY}px) scale(${imgZoom})`;
      tblElem.style.transition = 'transform 0.1s ease-out';
    }
  }
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

// Global Folder State
let folders = ['Uncategorized'];
let activeFolderName = 'Uncategorized';
let API_BASE_URL = '';

function saveFoldersToStorage() {
  try {
    localStorage.setItem('medical_library_folders', JSON.stringify(folders));
  } catch (e) {}
}

function loadFoldersFromStorage() {
  const saved = localStorage.getItem('medical_library_folders');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        parsed.forEach(f => {
          if (f && typeof f === 'string' && !f.includes('${') && !folders.includes(f)) {
            folders.push(f);
          }
        });
      }
    } catch (e) {}
  }
}

async function handleCreateFolder() {
  const folderName = prompt('Enter new folder name:');
  if (!folderName || !folderName.trim()) return;
  const cleanName = folderName.trim();
  if (!folders.includes(cleanName)) {
    folders.push(cleanName);
    activeFolderName = cleanName;
    saveFoldersToStorage();
    if (API_BASE_URL) {
      try {
        await fetch(`${API_BASE_URL}/api/create-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderName: cleanName })
        });
      } catch (e) {}
    }
    renderSidebar();
  } else {
    activeFolderName = cleanName;
    renderSidebar();
  }
}

async function handleRenameFolder(oldName) {
  if (oldName === 'Uncategorized') {
    alert('The Uncategorized folder cannot be renamed.');
    return;
  }
  const newName = prompt(`Rename folder "${oldName}" to:`, oldName);
  if (!newName || !newName.trim() || newName.trim() === oldName) return;
  const cleanNew = newName.trim();

  const idx = folders.indexOf(oldName);
  if (idx >= 0) folders[idx] = cleanNew;
  if (activeFolderName === oldName) activeFolderName = cleanNew;

  articles.forEach(a => {
    if (a.folderName === oldName) a.folderName = cleanNew;
  });

  if (API_BASE_URL) {
    try {
      await fetch(`${API_BASE_URL}/api/rename-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldName, newName: cleanNew })
      });
    } catch (e) {}
  }

  saveFoldersToStorage();
  saveArticles();
  renderSidebar();
}

async function handleDeleteFolder(folderName) {
  if (folderName === 'Uncategorized') {
    alert('The Uncategorized folder cannot be deleted.');
    return;
  }
  const folderArticles = articles.filter(a => (a.folderName || 'Uncategorized') === folderName);
  const count = folderArticles.length;

  if (confirm(`Are you sure you want to delete folder "${folderName}" and all ${count} article(s) inside it?`)) {
    // Delete articles from IndexedDB
    for (const art of folderArticles) {
      try { await dbDelete(art.id); } catch (e) {}
    }

    // Remove from articles memory array & folders array
    articles = articles.filter(a => (a.folderName || 'Uncategorized') !== folderName);
    folders = folders.filter(f => f !== folderName);
    if (activeFolderName === folderName) activeFolderName = 'Uncategorized';

    if (API_BASE_URL) {
      try {
        await fetch(`${API_BASE_URL}/api/delete-folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ folderName })
        });
      } catch (e) {}
    }

    saveFoldersToStorage();

    if (activeArticleId && !articles.some(a => a.id === activeArticleId)) {
      activeArticleId = articles.length > 0 ? articles[0].id : null;
    }

    await saveArticles();
    await syncLibraryToBackend();
    renderSidebar();
    if (activeArticleId) {
      displayArticle(activeArticleId);
    } else {
      welcomeState.classList.remove('hidden');
      articleContent.classList.add('hidden');
    }
  }
}

// Custom Context Menu Logic
function hideContextMenu() {
  const ctx = document.getElementById('app-context-menu');
  if (ctx) ctx.classList.add('hidden');
}

function positionContextMenu(x, y) {
  const ctx = document.getElementById('app-context-menu');
  if (!ctx) return;
  ctx.style.left = `${x}px`;
  ctx.style.top = `${y}px`;
  ctx.classList.remove('hidden');

  const rect = ctx.getBoundingClientRect();
  if (rect.right > window.innerWidth) {
    ctx.style.left = `${window.innerWidth - rect.width - 10}px`;
  }
  if (rect.bottom > window.innerHeight) {
    ctx.style.top = `${window.innerHeight - rect.height - 10}px`;
  }
}

function showArticleContextMenu(x, y, article) {
  const ctx = document.getElementById('app-context-menu');
  if (!ctx) return;

  const editSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
  const folderSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  const copySvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>`;
  const trashSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;

  const subItems = folders.map(f => `
    <div class="context-menu-item move-to-f-item" data-folder="${f}">
      ${folderSvg} <span>${f}</span> ${f === (article.folderName || 'Uncategorized') ? '<span style="color:#2563eb; font-weight:bold; margin-left:auto;">✓</span>' : ''}
    </div>
  `).join('');

  ctx.innerHTML = `
    <div class="context-menu-item ctx-rename-art">${editSvg} <span>Rename Article</span></div>
    <div class="context-menu-submenu">
      <div class="context-menu-item">${folderSvg} <span>Move to Folder ▸</span></div>
      <div class="context-submenu-list">${subItems}</div>
    </div>
    <div class="context-menu-item ctx-dup-art">${copySvg} <span>Duplicate Article</span></div>
    <div class="context-menu-divider"></div>
    <div class="context-menu-item danger ctx-del-art">${trashSvg} <span>Delete Article</span></div>
  `;

  const renameBtn = ctx.querySelector('.ctx-rename-art');
  if (renameBtn) {
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      hideContextMenu();
      const newTitle = prompt('Rename article:', article.title);
      if (newTitle && newTitle.trim()) {
        article.title = newTitle.trim();
        saveArticles(article);
        renderSidebar();
        if (activeArticleId === article.id) displayArticle(article.id);
      }
    };
  }

  const dupBtn = ctx.querySelector('.ctx-dup-art');
  if (dupBtn) {
    dupBtn.onclick = (e) => {
      e.stopPropagation();
      hideContextMenu();
      const dup = {
        ...article,
        id: 'art-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
        title: article.title + ' (Copy)'
      };
      addArticle(dup);
    };
  }

  const delBtn = ctx.querySelector('.ctx-del-art');
  if (delBtn) {
    delBtn.onclick = (e) => {
      e.stopPropagation();
      hideContextMenu();
      deleteArticle(article.id);
    };
  }

  ctx.querySelectorAll('.move-to-f-item').forEach(item => {
    item.onclick = (e) => {
      e.stopPropagation();
      hideContextMenu();
      const targetF = item.dataset.folder;
      article.folderName = targetF;
      saveArticles(article);
      renderSidebar();
    };
  });

  positionContextMenu(x, y);
}

function showFolderContextMenu(x, y, folderName) {
  const ctx = document.getElementById('app-context-menu');
  if (!ctx) return;

  const editSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
  const addSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>`;
  const trashSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;

  ctx.innerHTML = `
    <div class="context-menu-item ctx-new-folder">${addSvg} <span>New Folder</span></div>
    ${folderName !== 'Uncategorized' ? `
      <div class="context-menu-item ctx-rename-folder">${editSvg} <span>Rename Folder</span></div>
      <div class="context-menu-divider"></div>
      <div class="context-menu-item danger ctx-del-folder">${trashSvg} <span>Delete Folder</span></div>
    ` : ''}
  `;

  const newBtn = ctx.querySelector('.ctx-new-folder');
  if (newBtn) {
    newBtn.onclick = (e) => {
      e.stopPropagation();
      hideContextMenu();
      handleCreateFolder();
    };
  }

  const renBtn = ctx.querySelector('.ctx-rename-folder');
  if (renBtn) {
    renBtn.onclick = (e) => {
      e.stopPropagation();
      hideContextMenu();
      handleRenameFolder(folderName);
    };
  }

  const delBtn = ctx.querySelector('.ctx-del-folder');
  if (delBtn) {
    delBtn.onclick = (e) => {
      e.stopPropagation();
      hideContextMenu();
      handleDeleteFolder(folderName);
    };
  }

  positionContextMenu(x, y);
}

// Global Context Menu Dismiss
document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideContextMenu();
});

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
  setupTextHighlighter();
  renderSidebar();

  if (articles.length > 0) {
    displayArticle(articles[0].id);
  }
}

let activeFilterTab = 'all'; // 'all', 'fetched', 'pending'

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
    loadFoldersFromStorage();
    // Filter out any obsolete sample/test template articles if they exist in cache
    articles = articles.filter(a => a.id !== 'test-1' && a.id !== 'art-sample-1' && a.id !== 'art-sample-2' && a.title !== 'Acute Coronary Syndrome');

    // If IndexedDB is empty, seed from default library_data/library.json catalog
    if (articles.length === 0) {
      try {
        const resp = await fetch('library_data/library.json');
        if (resp.ok) {
          const libData = await resp.json();
          if (libData.folders && Array.isArray(libData.folders)) {
            folders = [...libData.folders];
          }
          if (libData.articles && Array.isArray(libData.articles)) {
            for (const art of libData.articles) {
              art.fetched = art.fetched || false;
              articles.push(art);
              await dbPut(art);
            }
          }
        }
      } catch (e) {
        console.warn('[Coursology] Could not load default library.json:', e);
      }
    }

    // Sort newest first or by master ID
    articles.sort((a, b) => (b.id > a.id ? 1 : -1));
  } catch (e) {
    console.error('[Coursology] Failed to load articles from IndexedDB:', e);
    articles = [];
  }
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
  const createFolderBtn = document.getElementById('create-folder-btn');
  if (createFolderBtn) createFolderBtn.addEventListener('click', handleCreateFolder);

  if (pasteBtn) pasteBtn.addEventListener('click', () => handleClipboardPaste());
  if (welcomePasteBtn) welcomePasteBtn.addEventListener('click', () => handleClipboardPaste());

  const exportFolderBtn = document.getElementById('export-folder-btn');
  const importZipInput = document.getElementById('import-zip-input');

  if (fileInput) fileInput.addEventListener('change', handleFileInput);
  if (importJsonInput) importJsonInput.addEventListener('change', handleJsonImport);
  if (importZipInput) importZipInput.addEventListener('change', handleImportZipPackage);
  if (searchInput) searchInput.addEventListener('input', renderSidebar);
  if (clearAllBtn) clearAllBtn.addEventListener('click', handleClearAll);
  if (exportAllBtn) exportAllBtn.addEventListener('click', handleExportBackup);
  if (exportFolderBtn) exportFolderBtn.addEventListener('click', handleExportFolderPackage);



  // Site Navigation Tree Modal Handlers
  const importTreeBtn = document.getElementById('import-tree-btn');
  const treeModal = document.getElementById('tree-import-modal');
  const closeTreeModalBtn = document.getElementById('close-tree-modal-btn');
  const cancelTreeModalBtn = document.getElementById('cancel-tree-modal-btn');
  const submitTreeModalBtn = document.getElementById('submit-tree-modal-btn');
  const treeHtmlInput = document.getElementById('tree-html-input');

  if (importTreeBtn && treeModal) {
    importTreeBtn.addEventListener('click', () => {
      treeModal.classList.remove('hidden');
      if (treeHtmlInput) treeHtmlInput.focus();
    });
  }

  const hideTreeModal = () => {
    if (treeModal) treeModal.classList.add('hidden');
    if (treeHtmlInput) treeHtmlInput.value = '';
  };

  if (closeTreeModalBtn) closeTreeModalBtn.addEventListener('click', hideTreeModal);
  if (cancelTreeModalBtn) cancelTreeModalBtn.addEventListener('click', hideTreeModal);
  if (submitTreeModalBtn) {
    submitTreeModalBtn.addEventListener('click', () => {
      const val = treeHtmlInput ? treeHtmlInput.value : '';
      if (!val || !val.trim()) {
        alert('Please paste an HTML DOM snippet or JSON tree first.');
        return;
      }
      parseAndImportHtmlTree(val);
      hideTreeModal();
    });
  }

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

function normalizeTitle(t) {
  if (!t) return '';
  return t.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function parseAndImportHtmlTree(rawInput) {
  if (!rawInput || !rawInput.trim()) return;

  let addedCount = 0;
  let folderCount = 0;

  // 1. Try direct or embedded JSON first
  let jsonData = null;
  try {
    jsonData = JSON.parse(rawInput);
  } catch (e) {
    const jsonMatch = rawInput.match(/\{\s*"folders"[\s\S]*"articles"[\s\S]*\}/);
    if (jsonMatch) {
      try { jsonData = JSON.parse(jsonMatch[0]); } catch (err) {}
    }
  }

  if (jsonData && (jsonData.folders || jsonData.articles)) {
    if (Array.isArray(jsonData.folders)) {
      jsonData.folders.forEach(f => {
        const fname = typeof f === 'string' ? f : (f.name || f.folderName);
        if (fname && !folders.includes(fname)) {
          folders.push(fname);
          folderCount++;
        }
      });
    }
    if (Array.isArray(jsonData.articles)) {
      jsonData.articles.forEach(art => {
        const title = typeof art === 'string' ? art : art.title;
        const folder = art.folderName || 'Uncategorized';
        if (title && !articles.some(a => normalizeTitle(a.title) === normalizeTitle(title))) {
          const masterArt = {
            id: 'master-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
            title: title.trim(),
            folderName: folder,
            fetched: false,
            markdown: null
          };
          articles.push(masterArt);
          dbPut(masterArt);
          addedCount++;
        }
      });
    }
    saveArticles();
    renderSidebar();
    alert(`Imported Tree: ${folderCount} new folder(s), ${addedCount} pending article(s) added!`);
    return;
  }

  // 2. Try raw Console Log text (lines containing 📁 Folder: and 📄 Article:)
  if (rawInput.includes('📁 Folder') || rawInput.includes('📄 Article')) {
    let currentF = 'Uncategorized';
    const lines = rawInput.split('\n');
    lines.forEach(line => {
      const folderMatch = line.match(/📁\s*Folder:\s*"([^"]+)"/i);
      if (folderMatch && folderMatch[1]) {
        currentF = folderMatch[1].trim();
        if (!folders.includes(currentF)) {
          folders.push(currentF);
          folderCount++;
        }
      }

      const articleMatch = line.match(/📄\s*Article:\s*"([^"]+)"\s*(?:->\s*\[([^\]]+)\])?/i);
      if (articleMatch && articleMatch[1]) {
        const title = articleMatch[1].trim();
        const fName = articleMatch[2] ? articleMatch[2].trim() : currentF;
        const norm = normalizeTitle(title);
        if (norm && !articles.some(a => normalizeTitle(a.title) === norm)) {
          const masterArt = {
            id: 'master-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
            title: title,
            folderName: fName,
            fetched: false,
            markdown: null
          };
          articles.push(masterArt);
          dbPut(masterArt);
          addedCount++;
        }
      }
    });

    if (addedCount > 0 || folderCount > 0) {
      saveArticles();
      renderSidebar();
      alert(`Imported Console Logs: ${folderCount} new folder(s), ${addedCount} pending article(s) added!`);
      return;
    }
  }

  // Parse HTML DOM string
  const parser = new DOMParser();
  const doc = parser.parseFromString(rawInput, 'text/html');

  let currentFolder = 'Uncategorized';
  
  // Find all buttons or row elements in tree
  const rows = Array.from(doc.body.querySelectorAll('button, a, div[class*="whitespace-nowrap"], div[class*="flex flex-row"]'));
  rows.forEach(el => {
    const span = el.querySelector('span') || el;
    const text = span.innerText ? span.innerText.replace(/\u00a0/g, ' ').trim() : '';
    if (!text || text.length > 120 || text.includes('\n')) return;

    const html = el.outerHTML ? el.outerHTML.toLowerCase() : '';
    const svg = el.querySelector('svg');
    const dataIcon = svg ? (svg.getAttribute('data-icon') || '') : '';

    const isFolder = dataIcon.includes('folder') || html.includes('fa-folder') || (html.includes('folder') && !html.includes('newspaper'));
    const isArticle = dataIcon.includes('newspaper') || html.includes('fa-newspaper') || html.includes('newspaper');

    if (isFolder && text) {
      currentFolder = text;
      if (!folders.includes(text)) {
        folders.push(text);
        folderCount++;
      }
    } else if (isArticle && text) {
      const norm = normalizeTitle(text);
      if (norm && !articles.some(a => normalizeTitle(a.title) === norm)) {
        const masterArt = {
          id: 'master-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
          title: text,
          folderName: currentFolder,
          fetched: false,
          markdown: null
        };
        articles.push(masterArt);
        dbPut(masterArt);
        addedCount++;
      }
    }
  });

  // Fallback if no specific icons found: extract clickable buttons/links
  if (addedCount === 0 && folderCount === 0) {
    const buttons = doc.querySelectorAll('button, a, div.whitespace-nowrap');
    buttons.forEach(btn => {
      const text = btn.innerText ? btn.innerText.trim() : '';
      if (!text || text.length > 80 || text.includes('\n')) return;

      const norm = normalizeTitle(text);
      if (norm && !articles.some(a => normalizeTitle(a.title) === norm)) {
        const masterArt = {
          id: 'master-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
          title: text,
          folderName: activeFolderName || 'Uncategorized',
          fetched: false,
          markdown: null
        };
        articles.push(masterArt);
        dbPut(masterArt);
        addedCount++;
      }
    });
  }

  saveArticles();
  renderSidebar();
  alert(`Imported Site Tree: ${folderCount} new folder(s), ${addedCount} pending article(s) added!`);
}

// Handle Clipboard Paste
async function handleClipboardPaste(targetFolder = null, targetArticleId = null) {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) {
      const manualText = prompt('Clipboard is empty! Paste your copied Markdown text here:');
      if (manualText) await parseAndAddMarkdown(manualText, targetFolder, targetArticleId);
      return;
    }

    await parseAndAddMarkdown(text, targetFolder, targetArticleId);
  } catch (err) {
    const manualText = prompt('Paste your copied Markdown text here:');
    if (manualText) {
      await parseAndAddMarkdown(manualText, targetFolder, targetArticleId);
    }
  }
}

// Parse Markdown frontmatter & clean body
async function parseAndAddMarkdown(mdText, targetFolder = null, targetArticleId = null) {
  let title = 'Medical Article';
  let date = new Date().toLocaleDateString();

  const titleMatch = mdText.match(/title:\s*"([^"]+)"/);
  if (titleMatch && titleMatch[1] && titleMatch[1].toLowerCase() !== 'medical library') {
    title = titleMatch[1].trim();
  } else {
    const h1Match = mdText.match(/^#\s+(.+)$/m);
    if (h1Match && h1Match[1]) {
      title = h1Match[1].trim();
    }
  }

  let cleanMarkdown = mdText.replace(/^---[\s\S]*?---\s*/, '');
  const optimizedMarkdown = await optimizeMarkdownImages(cleanMarkdown);

  let targetArticle = null;
  const effectiveFolder = targetFolder || activeFolderName || 'Uncategorized';
  const norm = normalizeTitle(title);

  if (targetArticleId) {
    targetArticle = articles.find(a => a.id === targetArticleId);
  } else {
    // Only match an existing article IF it is inside the target folder
    targetArticle = articles.find(a => (a.folderName || 'Uncategorized') === effectiveFolder && normalizeTitle(a.title) === norm);
  }

  if (targetArticle) {
    targetArticle.fetched = true;
    targetArticle.markdown = optimizedMarkdown;
    targetArticle.extractedAt = date;
    targetArticle.folderName = effectiveFolder;
    await saveArticles(targetArticle);
    displayArticle(targetArticle.id);
    alert(`✓ Marked "${targetArticle.title}" as fetched in folder "${targetArticle.folderName}"!`);
  } else {
    const newArt = {
      id: 'art-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      title: title,
      folderName: effectiveFolder,
      fetched: true,
      extractedAt: date,
      markdown: optimizedMarkdown
    };
    articles.unshift(newArt);
    await saveArticles(newArt);
    displayArticle(newArt.id);
    alert(`✓ Added new article "${title}" to folder "${newArt.folderName}"!`);
  }

  renderSidebar();
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
  if (!articleData.folderName) {
    articleData.folderName = activeFolderName || 'Uncategorized';
  }
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
  renderSidebar();
  displayArticle(articleData.id);
}

// Render Clean Flat Article List & Expandable/Collapsible Active Article TOC
function createArticleListItem(article) {
  const li = document.createElement('li');
  const isActive = article.id === activeArticleId;
  const isFetched = article.fetched !== false && !!article.markdown;

  li.className = (isActive ? 'active' : '') + (!isFetched ? ' pending-item' : '');
  if (isActive) {
    li.className += (activeTocCollapsed ? ' toc-collapsed' : '');
  }

  // HTML5 Drag and Drop support on articles
  li.setAttribute('draggable', 'true');
  li.ondragstart = (e) => {
    e.dataTransfer.setData('text/plain', article.id);
    e.dataTransfer.effectAllowed = 'move';
    li.classList.add('dragging');
  };
  li.ondragend = () => {
    li.classList.remove('dragging');
  };

  // Right Click Context Menu on Article
  li.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showArticleContextMenu(e.clientX, e.clientY, article);
  };

  const rowDiv = document.createElement('div');
  rowDiv.className = 'article-row-item' + (!isFetched ? ' pending-item' : '');

  const titleWrapper = document.createElement('div');
  titleWrapper.className = 'article-title-wrapper';

  const newspaperSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor" style="width:16px; height:16px; flex-shrink:0; color:#334155;"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>`;
  const chevronSvg = `<svg class="toc-toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>`;
  
  if (isActive && isFetched) {
    titleWrapper.innerHTML = `${newspaperSvg}${chevronSvg}<span class="article-title-text">${article.title}</span>`;
  } else {
    titleWrapper.innerHTML = `${newspaperSvg}<span class="article-title-text">${article.title}</span>`;
  }

  const rightBox = document.createElement('div');
  rightBox.style.display = 'flex';
  rightBox.style.alignItems = 'center';
  rightBox.style.gap = '6px';

  if (!isFetched) {
    const quickPasteBtn = document.createElement('button');
    quickPasteBtn.className = 'quick-paste-btn';
    quickPasteBtn.innerText = '+ Paste MD';
    quickPasteBtn.title = `Paste MD directly into "${article.title}"`;
    quickPasteBtn.onclick = (e) => {
      e.stopPropagation();
      handleClipboardPaste(article.folderName, article.id);
    };
    rightBox.appendChild(quickPasteBtn);
  }

  const bookmarkIcon = document.createElement('span');
  bookmarkIcon.style.display = 'flex';
  bookmarkIcon.style.alignItems = 'center';
  bookmarkIcon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.8" style="width:16px; height:16px; display:block; cursor:pointer;"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
  bookmarkIcon.title = 'Bookmark article';
  rightBox.appendChild(bookmarkIcon);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'delete-item';
  deleteBtn.innerHTML = '&times;';
  deleteBtn.title = 'Delete article';
  deleteBtn.onclick = (e) => {
    e.stopPropagation();
    deleteArticle(article.id);
  };
  rightBox.appendChild(deleteBtn);

  rowDiv.appendChild(titleWrapper);
  rowDiv.appendChild(rightBox);
  li.appendChild(rowDiv);

  if (isActive && isFetched && currentArticleToc && currentArticleToc.length > 0) {
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

  return li;
}

// Render Clean Sidebar Folder List & Article Tree
function renderSidebar() {
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  articleFlatList.innerHTML = '';

  let filtered = articles.filter(a => 
    a.title.toLowerCase().includes(query) || 
    (a.markdown && a.markdown.toLowerCase().includes(query)) ||
    (a.folderName && a.folderName.toLowerCase().includes(query))
  );

  if (activeFilterTab === 'fetched') {
    filtered = filtered.filter(a => a.fetched !== false && !!a.markdown);
  } else if (activeFilterTab === 'pending') {
    filtered = filtered.filter(a => a.fetched === false || !a.markdown);
  }

  const totalArticles = articles.length;
  const fetchedArticles = articles.filter(a => a.fetched !== false && !!a.markdown).length;

  if (articleCount) {
    articleCount.innerText = `${fetchedArticles} / ${totalArticles} Fetched`;
  }
  const progressFill = document.getElementById('progress-bar-fill');
  if (progressFill) {
    const pct = totalArticles > 0 ? Math.round((fetchedArticles / totalArticles) * 100) : 0;
    progressFill.style.width = `${pct}%`;
  }

  // Sanitize folders and articles from any template literal impurities
  folders = folders.filter(f => f && !f.includes('${'));
  articles = articles.filter(a => a && a.title && !a.title.includes('${') && !(a.folderName || '').includes('${'));

  // Ensure all article folder names exist in `folders` list
  filtered.forEach(art => {
    const fn = art.folderName || 'Uncategorized';
    if (fn && !fn.includes('${') && !folders.includes(fn)) folders.push(fn);
  });

  if (articles.length === 0) {
    welcomeState.classList.remove('hidden');
    articleContent.classList.add('hidden');
    if (mediaSidebar) mediaSidebar.classList.add('hidden');
    const toggleRightBtn = document.getElementById('toggle-right-sidebar-btn');
    if (toggleRightBtn) toggleRightBtn.classList.add('hidden');
  }

  articleFlatList.innerHTML = '';

  if (folders.length === 0) {
    articleFlatList.innerHTML = `<div style="font-size:0.85rem; color:#94a3b8; text-align:center; padding:16px;">No folders found</div>`;
    return;
  }

  const folderSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="#0284c7" style="width:18px; height:18px; flex-shrink:0;"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  const editSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor" style="width:14px; height:14px;"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
  const trashSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor" style="width:14px; height:14px;"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
  const chevronSvg = `<svg class="toc-toggle-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="width:14px; height:14px;"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

  folders.forEach(folderName => {
    const groupArticles = filtered.filter(a => (a.folderName || 'Uncategorized') === folderName);
    if ((query || activeFilterTab !== 'all') && groupArticles.length === 0) return;

    const allFolderArticles = articles.filter(a => (a.folderName || 'Uncategorized') === folderName);
    const fetchedInFolder = allFolderArticles.filter(a => a.fetched !== false && !!a.markdown).length;
    const totalInFolder = allFolderArticles.length;

    const isCollapsed = folderCollapseState.has(folderName);
    const isActiveTarget = (activeFolderName === folderName);

    const folderCard = document.createElement('div');
    folderCard.className = 'sidebar-folder-card' + (isCollapsed ? ' collapsed' : '') + (isActiveTarget ? ' active-target-folder' : '');

    // Folder Drag and Drop Target Handlers
    folderCard.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      folderCard.classList.add('drag-over');
    };

    folderCard.ondragleave = () => {
      folderCard.classList.remove('drag-over');
    };

    folderCard.ondrop = async (e) => {
      e.preventDefault();
      folderCard.classList.remove('drag-over');
      const articleId = e.dataTransfer.getData('text/plain');
      if (!articleId) return;

      const targetArt = articles.find(a => a.id === articleId);
      if (targetArt && (targetArt.folderName || 'Uncategorized') !== folderName) {
        targetArt.folderName = folderName;
        await saveArticles(targetArt);
        renderSidebar();
      }
    };

    const folderHeader = document.createElement('div');
    folderHeader.className = 'sidebar-folder-header';
    folderHeader.innerHTML = `
      <div class="sidebar-folder-title" style="display:flex; align-items:center; gap:8px;">
        ${folderSvg}
        <span style="font-weight:600; font-size:0.92rem; color:#0284c7;">${folderName}</span>
      </div>
      <div class="folder-actions" style="display:flex; align-items:center; gap:6px;">
        <button class="folder-paste-btn" title="Paste MD into this folder">+ Paste MD</button>
        ${folderName !== 'Uncategorized' ? `
          <button class="folder-action-btn rename-f-btn" title="Rename Folder" style="background:none; border:none; padding:3px; cursor:pointer; color:#64748b; display:flex;">${editSvg}</button>
          <button class="folder-action-btn delete-f-btn" title="Delete Folder" style="background:none; border:none; padding:3px; cursor:pointer; color:#ef4444; display:flex;">${trashSvg}</button>
        ` : ''}
        <span style="display:flex; align-items:center; color:#94a3b8; transition:transform 0.2s ease; transform: ${isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'};">${chevronSvg}</span>
      </div>
    `;

    // Folder Context Menu
    folderHeader.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showFolderContextMenu(e.clientX, e.clientY, folderName);
    };

    const pasteInFolderBtn = folderHeader.querySelector('.folder-paste-btn');
    if (pasteInFolderBtn) {
      pasteInFolderBtn.onclick = (e) => {
        e.stopPropagation();
        handleClipboardPaste(folderName);
      };
    }

    const renameBtn = folderHeader.querySelector('.rename-f-btn');
    if (renameBtn) {
      renameBtn.onclick = (e) => { e.stopPropagation(); handleRenameFolder(folderName); };
    }

    const deleteBtn = folderHeader.querySelector('.delete-f-btn');
    if (deleteBtn) {
      deleteBtn.onclick = (e) => { e.stopPropagation(); handleDeleteFolder(folderName); };
    }

    folderHeader.onclick = () => {
      activeFolderName = folderName;
      if (folderCollapseState.has(folderName)) {
        folderCollapseState.delete(folderName);
      } else {
        folderCollapseState.add(folderName);
      }
      renderSidebar();
    };

    const folderUl = document.createElement('ul');
    folderUl.className = 'folder-article-list' + (isCollapsed ? ' hidden' : '');

    groupArticles.forEach(art => {
      folderUl.appendChild(createArticleListItem(art));
    });

    folderCard.appendChild(folderHeader);
    folderCard.appendChild(folderUl);
    articleFlatList.appendChild(folderCard);
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

  const isFetched = article.fetched !== false && !!article.markdown;
  articleDate.innerText = isFetched ? `Extracted: ${article.extractedAt || 'Unknown'}` : `Status: Pending Import`;

  if (!isFetched) {
    articleBody.innerHTML = `
      <div style="text-align: center; padding: 60px 20px; background: #ffffff; border: 2px dashed #cbd5e1; border-radius: 12px; margin-top: 24px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02);">
        <div style="font-size: 3.5rem; margin-bottom: 14px;">📄</div>
        <h2 style="font-size: 1.4rem; color: #0f172a; margin-bottom: 10px; font-weight: 700;">Article Pending Import</h2>
        <p style="color: #64748b; font-size: 0.95rem; max-width: 520px; margin: 0 auto 24px auto; line-height: 1.5;">
          This article is indexed in your <strong>${article.folderName || 'Uncategorized'}</strong> medical folder, but its content has not been fetched yet.
        </p>
        <button id="pending-import-paste-btn" class="btn primary-btn" style="padding: 12px 24px; font-size: 1rem; background: #2563eb; border-color: #1d4ed8; font-weight: 600;">
          + Paste Markdown for "${article.title}"
        </button>
      </div>
    `;

    const pendingBtn = document.getElementById('pending-import-paste-btn');
    if (pendingBtn) {
      pendingBtn.onclick = () => handleClipboardPaste(article.folderName, article.id);
    }

    if (mediaSidebar) mediaSidebar.classList.add('hidden');
    const toggleRightBtn = document.getElementById('toggle-right-sidebar-btn');
    if (toggleRightBtn) toggleRightBtn.classList.add('hidden');
    return;
  }

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

  // Resolve localBlobStore URLs and attach automatic CDN fallback handler
  articleBody.querySelectorAll('img, video').forEach(el => {
    const src = el.getAttribute('src');
    if (src) {
      const baseName = src.replace(/^media\//, '');
      if (localBlobStore.has(src)) {
        el.src = localBlobStore.get(src);
      } else if (localBlobStore.has(baseName)) {
        el.src = localBlobStore.get(baseName);
      }
    }
    el.onerror = function() {
      const cdnBackup = this.getAttribute('data-cdn-src');
      if (cdnBackup && this.src !== cdnBackup) {
        console.warn('Local hard-drive asset missing/deleted. Falling back to CDN link:', cdnBackup);
        this.src = cdnBackup;
      }
    };
  });

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

  // Add chevron arrow & collapsible-heading class ONLY to top-level main section headings
  headingElements.forEach((heading, idx) => {
    heading.id = `sec-heading-${idx + 1}`;
    if (topHeadings.includes(heading)) {
      heading.classList.add('collapsible-heading', 'level-main');
      if (!heading.querySelector('.heading-arrow')) {
        const arrowSpan = document.createElement('span');
        arrowSpan.className = 'heading-arrow';
        arrowSpan.innerText = '›';
        heading.prepend(arrowSpan);
      }
    } else {
      heading.classList.add('article-subheading', 'level-sub');
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

    // Click H1 Main Section: Toggle main section body (expands/collapses all content & subheadings within it)
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

    // Process H2 subheadings inside this mainSectionWrapper for sidebar TOC
    const childH2s = Array.from(mainSectionWrapper.querySelectorAll('h2, h3, h4'));
    const subTocItems = [];

    childH2s.forEach((h2Heading) => {
      const h2Id = h2Heading.id;
      const h2Text = h2Heading.innerText.replace(/^›\s*/, '').trim();

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
  const videoPlayIcon = `<svg viewBox="0 0 24 24" fill="currentColor" class="media-thumb-icon" style="color:#2563eb;width:36px;height:36px;"><path d="M8 5v14l11-7z"/></svg>`;

  const figuresList = currentFigureList.filter(i => i.isImage);
  const videosList = currentFigureList.filter(i => i.isVideo);
  const tablesList = currentFigureList.filter(i => i.isTable);

  // Render Figures & Videos Section
  if (figuresList.length === 0 && videosList.length === 0) {
    mediaFiguresGrid.innerHTML = `<div class="empty-media-msg" style="font-size:0.85rem; color:#94a3b8; padding:4px 0; font-style:italic; font-weight:500;">No figures</div>`;
  } else {
    figuresList.forEach((fig) => {
      const labelText = (fig.alt || `figure ${fig.figNum || 1}`).replace(/^[\(\[\s]+|[\)\]\s]+$/g, '');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'media-thumb-btn';
      btn.innerHTML = `
        <div class="media-thumb-box">
          <img src="${fig.src}" alt="${labelText}" loading="lazy" class="media-thumb-img">
        </div>
        <p class="media-thumb-label">${labelText}</p>
      `;
      btn.onclick = () => openLightbox(fig.index);
      mediaFiguresGrid.appendChild(btn);
    });

    videosList.forEach((vid) => {
      const labelText = (vid.alt || `video ${vid.videoNum || 1}`).replace(/^[\(\[\s]+|[\)\]\s]+$/g, '');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'media-thumb-btn';
      btn.innerHTML = `
        <div class="media-thumb-box" style="background:#eff6ff;display:flex;align-items:center;justify-content:center;">
          ${videoPlayIcon}
        </div>
        <p class="media-thumb-label">${labelText}</p>
      `;
      btn.onclick = () => openLightbox(vid.index);
      mediaFiguresGrid.appendChild(btn);
    });
  }

  // Render Tables Section
  if (tablesList.length === 0) {
    mediaTablesGrid.innerHTML = `<div class="empty-media-msg" style="font-size:0.85rem; color:#94a3b8; padding:4px 0; font-style:italic; font-weight:500;">No tables</div>`;
  } else {
    tablesList.forEach((tbl) => {
      const labelText = `table ${tbl.tableNum || 1}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'media-thumb-btn';
      btn.innerHTML = `
        <div class="media-thumb-box">
          ${tableSvgIcon}
        </div>
        <p class="media-thumb-label">${labelText}</p>
      `;
      btn.onclick = () => openLightbox(tbl.index);
      mediaTablesGrid.appendChild(btn);
    });
  }

  mediaSidebar.classList.remove('hidden');
  const toggleRightBtn = document.getElementById('toggle-right-sidebar-btn');
  if (toggleRightBtn) toggleRightBtn.classList.remove('hidden');
}

// Setup Lightbox Gallery Items - scans ALL images, videos, and tables in DOM order
function setupLightboxGallery(container, defaultTitle) {
  currentFigureList = [];

  const VIDEO_EXT_RE = /\.(mp4|webm|mov|m3u8|ogg)(\?.*)?$/i;
  const elements = Array.from(container.querySelectorAll('img, video, table'));
  
  let figCounter = 0;
  let videoCounter = 0;
  let tableCounter = 0;

  const hasHtmlTables = container.querySelector('table') !== null;

  elements.forEach((el) => {
    const isTable = el.tagName === 'TABLE';
    const elSrc = el.src || el.getAttribute('src') || '';
    const altText = (el.getAttribute('alt') || el.getAttribute('title') || '').trim();

    // Skip redundant image placeholders representing tables if real HTML tables are present
    if (!isTable && hasHtmlTables && /^(table|tbl)\b/i.test(altText)) {
      return;
    }

    const isVid = !isTable && (el.tagName === 'VIDEO'
                 || el.getAttribute('data-is-video') === 'true'
                 || VIDEO_EXT_RE.test(elSrc));

    let figItem;

    if (isTable) {
      tableCounter++;
      if (!el.id) el.id = `table-${tableCounter}`;
      const caption = el.querySelector('caption')?.innerText?.trim() || `Table ${tableCounter}`;
      figItem = {
        isTable: true,
        isVideo: false,
        isImage: false,
        element: el,
        caption: caption,
        alt: caption,
        tableNum: tableCounter,
        index: currentFigureList.length
      };
    } else if (isVid) {
      videoCounter++;
      const caption = altText || `Video ${videoCounter}: ${defaultTitle}`;
      el.setAttribute('data-exhibit-asset', 'true');
      if (!el.id) el.id = `video-asset-${videoCounter}`;
      figItem = {
        isVideo: true,
        isTable: false,
        isImage: false,
        src: elSrc,
        caption: caption,
        element: el,
        alt: altText,
        videoNum: videoCounter,
        index: currentFigureList.length
      };
    } else {
      figCounter++;
      const caption = altText || `Figure ${figCounter}: ${defaultTitle}`;
      el.setAttribute('data-exhibit-asset', 'true');
      if (!el.id) el.id = `media-asset-${figCounter}`;
      figItem = {
        isImage: true,
        isVideo: false,
        isTable: false,
        src: elSrc,
        caption: caption,
        element: el,
        alt: altText,
        figNum: figCounter,
        index: currentFigureList.length
      };
    }

    currentFigureList.push(figItem);
  });
}

// Convert "(Figure X)" / "(Table X)" text references into sleek Coursology Exhibit Pill Buttons
function processFigureAndTableLinks(container) {
  const figureMap = {};

  // 1. Build map for figure images — with separate counters for videos vs figures
  let figCounter = 0;
  let videoCounter = 0;
  currentFigureList.forEach((item, index) => {
    // Generic index-based keys (fallback)
    const figNum = index + 1;
    figureMap[String(figNum)] = item;

    if (item.isVideo) {
      // Video-specific sequential keys
      videoCounter++;
      figureMap[`video ${videoCounter}`] = item;
      figureMap[`vid ${videoCounter}`] = item;
      figureMap[`video ${figNum}`] = item; // also by absolute index
    } else {
      // Figure/image sequential keys
      figCounter++;
      figureMap[`figure ${figCounter}`] = item;
      figureMap[`fig ${figCounter}`] = item;
      figureMap[`fig. ${figCounter}`] = item;
      figureMap[`image ${figCounter}`] = item;
      figureMap[`img ${figCounter}`] = item;
      figureMap[`img. ${figCounter}`] = item;
      figureMap[`exhibit ${figCounter}`] = item;
      figureMap[`figure ${figNum}`] = item;
      figureMap[`image ${figNum}`] = item;
    }

    if (item.alt) {
      const match = item.alt.match(/(?:Figure|Fig\.?|Table|Tbl\.?|Image|Img\.?|Exhibit|Video|Vid\.?)\s*(\d+[A-Za-z]?)/i);
      if (match) {
        const keyNum = match[1].toLowerCase();
        const isTab = match[0].toLowerCase().startsWith('tab');
        const isVidAlt = match[0].toLowerCase().startsWith('vid');
        const prefixStr = isTab ? 'table ' : isVidAlt ? 'video ' : 'figure ';
        figureMap[`${prefixStr}${keyNum}`] = item;
        figureMap[`image ${keyNum}`] = item;
        figureMap[`img ${keyNum}`] = item;
        figureMap[`img. ${keyNum}`] = item;
        if (isTab) {
          figureMap[`tbl ${keyNum}`] = item;
          figureMap[`tbl. ${keyNum}`] = item;
        } else if (isVidAlt) {
          figureMap[`vid ${keyNum}`] = item;
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
        if (/(?:Figure|Fig\.?|Table|Tbl\.?|Image|Img\.?|Exhibit|Video|Vid\.?)\s*\d+/i.test(node.nodeValue)) {
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

  const figRegex = /(?:\(\(|\(|\[)?\s*\b(Figure|Fig\.?|Table|Tbl\.?|Image|Img\.?|Exhibit|Video|Vid\.?)\s*(\d+[A-Za-z]?)\b\s*(?:\)\)|\)|\])?/gi;

  const cameraIconSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H5V5h14v14zm-5.04-6.71l-2.75 3.54-1.96-2.36L6.5 17h11l-3.54-4.71z"/></svg>`;
  const tableIconSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16c1.1 0 2 .9 2 2v14c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2zm0 4v4h7V7H4zm9 0v4h7V7h-7zm-9 6v4h7v-4H4zm9 0v4h7v-4h-7z"/></svg>`;
  const videoIconSvg = `<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;

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
      const prefixLc = prefix.toLowerCase();
      const isTable = prefixLc.startsWith('tab');
      const isVideo = prefixLc.startsWith('vid');
      const cleanLabel = `${prefix} ${num}`;

      const keyLower = `${prefixLc} ${num.toLowerCase()}`;
      let target = figureMap[keyLower]
        || figureMap[`video ${num.toLowerCase()}`]
        || figureMap[`image ${num.toLowerCase()}`]
        || figureMap[`figure ${num.toLowerCase()}`]
        || figureMap[`fig ${num.toLowerCase()}`]
        || figureMap[`table ${num.toLowerCase()}`]
        || figureMap[`tbl ${num.toLowerCase()}`]
        || figureMap[num.toLowerCase()];

      // Create High-Fidelity Exhibit Button
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = isTable ? 'exhibit-btn table-link' : 'exhibit-btn';
      const btnIcon = isTable ? tableIconSvg : isVideo ? videoIconSvg : cameraIconSvg;
      btn.innerHTML = `<span class="ex-paren">(</span>${btnIcon}<span class="ex-label">${cleanLabel}</span><span class="ex-paren">)</span>`;
      btn.title = `Click to view (${cleanLabel}) popup`;

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

// Open Image in Clean Viewer Tab
function openImageInNewTab(imgUrl) {
  if (!imgUrl) return;
  const newTab = window.open('');
  if (newTab) {
    newTab.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Medical Library - Image View</title>
        <style>
          html, body { margin:0; padding:0; background:#0f172a; height:100%; display:flex; align-items:center; justify-content:center; overflow:auto; }
          img { max-width:98vw; max-height:98vh; object-fit:contain; border-radius:6px; box-shadow:0 20px 30px rgba(0,0,0,0.5); }
        </style>
      </head>
      <body>
        <img src="${imgUrl}" alt="Full Resolution Image" />
      </body>
      </html>
    `);
    newTab.document.close();
  }
}

// Persistent Auto Text Highlighter (Bright Yellow)
function setupTextHighlighter() {
  const articleBody = document.getElementById('article-body');
  if (!articleBody) return;

  articleBody.addEventListener('mouseup', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const selectedText = selection.toString().trim();
    if (!selectedText || selectedText.length < 2) return;

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;

    if (!articleBody.contains(container)) return;

    const mark = document.createElement('mark');
    mark.className = 'yellow-highlight';
    mark.style.backgroundColor = '#fef08a';
    mark.style.color = '#1e293b';
    mark.style.fontWeight = '600';
    mark.style.padding = '1px 4px';
    mark.style.borderRadius = '3px';
    mark.title = 'Click to remove highlight';

    try {
      range.surroundContents(mark);
      selection.removeAllRanges();

      mark.onclick = (e) => {
        e.stopPropagation();
        const text = mark.innerText;
        mark.replaceWith(text);
        saveCurrentArticleHighlights();
      };

      saveCurrentArticleHighlights();
    } catch (e) {
      // Ignore cross-node range wrapping errors gracefully
    }
  });
}

function saveCurrentArticleHighlights() {
  if (!activeArticleId) return;
  const art = articles.find(a => a.id === activeArticleId);
  if (!art) return;

  const articleBody = document.getElementById('article-body');
  if (articleBody) {
    art.html = articleBody.innerHTML;
    saveArticles(art);
  }
}

// Setup Mouse Drag Pan & Scroll Zoom
function setupPanAndZoom() {
  const zoomInBtn = document.getElementById('tool-zoom-in');
  const zoomOutBtn = document.getElementById('tool-zoom-out');
  const zoomResetBtn = document.getElementById('tool-zoom-reset');
  const rotateBtn = document.getElementById('tool-rotate');
  const openTabBtn = document.getElementById('tool-open-tab');

  if (zoomInBtn) zoomInBtn.addEventListener('click', () => { imgZoom += 0.25; updateImageTransform(); });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => { imgZoom = Math.max(0.3, imgZoom - 0.25); updateImageTransform(); });
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', resetImageTransform);
  if (rotateBtn) rotateBtn.addEventListener('click', () => { imgRotation = (imgRotation + 90) % 360; updateImageTransform(); });
  if (openTabBtn) {
    openTabBtn.addEventListener('click', () => {
      const src = lightboxImg ? lightboxImg.src : null;
      if (src) openImageInNewTab(src);
    });
  }

  const viewports = [
    document.getElementById('lightbox-viewport'),
    document.getElementById('lb-table-viewport'),
    document.getElementById('table-lightbox-content')
  ].filter(Boolean);

  viewports.forEach(vp => {
    vp.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        imgZoom += 0.15;
      } else {
        imgZoom = Math.max(0.3, imgZoom - 0.15);
      }
      updateImageTransform();
    }, { passive: false });

    vp.addEventListener('mousedown', (e) => {
      if (e.target.closest('button') || e.target.closest('a')) return;
      isPanning = true;
      document.body.classList.add('dragging-active');
      startPanX = e.clientX - imgPanX;
      startPanY = e.clientY - imgPanY;
    });
  });

  window.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    imgPanX = e.clientX - startPanX;
    imgPanY = e.clientY - startPanY;
    updateImageTransform();
  });

  window.addEventListener('mouseup', () => {
    if (isPanning) {
      isPanning = false;
      document.body.classList.remove('dragging-active');
      if (window.getSelection) {
        window.getSelection().removeAllRanges();
      }
    }
  });
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
  let currentX = 0, currentY = 0;

  const resetPos = () => {
    currentX = 0;
    currentY = 0;
    cardEl.style.transform = 'translate3d(0px, 0px, 0px)';
  };
  cardEl._resetPos = resetPos;

  if (headerEl) {
    headerEl.style.cursor = 'grab';

    const onDragStart = (e) => {
      if (e.target.closest('.win-btn') || e.target.closest('.lb-close-btn') || e.target.closest('.lb-nav-btn')) return;
      if (cardEl.classList.contains('maximized')) return;
      isDragging = true;
      document.body.classList.add('dragging-active');
      headerEl.style.cursor = 'grabbing';
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      startX = clientX - currentX;
      startY = clientY - currentY;
    };

    const onDragMove = (e) => {
      if (!isDragging) return;
      if (e.cancelable) e.preventDefault();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      currentX = clientX - startX;
      currentY = clientY - startY;

      cardEl.style.transform = `translate3d(${currentX}px, ${currentY}px, 0px)`;
    };

    const onDragEnd = () => {
      if (isDragging) {
        isDragging = false;
        document.body.classList.remove('dragging-active');
        if (window.getSelection) {
          window.getSelection().removeAllRanges();
        }
      }
      headerEl.style.cursor = 'grab';
    };

    headerEl.addEventListener('mousedown', onDragStart);
    headerEl.addEventListener('touchstart', onDragStart, { passive: true });

    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('touchmove', onDragMove, { passive: false });

    window.addEventListener('mouseup', onDragEnd);
    window.addEventListener('touchend', onDragEnd);
  }

  if (maxBtnEl) {
    maxBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      cardEl.classList.toggle('maximized');
      if (!cardEl.classList.contains('maximized')) {
        resetPos();
      }
    });
  }

  if (minBtnEl) {
    minBtnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      modalParentEl.classList.add('hidden');
      const windowTitleText = cardEl.querySelector('.window-title-text, .lb-title')?.innerText || defaultTitle;
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

  const container = document.getElementById('rendered-content');
  const allTables = container ? Array.from(container.querySelectorAll('table')) : [];
  const tblIndex = allTables.indexOf(tableElem) + 1;
  const totalTables = allTables.length || 1;
  const countLabel = `Table ${tblIndex > 0 ? tblIndex : 1} of ${totalTables}`;

  if (tableTitle) tableTitle.innerText = captionTitle ? `${countLabel}: ${captionTitle}` : countLabel;
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
function openLightbox(val, captionOverride, isNavigating = false) {
  resetImageTransform();
  const lbCard = document.getElementById('lightbox-window');
  if (!isNavigating && lbCard && lbCard._resetPos) {
    lbCard._resetPos();
  }
  const windowTitleText = document.getElementById('window-title');

  if (typeof val === 'number') {
    if (!currentFigureList || currentFigureList.length === 0) return;
    currentFigureIndex = (val + currentFigureList.length) % currentFigureList.length;
    const item = currentFigureList[currentFigureIndex];

    const imgViewport = document.getElementById('lightbox-viewport');
    const vidViewport = document.getElementById('lb-video-viewport');
    const tblViewport = document.getElementById('lb-table-viewport');
    const lbToolbar = document.getElementById('lb-toolbar');
    const lightboxVid = document.getElementById('lightbox-video');

    // Calculate category totals and positions
    const videosList = currentFigureList.filter(i => i.isVideo);
    const figuresList = currentFigureList.filter(i => i.isImage || (!i.isVideo && !i.isTable));
    const tablesList = currentFigureList.filter(i => i.isTable);

    const rotateBtn = document.getElementById('tool-rotate');

    if (item.isTable) {
      if (imgViewport) imgViewport.classList.add('hidden');
      if (vidViewport) vidViewport.classList.add('hidden');
      if (tblViewport) tblViewport.classList.remove('hidden');
      if (lbToolbar) lbToolbar.classList.remove('hidden');
      if (rotateBtn) rotateBtn.classList.add('hidden');
      if (lightboxVid) lightboxVid.pause();

      if (tblViewport && item.element) {
        const cleanTbl = item.element.cloneNode(true);
        cleanTbl.removeAttribute('id');
        cleanTbl.style.display = 'table';
        cleanTbl.style.width = '100%';
        cleanTbl.style.maxWidth = '100%';
        cleanTbl.style.height = 'auto';
        cleanTbl.querySelectorAll('[style]').forEach(e => {
          e.style.width = ''; e.style.height = ''; e.style.fontSize = '';
        });
        tblViewport.innerHTML = '';
        tblViewport.appendChild(cleanTbl);
      }
    } else if (item.isVideo) {
      if (imgViewport) imgViewport.classList.add('hidden');
      if (tblViewport) tblViewport.classList.add('hidden');
      if (vidViewport) vidViewport.classList.remove('hidden');
      if (lbToolbar) lbToolbar.classList.add('hidden');

      if (lightboxVid) {
        lightboxVid.src = item.src;
        lightboxVid.load();
        lightboxVid.play().catch(() => {});
      }
    } else {
      if (lightboxVid) lightboxVid.pause();
      if (vidViewport) vidViewport.classList.add('hidden');
      if (tblViewport) tblViewport.classList.add('hidden');
      if (imgViewport) imgViewport.classList.remove('hidden');
      if (lbToolbar) lbToolbar.classList.remove('hidden');
      if (rotateBtn) rotateBtn.classList.remove('hidden');
      lightboxImg.src = item.src;
    }

    lightboxCaption.innerText = item.caption || '';

    // Calculate category specific index/total
    let countText = '';
    if (item.isTable) {
      const tIdx = tablesList.indexOf(item) + 1;
      countText = `Table ${tIdx > 0 ? tIdx : 1} of ${tablesList.length}`;
    } else if (item.isVideo) {
      const vIdx = videosList.indexOf(item) + 1;
      countText = `Video ${vIdx > 0 ? vIdx : 1} of ${videosList.length}`;
    } else {
      const fIdx = figuresList.indexOf(item) + 1;
      countText = `Figure ${fIdx > 0 ? fIdx : 1} of ${figuresList.length}`;
    }

    if (lightboxCounter) {
      lightboxCounter.innerText = countText;
    }

    if (windowTitleText) {
      windowTitleText.innerText = item.alt ? `Exhibit: ${item.alt}` : countText;
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
  const lightboxVid = document.getElementById('lightbox-video');
  if (lightboxVid) {
    lightboxVid.pause();
    lightboxVid.src = '';
  }
  lightbox.classList.add('hidden');
}

function showNextFigure(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  if (currentFigureList.length > 0) {
    openLightbox(currentFigureIndex + 1, null, true);
  }
}

function showPrevFigure(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  if (currentFigureList.length > 0) {
    openLightbox(currentFigureIndex - 1, null, true);
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
  if (confirm('Are you sure you want to delete all saved articles and folders?')) {
    articles = [];
    folders = ['Uncategorized'];
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

// Helper to fetch any media URL (CDN, Base64, or local blob) as a binary Blob with multi-stage CORS & Proxy fallbacks
async function fetchMediaAsBlob(url) {
  if (!url) return null;

  // 1. Check localBlobStore first
  if (typeof localBlobStore !== 'undefined') {
    const cleanKey = url.replace(/^media\//, '');
    if (localBlobStore.has(url) || localBlobStore.has(cleanKey)) {
      const blobUrl = localBlobStore.get(url) || localBlobStore.get(cleanKey);
      try {
        const res = await fetch(blobUrl);
        if (res.ok) {
          const blob = await res.blob();
          if (blob && blob.size > 0) return blob;
        }
      } catch (e) {
        console.warn('Failed to fetch from localBlobStore blob URL:', e);
      }
    }
  }

  // 2. Base64 Data URI
  if (url.startsWith('data:')) {
    try {
      const res = await fetch(url);
      return await res.blob();
    } catch (e) {
      console.warn('Failed to convert base64 data URI to blob:', e);
    }
  }

  // 3. Direct Fetch with CORS mode
  try {
    const resp = await fetch(url, { mode: 'cors' });
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob && blob.size > 100) return blob;
    }
  } catch (e) {
    console.warn('Direct CORS fetch failed for:', url, e);
  }

  // 4. Direct Fetch with standard mode
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob && blob.size > 100) return blob;
    }
  } catch (e) {
    console.warn('Direct fetch failed for:', url, e);
  }

  // 5. wsrv.nl Image CDN Proxy (Specialized high-speed CDN image proxy)
  try {
    const proxyUrl = 'https://wsrv.nl/?url=' + encodeURIComponent(url);
    const resp = await fetch(proxyUrl);
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob && blob.size > 100) return blob;
    }
  } catch (e) {
    console.warn('wsrv.nl proxy failed for:', url, e);
  }

  // 6. Google Focus Image Proxy
  try {
    const proxyUrl2 = 'https://images1-focus-opensocial.googleusercontent.com/gadgets/proxy?container=focus&refresh=31536000&url=' + encodeURIComponent(url);
    const resp = await fetch(proxyUrl2);
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob && blob.size > 100) return blob;
    }
  } catch (e) {
    console.warn('Google Focus proxy failed for:', url, e);
  }

  // 7. CodeTabs CORS Proxy
  try {
    const proxyUrl3 = 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(url);
    const resp = await fetch(proxyUrl3);
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob && blob.size > 100) return blob;
    }
  } catch (e) {
    console.warn('CodeTabs CORS proxy failed for:', url, e);
  }

  // 8. AllOrigins CORS Proxy
  try {
    const proxyUrl4 = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
    const resp = await fetch(proxyUrl4);
    if (resp.ok) {
      const blob = await resp.blob();
      if (blob && blob.size > 100) return blob;
    }
  } catch (e) {
    console.warn('AllOrigins CORS proxy failed for:', url, e);
  }

  // 7. Image Canvas Fallback
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    const timeout = setTimeout(() => resolve(null), 6000);

    img.onload = () => {
      clearTimeout(timeout);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width || 800;
        canvas.height = img.naturalHeight || img.height || 600;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => resolve(blob), 'image/png');
      } catch (err) {
        console.warn('Canvas export failed:', err);
        resolve(null);
      }
    };

    img.onerror = () => {
      clearTimeout(timeout);
      resolve(null);
    };

    img.src = url;
  });
}

function getMediaExtension(url, blob) {
  if (blob && blob.type) {
    if (blob.type.includes('png')) return 'png';
    if (blob.type.includes('jpeg')) return 'jpg';
    if (blob.type.includes('webp')) return 'webp';
    if (blob.type.includes('gif')) return 'gif';
    if (blob.type.includes('svg')) return 'svg';
    if (blob.type.includes('mp4')) return 'mp4';
    if (blob.type.includes('webm')) return 'webm';
  }
  if (url.startsWith('data:image/png')) return 'png';
  if (url.startsWith('data:image/jpeg')) return 'jpg';
  if (url.startsWith('data:image/webp')) return 'webp';
  if (url.startsWith('data:image/gif')) return 'gif';
  if (url.startsWith('data:image/svg')) return 'svg';
  if (url.startsWith('data:video/mp4')) return 'mp4';

  const extMatch = url.match(/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|mov)(\?.*)?$/i);
  if (extMatch) return extMatch[1].toLowerCase();

  return 'png';
}

// Export Folder Package (.zip) with Downloaded Hard-Drive Media & CDN Fallback Preservation
async function handleExportFolderPackage() {
  if (articles.length === 0) {
    alert('No articles available to export.');
    return;
  }

  const defaultName = articles[0]?.folderName || 'Medical Articles Pack';
  const folderName = prompt('Enter a name for your export folder package:', defaultName);
  if (!folderName || !folderName.trim()) return;

  const sanitizedFolderName = folderName.trim().replace(/[/\\?%*:|"<>]/g, '_');
  const progressModal = document.getElementById('export-progress-modal');
  const progressText = document.getElementById('export-progress-text');
  const progressBar = document.getElementById('export-progress-bar');

  if (progressModal) progressModal.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '5%';
  if (progressText) progressText.innerText = 'Initializing package exporter...';

  try {
    const zip = typeof JSZip !== 'undefined' ? new JSZip() : null;
    if (!zip) {
      alert('JSZip library failed to load. Please check script inclusion.');
      if (progressModal) progressModal.classList.add('hidden');
      return;
    }

    const mediaFolder = zip.folder('media');
    const mediaUrlMap = new Map(); // cdnUrl -> relative path
    let mediaCounter = 0;

    // Scan all articles ONLY for figure images (skipping all video files)
    const isVideoUrl = (u) => /\.(mp4|webm|mov|avi|mkv|flv|wmv)(\?.*)?$/i.test(u) || (u && u.startsWith('data:video'));
    const mediaUrlsToFetch = new Set();
    articles.forEach(art => {
      const content = (art.markdown || '') + ' ' + (art.html || '');

      // 1. img src
      const imgMatches = content.matchAll(/<img[^>]+src=["']?([^"'\s>]+)["']?/gi);
      for (const m of imgMatches) {
        if (m[1] && !m[1].startsWith('media/') && !isVideoUrl(m[1])) {
          mediaUrlsToFetch.add(m[1]);
        }
      }

      // 2. markdown images ![alt](url)
      const mdImgMatches = content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gi);
      for (const m of mdImgMatches) {
        if (m[1]) {
          const cleanUrl = m[1].split(/\s+/)[0].trim();
          if (cleanUrl && !cleanUrl.startsWith('media/') && !isVideoUrl(cleanUrl)) {
            mediaUrlsToFetch.add(cleanUrl);
          }
        }
      }

      // 3. data-cdn-src attribute
      const cdnMatches = content.matchAll(/data-cdn-src=["']?([^"'\s>]+)["']?/gi);
      for (const m of cdnMatches) {
        if (m[1] && !m[1].startsWith('media/') && !isVideoUrl(m[1])) {
          mediaUrlsToFetch.add(m[1]);
        }
      }
    });

    const totalMedia = mediaUrlsToFetch.size;
    let fetchedCount = 0;

    // Asynchronously fetch CDN & base64 media assets into binary Blobs
    for (const mediaUrl of mediaUrlsToFetch) {
      fetchedCount++;
      const percent = Math.min(85, Math.round((fetchedCount / (totalMedia || 1)) * 80));
      if (progressBar) progressBar.style.width = `${percent}%`;
      if (progressText) progressText.innerText = `Downloading hard-drive media ${fetchedCount} of ${totalMedia}...`;

      try {
        const blob = await fetchMediaAsBlob(mediaUrl);
        if (blob) {
          const ext = getMediaExtension(mediaUrl, blob);
          mediaCounter++;
          const filenameInZip = `asset_${mediaCounter}.${ext}`;
          const relativeName = `media/${filenameInZip}`;

          mediaFolder.file(filenameInZip, blob);
          mediaUrlMap.set(mediaUrl, relativeName);
        } else {
          console.warn('Could not fetch blob for media asset:', mediaUrl);
        }
      } catch (err) {
        console.warn(`Failed to download media asset (${mediaUrl}):`, err);
      }
    }

    if (progressBar) progressBar.style.width = '90%';
    if (progressText) progressText.innerText = 'Rewriting article paths & packing zip...';

    // Rewrite article contents with local relative media paths + backup CDN URLs
    const exportedArticles = [];
    articles.forEach((art, idx) => {
      let updatedMd = art.markdown || '';

      mediaUrlMap.forEach((relPath, originalUrl) => {
        const cdnBackup = originalUrl.startsWith('data:') ? '' : ` data-cdn-src="${originalUrl}"`;

        // Replace markdown ![alt](originalUrl)
        const mdEscaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mdRegex = new RegExp(`!\\[([^\\]]*)\\]\\(${mdEscaped}(?:\\s+["'][^"']*["'])?\\)`, 'g');
        updatedMd = updatedMd.replace(mdRegex, (match, altText) => {
          return `<img src="${relPath}"${cdnBackup} alt="${altText}" />`;
        });

        // Replace direct originalUrl occurrences inside markdown/HTML
        if (updatedMd.includes(originalUrl)) {
          updatedMd = updatedMd.split(originalUrl).join(relPath);
        }
      });

      const artCopy = {
        ...art,
        folderName: sanitizedFolderName,
        markdown: updatedMd
      };
      exportedArticles.push(artCopy);

      const filename = art.title ? art.title.replace(/[/\\?%*:|"<>]/g, '_') + '.md' : `article_${idx + 1}.md`;
      zip.file(filename, updatedMd);
    });

    const manifest = {
      folderName: sanitizedFolderName,
      exportedAt: new Date().toISOString(),
      articles: exportedArticles
    };
    zip.file('folder-manifest.json', JSON.stringify(manifest, null, 2));

    if (progressBar) progressBar.style.width = '95%';
    if (progressText) progressText.innerText = 'Generating package archive...';

    const zipBlob = await zip.generateAsync({ type: 'blob' });

    if (progressBar) progressBar.style.width = '100%';

    // Save File Picker prompt allows user to save anywhere on hard drive
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: `${sanitizedFolderName}.zip`,
          types: [{
            description: 'Folder Package Zip Archive',
            accept: { 'application/zip': ['.zip'] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(zipBlob);
        await writable.close();
      } catch (e) {
        if (e.name !== 'AbortError') {
          downloadBlob(zipBlob, `${sanitizedFolderName}.zip`);
        }
      }
    } else {
      downloadBlob(zipBlob, `${sanitizedFolderName}.zip`);
    }

  } catch (err) {
    console.error('Export Folder Package error:', err);
    alert('Failed to export folder package: ' + err.message);
  } finally {
    if (progressModal) progressModal.classList.add('hidden');
  }
}

// Import Folder Package (.zip)
async function handleImportZipPackage(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (typeof JSZip === 'undefined') {
    alert('JSZip library is missing.');
    return;
  }

  try {
    const zip = await JSZip.loadAsync(file);
    const zipFolderName = file.name.replace(/\.zip$/i, '');

    // Extract media files into localBlobStore with explicit MIME types
    const mediaFiles = zip.filter((relPath, fileObj) => relPath.startsWith('media/') && !fileObj.dir);
    for (const mFile of mediaFiles) {
      const ext = mFile.name.split('.').pop().toLowerCase();
      let mimeType = 'image/png';
      if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
      else if (ext === 'webp') mimeType = 'image/webp';
      else if (ext === 'gif') mimeType = 'image/gif';
      else if (ext === 'svg') mimeType = 'image/svg+xml';
      else if (ext === 'mp4') mimeType = 'video/mp4';

      const arrayBuffer = await mFile.async('arraybuffer');
      const typedBlob = new Blob([arrayBuffer], { type: mimeType });
      const blobUrl = URL.createObjectURL(typedBlob);

      localBlobStore.set(mFile.name, blobUrl);
      const baseName = mFile.name.replace(/^media\//, '');
      localBlobStore.set(baseName, blobUrl);
    }

    let newArticles = [];
    const manifestFile = zip.file('folder-manifest.json');
    if (manifestFile) {
      const manifestText = await manifestFile.async('string');
      const manifest = JSON.parse(manifestText);
      const groupName = manifest.folderName || zipFolderName;
      newArticles = (manifest.articles || []).map(art => ({
        ...art,
        id: art.id || (Date.now() + Math.random().toString(36).substring(2, 6)),
        folderName: groupName
      }));
    } else {
      const mdFiles = zip.filter((relPath, fileObj) => relPath.endsWith('.md') && !fileObj.dir);
      for (let i = 0; i < mdFiles.length; i++) {
        const mdText = await mdFiles[i].async('string');
        const titleMatch = mdText.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : mdFiles[i].name.replace(/\.md$/i, '');
        newArticles.push({
          id: 'art-' + Date.now() + '-' + i,
          title: title,
          extractedAt: new Date().toLocaleDateString(),
          markdown: mdText,
          folderName: zipFolderName
        });
      }
    }

    if (newArticles.length > 0) {
      for (const art of newArticles) {
        await addArticle(art, false);
      }
      await saveArticles();
      renderSidebar();
      displayArticle(newArticles[0].id);
      alert(`Successfully imported folder package "${zipFolderName}" containing ${newArticles.length} article(s)!`);
    } else {
      alert('No valid articles found inside zip package.');
    }
  } catch (err) {
    console.error('Import ZIP package error:', err);
    alert('Failed to import zip package: ' + err.message);
  } finally {
    e.target.value = '';
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// Initialize
document.addEventListener('DOMContentLoaded', init);
