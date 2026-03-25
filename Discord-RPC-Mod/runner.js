/**
 * Serika Discord Rich Presence Runner
 * 
 * This script runs locally to sync your Serika watch activity to Discord.
 * It authenticates with your Serika account and updates Discord Rich Presence.
 * 
 * DO NOT SHARE THIS FILE - it may contain your credentials!
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const https = require('https');
const http = require('http');
const { spawn, execSync } = require('child_process');
const net = require('net');

// ============================================================================
// Terminal Styling
// ============================================================================

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;

const colors = supportsColor
    ? {
        reset: '\x1b[0m',
        dim: '\x1b[2m',
        bright: '\x1b[1m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        white: '\x1b[37m',
    }
    : {
        reset: '',
        dim: '',
        bright: '',
        red: '',
        green: '',
        yellow: '',
        blue: '',
        magenta: '',
        cyan: '',
        white: '',
    };

function paint(text, color = colors.white) {
    return `${color}${text}${colors.reset}`;
}

function clearLine() {
    if (process.stdout.isTTY) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
    }
}

function showBanner() {
    console.clear();
    console.log(
        paint(
`╔══════════════════════════════════════╗
║        🎬 SERIKA PRESENCE            ║
║   Discord Rich Presence Runner      ║
╚══════════════════════════════════════╝`, colors.magenta)
    );
    console.log('');
}

function spinner(text) {
    const frames = ['-', '\\', '|', '/'];
    let i = 0;

    const interval = setInterval(() => {
        if (!process.stdout.isTTY) return;
        process.stdout.write(`\r${colors.dim}${frames[i++ % frames.length]} ${text}${colors.reset}`);
    }, 100);

    return () => {
        clearInterval(interval);
        if (process.stdout.isTTY) {
            process.stdout.write('\r');
            clearLine();
        }
    };
}

function statusLine(text) {
    if (process.stdout.isTTY) {
        process.stdout.write(`\r${colors.dim}${text}${colors.reset}`);
    } else {
        process.stdout.write(text + '\n');
    }
}

// Configuration
const API_URL = 'https://streaming.serika.dev';
const DISCORD_CLIENT_ID = '1467855257928335512';
const CONFIG_DIR = process.env.HOME 
    ? path.join(process.env.HOME, '.serika-presence')
    : path.join(process.env.USERPROFILE || '.', '.serika-presence');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PID_FILE = path.join(CONFIG_DIR, 'runner.pid');

const POLL_INTERVAL = 15000; // 15 seconds
const LOCAL_PORT = 6464;

// State
let config = { token: null, profileId: null, discordId: null };
let ipcSocket = null;
let isConnected = false;
let lastActivity = null;

// ============================================================================
// Utility Functions
// ============================================================================

function log(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();

    let color = colors.cyan;
    let prefix = 'ℹ️';

    if (type === 'success') {
        color = colors.green;
        prefix = '✅';
    } else if (type === 'error') {
        color = colors.red;
        prefix = '❌';
    } else if (type === 'warn') {
        color = colors.yellow;
        prefix = '⚠️';
    } else if (type === 'discord') {
        color = colors.magenta;
        prefix = '🎮';
    } else if (type === 'debug') {
        color = colors.dim;
        prefix = '•';
    }

    console.log(
        `${colors.dim}[${timestamp}]${colors.reset} ${color}${prefix} ${msg}${colors.reset}`
    );
}

function request(urlStr, options = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const protocol = url.protocol === 'https:' ? https : http;
        
        const req = protocol.request(url, {
            method: options.method || 'GET',
            headers: {
                'Content-Type': 'application/json',
                ...options.headers,
            },
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch {
                    resolve({ status: res.statusCode, data });
                }
            });
        });
        
        req.on('error', reject);
        
        if (options.body) {
            req.write(JSON.stringify(options.body));
        }
        
        req.end();
    });
}

function prompt(question) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    
    return new Promise(resolve => {
        rl.question(question, answer => {
            rl.close();
            resolve(answer);
        });
    });
}

function promptPassword(question) {
    // On Windows, stdin.setRawMode is not available — fall back to readline (password will be visible)
    if (!process.stdin.setRawMode) {
        return prompt(question);
    }
    return new Promise(resolve => {
        process.stdout.write(question);
        
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        
        let password = '';
        
        stdin.on('data', function handler(char) {
            char = char.toString();
            
            switch (char) {
                case '\n':
                case '\r':
                case '\u0004':
                    stdin.setRawMode(false);
                    stdin.removeListener('data', handler);
                    stdin.pause();
                    console.log('');
                    resolve(password);
                    break;
                case '\u0003':
                    process.exit();
                    break;
                case '\u007F':
                    password = password.slice(0, -1);
                    clearLine();
                    process.stdout.write(question + '*'.repeat(password.length));
                    break;
                default:
                    password += char;
                    process.stdout.write('*');
            }
        });
    });
}

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            return true;
        }
    } catch (e) {
        log('Failed to load config: ' + e.message, 'error');
    }
    return false;
}

function saveConfig() {
    try {
        if (!fs.existsSync(CONFIG_DIR)) {
            fs.mkdirSync(CONFIG_DIR, { recursive: true });
        }
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (e) {
        log('Failed to save config: ' + e.message, 'error');
    }
}

// ============================================================================
// Authentication
// ============================================================================

async function login() {
    console.log('');
    console.log(paint('🔐 Login to Serika', colors.bright + colors.cyan));
    console.log(paint('==================', colors.dim));
    console.log('');
    
    const email = await prompt('Email: ');
    const password = await promptPassword('Password: ');
    
    console.log('');
    const stop = spinner('Authenticating...');
    
    try {
        const res = await request(`${API_URL}/api/presence/auth`, {
            method: 'POST',
            body: { email, password },
        });

        stop();
        
        if (res.status !== 200 || !res.data.success) {
            log('Login failed: ' + (res.data.error || 'Invalid credentials'), 'error');
            return false;
        }
        
        // Get token from response
        config.token = res.data.token;
        
        log('Login successful!', 'success');
        return true;
    } catch (e) {
        stop();
        log('Login error: ' + e.message, 'error');
        return false;
    }
}

async function selectProfile() {
    log('Fetching profiles...', 'discord');
    
    try {
        const res = await request(`${API_URL}/api/presence/profiles`, {
            headers: { 'Authorization': `Bearer ${config.token}` },
        });
        
        if (res.status !== 200 || !res.data.profiles) {
            log('Failed to fetch profiles', 'error');
            return false;
        }
        
        const profiles = res.data.profiles;
        
        if (profiles.length === 0) {
            log('No profiles found. Please create a profile on the website first.', 'error');
            return false;
        }
        
        // Find profiles with Discord linked
        const linkedProfiles = profiles.filter(p => p.discordId);
        
        if (linkedProfiles.length === 0) {
            log('No profiles have Discord linked.', 'error');
            log('Please link your Discord account in Settings on the website first.', 'warn');
            return false;
        }
        
        if (linkedProfiles.length === 1) {
            config.profileId = linkedProfiles[0].id;
            config.discordId = linkedProfiles[0].discordId;
            log(`Using profile: ${linkedProfiles[0].name}`, 'success');
            return true;
        }
        
        // Multiple profiles - let user choose
        console.log('');
        console.log(paint('Select a profile:', colors.bright));
        linkedProfiles.forEach((p, i) => {
            console.log(`  ${paint(String(i + 1) + '.', colors.cyan)} ${p.name} ${paint(`(Discord: ${p.discordUsername || p.discordId})`, colors.dim)}`);
        });
        console.log('');
        
        const choice = await prompt('Enter number: ');
        const index = parseInt(choice, 10) - 1;
        
        if (index < 0 || index >= linkedProfiles.length) {
            log('Invalid selection', 'error');
            return false;
        }
        
        config.profileId = linkedProfiles[index].id;
        config.discordId = linkedProfiles[index].discordId;
        log(`Selected profile: ${linkedProfiles[index].name}`, 'success');
        return true;
    } catch (e) {
        log('Profile error: ' + e.message, 'error');
        return false;
    }
}

async function authenticate() {
    if (config.token && config.profileId && config.discordId) {
        // Verify token is still valid
        try {
            const res = await request(`${API_URL}/api/presence/auth`, {
                headers: { 'Authorization': `Bearer ${config.token}` },
            });
            
            if (res.status === 200 && res.data.user) {
                log('Session restored', 'success');
                return true;
            }
        } catch {
            // Token expired, need to re-login
        }
    }
    
    // Need to login
    if (!await login()) {
        return false;
    }
    
    if (!await selectProfile()) {
        return false;
    }
    
    saveConfig();
    return true;
}

// ============================================================================
// Discord IPC (Native - no external dependencies)
// ============================================================================

function getIPCPath(id) {
    if (process.platform === 'win32') {
        return '\\\\?\\pipe\\discord-ipc-' + id;
    }
    const prefix = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
    return path.join(prefix, 'discord-ipc-' + id);
}

function encodeIPC(opcode, data) {
    const jsonStr = JSON.stringify(data);
    const len = Buffer.byteLength(jsonStr);
    const packet = Buffer.alloc(8 + len);
    packet.writeUInt32LE(opcode, 0);
    packet.writeUInt32LE(len, 4);
    packet.write(jsonStr, 8);
    return packet;
}

function decodeIPC(buffer) {
    if (buffer.length < 8) return null;
    const opcode = buffer.readUInt32LE(0);
    const length = buffer.readUInt32LE(4);
    if (buffer.length < 8 + length) return null;
    const data = JSON.parse(buffer.slice(8, 8 + length).toString());
    return { opcode, data, rest: buffer.slice(8 + length) };
}

function tryConnect(pipePath) {
    return new Promise((resolve) => {
        const socket = net.createConnection(pipePath, () => resolve(socket));
        socket.once('error', () => resolve(null));
    });
}

async function connectDiscord() {
    log('Connecting to Discord IPC...', 'discord');

    for (let id = 0; id < 10; id++) {
        const paths = [getIPCPath(id)];
        if (process.platform !== 'win32') {
            const rd = process.env.XDG_RUNTIME_DIR;
            if (rd) {
                paths.push(path.join(rd, 'snap.discord', 'discord-ipc-' + id));
                paths.push(path.join(rd, 'app', 'com.discordapp.Discord', 'discord-ipc-' + id));
            }
        }

        for (const pipePath of paths) {
            const socket = await tryConnect(pipePath);
            if (!socket) continue;

            ipcSocket = socket;
            let buf = Buffer.alloc(0);

            socket.on('data', (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                let msg;
                while ((msg = decodeIPC(buf)) !== null) {
                    buf = msg.rest;
                    if (msg.opcode === 1 && msg.data.evt === 'READY') {
                        isConnected = true;
                        const u = msg.data.data.user;
                        log('Connected to Discord as ' + u.username + (u.discriminator && u.discriminator !== '0' ? '#' + u.discriminator : ''), 'success');
                        if (config.discordId && u.id !== config.discordId) {
                            log('Warning: Connected Discord account does not match linked account!', 'warn');
                            log('Expected: ' + config.discordId, 'warn');
                            log('Got: ' + u.id, 'warn');
                        }
                    }
                }
            });

            socket.on('close', () => {
                isConnected = false;
                ipcSocket = null;
                log('Discord disconnected, will retry in 60 seconds...', 'warn');
                setTimeout(connectDiscord, 60000);
            });

            socket.on('error', () => {
                isConnected = false;
                ipcSocket = null;
            });

            // Send handshake (opcode 0)
            socket.write(encodeIPC(0, { v: 1, client_id: DISCORD_CLIENT_ID }));
            await new Promise(r => setTimeout(r, 2000));
            return isConnected || true;
        }
    }

    log('Failed to connect to Discord. Make sure Discord is running.', 'error');
    log('Will retry in 60 seconds...', 'warn');
    setTimeout(connectDiscord, 60000);
    return false;
}

// ============================================================================
// Activity Sync
// ============================================================================

function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    if (h > 0) {
        return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
}

async function updateDiscordPresence(data) {
    if (!isConnected || !ipcSocket) return;

    try {
        const nonce = Math.random().toString(36).substring(2) + Date.now().toString(36);

        if (!data) {
            ipcSocket.write(encodeIPC(1, {
                cmd: 'SET_ACTIVITY',
                args: {
                    pid: process.pid,
                    activity: {
                        details: 'Browsing Serika',
                        state: 'Scrolling peak content',
                        assets: { large_image: 'serika_logo', large_text: 'Serika' },
                        buttons: [{ label: 'Watch on Serika THE GOAT', url: API_URL }],
                    }
                },
                nonce,
            }));
            log('Set Discord status: Browsing Serika', 'discord');
            return;
        }

        const { details, state, posterUrl, progressSeconds, durationSeconds, isPaused } = data;

        let safeProgress = progressSeconds;
        if (durationSeconds > 0 && safeProgress > durationSeconds) {
            safeProgress = durationSeconds;
        }

        const progress = durationSeconds
            ? `${formatTime(safeProgress)} / ${formatTime(durationSeconds)}`
            : formatTime(safeProgress);

        const activity = {
            details: details.substring(0, 128),
            state: state.substring(0, 128),
            assets: {
                large_image: posterUrl || 'serika_logo',
                large_text: details.substring(0, 128),
            },
            buttons: [{ label: 'Watch on Serika THE GOAT', url: API_URL }],
        };

        if (isPaused) {
            activity.assets.small_image = 'paused';
            activity.assets.small_text = 'Paused at ' + progress;
            activity.state = 'Paused';
            log(`Paused: ${details} ${colors.dim}(${progress})${colors.reset}`, 'warn');
        } else {
            activity.assets.small_image = 'playing';
            activity.assets.small_text = progress;
            activity.timestamps = { start: Math.floor(Date.now() / 1000) - safeProgress };
            log(`Now playing: ${details} ${colors.dim}(${state})${colors.reset}`, 'discord');
        }

        ipcSocket.write(encodeIPC(1, {
            cmd: 'SET_ACTIVITY',
            args: { pid: process.pid, activity },
            nonce,
        }));
        lastActivity = Date.now();
    } catch (e) {
        // Ignore
    }
}

async function syncActivity() {
    if (!isConnected || !ipcSocket) return;
    
    // If we received a local update recently (within 10 seconds), skip polling to avoid flickering
    if (lastActivity && Date.now() - lastActivity < 10000) {
        return;
    }

    try {
        statusLine('🔄 Syncing activity...');
        const res = await request(`${API_URL}/api/presence/activity?profileId=${config.profileId}`, {
            headers: { 'Authorization': `Bearer ${config.token}` },
        });

        if (res.status !== 200) return;

        const activity = res.data.activity;

        if (activity) {
            let details = activity.titleName;
            let state = 'Watching';

            if (activity.episodeName) {
                state = `S${activity.seasonNumber}E${activity.episodeNumber}: ${activity.episodeName}`;
            }

            await updateDiscordPresence({
                details,
                state,
                posterUrl: activity.posterUrl,
                progressSeconds: activity.progressSeconds,
                durationSeconds: activity.durationSeconds || 0,
                isPaused: activity.isPaused
            });
        } else {
            await updateDiscordPresence(null);
        }
    } catch (e) {
        // Ignore
    }
}

function startLocalServer() {
    const server = http.createServer((req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === 'POST' && req.url === '/update') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    updateDiscordPresence(data);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
        } else {
            res.writeHead(404);
            res.end();
        }
    });

    server.listen(LOCAL_PORT, '127.0.0.1', () => {
        log(`Local update server listening on port ${LOCAL_PORT}`, 'success');
    });
    
    server.on('error', (e) => {
        log(`Failed to start local server: ${e.message}`, 'error');
    });
}

// ============================================================================
// CLI Commands
// ============================================================================

async function stopRunner() {
    if (fs.existsSync(PID_FILE)) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
        try {
            if (process.platform === 'win32') {
                execSync(`taskkill /PID ${pid} /F`);
            } else {
                process.kill(pid, 'SIGINT');
            }
            log(`Successfully stopped runner (PID: ${pid})`, 'success');
            fs.unlinkSync(PID_FILE);
        } catch (e) {
            if (e.code === 'ESRCH') {
                log('Runner is not running.', 'warn');
                fs.unlinkSync(PID_FILE);
            } else {
                log('Failed to stop runner: ' + e.message, 'error');
            }
        }
    } else {
        log('No PID file found. Runner may not be running in background.', 'warn');
    }
}

async function checkStatus() {
    if (fs.existsSync(PID_FILE)) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
        try {
            process.kill(pid, 0);
            log(`Running in background (PID: ${pid})`, 'success');
            return true;
        } catch (e) {
            log('Not running (stale PID file)', 'warn');
            fs.unlinkSync(PID_FILE);
        }
    } else {
        log('Not running in background', 'warn');
    }
    return false;
}

async function daemonize() {
    if (fs.existsSync(PID_FILE)) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8'), 10);
        try {
            process.kill(pid, 0);
            log(`Runner is already running in background (PID: ${pid})`, 'warn');
            process.exit(0);
        } catch {}
    }

    log('Starting in background...', 'discord');
    
    const args = process.argv.slice(2).filter(a => a !== '--daemon');
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const out = fs.openSync(path.join(CONFIG_DIR, 'out.log'), 'a');
    const err = fs.openSync(path.join(CONFIG_DIR, 'out.log'), 'a');

    const spawnOpts = {
        detached: true,
        stdio: ['ignore', out, err],
        ...(process.platform === 'win32' ? { windowsHide: true } : {})
    };

    const child = spawn(process.argv[0], [process.argv[1], ...args, '--internal-daemon'], spawnOpts);

    fs.writeFileSync(PID_FILE, child.pid.toString());
    child.unref();
    
    log(`Started background process (PID: ${child.pid})`, 'success');
    log(`Logs: ${path.join(CONFIG_DIR, 'out.log')}`, 'info');
    process.exit(0);
}

async function installService() {
    if (process.platform === 'win32') {
        // Windows: create a Task Scheduler entry
        const binPath = path.join(process.env.USERPROFILE || '', '.serika-presence', 'serika-presence.bat');
        const taskName = 'SerikaPresence';
        try {
            execSync(`schtasks /Create /TN "${taskName}" /TR "${binPath}" /SC ONLOGON /RL HIGHEST /F`);
            log('Task Scheduler entry created! Serika Presence will start on login.', 'success');
            log('To remove: schtasks /Delete /TN "' + taskName + '" /F', 'info');
        } catch (e) {
            log('Failed to create Task Scheduler entry: ' + e.message, 'error');
            log('Try running as Administrator.', 'warn');
        }
        return;
    }
    if (process.platform !== 'linux') {
        log('Service installation is only supported on Linux (systemd) and Windows (Task Scheduler).', 'error');
        return;
    }

    const serviceDir = path.join(process.env.HOME, '.config', 'systemd', 'user');
    if (!fs.existsSync(serviceDir)) {
        fs.mkdirSync(serviceDir, { recursive: true });
    }

    const binPath = path.join(process.env.HOME, '.local', 'bin', 'serika-presence');
    const serviceContent = `[Unit]
Description=Serika Discord Presence
After=network.target

[Service]
ExecStart=${binPath}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;

    const servicePath = path.join(serviceDir, 'serika-presence.service');
    fs.writeFileSync(servicePath, serviceContent);

    try {
        execSync('systemctl --user daemon-reload');
        execSync('systemctl --user enable serika-presence.service');
        execSync('systemctl --user restart serika-presence.service');
        log('systemd service installed and started!', 'success');
        log('You can manage it with:', 'info');
        log('systemctl --user status serika-presence', 'info');
        log('systemctl --user restart serika-presence', 'info');
    } catch (e) {
        log('Failed to enable systemd service: ' + e.message, 'error');
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    const args = process.argv.slice(2);
    const isInternalDaemon = args.includes('--internal-daemon');
    
    if (args.includes('stop') || args.includes('down')) {
        return await stopRunner();
    }
    
    if (args.includes('status')) {
        return await checkStatus();
    }
    
    if (args.includes('--install-service')) {
        return await installService();
    }
    
    if (args.includes('--daemon') && !isInternalDaemon) {
        return await daemonize();
    }

    if (!isInternalDaemon) {
        showBanner();
    }
    
    // Load saved config
    loadConfig();
    
    // Authenticate (skip prompt if daemonized to avoid hanging, but authenticate() handles existing token)
    if (!await authenticate()) {
        if (isInternalDaemon) {
            log('Authentication failed in background. Please run manually to login.', 'error');
        } else {
            log('Authentication failed. Exiting.', 'error');
        }
        process.exit(1);
    }
    
    // Connect to Discord
    if (!await connectDiscord()) {
        log('Failed to connect to Discord. Exiting.', 'error');
        process.exit(1);
    }
    
    if (!isInternalDaemon) {
        console.log('');
        log('Starting activity sync...', 'success');
        console.log(paint('Press Ctrl+C to stop', colors.dim));
        console.log('');
    } else {
        log('Starting activity sync in background...', 'discord');
    }
    
    // Start local server
    startLocalServer();
    
    // Initial sync
    await syncActivity();
    
    // Poll for updates
    setInterval(syncActivity, POLL_INTERVAL);
}

// Handle shutdown
process.on('SIGINT', async () => {
    log('Shutting down...', 'warn');
    if (ipcSocket) {
        try {
            const nonce = Math.random().toString(36).substring(2);
            ipcSocket.write(encodeIPC(1, {
                cmd: 'SET_ACTIVITY',
                args: { pid: process.pid, activity: null },
                nonce,
            }));
            ipcSocket.destroy();
        } catch {}
    }
    process.exit(0);
});

process.on('uncaughtException', (e) => {
    log('Error: ' + e.message, 'error');
});

// Run
main();