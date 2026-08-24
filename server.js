const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const JSZip = require('jszip');

const app = express();
const PORT = process.env.PORT || 8088;

// Directories — stored OUTSIDE the git repo at ~/UW_Library_Data
const DATA_DIR = path.join(require('os').homedir(), 'UW_Library_Data');
const ARTICLES_DIR = path.join(DATA_DIR, 'articles');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const LIBRARY_JSON_PATH = path.join(DATA_DIR, 'library.json');

// Ensure directories exist
function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ARTICLES_DIR)) fs.mkdirSync(ARTICLES_DIR, { recursive: true });
  if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

  if (!fs.existsSync(LIBRARY_JSON_PATH)) {
    const initialData = { folders: ['Uncategorized'], articles: [] };
    fs.writeFileSync(LIBRARY_JSON_PATH, JSON.stringify(initialData, null, 2), 'utf-8');
  }
}
ensureDirs();

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Static file serving
app.use(express.static(__dirname));
app.use('/media', express.static(MEDIA_DIR));
app.use('/library_data/media', express.static(MEDIA_DIR));

// Memory storage for multer file uploads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

// Helper: Read master library catalog
function readCatalog() {
  ensureDirs();
  try {
    const raw = fs.readFileSync(LIBRARY_JSON_PATH, 'utf-8');
    const data = JSON.parse(raw);
    data.folders = data.folders || ['Uncategorized'];
    data.articles = data.articles || [];

    // Sync individual article files from ARTICLES_DIR into catalog if missing
    const files = fs.readdirSync(ARTICLES_DIR);
    for (const f of files) {
      if (f.endsWith('.json')) {
        try {
          const artRaw = fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf-8');
          const art = JSON.parse(artRaw);
          if (art && art.id) {
            const idx = data.articles.findIndex(a => a.id === art.id);
            if (idx >= 0) {
              data.articles[idx] = { ...data.articles[idx], ...art };
            } else {
              data.articles.push(art);
            }
          }
        } catch (e) {}
      }
    }

    return data;
  } catch (err) {
    console.error('Error reading catalog:', err);
    return { folders: ['Uncategorized'], articles: [] };
  }
}

// Helper: Save master library catalog
function saveCatalog(catalogData) {
  ensureDirs();
  try {
    fs.writeFileSync(LIBRARY_JSON_PATH, JSON.stringify(catalogData, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving catalog:', err);
  }
}

// Helper: Clean orphaned media files from MEDIA_DIR that are no longer referenced by any article
function cleanOrphanedMedia() {
  ensureDirs();
  try {
    if (!fs.existsSync(MEDIA_DIR)) return 0;
    const diskMediaFiles = fs.readdirSync(MEDIA_DIR);
    if (diskMediaFiles.length === 0) return 0;

    // Load content of all remaining articles from disk
    const allArticleTexts = [];
    if (fs.existsSync(ARTICLES_DIR)) {
      const artFiles = fs.readdirSync(ARTICLES_DIR);
      for (const f of artFiles) {
        if (f.endsWith('.json')) {
          try {
            allArticleTexts.push(fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf-8'));
          } catch (e) {}
        }
      }
    }

    const catalog = readCatalog();
    const combinedArticleData = allArticleTexts.join(' ') + ' ' + JSON.stringify(catalog);
    let unlinkedCount = 0;

    diskMediaFiles.forEach(mediaFile => {
      // Check if media filename is referenced by any remaining article
      if (!combinedArticleData.includes(mediaFile)) {
        const fullPath = path.join(MEDIA_DIR, mediaFile);
        try {
          fs.unlinkSync(fullPath);
          unlinkedCount++;
          console.log(`[Host Server GC] Unlinked orphaned media file from disk: ${mediaFile}`);
        } catch (e) {}
      }
    });

    return unlinkedCount;
  } catch (err) {
    console.error('[Host Server GC] Error cleaning orphaned media:', err);
    return 0;
  }
}

// API Routes

// 1. GET /api/catalog
app.get('/api/catalog', (req, res) => {
  const catalog = readCatalog();
  res.json({ success: true, ...catalog });
});

// 2. POST /api/articles - Save/Update Article on Disk
app.post('/api/articles', (req, res) => {
  try {
    const article = req.body;
    if (!article || !article.id) {
      return res.status(400).json({ success: false, error: 'Article ID is required' });
    }

    const safeId = String(article.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const articlePath = path.join(ARTICLES_DIR, `${safeId}.json`);

    // Write physical article file to disk
    fs.writeFileSync(articlePath, JSON.stringify(article, null, 2), 'utf-8');

    // Update catalog
    const catalog = readCatalog();
    const idx = catalog.articles.findIndex(a => a.id === article.id);
    if (idx >= 0) {
      catalog.articles[idx] = article;
    } else {
      catalog.articles.push(article);
    }
    if (article.folder && !catalog.folders.includes(article.folder)) {
      catalog.folders.push(article.folder);
    }
    saveCatalog(catalog);

    console.log(`[Host Server] Saved article "${article.title}" to disk (${safeId}.json)`);
    res.json({ success: true, article });
  } catch (err) {
    console.error('[Host Server] Error saving article:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. DELETE /api/articles/:id - Physical Hardware File Deletion & Media GC
app.delete('/api/articles/:id', (req, res) => {
  try {
    const targetId = req.params.id;
    const safeId = String(targetId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const articlePath = path.join(ARTICLES_DIR, `${safeId}.json`);

    // 1. Delete physical JSON file from disk if it exists
    if (fs.existsSync(articlePath)) {
      fs.unlinkSync(articlePath);
      console.log(`[Host Server] Hardware deletion: Unlinked ${articlePath}`);
    }

    // 2. Remove article entry from library.json
    const catalog = readCatalog();
    catalog.articles = catalog.articles.filter(a => a.id !== targetId);
    saveCatalog(catalog);

    // 3. Perform Media Garbage Collection to remove orphaned images/videos
    const cleanedMediaCount = cleanOrphanedMedia();

    res.json({ success: true, deletedId: targetId, cleanedMediaCount });
  } catch (err) {
    console.error('[Host Server] Error deleting article from disk:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. POST /api/import-zip - Unpack & Save Package directly to host disk
app.post('/api/import-zip', upload.single('zipFile'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No ZIP file uploaded' });
    }

    const zip = await JSZip.loadAsync(req.file.buffer);
    const catalog = readCatalog();
    let newArticles = [];

    // Extract media files directly to MEDIA_DIR on disk
    const mediaFiles = zip.filter((relPath, fileObj) => relPath.startsWith('media/') && !fileObj.dir);
    for (const mFile of mediaFiles) {
      const baseName = mFile.name.replace(/^media\//, '');
      const mediaOutPath = path.join(MEDIA_DIR, baseName);
      const fileBuffer = await mFile.async('nodebuffer');
      fs.writeFileSync(mediaOutPath, fileBuffer);
    }
    console.log(`[Host Server] Extracted ${mediaFiles.length} media files directly to ${MEDIA_DIR}`);

    // Check for folder-manifest.json
    const manifestFile = zip.file('folder-manifest.json');
    if (manifestFile) {
      const manifestText = await manifestFile.async('string');
      const manifest = JSON.parse(manifestText);
      const folderName = manifest.folderName || 'Imported Package';
      if (!catalog.folders.includes(folderName)) catalog.folders.push(folderName);

      newArticles = (manifest.articles || []).map(art => ({
        ...art,
        folder: art.folder || folderName,
        fetched: art.fetched !== undefined ? art.fetched : true
      }));
    } else {
      // Single markdown or generic ZIP package
      const mdFiles = zip.filter((relPath, fileObj) => relPath.endsWith('.md') && !fileObj.dir);
      const packageName = (req.file.originalname || 'Imported ZIP').replace(/\.zip$/i, '');
      if (!catalog.folders.includes(packageName)) catalog.folders.push(packageName);

      for (const mdFile of mdFiles) {
        const content = await mdFile.async('string');
        const title = mdFile.name.replace(/\.md$/i, '').replace(/^.*\//, '');
        const id = 'art-zip-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
        newArticles.push({
          id,
          title,
          folder: packageName,
          fetched: true,
          date: new Date().toISOString().split('T')[0],
          markdown: content,
          html: `<article class="article-content"><h1>${title}</h1></article>`
        });
      }
    }

    // Save each imported article as physical file on disk
    for (const art of newArticles) {
      const safeId = String(art.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      fs.writeFileSync(path.join(ARTICLES_DIR, `${safeId}.json`), JSON.stringify(art, null, 2), 'utf-8');

      const existingIdx = catalog.articles.findIndex(a => a.id === art.id);
      if (existingIdx >= 0) {
        catalog.articles[existingIdx] = art;
      } else {
        catalog.articles.push(art);
      }
    }

    saveCatalog(catalog);
    res.json({ success: true, importedCount: newArticles.length, catalog });
  } catch (err) {
    console.error('[Host Server] Error importing ZIP to disk:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. DELETE /api/folders - Cascading Hardware Deletion & Media GC
app.delete('/api/folders', (req, res) => {
  try {
    const { folderName } = req.body;
    if (!folderName) {
      return res.status(400).json({ success: false, error: 'folderName is required' });
    }

    const catalog = readCatalog();
    const articlesToDelete = catalog.articles.filter(a => a.folder === folderName);

    // Physically unlink each article JSON file on disk
    for (const art of articlesToDelete) {
      const safeId = String(art.id).replace(/[^a-zA-Z0-9_-]/g, '_');
      const filePath = path.join(ARTICLES_DIR, `${safeId}.json`);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
    }

    // Remove folder and articles from catalog
    catalog.articles = catalog.articles.filter(a => a.folder !== folderName);
    catalog.folders = catalog.folders.filter(f => f !== folderName);
    if (!catalog.folders.includes('Uncategorized')) catalog.folders.push('Uncategorized');

    saveCatalog(catalog);

    // Perform Media Garbage Collection to delete unreferenced media files
    const cleanedMediaCount = cleanOrphanedMedia();

    console.log(`[Host Server] Hardware deletion: Removed folder "${folderName}", ${articlesToDelete.length} articles, and ${cleanedMediaCount} media files from disk.`);
    res.json({ success: true, deletedFolder: folderName, cleanedMediaCount });
  } catch (err) {
    console.error('[Host Server] Error deleting folder from disk:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. POST /api/clean-orphaned-media - Run manual Media GC
app.post('/api/clean-orphaned-media', (req, res) => {
  const cleanedCount = cleanOrphanedMedia();
  res.json({ success: true, cleanedMediaCount: cleanedCount });
});

// 6. POST /api/clear-all - Wipe all user files from disk
app.post('/api/clear-all', (req, res) => {
  try {
    // Unlink all article files
    if (fs.existsSync(ARTICLES_DIR)) {
      const files = fs.readdirSync(ARTICLES_DIR);
      files.forEach(f => {
        try { fs.unlinkSync(path.join(ARTICLES_DIR, f)); } catch (e) {}
      });
    }

    // Unlink all media files
    if (fs.existsSync(MEDIA_DIR)) {
      const files = fs.readdirSync(MEDIA_DIR);
      files.forEach(f => {
        try { fs.unlinkSync(path.join(MEDIA_DIR, f)); } catch (e) {}
      });
    }

    // Reset library.json
    const initialData = { folders: ['Uncategorized'], articles: [] };
    fs.writeFileSync(LIBRARY_JSON_PATH, JSON.stringify(initialData, null, 2), 'utf-8');

    console.log('[Host Server] Hardware deletion: Cleared all saved articles and media from disk.');
    res.json({ success: true });
  } catch (err) {
    console.error('[Host Server] Error clearing library on disk:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`[Coursology Host Server] Running on http://localhost:${PORT}`);
  console.log(`[Disk Storage] Articles: ${ARTICLES_DIR}`);
  console.log(`[Disk Storage] Media:    ${MEDIA_DIR}`);
  console.log(`=======================================================`);
});
