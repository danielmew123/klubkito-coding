const http   = require('http');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT     = process.env.PORT || 4321;
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const BIN_DIR   = path.join(DATA_DIR, 'binaries');
const FILES = {
  projects: path.join(DATA_DIR, 'projects.json'),
  users:    path.join(DATA_DIR, 'users.json'),
  sessions: path.join(DATA_DIR, 'sessions.json'),
};
fs.mkdirSync(BIN_DIR, { recursive: true });

// ── DISK HELPERS ──────────────────────────────────────────────────────────────
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Load state
let projects = readJSON(FILES.projects, []);
let users    = readJSON(FILES.users,    []);
let sessions = readJSON(FILES.sessions, {}); // token -> username

function persist() {
  writeJSON(FILES.projects, projects);
  writeJSON(FILES.users,    users);
  writeJSON(FILES.sessions, sessions);
}

// ── AUTH HELPERS ──────────────────────────────────────────────────────────────
function hashPass(pass) {
  return crypto.createHash('sha256').update(pass + 'klubkito_salt').digest('hex');
}
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}
function getUser(token) {
  const username = sessions[token];
  if (!username) return null;
  return users.find(u => u.username === username) || null;
}

// ── ROUTING ───────────────────────────────────────────────────────────────────
const ROUTES = {};

function route(method, path, handler) {
  ROUTES[method + ' ' + path] = handler;
}

// Auth: register
route('POST', '/auth/register', (req, res, body) => {
  const { username, display, password } = body;
  if (!username || !password || !display) return send(res, 400, { error: 'Missing fields.' });
  if (username.length < 3) return send(res, 400, { error: 'Username must be at least 3 characters.' });
  if (password.length < 4) return send(res, 400, { error: 'Password must be at least 4 characters.' });
  if (users.find(u => u.username === username.toLowerCase())) return send(res, 409, { error: 'Username already taken.' });
  const user = { username: username.toLowerCase(), display, passwordHash: hashPass(password) };
  users.push(user);
  const token = makeToken();
  sessions[token] = user.username;
  persist();
  send(res, 200, { token, username: user.username, display: user.display });
});

// Auth: login
route('POST', '/auth/login', (req, res, body) => {
  const { username, password } = body;
  const user = users.find(u => u.username === username.toLowerCase());
  if (!user || user.passwordHash !== hashPass(password)) return send(res, 401, { error: 'Incorrect username or password.' });
  const token = makeToken();
  sessions[token] = user.username;
  persist();
  send(res, 200, { token, username: user.username, display: user.display });
});

// Auth: logout
route('POST', '/auth/logout', (req, res, body, token) => {
  if (token) { delete sessions[token]; persist(); }
  send(res, 200, { ok: true });
});

// Projects: list
route('GET', '/projects', (req, res) => {
  send(res, 200, projects);
});

// Projects: create
route('POST', '/projects', (req, res, body, token) => {
  const user = getUser(token);
  if (!user) return send(res, 401, { error: 'Not logged in.' });
  const { name, desc, lang, cat, code, icon } = body;
  if (!name || !desc) return send(res, 400, { error: 'Name and description are required.' });
  const p = {
    id: Date.now(),
    name, desc, lang: lang || 'Java', cat: cat || 'Other',
    code: code || '', icon: icon || '💻',
    author: user.display, authorUsername: user.username,
    likes: 0, likedBy: [],
    views: 0,
    createdAt: new Date().toISOString(),
  };
  projects.unshift(p);
  persist();
  send(res, 200, p);
});

// Projects: like (toggle)
route('POST', '/projects/like', (req, res, body, token) => {
  const user = getUser(token);
  if (!user) return send(res, 401, { error: 'Not logged in.' });
  const p = projects.find(x => x.id === body.id);
  if (!p) return send(res, 404, { error: 'Project not found.' });
  const already = p.likedBy.includes(user.username);
  if (already) {
    p.likes = Math.max(0, p.likes - 1);
    p.likedBy = p.likedBy.filter(u => u !== user.username);
  } else {
    p.likes++;
    p.likedBy.push(user.username);
  }
  persist();
  send(res, 200, { likes: p.likes, liked: !already });
});

// Projects: view (increment once per session handled client-side, server just accepts)
route('POST', '/projects/view', (req, res, body) => {
  const p = projects.find(x => x.id === body.id);
  if (p) { p.views++; persist(); }
  send(res, 200, { ok: true });
});

// Read entire project folder — returns all source files concatenated
route('POST', '/readdir', (req, res, body, token) => {
  const user = getUser(token);
  if (!user) return send(res, 401, { error: 'Not logged in.' });
  const dirPath = (body.path || '').trim();
  if (!dirPath) return send(res, 400, { error: 'No path provided.' });
  const allowed = ['.java','.kt','.py','.js','.ts','.go','.rs','.cpp','.c','.cs','.scala','.rb','.swift'];
  const skip = ['node_modules','.git','build','out','.gradle','.idea','__pycache__','.DS_Store'];
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return send(res, 400, { error: 'Path is not a directory.' });
  } catch { return send(res, 404, { error: 'Directory not found.' }); }
  const filePaths = [];
  function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); }
      else if (allowed.includes(path.extname(e.name).toLowerCase())) {
        filePaths.push(full);
        if (filePaths.length >= 200) return;
      }
    }
  }
  walk(dirPath, 0);
  if (filePaths.length === 0) return send(res, 400, { error: 'No source files found in that folder.' });
  const parts = [];
  let totalSize = 0;
  for (const fp of filePaths) {
    let content;
    try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    totalSize += content.length;
    if (totalSize > 500000) break;
    const rel = fp.startsWith(dirPath) ? fp.slice(dirPath.length).replace(/^\//, '') : fp;
    parts.push(`// ===== ${rel} =====\n${content}`);
  }
  const projectName = path.basename(dirPath);
  send(res, 200, { code: parts.join('\n\n'), filename: projectName, fileCount: parts.length });
});

// Read a file from disk by path
route('POST', '/readfile', (req, res, body, token) => {
  const user = getUser(token);
  if (!user) return send(res, 401, { error: 'Not logged in.' });
  const filePath = (body.path || '').trim();
  if (!filePath) return send(res, 400, { error: 'No path provided.' });
  const allowed = ['.java','.kt','.py','.js','.ts','.go','.rs','.cpp','.c','.cs','.scala','.rb','.swift','.html','.css','.json','.xml','.gradle','.txt','.md'];
  const ext = path.extname(filePath).toLowerCase();
  // If no extension, might be a directory — give a helpful error
  if (!ext) return send(res, 400, { error: 'Path looks like a folder. Use the folder picker below.' });
  if (!allowed.includes(ext)) return send(res, 400, { error: `File type "${ext}" is not allowed.` });
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) return send(res, 404, { error: `Could not read file: ${err.message}` });
    if (data.length > 500000) return send(res, 400, { error: 'File too large (max 500KB).' });
    send(res, 200, { code: data, filename: path.basename(filePath) });
  });
});

// Delete own project
route('POST', '/projects/delete', (req, res, body, token) => {
  const user = getUser(token);
  if (!user) return send(res, 401, { error: 'Not logged in.' });
  const idx = projects.findIndex(x => x.id === body.id && x.authorUsername === user.username);
  if (idx === -1) return send(res, 403, { error: 'Not found or not yours.' });
  projects.splice(idx, 1);
  persist();
  send(res, 200, { ok: true });
});

// Upload binary (base64) for a project
route('POST', '/projects/upload-binary', (req, res, body, token) => {
  const user = getUser(token);
  if (!user) return send(res, 401, { error: 'Not logged in.' });
  const p = projects.find(x => x.id === body.id && x.authorUsername === user.username);
  if (!p) return send(res, 403, { error: 'Not found or not yours.' });
  if (!body.data || !body.filename) return send(res, 400, { error: 'Missing data or filename.' });
  const allowed = ['.jar','.zip','.exe','.dmg','.apk'];
  const ext = path.extname(body.filename).toLowerCase();
  if (!allowed.includes(ext)) return send(res, 400, { error: 'Only .jar, .zip, .exe, .dmg, .apk allowed.' });
  const buf = Buffer.from(body.data, 'base64');
  if (buf.length > 150 * 1024 * 1024) return send(res, 400, { error: 'File too large (max 150MB).' });
  const filename = p.id + ext;
  fs.writeFileSync(path.join(BIN_DIR, filename), buf);
  p.binary = filename;
  p.binaryName = body.filename;
  persist();
  send(res, 200, { ok: true });
});

// Download binary
const server2 = http; // placeholder reference
route('GET', '/download', (req, res) => {
  // handled below in raw server
});

// Run code
route('POST', '/run', (req, res, body) => {
  const { code, lang } = body;
  if (!code || !lang) return send(res, 400, { stdout: '', stderr: 'Missing code or lang.', exitCode: 1 });
  runCode(lang, code, res);
});

// ── CODE RUNNER ───────────────────────────────────────────────────────────────
const TIMEOUT_MS = 60000;

// Parse a multi-file bundle (produced by /readdir) into [{name, code}]
// Format: // ===== relative/path/file.ext =====\n<content>
function parseBundle(src) {
  const parts = src.split(/^\/\/ ===== (.+?) =====$/m);
  if (parts.length < 3) return null; // not a bundle
  const files = [];
  for (let i = 1; i < parts.length; i += 2) {
    files.push({ name: parts[i].trim(), code: parts[i + 1] || '' });
  }
  return files.length ? files : null;
}

function writeBundle(files, tmpDir) {
  for (const f of files) {
    const dest = path.join(tmpDir, f.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.code);
  }
}

function runCode(lang, src, res) {
  const id     = crypto.randomBytes(6).toString('hex');
  const tmpDir = path.join(os.tmpdir(), 'klubkito-' + id);
  fs.mkdirSync(tmpDir, { recursive: true });

  const bundle = parseBundle(src);

  if (lang === 'Python') {
    if (bundle) {
      writeBundle(bundle, tmpDir);
      // Find the file with a main block or just use the first one
      const main = bundle.find(f => f.code.includes('if __name__')) || bundle[0];
      execute('python3', [path.join(tmpDir, main.name)], tmpDir, res, tmpDir);
    } else {
      const f = path.join(tmpDir, 'main.py');
      fs.writeFileSync(f, src);
      execute('python3', [f], tmpDir, res, tmpDir);
    }

  } else if (lang === 'JavaScript' || lang === 'TypeScript') {
    if (bundle) {
      writeBundle(bundle, tmpDir);
      const main = bundle.find(f => f.name.match(/index|main/i)) || bundle[0];
      execute('node', [path.join(tmpDir, main.name)], tmpDir, res, tmpDir);
    } else {
      const f = path.join(tmpDir, 'main.js');
      fs.writeFileSync(f, src);
      execute('node', [f], tmpDir, res, tmpDir);
    }

  } else if (lang === 'Java' || lang === 'Spring Boot' || lang === 'Android') {
    if (bundle) {
      writeBundle(bundle, tmpDir);
      const javaFiles = bundle.map(f => path.join(tmpDir, f.name));
      // Find the class with main method
      const mainFile = bundle.find(f => f.code.includes('public static void main')) || bundle[0];
      const clsMatch = mainFile.code.match(/public\s+class\s+(\w+)/);
      const cls = clsMatch ? clsMatch[1] : path.basename(mainFile.name, '.java');
      compile('javac', ['-cp', tmpDir, ...javaFiles], tmpDir, res, tmpDir, () => {
        execute('java', ['-cp', tmpDir, cls], tmpDir, res, tmpDir);
      });
    } else {
      const match = src.match(/public\s+class\s+(\w+)/);
      const cls   = match ? match[1] : 'Main';
      const f     = path.join(tmpDir, cls + '.java');
      fs.writeFileSync(f, src);
      compile('javac', [f], tmpDir, res, tmpDir, () => {
        execute('java', ['-cp', tmpDir, cls], tmpDir, res, tmpDir);
      });
    }

  } else if (lang === 'Kotlin') {
    const jar = path.join(tmpDir, 'out.jar');
    if (bundle) {
      writeBundle(bundle, tmpDir);
      const ktFiles = bundle.map(f => path.join(tmpDir, f.name));
      compile('kotlinc', [...ktFiles, '-include-runtime', '-d', jar], tmpDir, res, tmpDir, () => {
        execute('java', ['-jar', jar], tmpDir, res, tmpDir);
      });
    } else {
      const f = path.join(tmpDir, 'main.kt');
      fs.writeFileSync(f, src);
      compile('kotlinc', [f, '-include-runtime', '-d', jar], tmpDir, res, tmpDir, () => {
        execute('java', ['-jar', jar], tmpDir, res, tmpDir);
      });
    }

  } else if (lang === 'Go') {
    const f = path.join(tmpDir, 'main.go');
    fs.writeFileSync(f, src);
    execute('go', ['run', f], tmpDir, res, tmpDir);

  } else if (lang === 'Rust') {
    const f   = path.join(tmpDir, 'main.rs');
    const bin = path.join(tmpDir, 'main');
    fs.writeFileSync(f, src);
    compile('rustc', [f, '-o', bin], tmpDir, res, tmpDir, () => {
      execute(bin, [], tmpDir, res, tmpDir);
    });

  } else if (lang === 'C++') {
    const f   = path.join(tmpDir, 'main.cpp');
    const bin = path.join(tmpDir, 'main');
    fs.writeFileSync(f, src);
    compile('g++', [f, '-o', bin], tmpDir, res, tmpDir, () => {
      execute(bin, [], tmpDir, res, tmpDir);
    });

  } else if (lang === 'C#') {
    const f = path.join(tmpDir, 'Program.cs');
    fs.writeFileSync(f, src);
    execute('dotnet-script', [f], tmpDir, res, tmpDir);

  } else if (lang === 'Scala') {
    const f = path.join(tmpDir, 'main.scala');
    fs.writeFileSync(f, src);
    execute('scala', [f], tmpDir, res, tmpDir);

  } else {
    send(res, 200, { stdout: '', stderr: `"${lang}" execution not supported yet.`, exitCode: 1 });
    cleanup(tmpDir);
  }
}

function compile(cmd, args, cwd, res, cleanupDir, onSuccess) {
  const proc = spawn(cmd, args, { cwd });
  let out = '', err = '';
  proc.stdout.on('data', d => out += d);
  proc.stderr.on('data', d => err += d);
  const t = setTimeout(() => proc.kill('SIGKILL'), TIMEOUT_MS);
  proc.on('close', code => {
    clearTimeout(t);
    if (code !== 0) { send(res, 200, { stdout: out, stderr: err, exitCode: code }); cleanup(cleanupDir); }
    else onSuccess();
  });
  proc.on('error', e => {
    clearTimeout(t);
    send(res, 200, { stdout: '', stderr: `Could not run "${cmd}": ${e.message}\nMake sure it is installed.`, exitCode: 1 });
    cleanup(cleanupDir);
  });
}

function execute(cmd, args, cwd, res, cleanupDir) {
  const proc = spawn(cmd, args, { cwd });
  let stdout = '', stderr = '';
  proc.stdout.on('data', d => stdout += d);
  proc.stderr.on('data', d => stderr += d);
  const t = setTimeout(() => { proc.kill('SIGKILL'); stdout += '\n[killed: 10 second time limit exceeded]'; }, TIMEOUT_MS);
  proc.on('close', code => {
    clearTimeout(t);
    send(res, 200, { stdout, stderr, exitCode: code });
    cleanup(cleanupDir);
  });
  proc.on('error', e => {
    clearTimeout(t);
    send(res, 200, { stdout: '', stderr: `Could not run "${cmd}": ${e.message}\nMake sure it is installed.`, exitCode: 1 });
    cleanup(cleanupDir);
  });
}

function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

const MIME = { '.html':'text/html', '.png':'image/png', '.js':'text/javascript', '.css':'text/css', '.ico':'image/x-icon' };

const server = http.createServer((req, res) => {
  // CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type,Authorization' });
    res.end(); return;
  }

  // Static files
  // Binary download
  if (req.method === 'GET' && req.url.startsWith('/download/')) {
    const id = parseInt(req.url.split('/')[2]);
    const p = projects.find(x => x.id === id);
    if (!p || !p.binary) { res.writeHead(404); res.end('Not found'); return; }
    const filePath = path.join(BIN_DIR, p.binary);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('File not found'); return; }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${p.binaryName}"`,
        'Access-Control-Allow-Origin': '*',
      });
      res.end(data);
    });
    return;
  }

  const isApiRoute = ['/auth','/projects','/run','/readfile','/listfiles','/readdir','/download'].some(p => req.url.startsWith(p));
  if (req.method === 'GET' && !isApiRoute) {
    const safe = req.url.split('?')[0].replace(/\.\./g, '');
    const filePath = path.join(__dirname, safe === '/' ? 'index.html' : safe);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404, {'Content-Type':'text/html'}); res.end('<h2>Not found</h2>'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
      res.end(data);
    });
    return;
  }

  // API routes
  const token = (req.headers['authorization'] || '').replace('Bearer ', '');
  const key   = req.method + ' ' + req.url.split('?')[0];

  if (req.method === 'GET' && ROUTES[key]) {
    ROUTES[key](req, res, {}, token);
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body); } catch {}
      const handler = ROUTES[key];
      if (handler) handler(req, res, parsed, token);
      else send(res, 404, { error: 'Route not found: ' + key });
    });
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n✅  Klub Kito running at http://localhost:${PORT}\n`);
});
