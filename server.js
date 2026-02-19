const express = require('express');
const path = require('path');
const http = require('http');
const { exec, execFile } = require('child_process');
const multer = require('multer');
const fs = require('fs');
const config = require('./config');

// ── Markdown / text → PDF conversion ─────────────────────────────────────────
const PDF_STYLE = path.join(__dirname, 'pdf-style.css');

async function convertToPdf(srcPath, destPdfPath) {
  return new Promise((resolve, reject) => {
    const ext = path.extname(srcPath).toLowerCase();
    const tmpHtml = srcPath + '.tmp.html';
    const srcDir  = path.dirname(srcPath);
    const srcBase = path.basename(srcPath, ext);
    const date    = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // Step 1 – pandoc: md/txt → standalone HTML with metadata header
    const pandocArgs = [
      srcPath,
      '-f', ext === '.md' ? 'markdown' : 'plain',
      '-t', 'html5',
      '--standalone',
      '--metadata', `title=${srcBase.replace(/_/g, ' ')}`,
      '--metadata', `date=${date}`,
      '-o', tmpHtml
    ];

    execFile('pandoc', pandocArgs, (pandocErr) => {
      if (pandocErr) return reject(new Error(`pandoc: ${pandocErr.message}`));

      // Inject our stylesheet link into the <head>
      try {
        let html = fs.readFileSync(tmpHtml, 'utf-8');
        const styleLink = `<link rel="stylesheet" href="${PDF_STYLE}">`;
        html = html.replace('</head>', `${styleLink}\n</head>`);
        fs.writeFileSync(tmpHtml, html);
      } catch (e) { /* non-fatal – continue without custom styles */ }

      // Step 2 – weasyprint: HTML → PDF
      execFile('weasyprint', [tmpHtml, destPdfPath], (wpErr) => {
        try { fs.unlinkSync(tmpHtml); } catch (_) {}
        if (wpErr) return reject(new Error(`weasyprint: ${wpErr.message}`));
        resolve(destPdfPath);
      });
    });
  });
}

const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/events' });
const PORT = config.port;

// MiniMax proxy for OpenClaw integration
const minimaxProxy = require('./minimax-proxy');
app.use('/minimax', minimaxProxy);

// Configure multer for document uploads
const documentsPath = path.join(__dirname, 'public', 'documents');
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Ensure documents directory exists
    if (!fs.existsSync(documentsPath)) {
      fs.mkdirSync(documentsPath, { recursive: true });
    }
    cb(null, documentsPath);
  },
  filename: (req, file, cb) => {
    // Keep original filename (basename only), replace spaces with underscores,
    // and strip any path separators to prevent weird/unsafe paths.
    const originalBase = path.basename(file.originalname);
    let safeName = originalBase
      .replace(/\s+/g, '_')
      .replace(/[\\/]/g, '_')
      .replace(/\0/g, '');

    // Prevent special path names that could escape the documents folder on some FS operations
    if (!safeName || safeName === '.' || safeName === '..') {
      safeName = `upload_${Date.now()}`;
    }

    cb(null, safeName);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    // Accept common document types
    const allowedTypes = [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];
    const allowedExts = ['.pdf', '.txt', '.md', '.jpg', '.jpeg', '.png', '.gif', '.webp', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedTypes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not allowed: ${file.mimetype}`));
    }
  }
});

app.use(express.json());

// Secure document serving (prevents path traversal and blocks symlink escapes)
app.get('/documents/:filename', (req, res) => {
  const { filename } = req.params;
  const docsRoot = path.join(__dirname, 'public', 'documents');
  const resolved = resolveDocumentPathOrNull(docsRoot, filename);
  if (!resolved) {
    return res.status(400).send('Invalid filename');
  }

  try {
    if (!fs.existsSync(resolved)) {
      return res.status(404).send('File not found');
    }

    // Block symlinks (defense-in-depth)
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink() || !st.isFile()) {
      return res.status(400).send('Invalid file');
    }

    return res.sendFile(resolved);
  } catch (err) {
    return res.status(500).send('Failed to serve file');
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// --- PIN Authentication (server-side) ---
app.post('/api/auth', (req, res) => {
  const { pin } = req.body;
  if (typeof pin !== 'string') return res.status(400).json({ success: false, error: 'PIN required' });
  if (pin === config.pin) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Incorrect PIN' });
  }
});

// --- Public config (non-sensitive values for frontend) ---
app.get('/api/config', (req, res) => {
  res.json({
    title: config.title,
    agents: config.coreAgentIds,
    kanbanEnabled: config.kanban.enabled,
    vpsEnabled: config.vps.enabled,
  });
});

// Get OpenClaw status
app.get('/api/status', async (req, res) => {
  exec('openclaw status --json 2>/dev/null || openclaw status 2>&1 | head -50', (err, stdout) => {
    try {
      const json = JSON.parse(stdout);
      res.json(json);
    } catch {
      res.json({ raw: stdout, parsed: false });
    }
  });
});

// Get cron jobs
app.get('/api/cron', async (req, res) => {
  exec('openclaw cron list --json 2>/dev/null', (err, stdout) => {
    try {
      const json = JSON.parse(stdout);
      res.json(json);
    } catch {
      res.json({ jobs: [], error: stdout });
    }
  });
});

// Get external IP address
app.get('/api/external-ip', async (req, res) => {
  const https = require('https');
  https.get('https://api.ipify.org?format=json', (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      try {
        const json = JSON.parse(data);
        res.json({ ip: json.ip, timestamp: new Date().toISOString() });
      } catch {
        res.json({ error: 'Failed to get external IP' });
      }
    });
  }).on('error', (err) => {
    res.json({ error: err.message });
  });
});

// Proxy to Kanban API
app.get('/api/tasks', async (req, res) => {
  if (!config.kanban.enabled) return res.json({ todo: [], inprogress: [], done: [], error: 'Kanban not configured' });
  http.get(`${config.kanban.url}/api/tasks`, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      try {
        res.json(JSON.parse(data));
      } catch {
        res.json({ error: 'Failed to parse tasks' });
      }
    });
  }).on('error', (err) => {
    res.json({ error: err.message });
  });
});

// Move task
app.put('/api/tasks/:id', async (req, res) => {
  if (!config.kanban.enabled) return res.json({ error: 'Kanban not configured' });
  const { id } = req.params;
  const { fromColumn, toColumn } = req.body;
  const kanbanUrl = new URL(config.kanban.url);

  const data = JSON.stringify({ fromColumn, toColumn });
  const options = {
    hostname: kanbanUrl.hostname,
    port: kanbanUrl.port || 3000,
    path: `/api/tasks/${id}`,
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };
  
  const request = http.request(options, (response) => {
    let body = '';
    response.on('data', chunk => body += chunk);
    response.on('end', () => res.json(JSON.parse(body)));
  });
  request.on('error', (err) => res.json({ error: err.message }));
  request.write(data);
  request.end();
});

// Add task
app.post('/api/tasks', async (req, res) => {
  if (!config.kanban.enabled) return res.json({ error: 'Kanban not configured' });
  const { title } = req.body;
  const kanbanUrl = new URL(config.kanban.url);

  const data = JSON.stringify({ title });
  const options = {
    hostname: kanbanUrl.hostname,
    port: kanbanUrl.port || 3000,
    path: '/api/tasks',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length
    }
  };
  
  const request = http.request(options, (response) => {
    let body = '';
    response.on('data', chunk => body += chunk);
    response.on('end', () => res.json(JSON.parse(body)));
  });
  request.on('error', (err) => res.json({ error: err.message }));
  request.write(data);
  request.end();
});

// Get sessions list
app.get('/api/sessions', async (req, res) => {
  exec('openclaw sessions list --json 2>/dev/null', (err, stdout) => {
    try {
      const json = JSON.parse(stdout);
      res.json(json);
    } catch {
      res.json({ sessions: [], raw: stdout });
    }
  });
});

// Get actions log (recent activity)
app.get('/api/activity', async (req, res) => {
  if (!config.kanban.enabled) return res.json({ activity: [] });
  exec(`tail -50 "${config.kanban.actionsLog}" 2>/dev/null`, (err, stdout) => {
    const lines = stdout.trim().split('\n').filter(l => l).reverse();
    res.json({ activity: lines });
  });
});

// Get VPS actions log
app.get('/api/vps-actions-log', async (req, res) => {
  if (!config.vps.enabled) return res.json({ activity: [], error: 'VPS integration not configured' });
  const sshCmd = `ssh -i "${config.vps.sshKeyPath}" -o ConnectTimeout=${config.vps.connectTimeout} ${config.vps.username}@${config.vps.host} "tail -50 ${config.vps.remotePath} 2>/dev/null" 2>/dev/null`;
  exec(sshCmd, (err, stdout, stderr) => {
    if (err) {
      res.json({ activity: [], error: 'Could not connect to VPS' });
      return;
    }
    const lines = stdout.trim().split('\n').filter(l => l).reverse();
    res.json({ activity: lines });
  });
});

// Get SMS log (proxy to kanban server)
app.get('/api/sms-log', async (req, res) => {
  if (!config.kanban.enabled) return res.json([]);
  const limit = req.query.limit || 50;
  http.get(`${config.kanban.url}/api/sms-log?limit=${limit}`, (response) => {
    let data = '';
    response.on('data', chunk => data += chunk);
    response.on('end', () => {
      try {
        res.json(JSON.parse(data));
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse SMS log' });
      }
    });
  }).on('error', err => {
    res.status(500).json({ error: 'Failed to fetch SMS log' });
  });
});

// List documents in the documents folder
app.get('/api/documents', async (req, res) => {
  const fs = require('fs');
  const docsPath = path.join(__dirname, 'public', 'documents');
  
  try {
    if (!fs.existsSync(docsPath)) {
      fs.mkdirSync(docsPath, { recursive: true });
    }
    
    const files = fs.readdirSync(docsPath);
    const documents = files.map(file => {
      const filePath = path.join(docsPath, file);

      // Use lstat so we can detect and ignore symlinks (defense-in-depth against traversal via symlink)
      const stats = fs.lstatSync(filePath);
      if (stats.isSymbolicLink()) return null;
      if (!stats.isFile()) return null;

      const ext = path.extname(file).toLowerCase();
      return {
        name: file,
        size: stats.size,
        modified: stats.mtime,
        type: ext === '.pdf' ? 'pdf' : ext === '.md' ? 'markdown' : ext === '.txt' ? 'txt' : ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext) ? ext.slice(1) : 'other',
        // NOTE: relative URL so this works whether Mission Control is hosted at / or under /mission-control
        url: `documents/${encodeURIComponent(file)}`
      };
    }).filter(Boolean).filter(d => ['pdf', 'markdown', 'txt', 'jpg', 'jpeg', 'png', 'gif', 'webp'].includes(d.type));
    
    res.json({ documents });
  } catch (err) {
    res.json({ documents: [], error: err.message });
  }
});

// Upload document (auto-converts .md/.txt → PDF)
app.post('/api/documents/upload', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const ext = path.extname(req.file.filename).toLowerCase();
  const isText = ['.md', '.txt'].includes(ext);

  if (isText) {
    // Auto-convert to PDF
    const srcPath  = path.join(documentsPath, req.file.filename);
    const pdfName  = req.file.filename.replace(/\.[^.]+$/, '.pdf');
    const pdfPath  = path.join(documentsPath, pdfName);
    try {
      await convertToPdf(srcPath, pdfPath);
      return res.json({
        success: true,
        filename: pdfName,
        originalFilename: req.file.filename,
        size: fs.statSync(pdfPath).size,
        type: 'pdf',
        converted: true
      });
    } catch (convErr) {
      // Conversion failed – still return the original file
      console.error('PDF conversion failed:', convErr.message);
      return res.json({
        success: true,
        filename: req.file.filename,
        size: req.file.size,
        type: ext.slice(1),
        convertError: convErr.message
      });
    }
  }

  res.json({
    success: true,
    filename: req.file.filename,
    size: req.file.size,
    type: ext.slice(1)
  });
});

// Convert an existing document to PDF on demand
app.post('/api/documents/:filename/to-pdf', async (req, res) => {
  const { filename } = req.params;
  const docsRoot = path.join(__dirname, 'public', 'documents');
  const resolved = resolveDocumentPathOrNull(docsRoot, filename);
  if (!resolved) return res.status(400).json({ error: 'Invalid filename' });

  const ext = path.extname(filename).toLowerCase();
  if (!['.md', '.txt'].includes(ext)) {
    return res.status(400).json({ error: 'Only .md and .txt files can be converted' });
  }

  try {
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink() || !st.isFile()) return res.status(400).json({ error: 'Invalid file' });

    const pdfName = filename.replace(/\.[^.]+$/, '.pdf');
    const pdfPath = resolveDocumentPathOrNull(docsRoot, pdfName);
    if (!pdfPath) return res.status(400).json({ error: 'Invalid output path' });

    await convertToPdf(resolved, pdfPath);
    res.json({ success: true, pdfFilename: pdfName, size: fs.statSync(pdfPath).size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function resolveDocumentPathOrNull(docsRoot, filename) {
  if (typeof filename !== 'string' || filename.length === 0) return null;
  // Reject any path separators or attempts to smuggle paths
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) return null;
  // Ensure it's a simple basename
  if (path.basename(filename) !== filename) return null;
  const resolved = path.resolve(docsRoot, filename);
  // Containment check: prevent path traversal (e.g. ../../server.js)
  if (!resolved.startsWith(docsRoot + path.sep)) return null;
  return resolved;
}

// Rename document
app.put('/api/documents/:filename/rename', (req, res) => {
  const { filename } = req.params;
  const { newName } = req.body;
  if (!newName || typeof newName !== 'string') {
    return res.status(400).json({ error: 'Missing newName' });
  }
  const docsRoot = path.join(__dirname, 'public', 'documents');
  const resolved = resolveDocumentPathOrNull(docsRoot, filename);
  if (!resolved) return res.status(400).json({ error: 'Invalid filename' });

  // Preserve the original extension
  const ext = path.extname(filename).toLowerCase();
  const safeName = newName.replace(/\s+/g, '_').replace(/[\\/\0]/g, '').replace(/\.[^/.]+$/, '') + ext;
  const resolvedNew = resolveDocumentPathOrNull(docsRoot, safeName);
  if (!resolvedNew) return res.status(400).json({ error: 'Invalid new name' });

  try {
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink() || !st.isFile()) return res.status(400).json({ error: 'Invalid file' });
    if (fs.existsSync(resolvedNew)) return res.status(409).json({ error: 'A file with that name already exists' });

    fs.renameSync(resolved, resolvedNew);
    res.json({ success: true, oldName: filename, newName: safeName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete document
app.delete('/api/documents/:filename', (req, res) => {
  const { filename } = req.params;
  const docsRoot = path.join(__dirname, 'public', 'documents');
  const resolved = resolveDocumentPathOrNull(docsRoot, filename);
  if (!resolved) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    if (fs.existsSync(resolved)) {
      // Block symlinks and non-regular files (defense-in-depth)
      const st = fs.lstatSync(resolved);
      if (st.isSymbolicLink() || !st.isFile()) {
        return res.status(400).json({ error: 'Invalid file' });
      }

      fs.unlinkSync(resolved);
      res.json({ success: true, message: `Deleted ${filename}` });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get markdown file content (rendered as HTML)
app.get('/api/documents/:filename/content', async (req, res) => {
  const { filename } = req.params;
  const docsRoot = path.join(__dirname, 'public', 'documents');
  const resolved = resolveDocumentPathOrNull(docsRoot, filename);
  if (!resolved) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  // Only allow text-like documents to be returned via this endpoint
  const ext = path.extname(filename).toLowerCase();
  if (!['.md', '.txt'].includes(ext)) {
    return res.status(400).json({ error: 'Unsupported document type for content view' });
  }

  try {
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Block symlinks and non-regular files (defense-in-depth)
    const st = fs.lstatSync(resolved);
    if (st.isSymbolicLink() || !st.isFile()) {
      return res.status(400).json({ error: 'Invalid file' });
    }

    const content = fs.readFileSync(resolved, 'utf-8');
    res.json({ content, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MiniMax M2.5 Usage Tracker API
const minimaxTracker = require('./minimax-tracker');
minimaxTracker.initUsageFile();

// Get current MiniMax usage stats
app.get('/api/minimax/stats', (req, res) => {
  const stats = minimaxTracker.getCurrentStats();
  res.json(stats);
});

// Get historical MiniMax data (last 7 days)
app.get('/api/minimax/history', (req, res) => {
  const history = minimaxTracker.getHistoricalStats();
  res.json(history);
});

// Log a MiniMax API call
app.post('/api/minimax/log', express.json(), (req, res) => {
  const { inputTokens, outputTokens, responseTime, model } = req.body;
  
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return res.status(400).json({ error: 'Invalid input' });
  }
  
  const logEntry = minimaxTracker.logApiCall(
    inputTokens,
    outputTokens,
    responseTime || 0,
    model || 'MiniMax-M2.5'
  );
  
  res.json({ success: true, logEntry });
});

// Model Usage Stats (from OpenClaw sessions + all agent sessions.json files)
app.get('/api/model-usage', (req, res) => {
  const models = {};
  let totalTokens = 0;
  let totalSessions = 0;
  const seen = new Set();

  function addSession(s) {
    const key = s.key || s.sessionKey || '';
    if (seen.has(key)) return;
    if (key) seen.add(key);
    const model = s.model || 'unknown';
    const tokens = s.totalTokens || 0;
    if (!models[model]) models[model] = { sessions: 0, tokens: 0 };
    models[model].sessions++;
    models[model].tokens += tokens;
    totalTokens += tokens;
    totalSessions++;
  }

  // Read all agent sessions.json files directly
  const agentsDir = config.openclaw.agentsDir;
  try {
    const agents = fs.readdirSync(agentsDir);
    agents.forEach(agentId => {
      const sessFile = path.join(agentsDir, agentId, 'sessions', 'sessions.json');
      try {
        const data = JSON.parse(fs.readFileSync(sessFile, 'utf-8'));
        Object.entries(data).forEach(([key, val]) => {
          addSession({ key, model: val.model, totalTokens: val.totalTokens });
        });
      } catch {}
    });
  } catch {}

  // Also pull from CLI for any sessions not in agent dirs
  exec('openclaw sessions list --json 2>/dev/null', (err, stdout) => {
    try {
      const data = JSON.parse(stdout);
      (data.sessions || data || []).forEach(s => addSession(s));
    } catch {}

    const sorted = Object.entries(models)
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => b.tokens - a.tokens);

    res.json({ models: sorted, totalTokens, totalSessions });
  });
});

// --- Gateway Restart ---
app.post('/api/gateway/restart', (req, res) => {
  const uid = process.getuid ? process.getuid() : 502;
  exec(`launchctl kickstart -k gui/${uid}/${config.gateway.launchdLabel}`, (err, stdout, stderr) => {
    if (err) {
      // Fallback: kill and let launchd KeepAlive restart it
      exec('pkill -f openclaw-gateway', () => {});
      return res.json({ success: true, method: 'kill-restart', message: 'Gateway killed, launchd will restart it' });
    }
    res.json({ success: true, method: 'launchctl-kickstart', message: 'Gateway restarted via launchd' });
  });
});

// --- Gateway Uptime ---
app.get('/api/gateway/uptime', (req, res) => {
  exec("pgrep openclaw-gateway | head -1", (err, pidOut) => {
    const pid = (pidOut || '').trim();
    if (err || !pid || !/^\d+$/.test(pid)) return res.json({ running: false });
    let etime = '', lstart = '', done = 0;
    const finish = () => { if (++done === 2) res.json({ running: true, elapsed: etime, startedAt: lstart }); };
    exec(`ps -p ${pid} -o etime= 2>/dev/null`, (e1, out1) => { etime = (out1 || '').trim(); finish(); });
    exec(`ps -p ${pid} -o lstart= 2>/dev/null`, (e2, out2) => { lstart = (out2 || '').trim(); finish(); });
  });
});

// --- System Health ---
app.get('/api/system-health', (req, res) => {
  const commands = {
    top: "top -l 1 -n 0 -s 0 2>/dev/null | head -12",
    disk: "df -h / | tail -1",
    uptime: "uptime"
  };

  const results = {};
  let done = 0;
  const total = Object.keys(commands).length;

  Object.entries(commands).forEach(([key, cmd]) => {
    exec(cmd, (err, stdout) => {
      results[key] = stdout?.trim() || '';
      if (++done === total) {
        // Parse top output
        const cpuMatch = results.top.match(/CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle/);
        const memMatch = results.top.match(/PhysMem:\s*(\d+)M used.*?(\d+)M unused/);
        const loadMatch = results.top.match(/Load Avg:\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
        // Parse disk
        const diskParts = results.disk.split(/\s+/);
        // Parse uptime
        const uptimeMatch = results.uptime.match(/up\s+(.+?),\s+\d+ user/);

        res.json({
          cpu: {
            user: parseFloat(cpuMatch?.[1]) || 0,
            sys: parseFloat(cpuMatch?.[2]) || 0,
            idle: parseFloat(cpuMatch?.[3]) || 0,
            used: Math.round((parseFloat(cpuMatch?.[1]) || 0) + (parseFloat(cpuMatch?.[2]) || 0))
          },
          memory: {
            usedMB: parseInt(memMatch?.[1]) || 0,
            freeMB: parseInt(memMatch?.[2]) || 0,
            totalMB: (parseInt(memMatch?.[1]) || 0) + (parseInt(memMatch?.[2]) || 0),
            usedPercent: Math.round(((parseInt(memMatch?.[1]) || 0) / ((parseInt(memMatch?.[1]) || 0) + (parseInt(memMatch?.[2]) || 0))) * 100)
          },
          disk: {
            total: diskParts[1] || '?',
            used: diskParts[2] || '?',
            free: diskParts[3] || '?',
            usedPercent: parseInt(diskParts[4]) || 0
          },
          load: {
            avg1: parseFloat(loadMatch?.[1]) || 0,
            avg5: parseFloat(loadMatch?.[2]) || 0,
            avg15: parseFloat(loadMatch?.[3]) || 0
          },
          uptime: uptimeMatch?.[1]?.trim() || 'unknown'
        });
      }
    });
  });
});

// --- Agent Chat ---
app.post('/api/agent-chat', (req, res) => {
  const { agentId, message } = req.body;
  if (!agentId || !message) return res.status(400).json({ error: 'agentId and message required' });
  // Sanitize inputs for shell
  const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeMsg = message.replace(/'/g, "'\\''");
  exec(`openclaw agent --agent '${safeAgent}' --message '${safeMsg}' 2>&1`, { timeout: 120000 }, (err, stdout) => {
    res.json({ success: !err, output: stdout?.trim() || '', error: err?.message });
  });
});

// --- Cron Trigger ---
app.post('/api/cron/:id/trigger', (req, res) => {
  const { id } = req.params;
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  exec(`openclaw cron trigger '${safeId}' 2>&1 || openclaw cron run '${safeId}' 2>&1`, { timeout: 10000 }, (err, stdout) => {
    res.json({ success: !err, output: stdout?.trim() || '', error: err?.message });
  });
});

// --- Memory Search ---
app.get('/api/memory/search', (req, res) => {
  const { q, agent } = req.query;
  if (!q) return res.status(400).json({ error: 'query required' });
  const safeQ = q.replace(/'/g, "'\\''");
  const agentFlag = agent ? `--agent '${agent.replace(/[^a-zA-Z0-9_-]/g, '')}'` : '';
  exec(`openclaw memory search ${agentFlag} --json --max-results 10 '${safeQ}' 2>&1`, { timeout: 10000 }, (err, stdout) => {
    try {
      res.json({ results: JSON.parse(stdout) });
    } catch {
      res.json({ results: [], raw: stdout?.trim() });
    }
  });
});

// --- Memory Reindex ---
app.post('/api/memory/reindex', (req, res) => {
  const { agent } = req.body;
  const agentFlag = agent ? `--agent '${agent.replace(/[^a-zA-Z0-9_-]/g, '')}'` : '';
  exec(`openclaw memory index ${agentFlag} --force 2>&1`, { timeout: 30000 }, (err, stdout) => {
    res.json({ success: !err, output: stdout?.trim() || '' });
  });
});

// --- Session Explorer ---
app.get('/api/sessions/detailed', (req, res) => {
  exec('openclaw sessions list --json 2>/dev/null', (err, stdout) => {
    try {
      const data = JSON.parse(stdout);
      const sessions = (data.sessions || []).map(s => ({
        key: s.key,
        agent: s.key?.split(':')[1] || 'unknown',
        model: s.model || 'unknown',
        tokens: s.totalTokens || 0,
        inputTokens: s.inputTokens || 0,
        outputTokens: s.outputTokens || 0,
        updatedAt: s.updatedAt,
        ageMs: s.ageMs,
        contextTokens: s.contextTokens || 0
      }));
      res.json({ sessions });
    } catch {
      res.json({ sessions: [] });
    }
  });
});

// --- Agent Timeline (24h activity) ---
app.get('/api/agent-timeline', (req, res) => {
  exec('openclaw sessions list --json 2>/dev/null', (err, stdout) => {
    try {
      const data = JSON.parse(stdout);
      const sessions = data.sessions || [];
      const now = Date.now();
      const dayMs = 24 * 60 * 60 * 1000;
      const agents = {};

      sessions.forEach(s => {
        const agent = s.key?.split(':')[1] || 'unknown';
        if (!agents[agent]) agents[agent] = [];
        if (s.updatedAt && (now - s.updatedAt) < dayMs) {
          // Bucket into hourly slots
          const hour = new Date(s.updatedAt).getHours();
          agents[agent].push({ hour, tokens: s.totalTokens || 0 });
        }
      });

      // Build 24-hour grid per agent
      const timeline = Object.entries(agents).map(([agent, activity]) => {
        const hours = new Array(24).fill(0);
        activity.forEach(a => { hours[a.hour] += a.tokens; });
        return { agent, hours, totalActivity: activity.length };
      }).filter(a => a.totalActivity > 0);

      res.json({ timeline });
    } catch {
      res.json({ timeline: [] });
    }
  });
});

// --- Notifications (aggregate errors) ---
app.get('/api/notifications', (req, res) => {
  exec('openclaw cron list --json 2>/dev/null', (err, stdout) => {
    const notifications = [];
    try {
      const data = JSON.parse(stdout);
      (data.jobs || []).forEach(job => {
        if (job.state?.consecutiveErrors > 0) {
          notifications.push({
            type: 'cron_error',
            severity: job.state.consecutiveErrors >= 5 ? 'critical' : 'warning',
            title: `${job.name || job.id} failing`,
            detail: `${job.state.consecutiveErrors} consecutive errors: ${job.state.lastError || 'unknown'}`,
            timestamp: job.state.lastRunAtMs
          });
        }
      });
    } catch {}

    // Check agent-comms for recent errors
    try {
      const comms = JSON.parse(fs.readFileSync(agentCommsFile, 'utf-8'));
      comms.slice(-50).forEach(c => {
        if (c.event === 'agent.error' || c.status === 'error') {
          notifications.push({
            type: 'agent_error',
            severity: 'warning',
            title: `Agent error: ${c.from || 'unknown'}`,
            detail: c.message || c.details?.error || 'unknown error',
            timestamp: new Date(c.timestamp).getTime()
          });
        }
      });
    } catch {}

    notifications.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    res.json({ notifications: notifications.slice(0, 20), count: notifications.length });
  });
});

// Agent Communications API
const agentCommsFile = path.join(__dirname, 'agent-comms.json');

// Get agent communications log
app.get('/api/agent-comms', (req, res) => {
  try {
    const data = fs.readFileSync(agentCommsFile, 'utf-8');
    const comms = JSON.parse(data);
    // Return most recent 50 messages
    res.json({ communications: comms.slice(-50).reverse() });
  } catch (err) {
    res.json({ communications: [] });
  }
});

// Log an agent communication
app.post('/api/agent-comms', (req, res) => {
  try {
    const { from, to, message, status } = req.body;
    
    if (!from || !to || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    let comms = [];
    try {
      const data = fs.readFileSync(agentCommsFile, 'utf-8');
      comms = JSON.parse(data);
    } catch {
      comms = [];
    }
    
    const entry = {
      timestamp: new Date().toISOString(),
      from,
      to,
      message,
      status: status || 'sent'
    };
    
    comms.push(entry);
    
    // Keep last 200 messages
    if (comms.length > 200) {
      comms = comms.slice(-200);
    }
    
    fs.writeFileSync(agentCommsFile, JSON.stringify(comms, null, 2));
    
    res.json({ success: true, entry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agent Sessions - get active sessions from OpenClaw
app.get('/api/agent-sessions', (req, res) => {
  exec('openclaw sessions list --json 2>/dev/null || echo "[]"', (err, stdout, stderr) => {
    try {
      // Parse the output or return mock data if not available
      let sessions = [];
      try {
        const parsed = JSON.parse(stdout.trim());
        sessions = Array.isArray(parsed) ? parsed : (parsed.sessions || []);
      } catch {
        // Fallback - show what agents we know about
        sessions = [
          { agent: 'ops', sessionKey: 'agent:ops:main', active: true, lastActive: 'now' },
          { agent: 'default', sessionKey: 'agent:default:main', active: true, lastActive: 'now' }
        ];
      }
      res.json(sessions);
    } catch (e) {
      res.json([]);
    }
  });
});

// Agent Activity - get recent agent communications and activity
app.get('/api/agent-activity', (req, res) => {
  try {
    // Get from agent-comms file
    let activity = [];
    try {
      const data = fs.readFileSync(agentCommsFile, 'utf-8');
      const comms = JSON.parse(data);
      activity = comms.slice(-30).reverse().map(c => ({
        type: 'message',
        agent: c.from,
        content: `To ${c.to}: ${c.message}`,
        direction: 'outbound',
        timestamp: new Date(c.timestamp).toLocaleString()
      }));
    } catch {
      activity = [];
    }
    
    // Also include recent actions log entries as activity
    try {
      const actionsLog = fs.readFileSync(config.kanban.actionsLog, 'utf-8');
      const lines = actionsLog.trim().split('\n').slice(-20).reverse();
      lines.forEach(line => {
        if (line.includes('TASK_START') || line.includes('TASK_DONE')) {
          activity.push({
            type: 'task',
            agent: 'ops',
            content: line,
            direction: 'inbound',
            timestamp: line.substring(0, 20)
          });
        }
      });
    } catch {}
    
    res.json(activity.slice(0, 30));
  } catch (err) {
    res.json([]);
  }
});

// --- Agent Roster API ---
const OPENCLAW_CONFIG = config.openclaw.config;

app.get('/api/agents', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf-8'));
    const defaults = config.agents?.defaults || {};
    const agentList = (config.agents?.list || []).map(agent => ({
      id: agent.id,
      name: agent.name || agent.id,
      emoji: agent.identity?.emoji || null,
      workspace: agent.workspace || null,
      hasHeartbeat: !!agent.heartbeat,
      heartbeatInterval: agent.heartbeat?.every || null,
      model: typeof agent.model === 'string' ? agent.model :
             agent.model?.primary || defaults.model?.primary || 'unknown',
      isDefault: !!agent.default,
      isWorkflowAgent: agent.id.includes('-')
    }));
    res.json({ agents: agentList });
  } catch (err) {
    res.json({ agents: [], error: err.message });
  }
});

// --- Antfarm Workflow Runs API ---
const ANTFARM_DB = config.openclaw.antfarmDb;

app.get('/api/antfarm/runs', (req, res) => {
  const query = "SELECT id, workflow_id, task, status, created_at, updated_at FROM runs ORDER BY created_at DESC LIMIT 20;";
  exec(`sqlite3 -json "${ANTFARM_DB}" "${query}" 2>/dev/null`, (err, stdout) => {
    try {
      res.json({ runs: JSON.parse(stdout) });
    } catch {
      res.json({ runs: [] });
    }
  });
});

// --- WebSocket Event Streaming ---
const EVENTS_FILE = config.openclaw.eventsFile;
let lastEventSize = 0;

function broadcastEvent(event) {
  const message = JSON.stringify({ type: 'antfarm_event', data: event });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

function startEventTail() {
  try {
    const stats = fs.statSync(EVENTS_FILE);
    lastEventSize = stats.size;
  } catch { lastEventSize = 0; }

  fs.watchFile(EVENTS_FILE, { interval: 1000 }, (curr, prev) => {
    if (curr.size <= lastEventSize) {
      lastEventSize = curr.size;
      return;
    }
    const stream = fs.createReadStream(EVENTS_FILE, {
      start: lastEventSize,
      end: curr.size - 1,
      encoding: 'utf-8'
    });
    let buffer = '';
    stream.on('data', chunk => buffer += chunk);
    stream.on('end', () => {
      lastEventSize = curr.size;
      const lines = buffer.split('\n').filter(l => l.trim());
      lines.forEach(line => {
        try {
          broadcastEvent(JSON.parse(line));
        } catch {}
      });
    });
  });
}

// --- Agent-to-Agent Communication Monitoring ---
const CORE_AGENT_IDS = config.coreAgentIds;
const AGENTS_BASE = config.openclaw.agentsDir;
const A2A_POLL_INTERVAL = config.a2aPollInterval;

const lastSessionUpdates = {};   // { agentId: { sessionKey: updatedAt } }
const sessionFileOffsets = {};   // { filePath: byteOffset }
let a2aInitialized = false;

function broadcastA2AEvent(event) {
  const message = JSON.stringify({ type: 'agent_comms', data: event });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });

  // Persist to agent-comms.json
  let comms = [];
  try {
    comms = JSON.parse(fs.readFileSync(agentCommsFile, 'utf-8'));
  } catch { comms = []; }

  comms.push({
    timestamp: event.ts,
    from: event.fromAgent,
    to: event.toAgent || null,
    message: event.task || event.message || event.error || event.status,
    status: event.status || 'sent',
    event: event.event,
    details: event
  });

  if (comms.length > 200) comms = comms.slice(-200);

  try {
    fs.writeFileSync(agentCommsFile, JSON.stringify(comms, null, 2));
  } catch {}
}

function processSessionLine(obj, agentId) {
  if (obj.type !== 'message') return;
  const msg = obj.message;
  if (!msg) return;

  // Tool calls from assistant
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    msg.content.forEach(block => {
      if (block.type !== 'toolCall') return;
      if (block.name !== 'sessions_spawn' && block.name !== 'sessions_send') return;

      const args = block.arguments || {};
      const event = {
        ts: obj.timestamp,
        fromAgent: agentId,
        action: block.name
      };

      if (block.name === 'sessions_spawn') {
        event.event = 'agent.spawn';
        event.toAgent = args.agentId || args.label || 'subagent';
        event.task = (args.task || '').substring(0, 200);
        event.model = args.model || null;
        event.label = args.label || null;
      } else {
        event.event = 'agent.send';
        event.toAgent = args.sessionKey || args.label || '?';
        event.message = (args.message || '').substring(0, 200);
      }

      broadcastA2AEvent(event);
    });
  }

  // Tool results
  if (msg.role === 'toolResult' &&
      (msg.toolName === 'sessions_spawn' || msg.toolName === 'sessions_send')) {
    const details = msg.details || {};
    const event = {
      ts: obj.timestamp,
      fromAgent: agentId,
      action: msg.toolName,
      status: details.status || 'unknown'
    };

    if (details.status === 'error' || details.status === 'forbidden') {
      event.event = 'agent.error';
      event.error = details.error || 'unknown error';
    } else if (msg.toolName === 'sessions_spawn') {
      event.event = 'agent.spawn_ok';
      event.runId = details.runId || null;
      event.childSessionKey = details.childSessionKey || null;
    } else {
      event.event = 'agent.send_ok';
      event.runId = details.runId || null;
    }

    broadcastA2AEvent(event);
  }
}

function tailSessionFile(filePath, agentId) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch { return; }

  const prevOffset = sessionFileOffsets[filePath] || 0;
  if (stats.size <= prevOffset) {
    sessionFileOffsets[filePath] = stats.size;
    return;
  }

  const stream = fs.createReadStream(filePath, {
    start: prevOffset,
    end: stats.size - 1,
    encoding: 'utf-8'
  });

  let buffer = '';
  stream.on('data', chunk => buffer += chunk);
  stream.on('end', () => {
    sessionFileOffsets[filePath] = stats.size;
    const lines = buffer.split('\n').filter(l => l.trim());
    lines.forEach(line => {
      try {
        processSessionLine(JSON.parse(line), agentId);
      } catch {}
    });
  });
}

function pollSessionStores() {
  CORE_AGENT_IDS.forEach(agentId => {
    const sessionsPath = path.join(AGENTS_BASE, agentId, 'sessions', 'sessions.json');

    fs.readFile(sessionsPath, 'utf-8', (err, data) => {
      if (err) return;

      let sessions;
      try { sessions = JSON.parse(data); } catch { return; }

      if (!lastSessionUpdates[agentId]) {
        // First poll: record current state, set offsets to end of files
        lastSessionUpdates[agentId] = {};
        for (const [key, val] of Object.entries(sessions)) {
          lastSessionUpdates[agentId][key] = val.updatedAt;
          if (val.sessionFile) {
            try {
              sessionFileOffsets[val.sessionFile] = fs.statSync(val.sessionFile).size;
            } catch {}
          }
        }
        return;
      }

      for (const [sessionKey, sessionData] of Object.entries(sessions)) {
        const prevUpdate = lastSessionUpdates[agentId][sessionKey];
        const currUpdate = sessionData.updatedAt;

        if (currUpdate && currUpdate !== prevUpdate) {
          lastSessionUpdates[agentId][sessionKey] = currUpdate;
          if (sessionData.sessionFile) {
            tailSessionFile(sessionData.sessionFile, agentId);
          }
        }
      }
    });
  });
}

wss.on('connection', (ws) => {
  // Backfill last 50 antfarm events
  try {
    const content = fs.readFileSync(EVENTS_FILE, 'utf-8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    const recent = lines.slice(-50);
    recent.forEach(line => {
      try {
        ws.send(JSON.stringify({ type: 'antfarm_event', data: JSON.parse(line), backfill: true }));
      } catch {}
    });
  } catch {}

  // Backfill recent agent comms
  try {
    const commsData = JSON.parse(fs.readFileSync(agentCommsFile, 'utf-8'));
    commsData.slice(-30).forEach(comm => {
      ws.send(JSON.stringify({
        type: 'agent_comms',
        data: comm.details || comm,
        backfill: true
      }));
    });
  } catch {}

  ws.send(JSON.stringify({ type: 'backfill_complete' }));
});

// --- Start Server ---
server.listen(PORT, () => {
  console.log(`Mission Control running on http://localhost:${PORT}`);
  if (config.pin === '0000') {
    console.warn('WARNING: Using default PIN "0000". Set MC_PIN in your .env file for security.');
  }
  startEventTail();
  setInterval(pollSessionStores, A2A_POLL_INTERVAL);
  console.log(`Agent-to-agent monitor: polling ${CORE_AGENT_IDS.join(', ')} every ${A2A_POLL_INTERVAL / 1000}s`);
});
