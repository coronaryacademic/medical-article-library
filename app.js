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
const DB_VERSION = 2;
const STORE_NAME = 'articles';
const MEDIA_STORE_NAME = 'media';
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
      if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) {
        db.createObjectStore(MEDIA_STORE_NAME, { keyPath: 'key' });
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

// Media Store Helper Functions
async function dbPutMedia(key, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite');
    const req = tx.objectStore(MEDIA_STORE_NAME).put({ key, blob, updatedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbGetAllMedia() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE_NAME, 'readonly');
    const req = tx.objectStore(MEDIA_STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbDeleteMedia(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite');
    const req = tx.objectStore(MEDIA_STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function dbClearMedia() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEDIA_STORE_NAME, 'readwrite');
    const req = tx.objectStore(MEDIA_STORE_NAME).clear();
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e.target.error);
  });
}

async function loadMediaFromDB() {
  try {
    const items = await dbGetAllMedia();
    for (const item of items) {
      if (item && item.key && item.blob) {
        const blobUrl = URL.createObjectURL(item.blob);
        localBlobStore.set(item.key, blobUrl);
        const baseName = item.key.replace(/^media\//, '');
        localBlobStore.set(baseName, blobUrl);
      }
    }
    console.log('[Coursology] Loaded', items.length, 'media items from IndexedDB');
  } catch (e) {
    console.warn('[Coursology] Failed to load media from IndexedDB:', e);
  }
}

// Application State
let articles = [];
let activeArticleId = null;

let currentArticleToc = []; // [{ id, text, level }]
let activeTocCollapsed = false; // Tracks if active article TOC is collapsed in sidebar
let currentFigureList = []; // Array of { src, caption, element, alt, index }
let currentFigureIndex = 0;

let articleFontSizePercent = parseInt(localStorage.getItem('article_font_size') || '100');

function updateArticleFontSize() {
  const articleBody = document.getElementById('article-body');
  const display = document.getElementById('font-size-display');
  if (articleBody) {
    articleBody.style.fontSize = `${(1.02 * articleFontSizePercent) / 100}rem`;
  }
  if (display) {
    display.innerText = `${articleFontSizePercent}%`;
  }
}

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

    try {
      await fetch('/api/folders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderName })
      });
    } catch (e) {
      console.warn('Host backend folder deletion failed:', e);
    }

    saveFoldersToStorage();

    if (activeArticleId && !articles.some(a => a.id === activeArticleId)) {
      activeArticleId = articles.length > 0 ? articles[0].id : null;
    }

    // Save updated folder list to backend catalog
    try {
      await fetch('/api/catalog/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folders })
      });
    } catch (e) {
      console.warn('Could not sync folders to backend:', e);
    }

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
let activeTagFilters = new Set(); // empty = no filter, else Set of tag strings (OR logic)
let activeWorkspaceMode = 'reader'; // 'reader' or 'bookmarks'

function switchWorkspaceMode(mode) {
  activeWorkspaceMode = mode;
  const tabReader = document.getElementById('tab-reader-view');
  const tabBookmarks = document.getElementById('tab-bookmarks-view');
  const welcomeState = document.getElementById('welcome-state');
  const articleContent = document.getElementById('article-content');
  const bookmarksWorkspace = document.getElementById('bookmarks-workspace');
  const mediaSidebar = document.getElementById('media-sidebar');

  if (mode === 'bookmarks') {
    if (tabReader) tabReader.classList.remove('active');
    if (tabBookmarks) tabBookmarks.classList.add('active');
    if (welcomeState) welcomeState.classList.add('hidden');
    if (articleContent) articleContent.classList.add('hidden');
    if (mediaSidebar) mediaSidebar.classList.add('hidden');
    if (bookmarksWorkspace) bookmarksWorkspace.classList.remove('hidden');
    renderBookmarksWorkspace();
  } else {
    if (tabBookmarks) tabBookmarks.classList.remove('active');
    if (tabReader) tabReader.classList.add('active');
    if (bookmarksWorkspace) bookmarksWorkspace.classList.add('hidden');
    if (activeArticleId) {
      if (articleContent) articleContent.classList.remove('hidden');
      if (welcomeState) welcomeState.classList.add('hidden');
    } else {
      if (welcomeState) welcomeState.classList.remove('hidden');
      if (articleContent) articleContent.classList.add('hidden');
    }
  }
}

function renderBookmarksWorkspace() {
  const grid = document.getElementById('bookmarks-list-grid');
  const countBadge = document.getElementById('top-bookmark-count');
  const sortSelect = document.getElementById('bookmarks-sort-select');
  const topSearchInput = document.getElementById('top-search-input');
  const searchInput = document.getElementById('search-input');

  const bookmarked = articles.filter(a => a.bookmarked);
  if (countBadge) countBadge.textContent = bookmarked.length;

  if (!grid) return;

  const query = (topSearchInput && topSearchInput.value) ? topSearchInput.value.toLowerCase().trim() : (searchInput ? searchInput.value.toLowerCase().trim() : '');
  let filtered = bookmarked.filter(a => {
    if (!query) return true;
    return (a.title && a.title.toLowerCase().includes(query)) ||
           (a.folderName && a.folderName.toLowerCase().includes(query)) ||
           (a.markdown && a.markdown.toLowerCase().includes(query));
  });

  const sortVal = sortSelect ? sortSelect.value : 'newest';
  if (sortVal === 'title') {
    filtered.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortVal === 'folder') {
    filtered.sort((a, b) => (a.folderName || 'Uncategorized').localeCompare(b.folderName || 'Uncategorized'));
  } else {
    filtered.sort((a, b) => (b.id > a.id ? 1 : -1));
  }

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px 24px; background: #ffffff; border: 2px dashed #cbd5e1; border-radius: 16px;">
        <div style="font-size: 2.5rem; margin-bottom: 12px;">⭐</div>
        <h3 style="font-size: 1.1rem; font-weight: 700; color: #1e293b; margin-bottom: 6px;">${query ? 'No matching bookmarked guides found' : 'No Bookmarked Guides Yet'}</h3>
        <p style="font-size: 0.85rem; color: #64748b; max-width: 420px; margin: 0 auto;">
          ${query ? 'Try searching for another medical term or topic.' : 'Click the ⭐ star icon next to any article title in the sidebar to add it to your Bookmarks workspace for quick reference.'}
        </p>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map(art => {
    const title = escapeHtml(art.title || 'Untitled Article');
    const folder = escapeHtml(art.folderName || 'Uncategorized');
    const date = art.date || art.extractedAt || 'No Date';
    const plainText = (art.markdown || '').replace(/[#*`_~]/g, '').slice(0, 140) + '...';

    return `
      <div class="bookmark-card">
        <div>
          <div class="bm-card-header">
            <h3 class="bm-card-title" onclick="openArticleFromBookmarks('${art.id}')">${title}</h3>
            <button class="bm-remove-btn" title="Remove Bookmark" onclick="toggleBookmarkFromWorkspace('${art.id}')">
              <svg viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="1.8" style="width:18px; height:18px;"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
            </button>
          </div>
          <span class="bm-card-folder">📁 ${folder}</span>
          <p class="bm-card-excerpt">${escapeHtml(plainText)}</p>
        </div>
        <div class="bm-card-actions">
          <span style="font-size:0.75rem; color:#94a3b8;">${escapeHtml(date)}</span>
          <button class="bm-open-btn" onclick="openArticleFromBookmarks('${art.id}')">Open Guide →</button>
        </div>
      </div>
    `;
  }).join('');
}

function openArticleFromBookmarks(artId) {
  switchWorkspaceMode('reader');
  displayArticle(artId);
}

async function toggleBookmarkFromWorkspace(artId) {
  const art = articles.find(a => a.id === artId);
  if (art) {
    art.bookmarked = !art.bookmarked;
    await saveArticles(art);
    renderSidebar();
    renderBookmarksWorkspace();
  }
}

// Load articles from host backend API (falls back to IndexedDB if offline)
async function loadArticles() {
  try {
    let loadedFromApi = false;
    try {
      const resp = await fetch('/api/catalog');
      if (resp.ok) {
        const data = await resp.json();
        if (data.success && Array.isArray(data.articles)) {
          articles = data.articles;
          if (Array.isArray(data.folders) && data.folders.length > 0) {
            folders = data.folders;
            saveFoldersToStorage();
          }
          for (const art of articles) { await dbPut(art); }
          loadedFromApi = true;
          console.log('[Coursology] Hydrated catalog from Host Backend API:', articles.length, 'articles');
        }
      }
    } catch (e) {
      console.warn('[Coursology] Host API endpoint unavailable, using local IndexedDB:', e);
    }

    if (!loadedFromApi) {
      articles = await dbGetAll();
      loadFoldersFromStorage();
    }

    await loadMediaFromDB();

    // Filter out any obsolete sample/test template articles if they exist in cache
    articles = articles.filter(a => a.id !== 'test-1' && a.id !== 'art-sample-1' && a.id !== 'art-sample-2' && a.title !== 'Acute Coronary Syndrome');

    // Sort newest first or by master ID
    articles.sort((a, b) => (b.id > a.id ? 1 : -1));
  } catch (e) {
    console.error('[Coursology] Failed to load articles:', e);
    articles = [];
  }
}

// Save a single article to host backend API & IndexedDB
async function saveArticles(articleToSave) {
  try {
    if (articleToSave) {
      await dbPut(articleToSave);
      try {
        await fetch('/api/articles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(articleToSave)
        });
      } catch (e) {}
    } else {
      for (const a of articles) { await dbPut(a); }
    }
  } catch (e) {
    console.error('[Coursology] Save failed:', e);
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

  // Top Workspace Header & Bookmarks Controls
  const topSearchInput = document.getElementById('top-search-input');
  const clearTopSearchBtn = document.getElementById('clear-top-search-btn');
  const tabReaderView = document.getElementById('tab-reader-view');
  const tabBookmarksView = document.getElementById('tab-bookmarks-view');
  const bookmarksSortSelect = document.getElementById('bookmarks-sort-select');

  if (topSearchInput) {
    topSearchInput.addEventListener('input', () => {
      if (clearTopSearchBtn) {
        if (topSearchInput.value) clearTopSearchBtn.classList.remove('hidden');
        else clearTopSearchBtn.classList.add('hidden');
      }
      renderSidebar();
      if (activeWorkspaceMode === 'bookmarks') renderBookmarksWorkspace();
    });
  }

  if (clearTopSearchBtn) {
    clearTopSearchBtn.addEventListener('click', () => {
      if (topSearchInput) topSearchInput.value = '';
      clearTopSearchBtn.classList.add('hidden');
      renderSidebar();
      if (activeWorkspaceMode === 'bookmarks') renderBookmarksWorkspace();
    });
  }

  if (tabReaderView) tabReaderView.addEventListener('click', () => switchWorkspaceMode('reader'));
  if (tabBookmarksView) tabBookmarksView.addEventListener('click', () => switchWorkspaceMode('bookmarks'));
  if (bookmarksSortSelect) bookmarksSortSelect.addEventListener('change', renderBookmarksWorkspace);



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

  if (treeModal) {
    treeModal.addEventListener('click', (e) => {
      if (shouldCloseModalOnBackdropClick(e, treeModal)) hideTreeModal();
    });
  }

  const scriptModalBtn = document.getElementById('script-modal-btn');
  const scriptModalClose = document.getElementById('script-modal-close');
  const copyScriptCodeBtn = document.getElementById('copy-script-code-btn');
  const scriptModal = document.getElementById('script-modal');

  if (scriptModalBtn) scriptModalBtn.addEventListener('click', openScriptModal);
  if (scriptModalClose) scriptModalClose.addEventListener('click', closeScriptModal);
  if (copyScriptCodeBtn) copyScriptCodeBtn.addEventListener('click', copyScriptCode);
  if (scriptModal) {
    scriptModal.addEventListener('click', (e) => {
      if (shouldCloseModalOnBackdropClick(e, scriptModal)) closeScriptModal();
    });
  }

  // Settings View Modal Handlers
  const settingsModalBtn = document.getElementById('settings-modal-btn');
  const footerSettingsBtn = document.getElementById('footer-settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const closeSettingsModalBtn = document.getElementById('close-settings-modal-btn');
  const settingsImportZipInput = document.getElementById('settings-import-zip-input');
  const settingsScriptModalBtn = document.getElementById('settings-script-modal-btn');
  const settingsImportTreeBtn = document.getElementById('settings-import-tree-btn');

  const openSettingsModal = () => {
    if (settingsModal) settingsModal.classList.remove('hidden');
  };

  const closeSettingsModal = () => {
    if (settingsModal) settingsModal.classList.add('hidden');
  };

  if (settingsModalBtn) settingsModalBtn.addEventListener('click', openSettingsModal);
  if (footerSettingsBtn) footerSettingsBtn.addEventListener('click', openSettingsModal);
  if (closeSettingsModalBtn) closeSettingsModalBtn.addEventListener('click', closeSettingsModal);

  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (shouldCloseModalOnBackdropClick(e, settingsModal)) closeSettingsModal();
    });
  }

  if (settingsImportZipInput) settingsImportZipInput.addEventListener('change', (e) => {
    handleImportZipPackage(e);
    closeSettingsModal();
  });

  if (settingsScriptModalBtn) settingsScriptModalBtn.addEventListener('click', () => {
    closeSettingsModal();
    openScriptModal();
  });

  if (settingsImportTreeBtn) settingsImportTreeBtn.addEventListener('click', () => {
    closeSettingsModal();
    if (treeModal) {
      treeModal.classList.remove('hidden');
      if (treeHtmlInput) treeHtmlInput.focus();
    }
  });

  const cleanOrphanedMediaBtn = document.getElementById('clean-orphaned-media-btn');
  if (cleanOrphanedMediaBtn) {
    cleanOrphanedMediaBtn.addEventListener('click', async () => {
      try {
        const resp = await fetch('/api/clean-orphaned-media', { method: 'POST' });
        const data = await resp.json();
        if (data.success) {
          alert(`Orphaned Media Cleanup Complete!\nRemoved ${data.cleanedMediaCount} unused media file(s) from host disk.`);
        }
      } catch (e) {
        alert('Failed to clean media files: ' + e.message);
      }
    });
  }

  const expandAllFoldersBtn = document.getElementById('expand-all-folders-btn');
  const collapseAllFoldersBtn = document.getElementById('collapse-all-folders-btn');
  const fontDecBtn = document.getElementById('font-decrease-btn');
  const fontIncBtn = document.getElementById('font-increase-btn');

  if (expandAllFoldersBtn) {
    expandAllFoldersBtn.addEventListener('click', () => {
      folderCollapseState.clear();
      renderSidebar();
    });
  }

  if (collapseAllFoldersBtn) {
    collapseAllFoldersBtn.addEventListener('click', () => {
      folders.forEach(f => folderCollapseState.add(f));
      folderCollapseState.add('⭐ Bookmarks');
      renderSidebar();
    });
  }

  if (fontDecBtn) {
    fontDecBtn.addEventListener('click', () => {
      articleFontSizePercent = Math.max(80, articleFontSizePercent - 10);
      updateArticleFontSize();
      localStorage.setItem('article_font_size', articleFontSizePercent.toString());
    });
  }

  if (fontIncBtn) {
    fontIncBtn.addEventListener('click', () => {
      articleFontSizePercent = Math.min(160, articleFontSizePercent + 10);
      updateArticleFontSize();
      localStorage.setItem('article_font_size', articleFontSizePercent.toString());
    });
  }

  const articleCollapseAllBtn = document.getElementById('article-collapse-all-btn');
  const articleExpandAllBtn = document.getElementById('article-expand-all-btn');

  if (articleCollapseAllBtn) {
    articleCollapseAllBtn.addEventListener('click', () => {
      document.querySelectorAll('.collapsible-heading').forEach(h => h.classList.add('collapsed'));
      document.querySelectorAll('.h1-section-body').forEach(b => b.classList.add('collapsed'));
    });
  }

  if (articleExpandAllBtn) {
    articleExpandAllBtn.addEventListener('click', () => {
      document.querySelectorAll('.collapsible-heading').forEach(h => h.classList.remove('collapsed'));
      document.querySelectorAll('.h1-section-body').forEach(b => b.classList.remove('collapsed'));
    });
  }

  document.querySelectorAll('.modal-card, .lightbox-card').forEach(enableCornerResize);

  const lightboxCloseBtn = document.getElementById('lightbox-close-btn');
  if (lightboxCloseBtn) lightboxCloseBtn.addEventListener('click', closeLightbox);
  if (lightboxPrev) lightboxPrev.addEventListener('click', showPrevFigure);
  if (lightboxNext) lightboxNext.addEventListener('click', showNextFigure);

  if (lightbox) {
    lightbox.addEventListener('click', (e) => {
      if (shouldCloseModalOnBackdropClick(e, lightbox)) closeLightbox();
    });
  }

  const tableLightboxClose = document.getElementById('table-lightbox-close');
  const tableLightboxModal = document.getElementById('table-lightbox');
  if (tableLightboxClose) tableLightboxClose.addEventListener('click', closeTableLightbox);
  if (tableLightboxModal) {
    tableLightboxModal.addEventListener('click', (e) => {
      if (shouldCloseModalOnBackdropClick(e, tableLightboxModal)) closeTableLightbox();
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

  // Load & Apply Saved Sidebar Width from LocalStorage
  const savedSidebarWidth = localStorage.getItem('sidebar_width');
  if (savedSidebarWidth && leftSidebar) {
    const w = parseInt(savedSidebarWidth);
    if (w >= 180 && w <= 750) {
      leftSidebar.style.width = `${w}px`;
      if (toggleLeftBtn) toggleLeftBtn.style.left = `${w - 14}px`;
    }
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
      if (newWidth > 750) newWidth = 750;
      leftSidebar.style.width = `${newWidth}px`;
      toggleLeftBtn.style.left = `${newWidth - 14}px`;
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        leftResizer.classList.remove('resizing');
        document.body.style.cursor = '';
        const currentW = parseInt(leftSidebar.style.width);
        if (currentW) localStorage.setItem('sidebar_width', currentW.toString());
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

  const isBookmarked = !!article.bookmarked;
  const bookmarkBtn = document.createElement('button');
  bookmarkBtn.className = 'bookmark-btn' + (isBookmarked ? ' is-bookmarked' : '');
  bookmarkBtn.title = isBookmarked ? 'Remove Bookmark' : 'Bookmark Article';
  bookmarkBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="${isBookmarked ? '#f59e0b' : 'none'}" stroke="${isBookmarked ? '#f59e0b' : '#64748b'}" stroke-width="1.8" style="width:16px; height:16px; display:block; cursor:pointer;"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
  bookmarkBtn.onclick = async (e) => {
    e.stopPropagation();
    article.bookmarked = !article.bookmarked;
    await saveArticles(article);
    renderSidebar();
  };
  rightBox.appendChild(bookmarkBtn);

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
// Extract tags array from article — frontmatter > valid persisted > nothing
function getArticleTags(article) {
  // 1. YAML frontmatter is the most reliable source (parsed at extract time)
  if (article.markdown) {
    const tags = [];
    const fmMatch = article.markdown.match(/^---\n([\s\S]*?)\n---/);
    if (fmMatch) {
      fmMatch[1].replace(/- "([^"]+)"/g, (_, t) => tags.push(t));
    }
    if (tags.length > 0) return tags;
  }
  // 2. Persisted .tags array — only trust if tags look valid (not concatenated garbage)
  if (Array.isArray(article.tags) && article.tags.length > 0) {
    const valid = article.tags.filter(t => typeof t === 'string' && t.length > 0 && t.length <= 50);
    if (valid.length === article.tags.length) return article.tags;
    // Bad data — clear it so next open re-extracts correctly
    article.tags = [];
    dbPut(article);
  }
  return [];
}

// Collect all unique tags across all fetched articles
function getAllUniqueTags() {
  const tagSet = new Set();
  articles.forEach(a => getArticleTags(a).forEach(t => tagSet.add(t)));
  return [...tagSet].sort();
}

// Render the tag filter chip bar in the sidebar
function renderTagFilterBar() {
  const bar = document.getElementById('tag-filter-bar');
  if (!bar) return;

  const allTags = getAllUniqueTags();
  if (allTags.length === 0) {
    bar.style.display = 'none';
    bar.innerHTML = '';
    return;
  }

  bar.style.display = 'flex';
  bar.innerHTML = '';

  // "All" chip to clear all filters
  const allChip = document.createElement('button');
  allChip.className = 'tag-filter-chip' + (activeTagFilters.size === 0 ? ' active' : '');
  allChip.textContent = 'All';
  allChip.onclick = () => { activeTagFilters.clear(); renderTagFilterBar(); renderSidebar(); };
  bar.appendChild(allChip);

  allTags.forEach(tag => {
    const chip = document.createElement('button');
    chip.className = 'tag-filter-chip' + (activeTagFilters.has(tag) ? ' active' : '');
    chip.textContent = tag;
    chip.onclick = () => {
      if (activeTagFilters.has(tag)) {
        activeTagFilters.delete(tag);
      } else {
        activeTagFilters.add(tag);
      }
      renderTagFilterBar();
      renderSidebar();
    };
    bar.appendChild(chip);
  });
}

function renderSidebar() {
  const sidebarSearch = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const topSearch = (document.getElementById('top-search-input') || {}).value;
  const query = (topSearch && topSearch.trim()) ? topSearch.toLowerCase().trim() : sidebarSearch;
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

  // Tag filter — OR logic: show articles that have ANY of the selected tags
  if (activeTagFilters.size > 0) {
    filtered = filtered.filter(a => {
      const artTags = getArticleTags(a);
      return [...activeTagFilters].some(t => artTags.includes(t));
    });
  }

  renderTagFilterBar();

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

  // Render pinned Bookmarks folder if bookmarked articles exist
  const bookmarkedArts = articles.filter(a => a.bookmarked);
  if (bookmarkedArts.length > 0 && !query) {
    const bmFolderName = '⭐ Bookmarks';
    const isBmCollapsed = folderCollapseState.has(bmFolderName);

    const bmCard = document.createElement('div');
    bmCard.className = 'sidebar-folder-card' + (isBmCollapsed ? ' collapsed' : '');
    bmCard.style.borderLeft = '3px solid #f59e0b';
    bmCard.style.marginBottom = '10px';

    const bmHeader = document.createElement('div');
    bmHeader.className = 'sidebar-folder-header';
    bmHeader.style.background = '#fffbeb';
    bmHeader.innerHTML = `
      <div class="sidebar-folder-title" style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:1.1rem; line-height:1;">⭐</span>
        <span style="font-weight:700; font-size:0.92rem; color:#b45309;">Bookmarks</span>
        <span class="folder-count-badge" style="background:#fef3c7; color:#b45309;">${bookmarkedArts.length}</span>
      </div>
      <div class="folder-actions" style="display:flex; align-items:center; gap:6px;">
        <span style="display:flex; align-items:center; color:#d97706; transition:transform 0.2s ease; transform: ${isBmCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)'};">${chevronSvg}</span>
      </div>
    `;

    bmHeader.onclick = () => {
      if (folderCollapseState.has(bmFolderName)) {
        folderCollapseState.delete(bmFolderName);
      } else {
        folderCollapseState.add(bmFolderName);
      }
      renderSidebar();
    };

    const bmUl = document.createElement('ul');
    bmUl.className = 'folder-article-list' + (isBmCollapsed ? ' hidden' : '');

    bookmarkedArts.forEach(art => {
      bmUl.appendChild(createArticleListItem(art));
    });

    bmCard.appendChild(bmHeader);
    bmCard.appendChild(bmUl);
    articleFlatList.appendChild(bmCard);
  }

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

  if (activeWorkspaceMode === 'bookmarks') {
    switchWorkspaceMode('reader');
  } else {
    welcomeState.classList.add('hidden');
    articleContent.classList.remove('hidden');
  }

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

  // Strip YAML frontmatter and extract tags from it
  let frontmatterTags = [];
  cleanMd = cleanMd.replace(/^---\n([\s\S]*?)\n---\n?/, (_, fm) => {
    // Simple global scan: find every  - "tag name"  line anywhere in the frontmatter
    fm.replace(/^\s*-\s+"([^"]+)"/gm, (__, tag) => frontmatterTags.push(tag));
    return '';
  });

  // Remove leading `# Title` matching article title to prevent duplication
  cleanMd = cleanMd.replace(/^\s*#+\s+([^\n]+)/, (full, hText) => {
    const normH = hText.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (normH === normTitle) ? '' : full;
  }).trim();

  // Parse Markdown or restore saved HTML highlights
  if (article.html && article.html.trim().length > 0) {
    articleBody.innerHTML = article.html;
  } else if (typeof marked !== 'undefined') {
    articleBody.innerHTML = marked.parse(cleanMd);
  } else {
    articleBody.innerText = cleanMd;
  }

   // Re-bind removal handlers to all restored text highlights
  articleBody.querySelectorAll('mark.yellow-highlight').forEach(mark => {
    mark.onclick = (e) => {
      e.stopPropagation();
      const frag = document.createRange().createContextualFragment(mark.innerHTML);
      mark.replaceWith(frag);
      saveCurrentArticleHighlights();
    };
  });

  // Resolve localBlobStore URLs and attach automatic CDN fallback handler
  articleBody.querySelectorAll('img, video').forEach(el => {
    let rawSrc = el.getAttribute('src') || '';
    let origSrc = el.getAttribute('data-original-src');
    if (!origSrc && !rawSrc.startsWith('blob:') && !rawSrc.startsWith('http://') && !rawSrc.startsWith('https://')) {
      origSrc = rawSrc;
    }
    if (!origSrc && el.getAttribute('data-cdn-src')) {
      origSrc = el.getAttribute('data-cdn-src');
    }
    const targetKey = origSrc || rawSrc;
    if (targetKey) {
      const baseName = targetKey.replace(/^media\//, '');
      if (localBlobStore.has(targetKey)) {
        el.src = localBlobStore.get(targetKey);
        el.setAttribute('data-original-src', targetKey);
      } else if (localBlobStore.has(baseName)) {
        el.src = localBlobStore.get(baseName);
        el.setAttribute('data-original-src', targetKey);
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

  // 6. Tags bar — always render with proper CSS classes
  let domExtractedTags = [];

  // Strategy A: new tampermonkey format — <p data-tag="true"> inside .article-tags-wrapper
  const existingWrapper = articleBody.querySelector('.article-tags-wrapper');
  if (existingWrapper) {
    existingWrapper.querySelectorAll('[data-tag="true"], .tag-pill').forEach(el => {
      const t = el.innerText.trim();
      if (t && t.length <= 60 && t.toUpperCase() !== 'TAGS') domExtractedTags.push(t);
    });
    existingWrapper.remove();
  }

  // Strategy B: turndown converts <p data-tag="true"> blocks — find them anywhere in body
  if (domExtractedTags.length === 0) {
    articleBody.querySelectorAll('[data-tag="true"]').forEach(el => {
      const t = el.innerText.trim();
      if (t && t.length <= 60) domExtractedTags.push(t);
      el.remove();
    });
  }

  // Strategy C: TAGS heading followed by short sibling paragraphs
  // Handles: turndown converts site's block-level pill divs to separate markdown paragraphs
  if (domExtractedTags.length === 0) {
    const allEls = Array.from(articleBody.children);
    let tagsHeadingIdx = -1;
    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      const tag = el.tagName;
      const txt = el.innerText ? el.innerText.trim() : '';
      if (/^H[1-6]$/.test(tag) && txt.toUpperCase() === 'TAGS') {
        tagsHeadingIdx = i;
        break;
      }
    }
    if (tagsHeadingIdx >= 0) {
      // Collect following siblings that are short paragraphs (tag names, not article content)
      const toRemove = [allEls[tagsHeadingIdx]];
      for (let i = tagsHeadingIdx + 1; i < allEls.length; i++) {
        const sib = allEls[i];
        const txt = sib.innerText ? sib.innerText.trim() : '';
        // Stop if we hit another heading or a long paragraph (real content)
        if (/^H[1-6]$/.test(sib.tagName) || txt.length > 60 || txt.length === 0) break;
        domExtractedTags.push(txt);
        toRemove.push(sib);
      }
      toRemove.forEach(el => el.remove());
    }
  }

  // Strategy D: stray "TAGS:" paragraph with inline text (old format) — remove it but don't try to parse
  if (domExtractedTags.length === 0) {
    articleBody.querySelectorAll('p, div').forEach(el => {
      const txt = el.innerText ? el.innerText.trim() : '';
      if (/^TAGS[:.]?\s/i.test(txt) && el.children.length <= 3) {
        el.querySelectorAll('span, p').forEach(s => {
          const t = s.innerText.trim();
          if (t && t.toUpperCase() !== 'TAGS' && t.length <= 60) domExtractedTags.push(t);
        });
        el.remove();
      }
    });
  }

  // Final: determine tag list (frontmatter > DOM > cached valid)
  const validDomTags = domExtractedTags.filter(t => t.length > 0 && t.length <= 60);
  const tagsToRender = frontmatterTags.length > 0 ? frontmatterTags
    : validDomTags.length > 0 ? validDomTags
    : (Array.isArray(article.tags) ? article.tags.filter(t => t && t.length > 0 && t.length <= 60) : []);

  // Persist valid tags to IndexedDB, clear bad cached data
  if (tagsToRender.length > 0 && tagsToRender.every(t => t.length <= 60)) {
    if (JSON.stringify(article.tags) !== JSON.stringify(tagsToRender)) {
      article.tags = tagsToRender;
      dbPut(article);
    }
  } else if (Array.isArray(article.tags) && article.tags.some(t => t.length > 60)) {
    article.tags = [];
    dbPut(article);
  }

  // Step E: render the styled tag bar
  if (tagsToRender.length > 0) {
    const tagsWrapper = document.createElement('div');
    tagsWrapper.className = 'article-tags-wrapper';
    tagsWrapper.innerHTML = `
      <div class="article-tags-label">Tags</div>
      <div class="article-tags-pills">${tagsToRender.map(t =>
        `<span class="tag-pill">${t}</span>`
      ).join('')}</div>
    `;
    articleBody.appendChild(tagsWrapper);
  }

  // 7. Render Sidebar & Right Media Sidebar
  renderSidebar();
  renderMediaSidebar(articleBody);
  updateArticleFontSize();

  // 8. Boot sticky heading scroll tracker
  initStickyHeading();
}

// Sticky heading breadcrumb — updates as you scroll through article sections
let _stickyHeadingObserver = null;
function initStickyHeading() {
  const bar = document.getElementById('sticky-heading-bar');
  const label = document.getElementById('sticky-heading-text');
  const mainViewer = document.querySelector('.main-viewer');
  if (!bar || !label || !mainViewer) return;

  // Clean up any previous observer
  if (_stickyHeadingObserver) {
    _stickyHeadingObserver.disconnect();
    _stickyHeadingObserver = null;
  }

  const headings = Array.from(document.querySelectorAll('#article-body h1, #article-body h2, #article-body h3'));
  if (headings.length === 0) {
    bar.classList.add('hidden');
    return;
  }

  // Track which heading is currently "at the top" using IntersectionObserver
  const headingMap = new Map();

  _stickyHeadingObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      headingMap.set(entry.target, entry);
    });

    // Find the last heading that has crossed above the viewport midpoint
    let activeHeading = null;
    headings.forEach(h => {
      const obs = headingMap.get(h);
      if (!obs) return;
      if (!obs.isIntersecting || obs.boundingClientRect.top < 80) {
        activeHeading = h;
      }
    });

    if (activeHeading) {
      const text = activeHeading.textContent.trim().replace(/^[▶▼]\s*/, '');
      label.textContent = text;
      bar.classList.remove('hidden');
    } else {
      bar.classList.add('hidden');
    }
  }, {
    root: mainViewer,
    rootMargin: '-80px 0px 0px 0px',
    threshold: 0
  });

  headings.forEach(h => _stickyHeadingObserver.observe(h));
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
  if (!container) return;

  // 0. Clean up any pre-existing or nested exhibit buttons to prevent duplication e.g. (🖼 (🖼 Figure 1))))
  container.querySelectorAll('.exhibit-btn').forEach(btn => {
    const label = btn.querySelector('.ex-label')?.innerText || btn.innerText.replace(/[\(\)🖼\s]+/g, ' ').trim();
    if (label) {
      btn.replaceWith(document.createTextNode(`(${label})`));
    }
  });

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
        const parent = node.parentElement || node.parentNode;
        if (!parent || !parent.closest) return NodeFilter.FILTER_SKIP;

        // Strictly reject any node inside an existing button, exhibit button, figure link, or script/style tag
        if (parent.closest('button, .exhibit-btn, .figure-link, a, script, style, code, pre, figcaption')) {
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
  const newTab = window.open('about:blank', '_blank');
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

// Open Table in Clean Formatted Viewer Tab
function openTableInNewTab(tableHtml, title = 'Medical Table') {
  if (!tableHtml) return;
  const newTab = window.open('about:blank', '_blank');
  if (newTab) {
    newTab.document.write(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>${title}</title>
        <meta charset="utf-8" />
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
            background-color: #f8fafc;
            color: #0f172a;
            margin: 0;
            padding: 32px;
            display: flex;
            flex-direction: column;
            align-items: center;
          }
          h2 { margin-bottom: 20px; color: #1e293b; text-align: center; }
          .table-container {
            background: #ffffff;
            border-radius: 8px;
            padding: 24px;
            box-shadow: 0 10px 25px -5px rgba(0,0,0,0.1);
            max-width: 95vw;
            overflow-x: auto;
            border: 1px solid #cbd5e1;
          }
          table {
            border-collapse: collapse;
            width: 100%;
            font-size: 0.95rem;
          }
          th, td {
            border: 1px solid #cbd5e1;
            padding: 10px 14px;
            text-align: left;
          }
          th {
            background-color: #f1f5f9;
            font-weight: 700;
            color: #0f172a;
          }
          tr:nth-child(even) {
            background-color: #f8fafc;
          }
        </style>
      </head>
      <body>
        <h2>${title}</h2>
        <div class="table-container">
          ${tableHtml}
        </div>
      </body>
      </html>
    `);
    newTab.document.close();
  }
}

// Copy Image to System Clipboard
async function copyImageToClipboard(imgSrc) {
  if (!imgSrc) return;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imgSrc;
    await img.decode();

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    canvas.toBlob(async (blob) => {
      if (!blob) {
        alert('Could not process image for clipboard.');
        return;
      }
      try {
        const item = new ClipboardItem({ 'image/png': blob });
        await navigator.clipboard.write([item]);
        alert('✓ Image copied to clipboard! You can paste it directly to friends.');
      } catch (err) {
        await navigator.clipboard.writeText(canvas.toDataURL('image/png'));
        alert('✓ Image link copied to clipboard!');
      }
    }, 'image/png');
  } catch (e) {
    alert('Copy Image: ' + e.message);
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

    // Do NOT wrap or disturb exhibit buttons, SVG icons, or figure links
    const startNode = range.startContainer.parentElement;
    const endNode = range.endContainer.parentElement;
    if (startNode && startNode.closest('.exhibit-btn, button, .figure-link')) return;
    if (endNode && endNode.closest('.exhibit-btn, button, .figure-link')) return;

    const cloned = range.cloneContents();
    if (cloned.querySelector('.exhibit-btn, button, .figure-link, svg')) return;

    const mark = document.createElement('mark');
    mark.className = 'yellow-highlight';
    mark.title = 'Click to remove highlight';

    try {
      range.surroundContents(mark);
      selection.removeAllRanges();

           mark.onclick = (e) => {
        e.stopPropagation();
        const frag = document.createRange().createContextualFragment(mark.innerHTML);
        mark.replaceWith(frag);
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
  const copyImgBtn = document.getElementById('tool-copy-img');

  if (zoomInBtn) zoomInBtn.addEventListener('click', () => { imgZoom += 0.25; updateImageTransform(); });
  if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => { imgZoom = Math.max(0.3, imgZoom - 0.25); updateImageTransform(); });
  if (zoomResetBtn) zoomResetBtn.addEventListener('click', resetImageTransform);
  if (rotateBtn) rotateBtn.addEventListener('click', () => { imgRotation = (imgRotation + 90) % 360; updateImageTransform(); });
  
  if (openTabBtn) {
    openTabBtn.addEventListener('click', () => {
      const item = (currentFigureList && currentFigureIndex >= 0) ? currentFigureList[currentFigureIndex] : null;
      if (item && item.isTable) {
        const tblElem = document.getElementById('lb-table-viewport')?.querySelector('table') || item.element;
        if (tblElem) {
          openTableInNewTab(tblElem.outerHTML, item.caption || 'Medical Table');
          return;
        }
      }
      const standTableContent = document.getElementById('table-lightbox-content');
      const tableModal = document.getElementById('table-lightbox');
      if (tableModal && !tableModal.classList.contains('hidden') && standTableContent) {
        const tbl = standTableContent.querySelector('table');
        if (tbl) {
          const title = document.getElementById('table-lightbox-title')?.innerText || 'Medical Table';
          openTableInNewTab(tbl.outerHTML, title);
          return;
        }
      }

      const src = lightboxImg ? lightboxImg.src : null;
      if (src) openImageInNewTab(src);
    });
  }

  if (copyImgBtn) {
    copyImgBtn.addEventListener('click', () => {
      const src = lightboxImg ? lightboxImg.src : null;
      if (src) {
        copyImageToClipboard(src);
      } else {
        alert('No image to copy.');
      }
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

  const openTableTabBtn = document.getElementById('open-table-tab-btn');
  if (openTableTabBtn) {
    openTableTabBtn.addEventListener('click', () => {
      const standTableContent = document.getElementById('table-lightbox-content');
      if (standTableContent) {
        const tbl = standTableContent.querySelector('table');
        if (tbl) {
          const title = document.getElementById('table-lightbox-title')?.innerText || 'Medical Table';
          openTableInNewTab(tbl.outerHTML, title);
        }
      }
    });
  }

  if (imgWindow && imgHeader) {
    makeWindowDraggableAndResizable(imgWindow, imgHeader, imgModal, imgMin, imgMax, imgClose, 'Exhibit Viewer');
  }

  if (tblWindow && tblHeader) {
    makeWindowDraggableAndResizable(tblWindow, tblHeader, tblModal, tblMin, tblMax, tblClose, 'Table Viewer');
  }
}

let globalMouseDownTarget = null;
document.addEventListener('mousedown', (e) => {
  globalMouseDownTarget = e.target;
}, true);

let isModalInteracting = false;
let modalInteractEndTime = 0;

function markModalInteractStart() {
  isModalInteracting = true;
  modalInteractEndTime = Date.now();
  window._wasResizingModal = true;
}

function markModalInteractEnd() {
  modalInteractEndTime = Date.now();
  setTimeout(() => {
    isModalInteracting = false;
    window._wasResizingModal = false;
  }, 450);
}

function wasModalRecentlyInteracted() {
  return isModalInteracting || (Date.now() - modalInteractEndTime < 450);
}

function shouldCloseModalOnBackdropClick(e, backdropEl) {
  if (!backdropEl) return false;
  if (e.target !== backdropEl) return false;
  if (globalMouseDownTarget !== backdropEl) return false;
  if (wasModalRecentlyInteracted()) return false;
  return true;
}

// Global capture phase event suppressor for modal backdrop clicks after drag/resize
window.addEventListener('click', (e) => {
  if (wasModalRecentlyInteracted()) {
    if (e.target && (e.target.classList.contains('lightbox') || e.target.id === 'table-lightbox' || e.target.id === 'script-modal' || e.target.id === 'tree-import-modal')) {
      e.stopPropagation();
      e.preventDefault();
    }
  }
}, true);

function enableCornerResize(cardEl) {
  if (!cardEl || cardEl._hasResizeHandle) return;
  cardEl._hasResizeHandle = true;
  cardEl.style.resize = 'both';
  cardEl.style.overflow = 'auto';

  let handle = cardEl.querySelector('.modal-resize-handle');
  if (!handle) {
    handle = document.createElement('div');
    handle.className = 'modal-resize-handle';
    handle.title = 'Drag corner to resize';
    cardEl.appendChild(handle);
  }

  let isResizing = false;
  let startW = 0, startH = 0, startX = 0, startY = 0;

  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    isResizing = true;
    markModalInteractStart();
    startW = cardEl.offsetWidth;
    startH = cardEl.offsetHeight;
    startX = e.clientX;
    startY = e.clientY;

    const onMouseMove = (ev) => {
      if (!isResizing) return;
      markModalInteractStart();
      const newW = Math.max(280, startW + (ev.clientX - startX));
      const newH = Math.max(160, startH + (ev.clientY - startY));
      cardEl.style.width = newW + 'px';
      cardEl.style.height = newH + 'px';
    };

    const onMouseUp = () => {
      if (isResizing) {
        isResizing = false;
        markModalInteractEnd();
      }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  });
}

function makeWindowDraggableAndResizable(cardEl, headerEl, modalParentEl, minBtnEl, maxBtnEl, closeBtnEl, defaultTitle) {
  if (cardEl) enableCornerResize(cardEl);
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
      if (e.target.closest('.win-btn') || e.target.closest('.lb-close-btn') || e.target.closest('.lb-nav-btn') || e.target.closest('.modal-resize-handle')) return;
      if (cardEl.classList.contains('maximized')) return;
      isDragging = true;
      markModalInteractStart();
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
      markModalInteractStart();
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      currentX = clientX - startX;
      currentY = clientY - startY;

      cardEl.style.transform = `translate3d(${currentX}px, ${currentY}px, 0px)`;
    };

    const onDragEnd = () => {
      if (isDragging) {
        isDragging = false;
        markModalInteractEnd();
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
      e.preventDefault();
      const isMax = cardEl.classList.toggle('maximized');
      if (isMax) {
        cardEl._savedWidth = cardEl.style.width;
        cardEl._savedHeight = cardEl.style.height;
        cardEl.style.width = '';
        cardEl.style.height = '';
      } else {
        if (cardEl._savedWidth) cardEl.style.width = cardEl._savedWidth;
        if (cardEl._savedHeight) cardEl.style.height = cardEl._savedHeight;
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

// Delete Article (Executes physical hardware file unlinking on host server)
async function deleteArticle(id) {
  articles = articles.filter(a => a.id !== id);
  try {
    await dbDelete(id);
    await fetch(`/api/articles/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch (e) {
    console.error('Failed to delete article from host backend / IndexedDB:', e);
  }
  if (activeArticleId === id) {
    activeArticleId = articles.length > 0 ? articles[0].id : null;
  }
  renderSidebar();
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
  if (confirm('Are you sure you want to delete all saved articles, media, and folders?')) {
    articles = [];
    folders = ['Uncategorized'];
    activeArticleId = null;
    await dbClear();
    try { await dbClearMedia(); } catch (e) {}
    try { await fetch('/api/clear-all', { method: 'POST' }); } catch (e) {}
    localBlobStore.clear();
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

      // Persist binary media blob in IndexedDB so it survives browser reload
      await dbPutMedia(mFile.name, typedBlob);
      await dbPutMedia(baseName, typedBlob);
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

      // Push ZIP to host server for physical hardware storage
      try {
        const formData = new FormData();
        formData.append('zipFile', file);
        fetch('/api/import-zip', { method: 'POST', body: formData }).catch(e => {});
      } catch (e) {}

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
