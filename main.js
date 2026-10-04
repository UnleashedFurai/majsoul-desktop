'use strict'

const { app, BrowserWindow, session } = require('electron')
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')

const REPO_DIR = __dirname
const MM_DIR = path.join(REPO_DIR, 'MajsoulMax')  // ← Use bundled MajsoulMax
const VENV_DIR = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'majsoul-desktop',
    'venv'
)
const CONFIG_DIR = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'majsoul-desktop'
)
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const DEFAULTS = {
    port: 23410,
    url: 'https://game.mahjongsoul.com/index.html',
    width: 1280,
    height: 720,
}

console.log('[setup] Starting mitmproxy & app...')

// Ensure directories exist
fs.mkdirSync(CONFIG_DIR, { recursive: true })
fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true })

// Create venv if needed (only thing stored in XDG data)
const pipPath = path.join(VENV_DIR, 'bin', 'pip')
if (!fs.existsSync(pipPath)) {
    console.log('[setup] Creating venv...')
    try {
        execSync(`python3 -m venv ${VENV_DIR}`, { stdio: 'inherit' })
        console.log('[setup] Installing mitmproxy...')
        execSync(`${pipPath} install -r ${path.join(MM_DIR, 'requirements.txt')}`, { stdio: 'inherit' })
        fs.writeFileSync(path.join(VENV_DIR, 'ready'), '')
        console.log('[setup] Venv ready')
    } catch (err) {
        console.error('[ERROR] Failed to setup venv:', err.message)
        process.exit(1)
    }
}

function portOpen(port) {
    return new Promise(resolve => {
        const s = net.connect(port, '127.0.0.1')
        s.once('connect', () => { s.destroy(); resolve(true) })
        s.once('error', () => resolve(false))
    })
}

async function waitForProxy(port, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await portOpen(port)) return true
        await new Promise(r => setTimeout(r, 500))
    }
    return false
}

// Load config
let cfg = { ...DEFAULTS }
try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))) } catch (e) { /* first run */ }

// Update URL if old config exists
if (cfg.url === 'https://game.majsoul.jp/') {
    console.log('[config] Updating URL to correct JP endpoint...')
    cfg.url = 'https://game.mahjongsoul.com/index.html'
}
fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))

console.log('[config] Using config:', cfg)

// Start mitmdump (cwd is MajsoulMax dir, but files are already there)
console.log('[mitmdump] Starting on port', cfg.port)
const mitm = spawn(path.join(VENV_DIR, 'bin', 'mitmdump'), [
    '--mode', 'regular',
    '-p', String(cfg.port),
    '-s', 'addons.py',
], { cwd: MM_DIR })

mitm.stdout.on('data', d => process.stdout.write(`[mitmdump] ${d}`))
mitm.stderr.on('data', d => process.stderr.write(`[mitmdump] ${d}`))
mitm.on('exit', code => console.log(`[mitmdump] exited (${code})`))

// Error handlers
process.on('uncaughtException', err => {
    console.error('[UNCAUGHT]', err.stack)
    mitm && mitm.kill('SIGKILL')
    process.exit(1)
})

process.on('unhandledRejection', (reason, p) => {
    console.error('[UNHANDLED]', reason, 'at', p)
})

// Main async flow
;(async () => {
    console.log('[app] Waiting for proxy...')
    if (!(await waitForProxy(cfg.port))) {
        console.error('[ERROR] Proxy never started!')
        mitm.kill('SIGKILL')
        process.exit(1)
    }
    console.log('[app] Proxy ready')

    console.log('[app] Configuring session proxy...')
    await session.defaultSession.setProxy({
        proxyRules: `http://127.0.0.1:${cfg.port}`,
    })
    console.log('[app] Proxy configured')

    await new Promise(r => setTimeout(r, 1000))
    console.log('[app] Proxy settled, creating window...')

    const win = new BrowserWindow({
        width: cfg.width,
        height: cfg.height,
        show: false,
        backgroundColor: '#1a1a1a',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    })

    win.webContents.on('did-fail-load', (event, code, desc, validatedUrl) => {
        console.error('[LOAD FAILED]', code, desc, validatedUrl)
    })

    win.webContents.on('did-finish-load', () => {
        console.log('[SUCCESS] Page loaded:', cfg.url)
        win.show()
    })

    win.webContents.on('dom-ready', () => {
        console.log('[DOM READY] Page content loaded')
    })

    win.loadURL(cfg.url)

    win.once('ready-to-show', () => {
        console.log('[WINDOW READY] Window prepared for display')
        win.show()
    })

    setTimeout(() => {
        if (!win.isVisible()) {
            console.warn('[WARN] Window still hidden after 5s, forcing visible')
            win.show()
        }
    }, 5000)

    app.on('window-all-closed', () => app.quit())
    app.on('before-quit', () => {
        console.log('[quit] Shutting down...')
        mitm && mitm.kill('SIGTERM')
    })
})().catch(err => {
    console.error('[CRITICAL ERROR]', err.stack)
    mitm && mitm.kill('SIGKILL')
    process.exit(1)
})