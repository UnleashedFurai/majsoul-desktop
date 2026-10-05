'use strict'

const { app, BrowserWindow, session, dialog } = require('electron')
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const net = require('net')
const path = require('path')

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'

const REPO_DIR = __dirname
const CONFIG_DIR = path.join(
	process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
	'majsoul'
)
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

// Runtime layout:
//   - Dev:   persistent venv + repo MajsoulMax (fast iteration)
//   - Prod:  throwaway temp dir per launch. The bundled standalone Python
//            hardcodes its stdlib location relative to the AppImage mount
//            point, which changes on every launch, so any venv built from
//            it is unusable the next run anyway.
let RUNTIME_DIR, MM_DIR, VENV_DIR
if (isDev) {
	RUNTIME_DIR = REPO_DIR
	MM_DIR = path.join(REPO_DIR, 'MajsoulMax')
	VENV_DIR = path.join(REPO_DIR, 'venv')
} else {
	RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'majsoul-'))
	MM_DIR = path.join(RUNTIME_DIR, 'MajsoulMax')
	VENV_DIR = path.join(RUNTIME_DIR, 'venv')
}

// Bundled Python path (only in production)
const BUNDLED_PYTHON_PATH = isDev
	? null
	: path.join(process.resourcesPath, 'python', 'bin', 'python3')

// Server definitions
const SERVERS = {
	jp: {
		name: 'Japan (JP)',
		url: 'https://game.mahjongsoul.com/index.html',
	},
	cn: {
		name: 'China (CN)',
		url: 'https://game.maj-soul.com/',
	},
	en: {
		name: 'Global (EN)',
		url: 'https://mahjongsoul.game.yo-star.com/',
	},
}

const DEFAULTS = {
	port: 23410,
	server: 'en',
	width: 1280,
	height: 720,
}

console.log('[setup] Starting mitmproxy & app...')

// IMPORTANT: These switches MUST be set BEFORE app.whenReady() fires
// They disable ALL certificate verification for proxied HTTPS connections
app.commandLine.appendSwitch('ignore-certificate-errors')
app.commandLine.appendSwitch('allow-running-insecure-content')
app.commandLine.appendSwitch('disable-web-security')

console.log('[cert] Certificate verification disabled for mitmproxy')

// Ensure directories exist
fs.mkdirSync(CONFIG_DIR, { recursive: true })

// Helper to check if a command exists
function commandExists(cmd) {
	try {
		execSync(`command -v "${cmd}"`, { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
}

// Recursively copy a directory
function copyDir(src, dest) {
	fs.mkdirSync(dest, { recursive: true })
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const s = path.join(src, entry.name)
		const d = path.join(dest, entry.name)
		if (entry.isDirectory()) copyDir(s, d)
		else fs.copyFileSync(s, d)
	}
}

// Deploy bundled MajsoulMax
function deployResources() {
	if (isDev) return

	// The AppImage mount is read-only, copy MajsoulMax to runtime dir
	console.log('[setup] Deploying MajsoulMax to temp dir...')
	copyDir(path.join(process.resourcesPath, 'MajsoulMax'), MM_DIR)
}

// Load config
function loadConfig() {
	let cfg = { ...DEFAULTS }
	if (fs.existsSync(CONFIG_FILE)) {
		try {
			const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
			cfg = Object.assign(cfg, loaded)

			// Backwards compat
			if (cfg.url && !cfg.server) {
				if (cfg.url.includes('yo-star')) cfg.server = 'en'
				else if (cfg.url.includes('game.mahjongsoul.com')) cfg.server = 'jp'
				else if (cfg.url.includes('maj-soul.com')) cfg.server = 'cn'
				delete cfg.url
			}

			if (!SERVERS[cfg.server]) {
				console.warn('[WARN] Invalid server "' + cfg.server + '" in config, resetting to EN')
				cfg.server = 'en'
			}

			return cfg
		} catch (err) {
			console.warn('[WARN] Corrupted config.json, resetting to defaults')
			return { ...DEFAULTS }
		}
	}
	return cfg
}

// Check if this is first run
function isFirstRun(cfg) {
	return !fs.existsSync(CONFIG_FILE)
}

// Server selection dialog
async function showServerSelection() {
	console.log('[config] First-run detected, showing server selection dialog...')

	const result = await dialog.showMessageBox(null, {
		type: 'question',
		title: 'Select Game Server',
		message: 'Please choose your game server:',
		detail: 'You can change this later via right-click menu.',
		buttons: [
			'Japan (JP)',
			'China (CN)',
			'Global (EN)',
		],
		defaultId: 2,
		cancelId: -1,
	})

	if (result.response >= 0 && result.response < 3) {
		return Object.keys(SERVERS)[result.response]
	}

	console.error('[ERROR] User closed dialog without selecting server')
	return null
}

// A venv is considered complete only if all the binaries we depend on exist
function venvReady() {
	return fs.existsSync(path.join(VENV_DIR, 'bin', 'python3')) &&
		fs.existsSync(path.join(VENV_DIR, 'bin', 'pip')) &&
		fs.existsSync(path.join(VENV_DIR, 'bin', 'mitmdump'))
}

// Find or create Python environment
async function ensurePythonEnv() {
	// Fast path: dev mode, venv persists across runs
	if (isDev && venvReady()) {
		console.log('[setup] Existing dev venv found, skipping setup')
		return true
	}

	// In production, venv is always fresh (temp dir), so no need to check

	// Determine which Python interpreter to use
	let pythonInterpreter = null

	if (isDev) {
		if (!commandExists('python3')) {
			console.error('[ERROR] python3 not found on system')
			dialog.showErrorBox('Missing Dependency', 'python3 is not installed on your system.')
			return false
		}
		pythonInterpreter = 'python3'
	} else {
		// Production: try bundled python first, fallback to system
		if (BUNDLED_PYTHON_PATH && fs.existsSync(BUNDLED_PYTHON_PATH)) {
			console.log('[setup] Using bundled Python...')
			pythonInterpreter = BUNDLED_PYTHON_PATH
		} else if (commandExists('python3') && commandExists('pip3')) {
			console.log('[setup] Bundled Python unavailable, falling back to system Python...')
			pythonInterpreter = 'python3'
		} else {
			console.error('[ERROR] Python is not available')
			dialog.showErrorBox(
				'Missing Dependency',
				'Python is required.\n\n' +
					'Please ensure both \'python3\' and \'pip\' are installed.\n' +
					'If you are using an AppImage, please report a bug.'
			)
			return false
		}
	}

	const expectedVenvPython = path.join(VENV_DIR, 'bin', 'python3')

	// Remove any partial/old venv
	if (fs.existsSync(VENV_DIR)) {
		console.log('[setup] Removing old venv...')
		fs.rmSync(VENV_DIR, { recursive: true, force: true })
	}

	// Create venv
	console.log('[setup] Creating Python venv...')

	const venvFlags = isDev ? [] : ['--copies']  // Only in production

	try {
		execSync(`"${pythonInterpreter}" -m venv ${venvFlags.join(' ')} "${VENV_DIR}"`, { stdio: 'inherit' })

		if (!fs.existsSync(expectedVenvPython)) {
			throw new Error('Venv python3 not found after creation')
		}
	} catch (err) {
		console.warn('[WARN] --copies failed, retrying without it...')
		execSync(`"${pythonInterpreter}" -m venv "${VENV_DIR}"`, { stdio: 'inherit' })
	}

	// Verify venv was created correctly
	if (!fs.existsSync(expectedVenvPython)) {
		console.error('[ERROR] Venv creation did not produce expected python3 binary')
		console.error('[DEBUG] Looking in:', VENV_DIR, 'Contents:')
		try {
			const binDir = path.join(VENV_DIR, 'bin')
			if (fs.existsSync(binDir)) {
				console.error(fs.readdirSync(binDir).join(', '))
			} else {
				console.error('[DEBUG] bin/ directory does not exist')
			}
		} catch (readErr) {
			console.error('[DEBUG] Could not read bin directory:', readErr.message)
		}
		dialog.showErrorBox('Setup Failed', 'Venv creation failed - python3 binary not found.')
		return false
	}

	// Install pip
	if (!isDev) {
		// PRODUCTION: use bundled wheel (no network required)
		console.log('[setup] Installing pip from bundled wheel...')

		let pipFiles = []
		try {
			const pipDir = path.join(process.resourcesPath, 'pip')
			if (fs.existsSync(pipDir)) {
				pipFiles = fs.readdirSync(pipDir).filter(f => f.endsWith('.whl'))
			}
		} catch (err) {
			console.warn('[WARN] Could not read bundled pip directory:', err.message)
		}

		if (pipFiles.length === 0) {
			console.error('[ERROR] Bundled pip wheel not found')
			dialog.showErrorBox('Setup Failed', 'Bundled pip wheel missing.')
			return false
		}

		const pipWheelPath = path.join(process.resourcesPath, 'pip', pipFiles[0])
		console.log('[setup] Found pip wheel:', pipWheelPath)

		try {
			// Method 1: Use python -m ensurepip (might work with some standalone builds)
			try {
				execSync(`"${expectedVenvPython}" -m ensurepip --upgrade`, { stdio: 'inherit' })
				console.log('[setup] Installed pip via ensurepip')
			} catch (ensurepipErr) {
				console.log('[setup] ensurepip not available, trying direct wheel install...')

				// Method 2: Run the wheel as a script
				execSync(`"${expectedVenvPython}" "${pipWheelPath}"`, {
					stdio: 'inherit',
					env: { ...process.env, VIRTUALENV_NO_DOWNLOAD: '1' }
				})
			}

			// Verify pip was installed
			if (!fs.existsSync(path.join(VENV_DIR, 'bin', 'pip'))) {
				throw new Error('pip binary not found after installation')
			}
		} catch (err) {
			console.error('[ERROR] Failed to install pip:', err.message)
			dialog.showErrorBox('Setup Failed', 'Failed to install pip from bundled wheel.')
			return false
		}
	} else {
		// DEV MODE: try ensurepip first (bundled with Python), then get-pip.py
		console.log('[setup] Bootstrapping pip in dev venv...')
		
		try {
			// Try ensurepip (comes bundled with Python, works even if system has no pip)
			execSync(`"${expectedVenvPython}" -m ensurepip --upgrade`, { stdio: 'inherit' })
			console.log('[setup] Pip bootstrapped via ensurepip')
		} catch (ensurepipErr) {
			console.log('[setup] ensurepip failed, trying get-pip.py...')
			
			// Download and run get-pip.py
			try {
				const getpipScript = path.join(os.tmpdir(), 'get-pip.py')
				execSync(`curl -o "${getpipScript}" https://bootstrap.pypa.io/get-pip.py`, { stdio: 'inherit' })
				execSync(`"${expectedVenvPython}" "${getpipScript}"`, { stdio: 'inherit' })
				console.log('[setup] Pip bootstrapped via get-pip.py')
			} catch (getpipErr) {
				console.error('[ERROR] Failed to bootstrap pip in dev mode:', getpipErr.message)
				dialog.showErrorBox(
					'Setup Failed',
					'Failed to bootstrap pip. Please install pip:\n\n' +
						'Arch:   pacman -S python-pip\n' +
						'Ubuntu: apt install python3-pip\n' +
						'Fedora: dnf install python3-pip'
				)
				return false
			}
		}
	}

	// Install requirements
	console.log('[setup] Installing mitmproxy requirements...')
	const reqPath = path.join(MM_DIR, 'requirements.txt')
	try {
		execSync(
			`"${VENV_DIR}/bin/pip" install --upgrade pip`,
			{ stdio: 'inherit' }
		)
		execSync(
			`"${VENV_DIR}/bin/pip" install -r "${reqPath}"`,
			{ stdio: 'inherit' }
		)
	} catch (err) {
		console.error('[ERROR] Failed to install requirements:', err.message)
		dialog.showErrorBox('Setup Failed', 'Failed to install mitmproxy dependencies.')
		return false
	}

	// Verify final result
	if (!fs.existsSync(path.join(VENV_DIR, 'bin', 'mitmdump'))) {
		console.error('[ERROR] mitmdump not found after setup')
		dialog.showErrorBox('Setup Failed', 'mitmproxy was not installed correctly.')
		return false
	}

	return true
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

// Error handlers
process.on('uncaughtException', err => {
	console.error('[UNCAUGHT]', err.stack)
	process.exit(1)
})

process.on('unhandledRejection', (reason, p) => {
	console.error('[UNHANDLED]', reason, 'at', p)
})

// Main function
async function main() {
	// Load config
	let cfg = loadConfig()
	const needsServerSelection = isFirstRun(cfg)

	// Deploy MajsoulMax
	deployResources()

	// Ensure Python environment exists
	const envOk = await ensurePythonEnv()
	if (!envOk) {
		app.quit()
		return
	}

	// Start mitmdump from the venv
	console.log('[mitmdump] Starting proxy...')
	const mitm = spawn(path.join(VENV_DIR, 'bin', 'mitmdump'), [
		'-p', String(cfg.port),
		'-s', 'addons.py'
	], { cwd: MM_DIR })

	mitm.stdout.on('data', d => process.stdout.write(`[mitmdump] ${d}`))
	mitm.stderr.on('data', d => process.stderr.write(`[mitmdump] ${d}`))
	mitm.on('error', err => {
		console.error('[mitmdump] failed to spawn:', err.message)
	})
	mitm.on('exit', code => {
		console.log(`[mitmdump] exited (${code})`)
		if (code !== 0 && code !== null) {
			dialog.showErrorBox(
				'Mitmproxy Exited',
				'Mitmproxy crashed during startup. Unowned gacha elements will not be unlocked.'
			)
		}
	})

	// Show server selection if needed
	if (needsServerSelection) {
		const selectedServer = await showServerSelection()
		if (!selectedServer) {
			console.error('[ERROR] No server selected, exiting')
			mitm.kill('SIGKILL')
			app.quit()
			return
		}

		cfg.server = selectedServer
		console.log('[config] User selected:', SERVERS[cfg.server].name)
		fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
	}

	// Get resolved URL
	const serverInfo = SERVERS[cfg.server]
	const gameUrl = serverInfo.url

	console.log('[config] Selected server:', serverInfo.name, '(' + cfg.server + ')')
	console.log('[config] Resolved URL:', gameUrl)

	// Wait for proxy
	console.log('[app] Waiting for proxy...')
	if (!(await waitForProxy(cfg.port))) {
		console.error('[ERROR] Proxy never started!')
		mitm.kill('SIGKILL')
		app.quit()
		return
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
		console.log('[SUCCESS] Page loaded:', gameUrl)
		win.show()
	})

	win.webContents.on('dom-ready', () => {
		console.log('[DOM READY] Page content loaded')
	})

	win.loadURL(gameUrl)

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

	// Context menu for server switching
	const { Menu, MenuItem } = require('electron')
	const contextMenu = new Menu()
	contextMenu.append(new MenuItem({
		label: 'Change Server...',
		click: async () => {
			const result = await dialog.showMessageBox(null, {
				type: 'question',
				title: 'Select Game Server',
				message: 'Current: ' + SERVERS[cfg.server].name + '\nChoose new server:',
				buttons: Object.entries(SERVERS).map(([key, val]) => val.name),
				defaultId: Object.keys(SERVERS).indexOf(cfg.server),
			})
			const newServer = Object.keys(SERVERS)[result.response]
			if (newServer) {
				cfg.server = newServer
				fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
				dialog.showMessageBox(win, {
					type: 'info',
					title: 'Server Changed',
					message: 'Server changed to ' + SERVERS[newServer].name + '. Please restart the app.',
				})
			}
		},
	}))
	contextMenu.append(new MenuItem({ type: 'separator' }))
	contextMenu.append(new MenuItem({
		label: 'Reload Page',
		accelerator: 'CmdOrCtrl+R',
		click: () => win.reload()
	}))

	win.webContents.on('context-menu', (e, params) => {
		contextMenu.popup({ window: win, x: params.x, y: params.y })
	})

	app.on('window-all-closed', () => app.quit())
	app.on('before-quit', () => {
		console.log('[quit] Shutting down...')
		mitm && mitm.kill('SIGTERM')

		// Remove the per-run temp dir (prod only)
		if (!isDev) {
			try {
				fs.rmSync(RUNTIME_DIR, { recursive: true, force: true })
			} catch (err) {
				console.warn('[quit] Could not clean up temp dir:', err.message)
			}
		}
	})
}

// Wrap everything in app.whenReady()
app.whenReady().then(main).catch(err => {
	console.error('[CRITICAL ERROR]', err.stack)
	app.quit()
})
