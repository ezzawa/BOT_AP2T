const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Paths
const envPath = path.join(__dirname, '.env');
const profilesPath = path.join(__dirname, 'profiles.json');
const usersPath = path.join(__dirname, 'users.json');

// --- Helper Functions ---
function getEnv() {
    if (!fs.existsSync(envPath)) return {};
    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split('\n');
    const env = {};
    for (const line of lines) {
        if (!line || line.startsWith('#')) continue;
        const index = line.indexOf('=');
        if (index > -1) {
            env[line.substring(0, index).trim()] = line.substring(index + 1).trim();
        }
    }
    return env;
}

function saveEnv(env) {
    let content = '';
    for (const key in env) {
        content += `${key}=${env[key]}\n`;
    }
    fs.writeFileSync(envPath, content.trim() + '\n');
}

function getHWID() {
    try {
        const output = execSync('powershell -NoProfile -Command "(Get-CimInstance -Class Win32_ComputerSystemProduct).UUID"').toString();
        return output.trim() || 'UNKNOWN_HWID';
    } catch (e) {
        return 'UNKNOWN_HWID';
    }
}

// --- API Endpoints ---
app.get('/api/status', (req, res) => {
    const hwid = getHWID();
    const env = getEnv();
    const isLicensed = !!env.LICENSE_KEY; // Basic check for UI, real check is in bot
    res.json({
        hwid,
        isLicensed,
        botStatus: 'Running'
    });
});

// ENV
app.get('/api/env', (req, res) => {
    res.json(getEnv());
});

app.post('/api/env', (req, res) => {
    const data = req.body;
    const currentEnv = getEnv();
    const newEnv = { ...currentEnv, ...data };
    saveEnv(newEnv);
    res.json({ success: true, message: 'Settings saved. Restarting bot...' });
    
    // Restart Node process automatically so index.js picks up new env
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

app.post('/api/admin_login', (req, res) => {
    const pwd = req.body.password;
    const env = getEnv();
    const correctPassword = env.ADMIN_PASSWORD || 'admin123';
    
    if (pwd === correctPassword) {
        res.json({ success: true });
    } else {
        res.json({ success: false });
    }
});

// Profiles
app.get('/api/profiles', (req, res) => {
    if (!fs.existsSync(profilesPath)) return res.json({});
    res.json(JSON.parse(fs.readFileSync(profilesPath, 'utf8')));
});

app.post('/api/profiles', (req, res) => {
    const data = req.body;
    fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2));
    res.json({ success: true, message: 'Profiles updated' });
});

// Users
app.get('/api/users', (req, res) => {
    if (!fs.existsSync(usersPath)) return res.json({ users: [] });
    res.json(JSON.parse(fs.readFileSync(usersPath, 'utf8')));
});

app.post('/api/users', (req, res) => {
    const data = req.body;
    fs.writeFileSync(usersPath, JSON.stringify(data, null, 2));
    res.json({ success: true, message: 'Users updated' });
});

app.get('/api/fleet', async (req, res) => {
    const env = getEnv();
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return res.json({ error: 'GitHub belum dikonfigurasi' });
    
    try {
        const axios = require('axios');
        const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/fleet?ref=${env.GITHUB_BRANCH || 'main'}`;
        const headers = { Authorization: `token ${env.GITHUB_TOKEN}` };
        
        const dirRes = await axios.get(url, { headers });
        if (!Array.isArray(dirRes.data)) return res.json({ fleet: [] });
        
        const fleetData = [];
        for (const file of dirRes.data) {
            if (file.name.endsWith('.json')) {
                const fileRes = await axios.get(file.download_url, { headers });
                fleetData.push(fileRes.data);
            }
        }
        res.json({ fleet: fleetData });
    } catch (e) {
        if (e.response && e.response.status === 404) return res.json({ fleet: [] }); // Belum ada folder fleet
        res.status(500).json({ error: e.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`✅ GUI Dashboard is running on http://localhost:${PORT}`);
});
