require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer');
const { exec, execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Jalankan Web GUI Server lokal
require('./server.js');

// ===== AUTO-RESUME STATE MANAGEMENT =====
const STATE_FILE = path.join(__dirname, 'ct_state.json');

function loadCTState() {
    if (fs.existsSync(STATE_FILE)) {
        try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
    }
    return {};
}

function saveCTState(stateObj) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(stateObj, null, 2));
}

function getCTState(idpel) {
    const state = loadCTState();
    return state[idpel] || null;
}

function updateCTState(idpel, data) {
    const state = loadCTState();
    state[idpel] = { ...state[idpel], ...data, timestamp: Date.now() };
    saveCTState(state);
}

function clearCTState(idpel) {
    const state = loadCTState();
    if (state[idpel]) {
        delete state[idpel];
        saveCTState(state);
    }
}

// Tangkap semua error unhandled agar bot tidak mati
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

// Bersihkan Chrome saat bot dimatikan paksa (PM2 stop atau Ctrl+C)
function gracefulShutdown() {
    console.log('[*] Graceful shutdown diinisiasi...');
    try {
        if (browser) browser.close();
        killChromeAndClean();
    } catch(e) {}
    process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// ===== KONFIGURASI =====
const AP2T_TOKEN_EXE = 'C:\\Program Files (x86)\\PT PLN (PERSERO)\\AP2T ENKRIPSI\\Token.exe';
const READ_ENKRIPSI_PS1 = path.join(__dirname, 'read_enkripsi.ps1');
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BOT_PROFILE_DIR = path.join(__dirname, 'bot-chrome-profile');

// ===== TELEGRAM BOT =====
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) { console.error("TELEGRAM_BOT_TOKEN belum diset"); process.exit(1); }
const bot = new TelegramBot(token, { polling: true });

// (Logic moved to the existing processUpdate interceptor)

// --- OVERRIDE BOT.SENDMESSAGE UNTUK STATUS PROSES BERJALAN ---
// Fitur ini menggabungkan pesan-pesan proses menjadi 1 pesan dinamis (edit message)
// agar chat Telegram tidak dipenuhi spam log.
const originalSendMessage = bot.sendMessage.bind(bot);
const statusMessages = {};

// Reset grup pesan setiap kali user memberikan perintah baru
bot.on('message', (msg) => {
    if (msg && msg.chat) delete statusMessages[msg.chat.id];
    
    // Feedback format salah
    if (msg && msg.text && msg.text.startsWith('/')) {
        const cmds = {
            '/tambah_user': 'Gunakan: `/tambah_user <ID_Telegram> <Nama>`',
            '/ct': 'Gunakan: `/ct <No_Meter/IDPEL>`',
            '/reset_ct': 'Gunakan: `/reset_ct <No_Meter/IDPEL>`',
            '/cetak_token': 'Gunakan: `/cetak_token <No_Meter/IDPEL>`',
            '/cek_token': 'Gunakan: `/cek_token <No_Meter/IDPEL>`',
            '/ambil_token': 'Gunakan: `/ambil_token <No_Meter/IDPEL>`',
            '/cek_pelanggan': 'Gunakan: `/cek_pelanggan <No_Meter/IDPEL>`',
            '/set_ap2t': 'Gunakan: `/set_ap2t <Username> <Password>`',
            '/set_webmail': 'Gunakan: `/set_webmail <pusat\\uid> <Password>`',
            '/simpan_akun': 'Gunakan: `/simpan_akun <Nama_Profil> <User_AP2T> <Pass_AP2T> <User_Webmail> <Pass_Webmail>`',
            '/pakai_akun': 'Gunakan: `/pakai_akun <Nama_Profil>`',
            '/keygen': 'Gunakan: `/keygen <Hari>`',
            '/set_license': 'Gunakan: `/set_license <License_Key>`'
        };
        const text = msg.text.trim();
        const command = text.split(' ')[0].toLowerCase();
        
        if (cmds[command]) {
            const parts = text.split(' ').filter(p => p !== '');
            if (parts.length === 1) {
                bot.sendMessage(msg.chat.id, `⚠️ *Format Perintah Salah / Tidak Lengkap*\n\n${cmds[command]}`, {parse_mode: 'Markdown'});
            }
        }
    }
});

bot.sendMessage = async (chatId, text, options) => {
    // 1. Definisikan pesan akhir yang MURNI (jangan ditangkap ke dalam bubble)
    const isFinalOrError = text.includes('TOKEN CLEAR TAMPER') || 
                           text.includes('Berhasil berganti ke profil') || 
                           text.includes('Hasil Pencarian') ||
                           text.includes('Kode enkripsi:') ||
                           text.includes('No Agenda ditemukan:') ||
                           text.toLowerCase().includes('error');

    // 2. Cek format khusus
    const hasSpecialOptions = options && (options.reply_markup || (options.parse_mode && options.parse_mode.toLowerCase() === 'html'));

    const now = Date.now();
    
    // 3. Jika pesan akhir, error, atau format HTML, kirim terpisah dan reset bubble
    if (isFinalOrError || hasSpecialOptions) {
        delete statusMessages[chatId];
        return await originalSendMessage(chatId, text, options);
    }

    // 4. Reset bubble jika umurnya sudah lebih dari 45 detik (menandakan command baru)
    if (statusMessages[chatId] && (now - statusMessages[chatId].lastUpdate > 45000)) {
        delete statusMessages[chatId];
    }

    // 5. Anggap pesan lainnya sebagai progres (gabungkan ke dalam 1 bubble)
    if (!statusMessages[chatId]) {
        statusMessages[chatId] = { msgId: null, text: text, lastUpdate: now };
        const m = await originalSendMessage(chatId, `🤖 *BOT AP2T SEDANG BEKERJA*\n_Silakan tunggu..._\n\n> ${text}`, { parse_mode: 'Markdown' }).catch(()=>null);
        if (m) statusMessages[chatId].msgId = m.message_id;
        return m || { message_id: statusMessages[chatId].msgId || 0, chat: { id: chatId } };
    } else {
        let state = statusMessages[chatId];
        state.text = text;
        state.lastUpdate = now;
        
        const newText = `🤖 *BOT AP2T SEDANG BEKERJA*\n_Silakan tunggu..._\n\n> ${state.text}`;
        if (state.msgId) {
            await bot.editMessageText(newText, { chat_id: chatId, message_id: state.msgId, parse_mode: 'Markdown' }).catch(async (e) => {
                if(e.message && e.message.includes('not found')) {
                    const m = await originalSendMessage(chatId, newText, { parse_mode: 'Markdown' }).catch(()=>null);
                    if (m) state.msgId = m.message_id;
                }
            });
            return { message_id: state.msgId, chat: { id: chatId } };
        } else {
            return { message_id: 0, chat: { id: chatId } };
        }
    }
};
// ----------------------------------------------------------------

// ===== OTORISASI ADMIN, USER, DAN LISENSI HARDWARE =====
function getHWID() {
    try {
        const output = require('child_process').execSync('wmic csproduct get uuid').toString();
        const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
        return lines[1] || 'UNKNOWN_HWID';
    } catch (e) { return 'UNKNOWN_HWID'; }
}
const HWID = getHWID();
const EXPECTED_LICENSE = crypto.createHash('sha256').update(HWID + "AP2T_PLN_SECRET").digest('hex').substring(0, 16).toUpperCase();

let adminChatId = process.env.ADMIN_CHAT_ID || process.env.AUTHORIZED_CHAT_ID || null;

const botStartTime = Math.floor(Date.now() / 1000);
const notifiedOfflineUsers = {};
const originalProcessUpdate = bot.processUpdate.bind(bot);
bot.processUpdate = async (update) => {
    const msg = update.message || update.callback_query?.message;
    
    // --- MENCEGAH PENUMPUKAN PERINTAH SAAT BOT OFFLINE ---
    if (msg && msg.date && msg.date < botStartTime) {
        if (!notifiedOfflineUsers[msg.chat.id]) {
            bot.sendMessage(msg.chat.id, `⚠️ **PERINTAH DIABAIKAN**\nMohon maaf, pesan/perintah yang Anda kirim saat Bot/PC sedang **Mati (Offline)** tidak diproses untuk mencegah penumpukan tugas (spam).\n\nSilakan kirim ulang perintah Anda sekarang.`, { parse_mode: 'Markdown' });
            notifiedOfflineUsers[msg.chat.id] = true;
        }
        return; 
    }

    if (msg && msg.chat) {
        const chatIdStr = msg.chat.id.toString();
        const text = (update.message && update.message.text) ? update.message.text : '';
        
        // 1. Klaim Admin Pertama Kali
        if (!adminChatId) {
            if (text.startsWith('/start')) {
                adminChatId = chatIdStr;
                
                const envPath = path.join(__dirname, '.env');
                let envContent = '';
                if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf8');
                if (envContent.includes('ADMIN_CHAT_ID=')) {
                    envContent = envContent.replace(/^ADMIN_CHAT_ID=.*$/m, `ADMIN_CHAT_ID=${adminChatId}`);
                } else if (envContent.includes('AUTHORIZED_CHAT_ID=')) {
                    envContent = envContent.replace(/^AUTHORIZED_CHAT_ID=.*$/m, `ADMIN_CHAT_ID=${adminChatId}`);
                } else {
                    envContent += `\nADMIN_CHAT_ID=${adminChatId}`;
                }
                fs.writeFileSync(envPath, envContent.trim() + '\n');
                
                bot.sendMessage(msg.chat.id, `✅ Anda berhasil terdaftar sebagai **ADMIN UTAMA** bot ini (Chat ID: ${adminChatId}).\nGunakan web GUI di http://localhost:3000 untuk memantau.`, {parse_mode: 'Markdown'});
                return originalProcessUpdate(update);
            } else {
                bot.sendMessage(msg.chat.id, `⚠️ Bot belum memiliki Admin.\n\nSilakan ketik /start untuk mengklaim bot ini.`);
                return; // Stop
            }
        }

        const isAdmin = (chatIdStr === adminChatId);
        
        // 2. Cek apakah ini user terdaftar
        let users = [];
        try { users = JSON.parse(fs.readFileSync(path.join(__dirname, 'users.json'))).users || []; } catch(e){}
        const isUser = users.some(u => (typeof u === 'object' ? u.id : u) === chatIdStr);
        
        if (!isAdmin && !isUser) {
            bot.sendMessage(msg.chat.id, `⛔ *AKSES DITOLAK*\nAnda belum terdaftar untuk menggunakan bot di komputer ini.\n\nSilakan *Forward (Teruskan)* pesan angka di bawah ini kepada Admin agar Anda didaftarkan:`, {parse_mode: 'Markdown'});
            setTimeout(() => {
                bot.sendMessage(msg.chat.id, `\`${chatIdStr}\``, {parse_mode: 'Markdown'});
            }, 500);
            return;
            return;
        }

        // 3. Validasi Lisensi Hardware
        const currentLicense = process.env.LICENSE_KEY || '';
        if (currentLicense !== EXPECTED_LICENSE) {
            if (isAdmin) {
                // Izinkan admin mengeksekusi /keygen atau /set_license
                if (text.startsWith('/keygen') || text.startsWith('/set_license')) {
                    return originalProcessUpdate(update);
                } else {
                    bot.sendMessage(msg.chat.id, `🔒 **KOMPUTER BELUM DILISENSI**\n\nHardware ID Komputer Ini: \`${HWID}\`\n\nUntuk menghasilkan kunci lisensi, ketik:\n\`/keygen ${HWID}\`\n\nLalu simpan menggunakan:\n\`/set_license <Kunci_Lisensi>\`\natau masukkan via panel Web GUI (http://localhost:3000).`, {parse_mode: 'Markdown'});
                    return;
                }
            } else {
                bot.sendMessage(msg.chat.id, `🔒 Bot saat ini terkunci. Komputer belum memiliki lisensi yang valid. Silakan hubungi Admin.`);
                return;
            }
        }
    }
    return originalProcessUpdate(update);
};

// Mendaftarkan perintah ke Menu Telegram ada di bagian bawah file
// ===== KREDENSIAL =====
const credentials = {
    main: { username: process.env.MAIN_USERNAME, password: process.env.MAIN_PASSWORD },
    webmail: { username: process.env.WEBMAIL_USERNAME, password: process.env.WEBMAIL_PASSWORD }
};

// ===== SELECTOR =====
// Field enkripsi: #lblEnkripsi menerima paste Ctrl+V (format AP2T|kode|...)
// Validasi otomatis setelah paste — field akan tampilkan "Valid"
const SELECTORS = {
    usernameInput: '#tfUser',
    passwordInput: '#tfPassword',
    encryptionInput: '#lblEnkripsi',  // Harus di-paste dengan Ctrl+V!
    loginButton: '#Button1',
    validCheckbox: 'input[id*="chkValidasi"]',  // Checkbox "Valid" setelah enkripsi
    errorMessage: '.alert-danger',
    dashboardElement: '#dashboard-menu'
};

// ===== STATE GLOBAL =====
let browser = null;
let page = null;
let isLoggedIn = false;
let isLoggingIn = false;
let currentAccount = 'none';
let activeChatId = null;

// Antrean eksekusi global
let commandQueue = [];
let isProcessingCT = false;
let isPaused = false; // Flag untuk pause

// Helper untuk menahan eksekusi
async function checkPause(chatId) {
    if (isPaused) {
        if (chatId) bot.sendMessage(chatId, `⏸️ **Bot Menunggu (Di-Pause)**\nProses ditahan sementara. Ketik /resume_bot untuk melanjutkan.`);
        while (isPaused) {
            await new Promise(r => setTimeout(r, 1000));
        }
        if (chatId) bot.sendMessage(chatId, `▶️ **Bot Melanjutkan Proses...**`);
    }
}

// ===== FUNGSI: Eksekusi Antrean Global =====
async function processQueue() {
    if (isProcessingCT || commandQueue.length === 0) return;
    isProcessingCT = true;

    const task = commandQueue.shift();
    try {
        await task();
    } catch (err) {
        console.error("Queue process error:", err);
    } finally {
        isProcessingCT = false;
        // Lanjut ke antrean berikutnya jika ada
        if (commandQueue.length > 0) {
            processQueue();
        }
    }
}

// ===== FUNGSI: Bersihkan Chrome sebelum launch =====
function killChromeAndClean() {
    try { execSync('taskkill /F /IM chrome.exe /T', { stdio: 'ignore' }); } catch (e) { }
    // Hapus SingletonLock agar Chrome bisa start bersih
    const lockFile = path.join(BOT_PROFILE_DIR, 'SingletonLock');
    const lockFile2 = path.join(BOT_PROFILE_DIR, 'Default', 'SingletonLock');
    if (fs.existsSync(lockFile)) { try { fs.unlinkSync(lockFile); } catch (e) { } }
    if (fs.existsSync(lockFile2)) { try { fs.unlinkSync(lockFile2); } catch (e) { } }
}

// ===== FUNGSI: Baca Kode Enkripsi dari Token.exe =====
async function getEncryptionCodeFromApp(chatId) {
    bot.sendMessage(chatId, `🔐 Membuka AP2T ENKRIPSI untuk membaca kode otomatis...`);

    // Matikan Token.exe jika sudah running (mencegah .NET error "key already added")
    try { execSync('taskkill /F /IM Token.exe /T', { stdio: 'ignore' }); } catch (e) { }
    await new Promise(r => setTimeout(r, 1000));

    return new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const ps = spawn('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', READ_ENKRIPSI_PS1
        ]);

        let output = '';
        let stderr = '';

        ps.stdout.on('data', (data) => { output += data.toString(); });
        ps.stderr.on('data', (data) => { stderr += data.toString(); });

        const timeout = setTimeout(() => {
            ps.kill();
            reject(new Error('Timeout membaca enkripsi (45 detik)'));
        }, 45000);

        ps.on('close', (code) => {
            clearTimeout(timeout);
            console.log('PS output:', output);
            if (stderr) console.error('PS stderr:', stderr);

            if (code !== 0) return reject(new Error(`PowerShell exit ${code}. ${stderr}`));

            const lines = output.split('\n').map(l => l.trim()).filter(Boolean);
            const resultLine = lines.find(l => l.startsWith('RESULT:'));
            if (!resultLine) return reject(new Error(`Kode tidak ditemukan dalam output PS`));

            const kode = resultLine.replace('RESULT:', '').trim();
            if (!kode || kode.length < 4) return reject(new Error(`Kode tidak valid: "${kode}"`));
            resolve(kode);
        });
    });
}

// ===== FUNGSI: Inisialisasi Browser =====
async function initBrowser(chatId) {
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
        try {
            if (browser) {
                try {
                    await browser.version();
                    let pageHealthy = false;
                    if (page && !page.isClosed()) {
                        try {
                            await page.evaluate(() => true);
                            pageHealthy = true;
                        } catch(err) {
                            pageHealthy = false; // Protocol error
                        }
                    }
                    if (!pageHealthy) {
                        if (page && !page.isClosed()) await page.close().catch(()=>null);
                        page = await browser.newPage();
                        setupPageHandlers();
                    }
                    return;
                } catch (e) {
                    browser = null;
                }
            }

            if (chatId && retryCount === 0) bot.sendMessage(chatId, `⚙️ Mempersiapkan Chrome untuk login AP2T...`);

            // Coba reconnect ke browser yang ditinggalkan (jika bot baru restart)
            try {
                const axios = require('axios');
                const res = await axios.get('http://127.0.0.1:9222/json/version');
                browser = await puppeteer.connect({ browserWSEndpoint: res.data.webSocketDebuggerUrl, defaultViewport: null });
                const pages = await browser.pages();
                page = pages.find(p => p.url().includes('ap2t')) || pages[0];
                
                let pageHealthy = false;
                if (page && !page.isClosed()) {
                    try { await page.evaluate(() => true); pageHealthy = true; } catch(e) {}
                }
                if (!pageHealthy) {
                    if (page && !page.isClosed()) await page.close().catch(()=>null);
                    page = await browser.newPage();
                }
                setupPageHandlers();

                // Cek apakah sudah di dashboard
                try {
                    const currentUrl = page.url().toLowerCase();
                    if (currentUrl.includes('beranda') || currentUrl.includes('menu') || currentUrl.includes('default')) {
                        isLoggedIn = true;
                    }
                } catch(e) {}

                if (chatId && retryCount === 0) bot.sendMessage(chatId, `✅ Berhasil terhubung kembali ke browser yang sudah terbuka.`);
                return;
            } catch (e) {
                // Gagal reconnect, berarti harus buka baru
            }

            // Bersihkan Chrome lama
            killChromeAndClean();
            await new Promise(r => setTimeout(r, 3000)); // Tambah delay jadi 3 detik

            browser = await puppeteer.launch({
                executablePath: CHROME_EXE,
                userDataDir: BOT_PROFILE_DIR,
                ignoreHTTPSErrors: true,
                args: [
                    '--no-first-run',
                    '--disable-restore-session-state',
                    '--disable-session-crashed-bubble',
                    '--disable-notifications',
                    '--disable-infobars',
                    '--disable-translate',
                    '--start-maximized',
                    '--disable-features=PasswordManager,AutofillServerCommunication',
                    '--disable-save-password-bubble',
                    '--no-sandbox', // Tambahkan sandbox untuk stabilitas di server/windows tertentu
                    '--remote-debugging-port=9222',
                    '--ignore-certificate-errors'
                ],
                headless: false,
                defaultViewport: null,
                pipe: true,
                timeout: 45000
            });

            browser.on('disconnected', () => {
                browser = null; page = null; isLoggedIn = false;
            });

            // Tunggu sebentar sebelum buka tab
            await new Promise(r => setTimeout(r, 1000));

            const existingPages = await browser.pages();
            for (const p of existingPages) {
                await p.close().catch(() => { });
            }

            page = await browser.newPage();
            setupPageHandlers();
            return; // Berhasil, keluar dari loop

        } catch (err) {
            retryCount++;
            console.error(`Gagal init browser (percobaan ${retryCount}):`, err.message);
            if (retryCount >= maxRetries) throw err;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

function setupPageHandlers() {
    page.on('dialog', async dialog => {
        console.log("Dialog:", dialog.message());
        if (activeChatId) bot.sendMessage(activeChatId, `⚠️ Alert Web: ${dialog.message()}`);
        await dialog.accept();
    });
}


// ===== FUNGSI: Reset Session via OWA =====
async function handleOwaSessionReset(chatId) {
    bot.sendMessage(chatId, `[i] Buka Webmail OWA untuk klik link Reset Session...`);
    let mailPage = await browser.newPage();
    mailPage.on('dialog', async dialog => {
        if (chatId) bot.sendMessage(chatId, `[i] Menutup popup Webmail: ${dialog.message()}`);
        await dialog.accept().catch(()=>{});
    });
    try {
        await mailPage.goto('https://webmail.pln.co.id/owa/auth/logon.aspx?replaceCurrent=1&url=https%3a%2f%2fwebmail.pln.co.id%2fowa', { waitUntil: 'networkidle2', timeout: 30000 });

        await mailPage.waitForSelector('#username', { timeout: 15000 });
        try {
            await mailPage.click('#username').catch(()=>{});
            await mailPage.evaluate(() => { const u = document.getElementById('username'); if(u) u.value = ''; });
            await mailPage.type('#username', credentials.webmail.username).catch(()=>{});
            
            // Atasi trik placeholder OWA (klik text palsu agar input password asli muncul)
            await mailPage.click('#passwordText').catch(()=>{});
            await mailPage.waitForSelector('#password', { timeout: 2000, visible: true }).catch(()=>{});
            
            await mailPage.click('#password').catch(()=>{});
            await mailPage.evaluate(() => { const p = document.getElementById('password'); if(p) p.value = ''; });
            await mailPage.type('#password', credentials.webmail.password).catch(()=>{});
        } catch(e) {}
        
        // Fallback murni JS jika UI OWA bermasalah
        await mailPage.evaluate((u, p) => {
            const passEl = document.getElementById('password') || document.querySelector('input[type="password"]');
            if (passEl && passEl.value !== p) passEl.value = p;
            const userEl = document.getElementById('username');
            if (userEl && userEl.value !== u) userEl.value = u;
        }, credentials.webmail.username, credentials.webmail.password).catch(()=>{});

        await Promise.all([
            mailPage.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null),
            mailPage.click('.signinbutton')
        ]);

        await new Promise(r => setTimeout(r, 2000));

        // CEK JIKA GAGAL LOGIN (SALAH PASSWORD)
        const isError = await mailPage.evaluate(() => {
            const err = document.querySelector('.signInErrorText, #signInErrorDiv, #errTxt');
            if (err && err.offsetParent !== null && err.textContent.trim().length > 0) return true;
            return false;
        }).catch(()=>false);
        
        if (isError) {
            bot.sendMessage(chatId, `❌ *GAGAL LOGIN WEBMAIL*\nUsername atau Password Webmail OWA salah/kadaluarsa.\n\nSilakan perbaiki menggunakan perintah:\n\`/set_webmail <username> <password>\``, {parse_mode: 'Markdown'});
            throw new Error('Webmail login failed due to invalid credentials.');
        }

        bot.sendMessage(chatId, `⏳ Menunggu email pemberitahuan masuk (maks 2 menit)...`);
        
        let elemHandle = null;
        let retries = 0;
        const maxRetries = 24; // 24 * 5 detik = 120 detik (2 menit)

        while (retries < maxRetries) {
            // Cek dan tutup popup OWA jika muncul di tengah-tengah
            await mailPage.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, span, div, a, .ms-Button'));
                const okBtn = buttons.find(b => {
                    const txt = (b.textContent || '').trim().toUpperCase();
                    return txt === 'OK' && b.offsetParent !== null;
                });
                if (okBtn) okBtn.click();
            }).catch(() => {});

            const found = await mailPage.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('*')).filter(el => {
                    const txt = el.textContent.toLowerCase();
                    return (txt.includes('notifikasi_ap2t') || txt.includes('pemberitahuan login') || txt.includes('reset session')) && el.children.length === 0;
                });
                return elements.length > 0;
            });

            if (found) {
                elemHandle = await mailPage.evaluateHandle(() => {
                    const elements = Array.from(document.querySelectorAll('*')).filter(el => {
                        const txt = el.textContent.toLowerCase();
                        return (txt.includes('notifikasi_ap2t') || txt.includes('pemberitahuan login') || txt.includes('reset session')) && el.children.length === 0;
                    });
                    return elements[0];
                });
                break;
            }

            retries++;
            if (retries % 6 === 0) bot.sendMessage(chatId, `⏳ Masih menunggu email terbaru masuk... (${retries * 5} / 120 detik)`);
            await new Promise(r => setTimeout(r, 5000));
        }

        if (elemHandle) {
            bot.sendMessage(chatId, `📧 Membuka email Pemberitahuan Login...`);
            const box = await elemHandle.boundingBox();
            if (box) {
                const cx = box.x + box.width / 2;
                const cy = box.y + box.height / 2;
                await mailPage.mouse.click(cx, cy);
                await new Promise(r => setTimeout(r, 1000));
            } else {
                await elemHandle.click().catch(() => { });
            }
            await elemHandle.dispose();

            // Cek popup limit storage yang mungkin muncul SETELAH membuka email
            await mailPage.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, span, div, a, .ms-Button'));
                const okBtn = buttons.find(b => {
                    const txt = (b.textContent || '').trim().toUpperCase();
                    return txt === 'OK' && b.offsetParent !== null;
                });
                if (okBtn) okBtn.click();
            }).catch(() => {});
            await new Promise(r => setTimeout(r, 1000));
        } else {
            bot.sendMessage(chatId, `⚠️ *TIDAK ADA EMAIL BARU*\nSudah menunggu 2 menit namun email *Reset Session* belum masuk dari pusat. Harap ulangi beberapa saat lagi.`, {parse_mode: 'Markdown'});
            throw new Error('Tidak ada email baru masuk dalam waktu 2 menit (Session).');
        }

        bot.sendMessage(chatId, `[i] Menunggu isi email Reset Session muncul...`);
        await mailPage.waitForFunction(() => {
            return Array.from(document.querySelectorAll('a')).some(a => a.textContent.toLowerCase().includes('reset'));
        }, { timeout: 10000 }).catch(() => { });

        const resetLinks = await mailPage.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'))
                .filter(a => a.textContent.toLowerCase().includes('reset'))
                .map(a => a.href);
            return links;
        });

        if (resetLinks.length > 0) {
            bot.sendMessage(chatId, `[i] Ditemukan link Reset Session. Mengklik link...`);
            const resetPage = await browser.newPage();
            resetPage.on('dialog', async dialog => { await dialog.accept(); });
            try {
                await resetPage.goto(resetLinks[0], { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => { });

                await resetPage.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn'));
                    const target = btns.find(b => {
                        const txt = (b.textContent || b.value || '').toLowerCase();
                        return txt.includes('reset') || txt.includes('yes') || txt.includes('ok') || txt.includes('setuju');
                    });
                    if (target) target.click();
                });
                await new Promise(r => setTimeout(r, 3000));
                await resetPage.close().catch(() => { });
                bot.sendMessage(chatId, `[i] Reset Session berhasil dikonfirmasi!`);
            } catch (e) {
                console.log('Error klik reset link', e);
            }
        } else {
            bot.sendMessage(chatId, `[i] Link Reset Session tidak ditemukan di email.`);
        }

        await mailPage.close().catch(() => { });
    } catch (err) {
        bot.sendMessage(chatId, `[i] Gagal reset session via OWA: ${err.message}`);
        if (mailPage) await mailPage.close().catch(() => { });
    }
}

// ===== FUNGSI: Reset MAC via OWA =====
async function handleOwaMacReset(chatId) {
    bot.sendMessage(chatId, `🔄 Reset MAC Address via Webmail OWA...`);
    let mailPage = await browser.newPage();
    mailPage.on('dialog', async dialog => {
        if (chatId) bot.sendMessage(chatId, `[i] Menutup popup Webmail: ${dialog.message()}`);
        await dialog.accept().catch(()=>{});
    });
    try {
        await mailPage.goto('https://webmail.pln.co.id/owa/auth/logon.aspx?replaceCurrent=1&url=https%3a%2f%2fwebmail.pln.co.id%2fowa', { waitUntil: 'networkidle2', timeout: 30000 });

        bot.sendMessage(chatId, `⏳ Login ke Webmail...`);
        await mailPage.waitForSelector('#username', { timeout: 15000 });
        try {
            await mailPage.click('#username').catch(()=>{});
            await mailPage.evaluate(() => { const u = document.getElementById('username'); if(u) u.value = ''; });
            await mailPage.type('#username', credentials.webmail.username).catch(()=>{});
            
            // Atasi trik placeholder OWA (klik text palsu agar input password asli muncul)
            await mailPage.click('#passwordText').catch(()=>{});
            await mailPage.waitForSelector('#password', { timeout: 2000, visible: true }).catch(()=>{});
            
            await mailPage.click('#password').catch(()=>{});
            await mailPage.evaluate(() => { const p = document.getElementById('password'); if(p) p.value = ''; });
            await mailPage.type('#password', credentials.webmail.password).catch(()=>{});
        } catch(e) {}
        
        // Fallback murni JS jika UI OWA bermasalah
        await mailPage.evaluate((u, p) => {
            const passEl = document.getElementById('password') || document.querySelector('input[type="password"]');
            if (passEl && passEl.value !== p) passEl.value = p;
            const userEl = document.getElementById('username');
            if (userEl && userEl.value !== u) userEl.value = u;
        }, credentials.webmail.username, credentials.webmail.password).catch(()=>{});

        await Promise.all([
            mailPage.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => null),
            mailPage.click('.signinbutton')
        ]);

        // CEK JIKA GAGAL LOGIN (SALAH PASSWORD)
        const isError = await mailPage.evaluate(() => {
            const err = document.querySelector('.signInErrorText, #signInErrorDiv, #errTxt');
            if (err && err.offsetParent !== null && err.textContent.trim().length > 0) return true;
            return false;
        }).catch(()=>false);
        
        if (isError) {
            bot.sendMessage(chatId, `❌ *GAGAL LOGIN WEBMAIL*\nUsername atau Password Webmail OWA salah/kadaluarsa.\n\nSilakan perbaiki menggunakan perintah:\n\`/set_webmail <username> <password>\``, {parse_mode: 'Markdown'});
            throw new Error('Webmail login failed due to invalid credentials.');
        }

        bot.sendMessage(chatId, `⏳ Mencari email pemberitahuan AP2T terbaru...`);
        await new Promise(r => setTimeout(r, 2000)); // Tunggu inbox load

        bot.sendMessage(chatId, `⏳ Menunggu email pemberitahuan masuk (maks 2 menit)...`);
        
        let elemHandle = null;
        let retries = 0;
        const maxRetries = 24; // 24 * 5 detik = 120 detik (2 menit)

        while (retries < maxRetries) {
            // Cek dan tutup popup OWA jika muncul di tengah-tengah
            await mailPage.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, span, div, a, .ms-Button'));
                const okBtn = buttons.find(b => {
                    const txt = (b.textContent || '').trim().toUpperCase();
                    return txt === 'OK' && b.offsetParent !== null;
                });
                if (okBtn) okBtn.click();
            }).catch(() => {});

            const found = await mailPage.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('*')).filter(el => {
                    const txt = el.textContent.toLowerCase();
                    return (txt.includes('notifikasi_ap2t') || txt.includes('pemberitahuan login') || txt.includes('reset session')) && el.children.length === 0;
                });
                return elements.length > 0;
            });

            if (found) {
                elemHandle = await mailPage.evaluateHandle(() => {
                    const elements = Array.from(document.querySelectorAll('*')).filter(el => {
                        const txt = el.textContent.toLowerCase();
                        return (txt.includes('notifikasi_ap2t') || txt.includes('pemberitahuan login') || txt.includes('reset session')) && el.children.length === 0;
                    });
                    return elements[0];
                });
                break;
            }

            retries++;
            if (retries % 6 === 0) bot.sendMessage(chatId, `⏳ Masih menunggu email terbaru masuk... (${retries * 5} / 120 detik)`);
            await new Promise(r => setTimeout(r, 5000));
        }

        if (elemHandle) {
            bot.sendMessage(chatId, `📧 Membuka email Pemberitahuan Login...`);
            const box = await elemHandle.boundingBox();
            if (box) {
                const cx = box.x + box.width / 2;
                const cy = box.y + box.height / 2;
                // Cukup SATU KALI klik kiri secara fisik agar tidak membuka tab baru
                await mailPage.mouse.click(cx, cy);
                await new Promise(r => setTimeout(r, 1000));
            } else {
                await elemHandle.click().catch(() => { });
            }
            await elemHandle.dispose();

            // Cek popup limit storage yang mungkin muncul SETELAH membuka email
            await mailPage.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button, span, div, a, .ms-Button'));
                const okBtn = buttons.find(b => {
                    const txt = (b.textContent || '').trim().toUpperCase();
                    return txt === 'OK' && b.offsetParent !== null;
                });
                if (okBtn) okBtn.click();
            }).catch(() => {});
            await new Promise(r => setTimeout(r, 1000));
        } else {
            bot.sendMessage(chatId, `⚠️ *TIDAK ADA EMAIL BARU*\nSudah menunggu 2 menit namun email *Reset MAC* belum masuk dari pusat. Harap ulangi beberapa saat lagi.`, {parse_mode: 'Markdown'});
            throw new Error('Tidak ada email baru masuk dalam waktu 2 menit (MAC).');
        }

        bot.sendMessage(chatId, `⏳ Menunggu isi email muncul di layar...`);
        // Tunggu maksimal 10 detik agar link 'Hapus' muncul di layar
        await mailPage.waitForFunction(() => {
            return Array.from(document.querySelectorAll('a')).some(a => a.textContent.trim().toLowerCase() === 'hapus');
        }, { timeout: 10000 }).catch(() => { });

        // Ambil semua URL dari link "Hapus"
        const hapusLinks = await mailPage.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'))
                .filter(a => a.textContent.trim().toLowerCase() === 'hapus')
                .map(a => a.href);
            return links;
        });

        if (hapusLinks.length > 0) {
            bot.sendMessage(chatId, `🔍 Ditemukan ${hapusLinks.length} MAC Address yang harus dihapus. Memproses satu per satu...`);

            // Buka setiap link hapus di tab baru secara bergantian
            for (let i = 0; i < hapusLinks.length; i++) {
                bot.sendMessage(chatId, `🧹 Menghapus MAC Address N[+]${i + 1}...`);
                const delPage = await browser.newPage();

                // Otomatis klik OK jika ada popup konfirmasi dari AP2T saat menghapus MAC
                delPage.on('dialog', async dialog => {
                    await dialog.accept();
                });

                try {
                    await delPage.goto(hapusLinks[i], { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(e => console.log('Halaman hapus selesai dimuat (mengabaikan spinner)'));

                    // JIKA ADA TOMBOL HAPUS/YES/OK DI HALAMAN TERSEBUT, KLIK OTOMATIS
                    await delPage.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn'));
                        const target = btns.find(b => {
                            const txt = (b.textContent || b.value || '').toLowerCase();
                            return txt.includes('hapus') || txt.includes('yes') || txt.includes('ok') || txt.includes('setuju');
                        });
                        if (target) target.click();
                    });

                    await new Promise(r => setTimeout(r, 3000));

                    // AMBIL SCREENSHOT AGAR KITA BISA LIHAT HASILNYA
                    const path = require('path');
                    const fs = require('fs');
                    const ssBuffer = await delPage.screenshot();
                    await bot.sendPhoto(chatId, ssBuffer, { caption: `📸 Screenshot layar setelah klik Hapus MAC ke-${i + 1}` }, { filename: `screenshot_hapus.png`, contentType: 'image/png' });

                } catch (err) {
                    console.error(`Gagal menghapus MAC ${i + 1}:`, err);
                } finally {
                    await delPage.close().catch(() => { });
                }
            }
            bot.sendMessage(chatId, `✅ Semua MAC Address selesai diproses! Kembali ke AP2T...`);
        } else {
            bot.sendMessage(chatId, `⚠️ Link 'Hapus' MAC Address tidak ditemukan di email. Mungkin salah buka email atau tidak ada MAC yang terdaftar.`);
        }

    } catch (e) {
        bot.sendMessage(chatId, `❌ Error Webmail OWA: ${e.message}`);
    } finally {
        await mailPage.close().catch(() => { });
    }
}

// ===== FUNGSI: Login =====
async function login(accountType, chatId) {
    try {
        await initBrowser(chatId);

        bot.sendMessage(chatId, `⏳ Membuka halaman login AP2T...`);
        await page.goto('https://ap2t.pln.co.id/ap2t/Login.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Cek apakah langsung dialihkan ke dashboard (karena session cookie masih aktif)
        await new Promise(r => setTimeout(r, 3000));
        const dashboardUrlCheck = page.url().toLowerCase();
        if (dashboardUrlCheck.includes('beranda') || dashboardUrlCheck.includes('menu') || dashboardUrlCheck.includes('default')) {
            bot.sendMessage(chatId, `✅ Sesi sebelumnya masih aktif! Anda sudah berada di dalam sistem AP2T.`);
            return true;
        }

        const { username, password } = credentials[accountType];
        if (!username || !password) {
            bot.sendMessage(chatId, `⚠️ Kredensial [${accountType}] kosong di .env`);
            return false;
        }

        // Pastikan form login benar-benar ada
        try {
            await page.waitForSelector(SELECTORS.usernameInput, { timeout: 10000 });
        } catch (e) {
            bot.sendMessage(chatId, `⚠️ Halaman login tidak merespon dengan benar atau Anda sudah login di halaman lain.`);
            // Anggap saja sudah login untuk menghindari crash
            return true;
        }

        bot.sendMessage(chatId, `⏳ Mengisi User ID dan Password...`);

        await page.evaluate((s) => { document.querySelector(s).value = ''; }, SELECTORS.usernameInput);
        await page.evaluate((s) => { document.querySelector(s).value = ''; }, SELECTORS.passwordInput);
        await page.type(SELECTORS.usernameInput, username, { delay: 50 });
        await page.type(SELECTORS.passwordInput, password, { delay: 50 });

        // ===== BACA KODE ENKRIPSI OTOMATIS =====
        let kodeEnkripsi = '';
        try {
            kodeEnkripsi = await getEncryptionCodeFromApp(chatId);
            bot.sendMessage(chatId, `🔑 Kode enkripsi: \`${kodeEnkripsi}\``, { parse_mode: 'Markdown' });
        } catch (encErr) {
            console.error('Auto enkripsi gagal:', encErr.message);
            bot.sendMessage(chatId, `⚠️ Auto-baca gagal (${encErr.message}).\nSilakan kirim kode enkripsi manual (timeout 90 detik):`);

            let waitingManual = true;
            const manualHandler = (msg) => {
                if (msg.chat.id === chatId && msg.text && !msg.text.startsWith('/')) {
                    kodeEnkripsi = msg.text.trim();
                    waitingManual = false;
                    bot.removeListener('message', manualHandler);
                }
            };
            bot.on('message', manualHandler);
            let countdown = 90;
            while (waitingManual && countdown > 0) {
                await new Promise(r => setTimeout(r, 1000));
                countdown--;
            }
            bot.removeListener('message', manualHandler);
            if (!kodeEnkripsi) {
                bot.sendMessage(chatId, `⏰ Timeout. Login dibatalkan.`);
                return false;
            }
        }

        // Isi kode enkripsi — WAJIB pakai Ctrl+V (bukan ketik/set value)
        // Field AP2T punya event listener yang hanya trigger saat paste
        bot.sendMessage(chatId, `⏳ Memasukkan kode enkripsi via Ctrl+V...`);

        // 1. Set kode ke clipboard Windows dulu via PowerShell (gunakan base64 agar aman dari karakter khusus)
        try {
            const b64 = Buffer.from(kodeEnkripsi).toString('base64');
            execSync(`powershell -command "[System.Windows.Forms.Clipboard]::SetText([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')))"`, { stdio: 'ignore' });
        } catch (e) {
            console.error('Set clipboard gagal:', e.message);
            // Fallback ke cara biasa jika gagal
            try {
                const escaped = kodeEnkripsi.replace(/'/g, "''");
                execSync(`powershell -command "Set-Clipboard -Value '${escaped}'"`, { stdio: 'ignore' });
            } catch (e2) { }
        }
        await new Promise(r => setTimeout(r, 1000));

        // 2. Klik field enkripsi agar terfokus
        await page.waitForSelector(SELECTORS.encryptionInput, { timeout: 10000 });
        await page.click(SELECTORS.encryptionInput);
        await new Promise(r => setTimeout(r, 300));

        // 3. Paste dengan Ctrl+V — ini yang memicu validasi AP2T
        await page.keyboard.down('Control');
        await page.keyboard.press('v');
        await page.keyboard.up('Control');

        // 4. Tunggu validasi selesai (checkbox Valid muncul)
        await new Promise(r => setTimeout(r, 2000));

        // Cek apakah valid (opsional, lanjut saja jika tidak terdeteksi)
        const isValid = await page.evaluate(() => {
            const lbl = document.querySelector('#lblEnkripsi');
            return lbl && lbl.value && lbl.value.toLowerCase().includes('valid');
        }).catch(() => false);

        if (isValid) {
            bot.sendMessage(chatId, `✅ Enkripsi Valid!`);
        } else {
            bot.sendMessage(chatId, `⚠️ Enkripsi mungkin belum tervalidasi, melanjutkan login...`);
        }
        await new Promise(r => setTimeout(r, 500));

        // Klik Login (menggunakan Promise.race agar tidak menunggu 30 detik jika ada popup ExtJS)
        bot.sendMessage(chatId, `⏳ Menekan tombol Login...`);
        const navPromise = page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null);
        const popupPromise = page.waitForFunction(() => {
            return document.querySelector('.ext-mb-text') || document.querySelector('.x-window-mc') || document.querySelector('.alert-danger');
        }, { timeout: 30000 }).catch(() => null);
        
        await page.click(SELECTORS.loginButton);
        await Promise.race([navPromise, popupPromise]);
        await new Promise(r => setTimeout(r, 2000));
        await checkPause(chatId);
        await new Promise(r => setTimeout(r, 3000));

        // Cek hasil login
        const isDashboard = await page.$(SELECTORS.dashboardElement).catch(() => null);
        if (isDashboard) return true;


        // Cek limit MAC
        const content = await page.content();

        if (content.includes('Data enkripsi tidak valid, data sudah kadaluarsa')) {
            bot.sendMessage(chatId, `⚠️ Data enkripsi sudah kadaluarsa. Mengambil ulang kode enkripsi baru...`);
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('.ext-mb-btn button, .x-window-mc button, button'));
                const okBtn = btns.find(b => b.textContent === 'OK');
                if (okBtn) okBtn.click();
            });
            await new Promise(r => setTimeout(r, 1000));
            // Force fetch a new code by clearing any local cache if I had one, or just re-running login
            return await login(accountType, chatId);
        }

        // >> TAMBAHAN LOGIC RESET SESSION
        if (content.includes('User ID yang sama sedang digunakan di tempat lain')) {
            bot.sendMessage(chatId, `[i] Sesi nyangkut (User ID sedang digunakan). Melakukan Reset Session otomatis...`);

            // Klik OK di popup
            await page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('.ext-mb-btn button, .x-window-mc button, button'));
                const okBtn = btns.find(b => b.textContent === 'OK');
                if (okBtn) okBtn.click();
            });
            await new Promise(r => setTimeout(r, 1000));

            // Klik "Reset Session [i]"
            await page.evaluate(() => {
                const links = Array.from(document.querySelectorAll('a'));
                const resetLink = links.find(a => a.textContent.includes('Reset Session'));
                if (resetLink) resetLink.click();
            });
            await new Promise(r => setTimeout(r, 3000));

            bot.sendMessage(chatId, `[i] Mengisi form Reset Session...`);
            // Format email
            let emailUser = credentials.webmail.username;
            emailUser = emailUser.replace(/^.*[\\\/]/, ''); // Hapus domain seperti pusat\ atau uid\
            if (!emailUser.includes('@')) emailUser += '@pln.co.id';

            await page.evaluate((userId, email) => {
                const win = document.querySelector('.x-window');
                const inputs = Array.from((win || document).querySelectorAll('input[type="text"], input[type="email"], input.x-form-text'));
                let visibleInputs = inputs.filter(i => i.offsetParent !== null && !i.disabled);

                if (visibleInputs.length >= 2) {
                    visibleInputs[0].focus();
                    visibleInputs[0].value = userId;
                    visibleInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
                    visibleInputs[0].dispatchEvent(new Event('blur', { bubbles: true }));
                    
                    visibleInputs[1].focus();
                    visibleInputs[1].value = email;
                    visibleInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
                    visibleInputs[1].dispatchEvent(new Event('blur', { bubbles: true }));
                }
            }, credentials[accountType].username, emailUser);
            
            await new Promise(r => setTimeout(r, 1500));

            await page.evaluate(() => {
                const win = document.querySelector('.x-window');
                const btns = Array.from((win || document).querySelectorAll('button, .x-btn-text, input[type="button"]'));
                const kirim = btns.find(b => (b.textContent || b.value || '').toLowerCase().includes('kirim'));
                if (kirim) kirim.click();
            });

            await new Promise(r => setTimeout(r, 3000));
            bot.sendMessage(chatId, `[i] Permintaan Reset Session dikirim. Memeriksa Webmail...`);
            await handleOwaSessionReset(chatId);

            bot.sendMessage(chatId, `[i] Login ulang setelah reset session...`);
            return await login(accountType, chatId);
        }
        // << AKHIR LOGIC RESET SESSION

        if (content.includes('Mohon maaf User ID AP2T hanya diijinkan dari 2 MAC Address') || content.includes('dikirimkan ke email')) {
            bot.sendMessage(chatId, `⚠️ Limit MAC Address terdeteksi. Otomatis reset via OWA...`);
            await handleOwaMacReset(chatId);
            bot.sendMessage(chatId, `🔄 Login ulang setelah reset...`);
            return await login(accountType, chatId);
        }

        // Cek apakah URL sudah bukan login page
        const currentUrl = page.url();
        if (!currentUrl.includes('Login.aspx')) {
            return true; // berhasil
        }

        const errorEl = await page.$(SELECTORS.errorMessage).catch(() => null);
        if (errorEl) {
            const errText = await page.evaluate(el => el.textContent, errorEl);
            bot.sendMessage(chatId, `❌ Pesan web: ${errText.trim()}`);
        }
        return false;
    } catch (error) {
        console.error(`Login error [${accountType}]:`, error.message);
        bot.sendMessage(chatId, `[x] Error login: ${error.message}`);
        browser = null; page = null;
        return false;
    }
}
// ===== FUNGSI: Smart Login =====
async function startSmartLogin(chatId) {
    bot.sendMessage(chatId, `🚀 Memulai proses login...`);
    const success = await login('main', chatId);
    if (success) {
        isLoggedIn = true;
        currentAccount = 'main';
        bot.sendMessage(chatId, `✅ Login berhasil dengan Akun Utama!`);
    } else {
        bot.sendMessage(chatId, `⚠️ Login gagal. Coba lagi dengan /login atau /reset_akun`);
    }
}

// ===== COMMANDS =====

// --- ADMIN COMMANDS ---
bot.onText(/\/upload_perbaikan/, async (msg) => {
    if (msg.chat.id.toString() !== adminChatId) return bot.sendMessage(msg.chat.id, "⛔ Akses ditolak.");
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    if (!token || !repo) return bot.sendMessage(msg.chat.id, "❌ Konfigurasi GITHUB_TOKEN atau GITHUB_REPO belum diatur di .env");
    
    const statusMsg = await bot.sendMessage(msg.chat.id, "⏳ Sedang memeriksa dan mengunggah perbaikan ke GitHub...\nMohon tunggu sebentar...");
    const filesToSync = ['index.js', 'server.js', 'public/index.html', 'public/style.css', 'public/app.js'];
    const axios = require('axios');
    let successCount = 0;
    let sameCount = 0;
    let failCount = 0;
    
    for (const file of filesToSync) {
        try {
            const filePath = path.join(__dirname, ...file.split('/'));
            if (!fs.existsSync(filePath)) continue;
            
            const content = fs.readFileSync(filePath, 'utf8');
            const contentBase64 = Buffer.from(content).toString('base64');
            
            const url = `https://api.github.com/repos/${repo}/contents/${file}?ref=${branch}`;
            const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
            let sha = null;
            try {
                const getRes = await axios.get(url, { headers });
                sha = getRes.data.sha;
            } catch (e) {
                if (e.response && e.response.status !== 404) throw e;
            }
            
            const payload = {
                message: `Update ${file} via Telegram Bot`,
                content: contentBase64,
                branch: branch
            };
            if (sha) payload.sha = sha;
            
            await axios.put(url, payload, { headers });
            successCount++;
        } catch (e) {
            if (e.response && e.response.status === 422) {
                sameCount++;
            } else {
                console.error(`Gagal upload ${file}:`, e.message);
                failCount++;
            }
        }
    }
    
    let resultMsg = `*Hasil Sinkronisasi GitHub:*\n`;
    if (successCount > 0) resultMsg += `✅ *${successCount} File Diunggah*\n`;
    if (sameCount > 0) resultMsg += `ℹ️ *${sameCount} File Sudah Versi Terbaru* (Tidak ada perubahan)\n`;
    if (failCount > 0) resultMsg += `❌ *${failCount} File Gagal*\n`;
    
    if (successCount > 0) {
        resultMsg += `\nSekarang Anda bisa menjalankan \`/update_bot\` di PC lain.`;
    }
    
    bot.editMessageText(resultMsg, {
        chat_id: msg.chat.id,
        message_id: statusMsg.message_id,
        parse_mode: 'Markdown'
    }).catch(() => {});
});

bot.onText(/\/update_bot/, async (msg) => {
    if (msg.chat.id.toString() !== adminChatId) return bot.sendMessage(msg.chat.id, "⛔ Akses ditolak.");
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    if (!token || !repo) return bot.sendMessage(msg.chat.id, "❌ Konfigurasi GITHUB_TOKEN atau GITHUB_REPO belum diatur.");
    
    bot.sendMessage(msg.chat.id, "⏳ Sedang mengunduh update dari GitHub...");
    const filesToSync = ['index.js', 'server.js', 'public/index.html', 'public/style.css', 'public/app.js'];
    const axios = require('axios');
    let successCount = 0;
    
    for (const file of filesToSync) {
        try {
            const url = `https://raw.githubusercontent.com/${repo}/${branch}/${file}`;
            const headers = { Authorization: `token ${token}` };
            const res = await axios.get(url, { headers });
            
            const filePath = path.join(__dirname, ...file.split('/'));
            fs.writeFileSync(filePath, res.data);
            successCount++;
        } catch (e) {
            console.error(`Gagal download ${file}:`, e.message);
        }
    }
    
    bot.sendMessage(msg.chat.id, `✅ Update selesai! Berhasil memperbarui ${successCount} file.\nBot akan me-restart sekarang...`);
    setTimeout(() => {
        try { require('child_process').execSync('pm2 restart AP2T_Bot'); } catch(e){ process.exit(0); }
    }, 2000);
});
bot.onText(/\/keygen (.+)/, (msg, match) => {
    if (msg.chat.id.toString() !== adminChatId) return bot.sendMessage(msg.chat.id, "⛔ Akses ditolak. Anda bukan Admin.");
    const reqHwid = match[1].trim();
    const key = crypto.createHash('sha256').update(reqHwid + "AP2T_PLN_SECRET").digest('hex').substring(0, 16).toUpperCase();
    bot.sendMessage(msg.chat.id, `🔑 **KUNCI LISENSI BERHASIL DIBUAT**\n\nHWID: \`${reqHwid}\`\nLicense Key: \`${key}\`\n\nGunakan perintah \`/set_license ${key}\` di komputer tersebut untuk mengaktifkan bot.`, {parse_mode: 'Markdown'});
});

bot.onText(/\/set_license (.+)/, (msg, match) => {
    if (msg.chat.id.toString() !== adminChatId) return bot.sendMessage(msg.chat.id, "⛔ Akses ditolak. Anda bukan Admin.");
    const key = match[1].trim().toUpperCase();
    const expected = crypto.createHash('sha256').update(HWID + "AP2T_PLN_SECRET").digest('hex').substring(0, 16).toUpperCase();
    
    if (key === expected) {
        process.env.LICENSE_KEY = key;
        const envPath = path.join(__dirname, '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf8');
        if (envContent.includes('LICENSE_KEY=')) {
            envContent = envContent.replace(/^LICENSE_KEY=.*$/m, `LICENSE_KEY=${key}`);
        } else {
            envContent += `\nLICENSE_KEY=${key}`;
        }
        fs.writeFileSync(envPath, envContent.trim() + '\n');
        bot.sendMessage(msg.chat.id, `✅ **LISENSI DITERIMA**\nBot berhasil diaktifkan untuk komputer ini!`, {parse_mode: 'Markdown'});
    } else {
        bot.sendMessage(msg.chat.id, `❌ **LISENSI TIDAK VALID**\nKunci lisensi tidak sesuai dengan Hardware ID komputer ini (\`${HWID}\`).`, {parse_mode: 'Markdown'});
    }
});

bot.onText(/\/tambah_user (.+)/, (msg, match) => {
    if (msg.chat.id.toString() !== adminChatId) return bot.sendMessage(msg.chat.id, "⛔ Akses ditolak.");
    const input = match[1].trim().split(' ');
    if (input.length < 2) return bot.sendMessage(msg.chat.id, "⚠️ Format salah.\nGunakan: `/tambah_user <chat_id> <nama>`\nContoh: `/tambah_user 12345678 Budi PLN`", {parse_mode: 'Markdown'});
    
    const newId = input[0];
    const newName = input.slice(1).join(' ');
    
    const usersPath = path.join(__dirname, 'users.json');
    let usersData = { users: [] };
    if (fs.existsSync(usersPath)) {
        try { usersData = JSON.parse(fs.readFileSync(usersPath, 'utf8')); } catch(e){}
    }
    
    const exists = usersData.users.some(u => (typeof u === 'object' ? u.id : u) === newId);
    if (!exists) {
        usersData.users.push({ id: newId, nama: newName });
        fs.writeFileSync(usersPath, JSON.stringify(usersData, null, 2));
        bot.sendMessage(msg.chat.id, `✅ Staf *${newName}* (\`${newId}\`) berhasil didaftarkan di PC ini!`, {parse_mode: 'Markdown'});
        updateGitHubStatus(); // Lapor status
    } else {
        bot.sendMessage(msg.chat.id, `⚠️ User dengan ID \`${newId}\` sudah terdaftar.`);
    }
});

bot.onText(/\/hapus_user/, (msg) => {
    if (msg.chat.id.toString() !== adminChatId) return bot.sendMessage(msg.chat.id, "⛔ Akses ditolak.");
    
    const usersPath = path.join(__dirname, 'users.json');
    let usersData = { users: [] };
    if (fs.existsSync(usersPath)) {
        try { usersData = JSON.parse(fs.readFileSync(usersPath, 'utf8')); } catch(e){}
    }
    
    if (usersData.users.length === 0) return bot.sendMessage(msg.chat.id, "Tidak ada user terdaftar di PC ini.");
    
    const inlineKeyboard = usersData.users.map(u => {
        let id = typeof u === 'object' ? u.id : u;
        let nama = typeof u === 'object' ? u.nama : u;
        return [{ text: `❌ Hapus: ${nama} (${id})`, callback_data: `deluser_${id}` }];
    });
    
    bot.sendMessage(msg.chat.id, "Pilih staf yang ingin dihapus aksesnya dari PC ini:", {
        reply_markup: { inline_keyboard: inlineKeyboard }
    });
});

bot.onText(/\/daftar_user/, (msg) => {
    if (msg.chat.id.toString() !== adminChatId) return bot.sendMessage(msg.chat.id, "⛔ Akses ditolak.");
    const usersPath = path.join(__dirname, 'users.json');
    let usersData = { users: [] };
    if (fs.existsSync(usersPath)) {
        try { usersData = JSON.parse(fs.readFileSync(usersPath, 'utf8')); } catch(e){}
    }
    if (usersData.users.length === 0) return bot.sendMessage(msg.chat.id, "Tidak ada user tambahan yang terdaftar.");
    const list = usersData.users.map(u => `- \`${u}\``).join('\n');
    bot.sendMessage(msg.chat.id, `👥 **DAFTAR USER TERDAFTAR:**\n\n${list}`, {parse_mode: 'Markdown'});
});

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    let menuText = `⚡ *BOT AP2T PLN (V3)* ⚡\n\n` +
        `🛠️ *MENU UTAMA:*\n` +
        `\`/login\` - Masuk ke AP2T (Smart Login)\n` +
        `\`/status\` - Cek status bot & ambil screenshot layar\n` +
        `\`/ambil_token <no_agenda>\` - Cari dan ambil Token 20 digit\n` +
        `\`/cetak_token <no_agenda>\` - Cetak tiket token otomatis\n` +
        `\`/cek_token <no_agenda>\` - Monitoring layar token (SS)\n\n` +
        `🔍 *PENCARIAN DATA:*\n` +
        `\`/ct <idpel_atau_nometer> <no_gangguan>\` - Proses CLEAR TAMPER otomatis\n` +
        `\`/cek_pelanggan <idpel_atau_nometer>\` - Cek Data Pelanggan\n` +
        `\`/logout\` - Mengeluarkan akun dan menutup Chrome\n` +
        `\`/reset_akun\` - Gunakan ini JIKA bot macet/error untuk me-restart paksa browser\n\n` +
        `⚙️ *MANAJEMEN AKUN:*\n` +
        `\`/set_ap2t <user> <pass>\` - Ganti akun AP2T\n` +
        `\`/set_webmail <user> <pass>\` - Ganti akun Webmail (OWA)\n` +
        `\`/simpan_akun <nama> <userAP2T> <passAP2T> <userWeb> <passWeb>\` - Simpan profil akun\n` +
        `\`/pakai_akun <nama>\` - Ganti akun dengan cepat\n` +
        `\`/daftar_akun\` - Lihat semua profil akun tersimpan`;

    if (chatId.toString() === adminChatId) {
        menuText += `\n\n👑 *MENU KHUSUS ADMIN:*\n` +
        `\`/tambah_user <chat_id>\` - Tambah akses staf\n` +
        `\`/hapus_user <chat_id>\` - Cabut akses staf\n` +
        `\`/keygen <hwid>\` - Generate lisensi untuk PC baru\n` +
        `\`/upload_perbaikan\` - Upload kode terbaru ke GitHub\n` +
        `\`/update_bot\` - Download update dari GitHub\n`;
    }

    bot.sendMessage(chatId, menuText, { parse_mode: 'Markdown' });
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    bot.answerCallbackQuery(query.id).catch(() => {});

    if (data === 'cmd_login') {
        bot.sendMessage(chatId, "Ketik /login untuk memulai proses masuk ke AP2T.");
    } else if (data === 'cmd_status') {
        bot.sendMessage(chatId, "Ketik /status untuk mengecek kondisi browser.");
    } else if (data === 'cmd_ct') {
        bot.sendMessage(chatId, "Kirimkan perintah dengan format:\n`/ct <idpel_atau_nometer> <no_gangguan>`", { parse_mode: 'Markdown' });
    } else if (data === 'cmd_resume') {
        bot.sendMessage(chatId, "Ketik /resume untuk melanjutkan proses CT yang tertunda.");
    } else if (data === 'cmd_cetak') {
        bot.sendMessage(chatId, "Kirimkan perintah dengan format:\n`/cetak_token <no_agenda>`", { parse_mode: 'Markdown' });
    } else if (data === 'cmd_cektoken') {
        bot.sendMessage(chatId, "Kirimkan perintah dengan format:\n`/cek_token <no_agenda>`", { parse_mode: 'Markdown' });
    } else if (data === 'cmd_logout') {
        bot.sendMessage(chatId, "Kirimkan perintah /logout untuk keluar dari sesi AP2T saat ini.");
    } else if (data.startsWith('deluser_')) {
        if (chatId.toString() !== adminChatId) return bot.sendMessage(chatId, "⛔ Akses ditolak.");
        const delId = data.replace('deluser_', '');
        const usersPath = path.join(__dirname, 'users.json');
        let usersData = { users: [] };
        if (fs.existsSync(usersPath)) {
            try { usersData = JSON.parse(fs.readFileSync(usersPath, 'utf8')); } catch(e){}
        }
        const initialLen = usersData.users.length;
        usersData.users = usersData.users.filter(u => (typeof u === 'object' ? u.id : u) !== delId);
        if (usersData.users.length < initialLen) {
            fs.writeFileSync(usersPath, JSON.stringify(usersData, null, 2));
            bot.editMessageText(`✅ Staf dengan ID \`${delId}\` berhasil dihapus aksesnya dari PC ini.`, {
                chat_id: chatId,
                message_id: query.message.message_id,
                parse_mode: 'Markdown'
            });
            updateGitHubStatus(); // Lapor status
        } else {
            bot.sendMessage(chatId, `⚠️ User \`${delId}\` tidak ditemukan.`);
        }
    } else if (data === 'cmd_cekpel') {
        bot.sendMessage(chatId, "Kirimkan perintah dengan format:\n`/cek_pelanggan <idpel_atau_nometer>`", { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    if (page && !page.isClosed()) {
        const ss = await page.screenshot().catch(() => null);
        if (ss) bot.sendPhoto(chatId, ss, { caption: `Status saat ini. Akun: ${currentAccount}` });
    } else {
        bot.sendMessage(chatId, `[i] Browser tidak aktif.`);
    }
});

bot.onText(/\/login/, async (msg) => {
    const chatId = msg.chat.id;
    if (isLoggingIn) return bot.sendMessage(chatId, `[i] Sedang proses login...`);
    isLoggingIn = true;
    try { await startSmartLogin(chatId); }
    finally { isLoggingIn = false; }
});

bot.onText(/\/reset_akun/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `[*] Mereset semua koneksi...`);
    killChromeAndClean();
    browser = null; page = null; isLoggedIn = false; isLoggingIn = false;
    bot.sendMessage(chatId, `[+] Selesai. Silakan /login kembali.`);
});

bot.onText(/\/ct (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `[*] Perintah CT diterima. Sedang memproses...`);

    const parts = match[1].trim().split(/\s+/);
    if (parts.length < 2) {
        return bot.sendMessage(chatId, `[!] Format salah. Gunakan: \`/ct <idpel> <no_gangguan>\``, { parse_mode: 'Markdown' });
    }
    const [idpel, nogan] = parts;

    if (isLoggingIn) return bot.sendMessage(chatId, `[i] Bot sedang sibuk login. Mohon tunggu sebentar lalu ulangi.`);

    commandQueue.push(async () => {
        try {
            await processCT(idpel, nogan, chatId, msg.from.first_name);
        } catch (err) {
            bot.sendMessage(chatId, `❌ Terjadi kesalahan fatal CT: ${err.message}`);
        }
    });
    
    if (!isProcessingCT) {
        processQueue();
    } else {
        bot.sendMessage(chatId, `[i] Menunggu antrean... Saat ini ada ${commandQueue.length} permintaan.`);
    }
});

bot.onText(/\/reset_ct (.+)/, (msg, match) => {
    const idpel = match[1].trim();
    clearCTState(idpel);
    bot.sendMessage(msg.chat.id, `✅ Memori kerja (Resume State) untuk IDPEL ${idpel} telah dihapus. Anda bisa memulai pembuatan /ct dari awal lagi.`);
});
bot.onText(/\/pause_bot/, (msg) => {
    isPaused = true;
    bot.sendMessage(msg.chat.id, `[*] **Bot Di-Pause Secara Paksa!**\nBot langsung dihentikan sementara (dibekukan). Layar Chrome aman untuk dikontrol manual.\n\nKetik /resume_bot untuk melanjutkan.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/resume_bot/, (msg) => {
    if (isPaused) {
        isPaused = false;
        bot.sendMessage(msg.chat.id, `[*] **Bot Dilanjutkan!**\nMelanjutkan proses yang tertunda...`);
    } else {
        bot.sendMessage(msg.chat.id, `Bot saat ini sedang tidak di-pause.`);
    }
});

const updateEnv = (key, value) => {
    const path = require('path');
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
    }
    if (envContent.includes(`${key}=`)) {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        envContent = envContent.replace(regex, `${key}=${value}`);
    } else {
        envContent += `\n${key}=${value}`;
    }
    fs.writeFileSync(envPath, envContent.trim() + '\n');
};

bot.onText(/\/set_ap2t (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const parts = match[1].trim().split(/\s+/);

    if (parts.length < 2) {
        return bot.sendMessage(chatId, `[!] **Format salah!**\nGunakan format:\n\`/set_ap2t <user_ap2t> <pass_ap2t>\`\n\n*Contoh:*\n\`/set_ap2t 9514012B4Y Rahasia123\``, { parse_mode: 'Markdown' });
    }

    const [ap2tUser, ap2tPass] = parts;
    credentials.main.username = ap2tUser;
    credentials.main.password = ap2tPass;

    updateEnv('MAIN_USERNAME', ap2tUser);
    updateEnv('MAIN_PASSWORD', ap2tPass);

    bot.sendMessage(chatId, `[+] Akun AP2T berhasil diubah menjadi: **${ap2tUser}**`, { parse_mode: 'Markdown' });
});

bot.onText(/\/set_webmail (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const parts = match[1].trim().split(/\s+/);

    if (parts.length < 2) {
        return bot.sendMessage(chatId, `[!] **Format salah!**\nGunakan format:\n\`/set_webmail <user_webmail> <pass_webmail>\`\n\n*Contoh:*\n\`/set_webmail pusat\\\\sandy_hanif Rahasia123\``, { parse_mode: 'Markdown' });
    }

    const [webUser, webPass] = parts;
    credentials.webmail.username = webUser;
    credentials.webmail.password = webPass;

    updateEnv('WEBMAIL_USERNAME', webUser);
    updateEnv('WEBMAIL_PASSWORD', webPass);

    bot.sendMessage(chatId, `[+] Akun Webmail berhasil diubah menjadi: **${webUser}**`, { parse_mode: 'Markdown' });
});

bot.onText(/\/simpan_akun (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const parts = match[1].trim().split(/\s+/);

    if (parts.length < 5) {
        return bot.sendMessage(chatId, `[!] **Format salah!**\nGunakan format:\n\`/simpan_akun <nama_profil> <user_ap2t> <pass_ap2t> <user_webmail> <pass_webmail>\``, { parse_mode: 'Markdown' });
    }

    const path = require('path');
    const [nama, ap2tUser, ap2tPass, webUser, webPass] = parts;
    const profilesPath = path.join(__dirname, 'profiles.json');
    let profiles = {};
    if (fs.existsSync(profilesPath)) {
        profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    }

    profiles[nama] = {
        ap2t: { username: ap2tUser, password: ap2tPass },
        webmail: { username: webUser, password: webPass }
    };

    fs.writeFileSync(profilesPath, JSON.stringify(profiles, null, 2));
    bot.sendMessage(chatId, `[+] Profil akun **${nama}** berhasil disimpan!`, { parse_mode: 'Markdown' });
});

bot.onText(/\/pakai_akun (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const path = require('path');
    const nama = match[1].trim();
    const profilesPath = path.join(__dirname, 'profiles.json');

    if (!fs.existsSync(profilesPath)) return bot.sendMessage(chatId, `[i] Belum ada profil yang tersimpan.`);

    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));
    if (!profiles[nama]) return bot.sendMessage(chatId, `[i] Profil **${nama}** tidak ditemukan.`, { parse_mode: 'Markdown' });

    const p = profiles[nama];
    const pAp2t = p.ap2t || { username: p.ap2t_user, password: p.ap2t_pass };
    const pWebmail = p.webmail || { username: p.web_user, password: p.web_pass };
    
    credentials.main = pAp2t;
    credentials.webmail = pWebmail;

    updateEnv('MAIN_USERNAME', pAp2t.username);
    updateEnv('MAIN_PASSWORD', pAp2t.password);
    updateEnv('WEBMAIL_USERNAME', pWebmail.username);
    updateEnv('WEBMAIL_PASSWORD', pWebmail.password);

    bot.sendMessage(chatId, `[+] Berhasil berganti ke profil **${nama}**!\nBot akan otomatis mereset sesi. Silakan /login kembali.`, { parse_mode: 'Markdown' });

    killChromeAndClean();
    browser = null; page = null; isLoggedIn = false;
});

bot.onText(/\/daftar_akun/, async (msg) => {
    const chatId = msg.chat.id;
    const path = require('path');
    const profilesPath = path.join(__dirname, 'profiles.json');

    if (!fs.existsSync(profilesPath)) return bot.sendMessage(chatId, `[i] Belum ada profil yang tersimpan.`);
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8'));

    const names = Object.keys(profiles);
    if (names.length === 0) return bot.sendMessage(chatId, `[i] Belum ada profil yang tersimpan.`);

    const list = names.map(n => {
        const ap2tUser = profiles[n].ap2t ? profiles[n].ap2t.username : profiles[n].ap2t_user;
        return `- **${n}** (AP2T: ${ap2tUser})`;
    }).join('\n');
    bot.sendMessage(chatId, `[+] **Daftar Profil Akun:**\n\n${list}\n\nGunakan \`/pakai_akun <nama_profil>\` untuk menggunakan.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/logout/, async (msg) => {
    const chatId = msg.chat.id;
    if (!isLoggedIn) return bot.sendMessage(chatId, `ℹ️ Belum login.`);
    try {
        if (page && !page.isClosed()) { await page.close().catch(() => { }); page = null; }
        isLoggedIn = false; currentAccount = 'none';
        bot.sendMessage(chatId, `✅ Logout & tab AP2T ditutup.`);
    } catch (e) { bot.sendMessage(chatId, `❌ Gagal logout: ${e.message}`); }
});

bot.onText(/\/stop_bot/, async (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, `🛑 Mematikan bot dan menutup browser...`);
    try {
        if (browser) {
            await browser.close().catch(() => {});
        }
        await bot.sendMessage(chatId, `✅ Bot telah dimatikan dari Telegram.`);
        setTimeout(() => process.exit(0), 1500);
    } catch(e) {
        bot.sendMessage(chatId, `❌ Gagal mematikan bot: ${e.message}`);
    }
});
// ===== FUNGSI HELPER: Navigasi & UI =====

async function closePopups(page) {
    try {
        // 1. Coba tekan tombol Escape (seringkali menutup popup di ExtJS)
        await page.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500));

        // 2. Hapus elemen popup secara paksa dari DOM (Sangat Agresif & Pasti Hilang)
        const closeLogic = () => {
            // Hapus jendela ExtJS
            const windows = Array.from(document.querySelectorAll('.x-window, .x-window-dlg'));
            for (const win of windows) {
                if (win.style.display !== 'none' && win.style.visibility !== 'hidden' && win.offsetParent !== null) {
                    const txt = win.textContent.toLowerCase();
                    if (txt.includes('pesta siap bongkar') || txt.includes('informasi') || txt.includes('peringatan') || txt.includes('error')) {
                        win.remove(); // Hapus jendela dari DOM
                    }
                }
            }

            // Hapus background abu-abu (mask) dan bayangan (.x-shadow) yang menghalangi klik
            const masks = Array.from(document.querySelectorAll('.ext-el-mask, .ext-el-mask-msg, .x-shadow'));
            masks.forEach(m => m.remove());
            
            // Coba klik tombol X jika masih ada sisa (sebagai cadangan)
            const xButtons = Array.from(document.querySelectorAll('.x-tool-close, .x-tool-close-over, .x-window-close'));
            xButtons.forEach(btn => { 
                if (btn.offsetParent !== null) {
                    try { btn.click(); } catch(e){}
                } 
            });
        };

        // Eksekusi di main page
        await page.evaluate(closeLogic).catch(() => { });

        // Eksekusi di semua iframe
        for (const frame of page.frames()) {
            await frame.evaluate(closeLogic).catch(() => { });
        }

        await new Promise(r => setTimeout(r, 1000));
    } catch (e) { }
}

async function clickMenu(page, menuPath) {
    for (const menuName of menuPath) {
        console.log(`Mencoba klik menu: ${menuName}`);

        // Pastikan tidak ada popup yang menghalangi
        await closePopups(page);

        const clicked = await page.evaluate((name) => {
            const elements = Array.from(document.querySelectorAll('.x-tree-node-anchor, .x-tree-node-text, span, a'));
            const target = elements.find(el => el.textContent.trim() === name && el.offsetParent !== null);

            if (target) {
                const node = target.closest('.x-tree-node-el');
                const ec = node ? node.querySelector('.x-tree-ec-icon') : null;
                if (ec && (ec.className.includes('plus') || ec.className.includes('expand'))) {
                    ec.click();
                } else {
                    target.click();
                }
                return true;
            }
            return false;
        }, menuName);

        if (!clicked) {
            // Fallback: klik tanpa cek offsetParent (mungkin terhalang popup transparan)
            const forceClicked = await page.evaluate((name) => {
                const elements = Array.from(document.querySelectorAll('.x-tree-node-anchor, .x-tree-node-text'));
                const target = elements.find(el => el.textContent.trim() === name);
                if (target) { target.click(); return true; }
                return false;
            }, menuName);

            if (!forceClicked) throw new Error(`Menu "${menuName}" tidak ditemukan`);
        }
        await new Promise(r => setTimeout(r, 800));

        // Cek loading global setelah navigasi menu
        if (activeChatId) {
            let waitTime = 0;
            while (waitTime < 10000) {
                const isLoading = await page.evaluate(() => {
                    const txt = document.body.innerText;
                    return txt.includes('Loading') || !!document.querySelector('.ext-el-mask-msg');
                });
                if (!isLoading) break;
                await new Promise(r => setTimeout(r, 1000));
                waitTime += 1000;
            }
        }
    }
    
    // --- PENGHANCUR POPUP OTOMATIS (DI AKHIR SAJA) ---
    // Popup 'Pesta Siap Bongkar' biasanya muncul beberapa detik setelah menu TERAKHIR selesai loading.
    await new Promise(r => setTimeout(r, 1000));
    await closePopups(page);
}

async function setFieldValue(page, labelText, value, isDropdown = false) {
    const success = await page.evaluate(async (label, val, drop) => {
        const labels = Array.from(document.querySelectorAll('label, span, td, .x-form-item-label'));
        const targetLabel = labels.find(el => el.textContent.trim().includes(label) && el.offsetParent !== null);
        if (!targetLabel) return { success: false, msg: `Label ${label} tidak ditemukan` };

        // Cari input di parent atau sibling
        let container = targetLabel.closest('.x-form-item') || targetLabel.parentElement;
        let input = container.querySelector('input, textarea');

        if (!input) {
            // Coba cari di row yang sama (td)
            const row = targetLabel.closest('tr');
            if (row) input = row.querySelector('input, textarea');
        }

        if (input) {
            input.focus();
            input.scrollIntoView();
            // Simpan ID untuk digunakan di page.type()
            if (!input.id) input.id = 'bot_input_' + Math.random().toString(36).substr(2, 9);
            return { success: true, id: input.id };
        }
        return { success: false, msg: `Input untuk ${label} tidak ditemukan` };
    }, labelText, value, isDropdown);

    if (success.success) {
        // Gunakan page.type untuk simulasi keyboard sungguhan
        await page.click(`#${success.id}`, { clickCount: 3 }); // Select all
        await page.keyboard.press('Backspace');
        await page.type(`#${success.id}`, value, { delay: 50 });
        await page.keyboard.press('Tab');
        await new Promise(r => setTimeout(r, 500));
        return true;
    }
    console.error(success.msg);
    return false;
}

// ===== FUNGSI UTAMA: PROSES CT =====

async function processCT(idpel, nogan, chatId, pembuat) {
    activeChatId = chatId;
    try {
        if (!isLoggedIn) {
            const ok = await login('main', chatId);
            if (!ok) return;
            isLoggedIn = true;
            currentAccount = 'main';
        }

        // DETEKSI 11 DIGIT (NOMOR METER)
        if (idpel.length === 11) {
            const realIdpel = await getIdpelFromNomet(idpel, chatId);
            if (!realIdpel) {
                return bot.sendMessage(chatId, `❌ Gagal menemukan ID Pelanggan untuk Nomor Meter ${idpel}. Silakan masukkan ID Pelanggan secara manual.`);
            }
            bot.sendMessage(chatId, `✅ Berhasil mendapatkan ID Pelanggan: *${realIdpel}*. Melanjutkan proses CT...`, { parse_mode: 'Markdown' });
            idpel = realIdpel;
        }

        let currentState = getCTState(idpel) || { step: 'START', noAgenda: null, nogan: null };
        let isResuming = false;
        
        if (currentState.step !== 'START') {
            if (currentState.nogan && currentState.nogan !== nogan) {
                bot.sendMessage(chatId, `[i] Terdeteksi input No Gangguan yang berbeda (*${nogan}*) dari sebelumnya (*${currentState.nogan}*).\nMemulai ulang pembuatan CT dari awal...`, { parse_mode: 'Markdown' });
                clearCTState(idpel);
                currentState = { step: 'START', noAgenda: null, nogan: null };
            } else {
                bot.sendMessage(chatId, `[i] Memori kerja terdeteksi (IDPEL dan NOGAN sama)!\nMelompat langsung ke tahap **Monitoring Token**...`, { parse_mode: 'Markdown' });
                currentState.step = 'MONITORING';
                isResuming = true;
            }
        }
        let noAgenda = currentState.noAgenda;

        if (currentState.step === 'START') {
            bot.sendMessage(chatId, `🔍 Membersihkan popup pengumuman...`);
            // Tutup popup berkali-kali (agresif)
        for (let i = 0; i < 5; i++) {
            await closePopups(page);
            await new Promise(r => setTimeout(r, 800));
        }

        bot.sendMessage(chatId, `🔍 Navigasi Menu Pengaduan...`);
        // Pastikan menu terlihat
        await page.evaluate(() => {
            const expand = Array.from(document.querySelectorAll('a, span')).find(el => el.textContent.includes('Expand All'));
            if (expand) expand.click();
        });
        await new Promise(r => setTimeout(r, 1000));

        await clickMenu(page, ['PELAYANAN PELANGGAN', 'Rekening', 'Permohonan', 'Pengaduan Pelanggan']);

        bot.sendMessage(chatId, `⏳ Menunggu halaman Pengaduan Pelanggan terbuka...`);
        await page.waitForFunction(() => !document.body.innerText.includes('Loading Pengaduan Pelanggan'), { timeout: 30000 });
        await new Promise(r => setTimeout(r, 1500));

        // Bersihkan popup Informasi Pesta Siap Bongkar yang sering muncul setelah halaman dimuat
        bot.sendMessage(chatId, `🔍 Membersihkan popup Informasi jika ada...`);
        for (let i = 0; i < 3; i++) {
            await closePopups(page);
            await new Promise(r => setTimeout(r, 500));
        }

        // 0. Klik Tombol CLEAR (Jika sudah terbuka sebelumnya agar form bersih)
        bot.sendMessage(chatId, `🧹 Membersihkan Form Pengaduan...`);
        await page.evaluate(() => {
            const frames = Array.from(document.querySelectorAll('iframe'));
            for (const f of frames) {
                try {
                    const btns = Array.from(f.contentDocument.querySelectorAll('button, .x-btn-text'));
                    const clearBtn = btns.find(b => b.textContent.trim() === 'Clear' && b.offsetParent !== null);
                    if (clearBtn) {
                        clearBtn.click();
                        return;
                    }
                } catch (e) { }
            }
            // Jika di main page
            const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
            const clearBtn = btns.find(b => b.textContent.trim() === 'Clear' && b.offsetParent !== null);
            if (clearBtn) clearBtn.click();
        });
        await new Promise(r => setTimeout(r, 2000));

        // 1. Input Id Pelanggan (Cari di semua frame secara langsung)
        bot.sendMessage(chatId, `📝 Mencari kolom Id Pelanggan di semua tingkatan halaman...`);

        let targetFrame = null;
        const allFrames = page.frames();

        for (const frame of allFrames) {
            try {
                const found = await frame.evaluate(() => {
                    const labels = Array.from(document.querySelectorAll('label, span, td, .x-form-item-label'));
                    const targetLabel = labels.find(l => l.textContent.trim().includes('Id Pelanggan') && l.offsetParent !== null);

                    if (targetLabel) {
                        let container = targetLabel.closest('.x-form-item') || targetLabel.parentElement;
                        let input = container.querySelector('input[type="text"]');
                        if (!input) {
                            const allInputs = Array.from(document.querySelectorAll('input[type="text"]'));
                            input = allInputs.find(i => i.offsetParent !== null && Math.abs(i.getBoundingClientRect().top - targetLabel.getBoundingClientRect().top) < 30);
                        }

                        if (input) {
                            input.id = 'final_target_idpel';
                            input.scrollIntoView();
                            return true;
                        }
                    }
                    return false;
                });

                if (found) {
                    targetFrame = frame;
                    break;
                }
            } catch (e) { }
        }

        if (targetFrame) {
            bot.sendMessage(chatId, `📝 Mengisi Id Pelanggan: ${idpel}...`);
            await targetFrame.click('#final_target_idpel', { clickCount: 3 });
            await page.keyboard.down('Control');
            await page.keyboard.press('a');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 500));

            // Isi dengan type (simulasi)
            await targetFrame.type('#final_target_idpel', idpel, { delay: 100 });
            await page.keyboard.press('Enter');

            // Backup: paksa value jika type gagal memicu perubahan
            await targetFrame.evaluate((val) => {
                const input = document.getElementById('final_target_idpel');
                if (input && input.value !== val) {
                    input.value = val;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }, idpel);

            bot.sendMessage(chatId, `⏳ Menunggu data muncul...`);
            // CEK POPUP ERROR ULP / VALIDASI IDPEL (Misal beda unit)
            const checkPopup = async () => {
                return await page.evaluate(() => {
                    const mb = document.querySelector('.ext-mb-text');
                    if (mb && mb.offsetParent !== null && mb.textContent.trim().length > 0) {
                        const txt = mb.textContent.trim();
                        if (!txt.toLowerCase().includes('load data') && !txt.toLowerCase().includes('mohon tunggu') && !txt.toLowerCase().includes('loading')) {
                            return txt;
                        }
                    }
                    const wins = Array.from(document.querySelectorAll('.x-window')).filter(w => w.offsetParent !== null);
                    for(let w of wins) {
                        if(w.textContent.includes('Pemberitahuan') || w.textContent.includes('tidak valid') || w.textContent.includes('Error')) {
                            const body = w.querySelector('.x-window-mc') || w;
                            let text = body.textContent.replace(/OK|Yes|No|Cancel/gi, '').trim();
                            text = text.replace('Pemberitahuan', '').trim();
                            if (text.length > 5 && !text.toLowerCase().includes('load data') && !text.toLowerCase().includes('mohon tunggu')) return text;
                        }
                    }
                    return null;
                }).catch(()=>null) || await targetFrame.evaluate(() => {
                    const mb = document.querySelector('.ext-mb-text');
                    if (mb && mb.offsetParent !== null && mb.textContent.trim().length > 0) {
                        const txt = mb.textContent.trim();
                        if (!txt.toLowerCase().includes('load data') && !txt.toLowerCase().includes('mohon tunggu') && !txt.toLowerCase().includes('loading')) {
                            return txt;
                        }
                    }
                    const wins = Array.from(document.querySelectorAll('.x-window')).filter(w => w.offsetParent !== null);
                    for(let w of wins) {
                        if(w.textContent.includes('Pemberitahuan') || w.textContent.includes('tidak valid') || w.textContent.includes('Error')) {
                            const body = w.querySelector('.x-window-mc') || w;
                            let text = body.textContent.replace(/OK|Yes|No|Cancel/gi, '').trim();
                            text = text.replace('Pemberitahuan', '').trim();
                            if (text.length > 5 && !text.toLowerCase().includes('load data') && !text.toLowerCase().includes('mohon tunggu')) return text;
                        }
                    }
                    return null;
                }).catch(()=>null);
            };

            let popupMsg = null;
            let dataReady = false;
            for (let i = 0; i < 20; i++) { // Max 10 detik polling
                await new Promise(r => setTimeout(r, 500));
                popupMsg = await checkPopup();
                if (popupMsg) break;
                
                if (!dataReady) {
                    dataReady = await targetFrame.evaluate(() => {
                        const lbl = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes('Tarif / Daya'));
                        if (lbl) {
                            const input = lbl.closest('.x-form-item').querySelector('input');
                            if (input && input.value.trim().length > 0) return true;
                        }
                        return false;
                    }).catch(() => false);
                }
                
                // Pastikan kita menunggu setidaknya 4 detik (i >= 8) meskipun data sudah muncul
                // karena popup validasi server AP2T terkadang muncul sangat terlambat
                if (dataReady && i >= 8) {
                    break;
                }
            }
            
            if (!popupMsg) popupMsg = await checkPopup();

            if (popupMsg) {
                bot.sendMessage(chatId, `⚠️ Menangkap pesan error dari sistem AP2T...`);
                const ss = await page.screenshot({ fullPage: true }).catch(() => null);
                if (ss) await bot.sendPhoto(chatId, ss, { caption: `⚠️ *GAGAL BIKIN CT*\nID Pelanggan tidak dapat diproses (Beda ULP / Error Sistem).\n\nPesan AP2T: _${popupMsg}_`, parse_mode: 'Markdown' });
                throw new Error(`Dibatalkan oleh sistem AP2T: ${popupMsg}`);
            }

            // CEK TARIF PASCABAYAR
            bot.sendMessage(chatId, `🔍 Mengecek Tarif / Daya...`);
            const tarifDaya = await targetFrame.evaluate(() => {
                const labels = Array.from(document.querySelectorAll('label'));
                const label = labels.find(l => l.textContent.includes('Tarif / Daya'));
                if (label) {
                    const input = label.closest('.x-form-item').querySelector('input');
                    if (input) return input.value;
                }
                return null;
            });

            if (tarifDaya) {
                // Contoh: "R1M / 900"
                const tarifParts = tarifDaya.split('/');
                const tarif = tarifParts[0].trim().toUpperCase();
                if (!tarif.endsWith('T')) {
                    throw new Error(`⚠️ *KWH PASCABAYAR TERDETEKSI!*\nTarif Pelanggan: \`${tarifDaya}\`\nTarif tidak memiliki akhiran 'T', sehingga CT tidak dapat dibuat untuk KWH Pascabayar.`);
                }
            }
        } else {
            const ss = await page.screenshot().catch(() => null);
            if (ss) await bot.sendPhoto(chatId, ss, { caption: "Gagal menemukan kolom IDPEL." });
            throw new Error("Gagal menemukan kolom input Id Pelanggan.");
        }

        // Fungsi helper untuk memilih combobox ExtJS secara presisi
        const selectExtJSCombo = async (labelName, targetVal) => {
            await checkPause(chatId); // Tahan sebelum interaksi jika di-pause
            const id = await targetFrame.evaluate((lName) => {
                const lbl = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes(lName));
                if (!lbl) return null;
                const inp = lbl.closest('.x-form-item').querySelector('input');
                if (!inp) return null;
                // Klik tombol panah dropdown jika ada untuk me-load data
                const trig = lbl.closest('.x-form-item').querySelector('.x-form-trigger');
                if (trig) trig.click(); else inp.click();
                inp.id = 'combo_' + Math.random().toString(36).substr(2, 5);
                return inp.id;
            }, labelName);

            if (!id) throw new Error(`Input dropdown ${labelName} tidak ditemukan`);

            // Tunggu sebentar agar proses loading (Ajax) dari ExtJS selesai
            await new Promise(r => setTimeout(r, 1500));

            // Bersihkan input sebelum mengetik
            await targetFrame.evaluate((inpId) => { document.getElementById(inpId).value = ''; }, id);
            await targetFrame.click(`#${id}`);
            await new Promise(r => setTimeout(r, 500));
            
            // Ketik untuk memfilter dengan perlahan
            await targetFrame.type(`#${id}`, targetVal, { delay: 100 });
            await new Promise(r => setTimeout(r, 2000)); // Tunggu daftar hasil filter muncul

            // Cari dan klik elemen dropdown yang teksnya cocok via DOM Events
            const targetClicked = await targetFrame.evaluate((tVal) => {
                const items = Array.from(document.querySelectorAll('.x-combo-list-item, .x-boundlist-item'));
                // Gunakan includes agar lebih tahan banting terhadap spasi berlebih
                const target = items.find(i => i.textContent.toUpperCase().includes(tVal.toUpperCase()) && i.offsetParent !== null);
                if (target) {
                    target.scrollIntoView({ block: 'center' });
                    // ExtJS ComboBox mendeteksi event mousedown untuk memilih item
                    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    return true;
                }
                return false;
            }, targetVal);

            if (!targetClicked) throw new Error(`Opsi "${targetVal}" tidak terdeteksi di dropdown ${labelName}. Menghentikan proses.`);

            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('Tab'); // Trigger blur event untuk validasi
            await new Promise(r => setTimeout(r, 500));
        };

        // 2. Pilih Jenis Pengaduan (Menggunakan Klik Presisi)
        await checkPause(chatId);
        bot.sendMessage(chatId, `📝 Memilih Jenis Pengaduan...`);
        await selectExtJSCombo('Jenis Pengaduan', 'PERMINTAAN CLEAR TAMPER');

        // 3. Isi Uraian
        await checkPause(chatId);
        bot.sendMessage(chatId, `📝 Mengisi Uraian: ${nogan}...`);
        await targetFrame.evaluate((labelName) => {
            const label = Array.from(document.querySelectorAll('label')).find(l => l.textContent.includes(labelName));
            if (label) {
                const input = label.closest('.x-form-item').querySelector('textarea, input');
                input.focus();
                input.id = 'final_target_uraian';
            }
        }, 'Uraian:');
        await targetFrame.click('#final_target_uraian', { clickCount: 3 }).catch(() => { });
        await targetFrame.type('#final_target_uraian', nogan, { delay: 50 }).catch(() => { });
        await new Promise(r => setTimeout(r, 1000));

        // 4. Pilih Alasan Clear Tamper (Menggunakan Klik Presisi)
        await checkPause(chatId);
        bot.sendMessage(chatId, `📝 Memilih Alasan Clear Tamper...`);
        await selectExtJSCombo('Alasan Clear Tamper', 'Muncul Informasi Call, Overload atau Lock');

        // (Screenshot sebelum save dihapus, diganti menjadi screenshot setelah popup muncul)
        // Tahan di sini jika user meminta pause
        await checkPause(chatId);

        // 5. Klik Save
        bot.sendMessage(chatId, `💾 Menyimpan Pengaduan...`);
        await targetFrame.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
            const saveBtn = btns.find(b => b.textContent.trim() === 'Save' && b.offsetParent !== null);
            if (saveBtn) {
                saveBtn.focus();
                saveBtn.click();
            }
        });
        // 6. Tunggu dan Klik OK pada Popup Success
        // 6. Tunggu dan Klik OK pada Popup Success / Error
        bot.sendMessage(chatId, `⏳ Menunggu konfirmasi dari server AP2T...`);
        
        const checkSavePopupTextOnly = () => {
            let msg = null;
            const mb = document.querySelector('.ext-mb-text');
            if (mb && mb.offsetParent !== null && mb.textContent.trim().length > 0) {
                msg = mb.textContent.trim();
            } else {
                const wins = Array.from(document.querySelectorAll('.x-window')).filter(w => w.offsetParent !== null);
                for(let w of wins) {
                    if (w.textContent.includes('Pemberitahuan') || w.textContent.includes('Error') || w.textContent.includes('tidak valid') || w.textContent.includes('Berhasil')) {
                        const body = w.querySelector('.x-window-mc') || w;
                        let text = body.textContent.replace(/OK|Yes|No|Cancel/gi, '').trim();
                        text = text.replace('Pemberitahuan', '').trim();
                        if (text.length > 3) msg = text;
                    }
                }
            }
            return msg; // DONT CLICK OK YET
        };
        
        let savePopupMsg = null;
        for (let i = 0; i < 30; i++) { // Polling max 15 detik
            await new Promise(r => setTimeout(r, 500));
            savePopupMsg = await page.evaluate(checkSavePopupTextOnly).catch(()=>null) || await targetFrame.evaluate(checkSavePopupTextOnly).catch(()=>null);
            if (savePopupMsg) break;
        }

        // AMBIL SCREENSHOT DENGAN POPUP MUNCUL (sebelum OK diklik)
        const postSaveSS = await page.screenshot({ fullPage: true }).catch(() => null);
        if (postSaveSS) await bot.sendPhoto(chatId, postSaveSS, { caption: "Status Form setelah Save (Ada Popup)" });

        // SEKARANG KLIK OK
        if (savePopupMsg) {
            const clickOk = () => {
                const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
                const okBtn = btns.find(b => (b.textContent.trim() === 'OK' || b.textContent.trim() === 'Yes') && b.offsetParent !== null);
                if (okBtn) {
                    okBtn.click();
                } else {
                    const closeBtn = document.querySelector('.x-tool-close');
                    if (closeBtn && closeBtn.offsetParent !== null) closeBtn.click();
                }
            };
            await page.evaluate(clickOk).catch(()=>null);
            await targetFrame.evaluate(clickOk).catch(()=>null);
        }
        
        if (savePopupMsg && (savePopupMsg.toLowerCase().includes('tidak valid') || savePopupMsg.toLowerCase().includes('error'))) {
            bot.sendMessage(chatId, `⚠️ *GAGAL BIKIN CT*\nPenolakan sistem AP2T saat menyimpan data.\n\nPesan AP2T: _${savePopupMsg}_`, { parse_mode: 'Markdown' });
            throw new Error(`Penyimpanan ditolak oleh AP2T: ${savePopupMsg}`);
        }
        
        await new Promise(r => setTimeout(r, 1500));

        // 7. Ambil Nomor Pengaduan (No Agenda) - VISUAL BLOCK
        bot.sendMessage(chatId, `🔍 Menyalin No Agenda (Visual Block)...`);
        noAgenda = null;
        for (let i = 0; i < 3; i++) {
            noAgenda = await targetFrame.evaluate((idpelStr) => {
                const inputs = Array.from(document.querySelectorAll('input'));
                const target = inputs.find(inp => {
                    const val = inp.value ? inp.value.trim() : '';
                    return val !== idpelStr && val.length >= 12 && val.startsWith('17') && /^\d+$/.test(val) && inp.offsetParent !== null;
                });
                if (target) {
                    target.focus();
                    target.select(); // Visual block (biru)
                    return target.value.trim();
                }
                return null;
            }, idpel);
            if (noAgenda) break;
            await new Promise(r => setTimeout(r, 1500));
        }

        if (!noAgenda) {
            const ss = await page.screenshot().catch(() => null);
            if (ss) await bot.sendPhoto(chatId, ss, { caption: "No Agenda tidak ditemukan di layar." });
            throw new Error("Gagal memindai No Agenda dari layar. Berhenti.");
        }
        bot.sendMessage(chatId, `📝 No Agenda ditemukan: <code>${noAgenda}</code>.`);

        // SIMPAN STATE
        updateCTState(idpel, { step: 'AKTIVASI_NO_METER', noAgenda: noAgenda, nogan: nogan, chatId: chatId, pembuat: pembuat });
        currentState.step = 'AKTIVASI_NO_METER';
        } // End of START block

        if (currentState.step === 'AKTIVASI_NO_METER') {

        // 8. Navigasi ke Aktivasi No Meter
        bot.sendMessage(chatId, `🚚 Navigasi ke Menu Aktivasi No Meter...`);
        await clickMenu(page, ['PELAYANAN PELANGGAN', 'Perintah Kerja', 'Aktivasi No Meter']);
        bot.sendMessage(chatId, `⏳ Menunggu halaman Aktivasi No Meter terbuka...`);
        await new Promise(r => setTimeout(r, 2000));

        // Bersihkan popup Informasi Pesta Siap Bongkar jika muncul lagi
        bot.sendMessage(chatId, `🔍 Membersihkan popup Informasi jika ada...`);
        for (let i = 0; i < 3; i++) {
            await closePopups(page);
            await new Promise(r => setTimeout(r, 500));
        }

        // Mencari frame Aktivasi No Meter (Deep Scanner)
        let aktivasiFrame = null;
        for (const frame of page.frames()) {
            const isAktivasi = await frame.evaluate(() => {
                return document.body.innerText.includes('Pencarian') ||
                    document.body.innerText.includes('No Agenda') ||
                    document.querySelector('input[id*="ext-comp"]') !== null;
            });
            if (isAktivasi) {
                // Pastikan ada input pencarian di frame ini
                const hasInput = await frame.evaluate(() => {
                    return Array.from(document.querySelectorAll('input')).some(i => i.offsetParent !== null);
                });
                if (hasInput) {
                    aktivasiFrame = frame;
                    break;
                }
            }
        }
        if (!aktivasiFrame) aktivasiFrame = page;

        // 9. Input No Agenda di Aktivasi (Force Paste)
        bot.sendMessage(chatId, `📝 Menempelkan No Agenda di Aktivasi...`);
        const inputIdentified = await aktivasiFrame.evaluate((val) => {
            // Cara 1: Cari label
            const labels = Array.from(document.querySelectorAll('label, span'));
            const label = labels.find(l => l.textContent.includes('No Agenda') && l.offsetParent !== null);
            let target = null;
            if (label) {
                target = label.closest('.x-form-item')?.querySelector('input') || label.parentElement.querySelector('input');
            }

            // Cara 2: Cari input pertama yang kosong dan visible
            if (!target) {
                const allInputs = Array.from(document.querySelectorAll('input'));
                target = allInputs.find(i => i.offsetParent !== null && i.type === 'text' && i.id.includes('ext-comp'));
            }

            if (target) {
                target.style.border = "5px solid red"; // Tandai merah
                target.focus();
                target.id = 'target_input_aktivasi_final';
                return true;
            }
            return false;
        }, noAgenda);

        if (inputIdentified) {
            await aktivasiFrame.click('#target_input_aktivasi_final', { clickCount: 3 }).catch(() => null);
            await new Promise(r => setTimeout(r, 500));

            // Clear isi dengan Backspace berulang atau pastikan terhapus
            await page.keyboard.press('Backspace');
            await new Promise(r => setTimeout(r, 500)); // Tunggu sistem ready

            bot.sendMessage(chatId, `⌨️ Mengetik No Agenda: ${noAgenda}...`);
            await aktivasiFrame.type('#target_input_aktivasi_final', noAgenda, { delay: 50 });
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 500));

            // Klik Tombol Cari
            bot.sendMessage(chatId, `🔍 Mengeklik tombol Cari...`);
            await aktivasiFrame.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, .x-btn-text, .x-form-trigger'));
                const findBtn = btns.find(b => (b.textContent.includes('Cari') || b.className.includes('search')) && b.offsetParent !== null);
                if (findBtn) findBtn.click();
            });
            await new Promise(r => setTimeout(r, 2000));

            // 10. Klik Tombol SIMPAN
            bot.sendMessage(chatId, `💾 Menyimpan Aktivasi...`);
            const saveSuccess = await aktivasiFrame.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
                const saveBtn = btns.find(b => b.textContent.trim().toUpperCase() === 'SIMPAN' && b.offsetParent !== null);
                if (saveBtn) {
                    saveBtn.click();
                    return true;
                }
                return false;
            });

            if (saveSuccess) {
                bot.sendMessage(chatId, `⏳ Menunggu popup konfirmasi...`);
                await new Promise(r => setTimeout(r, 1500));

                // Popup 1: Ya
                const yaClicked = await aktivasiFrame.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
                    const yaBtn = btns.find(b => b.textContent.trim() === 'Ya' && b.offsetParent !== null);
                    if (yaBtn) { yaBtn.click(); return true; }
                    return false;
                });
                if (yaClicked) bot.sendMessage(chatId, `✅ Konfirmasi 'Ya' diklik.`);

                await new Promise(r => setTimeout(r, 1500));

                // Popup 2: OK
                const okClicked = await aktivasiFrame.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
                    const okBtn = btns.find(b => b.textContent.trim() === 'OK' && b.offsetParent !== null);
                    if (okBtn) { okBtn.click(); return true; }
                    return false;
                });
                if (okClicked) bot.sendMessage(chatId, `✅ Konfirmasi 'OK' diklik.`);

                bot.sendMessage(chatId, `🎉 **Aktivasi Berhasil Disimpan!**`);
            } else {
                bot.sendMessage(chatId, `⚠️ Tombol SIMPAN tidak merespon/tidak ditemukan.`);
            }
        } else {
            throw new Error("Gagal menemukan kolom input No Agenda di halaman Aktivasi.");
        }

        // SIMPAN STATE
        updateCTState(idpel, { step: 'MONITORING' });
        currentState.step = 'MONITORING';
        } // End of AKTIVASI_NO_METER block

        if (currentState.step === 'MONITORING') {

        // 11. Monitoring & Ambil Token CT
        bot.sendMessage(chatId, `🔍 Menuju Monitoring Permohonan Token...`);
        await clickMenu(page, ['PELAYANAN PELANGGAN', 'Monitoring', 'Monitoring Permohonan Token']);
        await new Promise(r => setTimeout(r, 2500));

        // Bersihkan popup Informasi Pesta Siap Bongkar jika muncul lagi
        bot.sendMessage(chatId, `🔍 Membersihkan popup Informasi jika ada...`);
        for (let i = 0; i < 3; i++) {
            await closePopups(page);
            await new Promise(r => setTimeout(r, 500));
        }

        // Cari frame yang memuat konten Monitoring (AP2T pakai iframe)
        bot.sendMessage(chatId, `🎯 Mendeteksi frame Monitoring...`);

        let monitorFrame = null;
        const frames = page.frames();
        for (const frame of frames) {
            try {
                const found = await frame.evaluate(() => {
                    return !!Array.from(document.querySelectorAll('*')).find(el =>
                        el.innerText && el.innerText.includes('Jenis Permohonan') && el.offsetParent !== null
                    );
                });
                if (found) {
                    monitorFrame = frame;
                    break;
                }
            } catch (e) { /* skip frame yang tidak bisa diakses */ }
        }

        // Jika tidak ditemukan di frame, coba di halaman utama
        if (!monitorFrame) monitorFrame = page;

        // Sekarang cari dan isi input di frame yang benar
        const visualResult = await monitorFrame.evaluate(() => {
            const allElements = Array.from(document.querySelectorAll('*'));
            const label = allElements.find(el =>
                el.innerText && el.innerText.trim().includes('Jenis Permohonan') &&
                el.offsetParent !== null && el.children.length === 0
            );

            if (label) {
                const rect = label.getBoundingClientRect();
                // Toleransi sangat ketat (15px) agar hanya baris Jenis Permohonan yang terpilih
                const inputs = Array.from(document.querySelectorAll('input, select')).filter(i => {
                    const iRect = i.getBoundingClientRect();
                    return iRect.left > rect.left &&
                        Math.abs(iRect.top - rect.top) < 15 &&
                        i.offsetParent !== null;
                });
                inputs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

                if (inputs.length >= 2) {
                    inputs[0].id = 'final_dropdown_visual';
                    inputs[1].id = 'final_agenda_visual';
                    inputs[0].style.border = '3px solid red';
                    inputs[1].style.border = '3px solid blue';
                    return 'OK';
                }
                return 'ONLY_FOUND_' + inputs.length;
            }
            return 'LABEL_NOT_FOUND';
        });

        if (visualResult === 'OK') {
            const searchType = isResuming ? 'ID PEL' : 'PER NOAGENDA';
            const searchValue = isResuming ? idpel : (noAgenda || idpel);

            // Isi Dropdown Jenis Permohonan
            const dropdownEl = await monitorFrame.$('#final_dropdown_visual');
            await dropdownEl.click({ clickCount: 3 }).catch(() => null);
            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('Backspace');
            await page.keyboard.type(searchType, { delay: 100 });
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 1500));

            // Isi Value Pencarian
            const agendaEl = await monitorFrame.$('#final_agenda_visual');
            await agendaEl.click({ clickCount: 3 }).catch(() => null);
            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('Backspace');
            await page.keyboard.type(searchValue, { delay: 100 });
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 1000));

            // Klik Tombol Filter
            await monitorFrame.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
                const filterBtn = btns.find(b => b.textContent.trim() === 'Filter' && b.offsetParent !== null);
                if (filterBtn) filterBtn.click();
            });

            bot.sendMessage(chatId, `✅ Filter berhasil diisi! Memantau Token...`);
        } else {
            bot.sendMessage(chatId, `❌ Gagal deteksi: ${visualResult}. Proses dihentikan.`);
            return;
        }

        // Loop Filter & Ambil Token dari CLEAR TAMPER
        bot.sendMessage(chatId, `🔄 Memantau Token... (Menunggu Status 3)`);

        let tokenCT = null;
        let retries = 0;
        const maxRetries = 60; // Max 300 detik (5 menit)

        while (retries < maxRetries) {
            // Klik Filter di frame yang benar
            await monitorFrame.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
                const filterBtn = btns.find(b => b.textContent.trim() === 'Filter' && b.offsetParent !== null);
                if (filterBtn) filterBtn.click();
            });

            await new Promise(r => setTimeout(r, 5000));

            // Scan tabel di frame yang benar — cari kolom CLEAR TAMPER dari baris status 3
            const foundData = await monitorFrame.evaluate((currentAgenda) => {
                // Cari baris dengan STATUSAGENDA = 3
                const rows = Array.from(document.querySelectorAll('tr, .x-grid3-row'));
                const row3 = rows.find(r => {
                    const cells = Array.from(r.querySelectorAll('td'));
                    return cells.some(c => c.textContent.trim() === '3');
                });

                if (row3) {
                    // Cari angka 20 digit di baris tersebut yang BUKAN No Agenda
                    const cells = Array.from(row3.querySelectorAll('td'));
                    const tokenCell = cells.find(c => {
                        const val = c.textContent.trim().replace(/\s/g, '');
                        // Harus 20 digit dan tidak boleh sama dengan No Agenda yang kita cari
                        return /^\d{20}$/.test(val) && val !== currentAgenda;
                    });

                    if (tokenCell) {
                        const token = tokenCell.textContent.trim().replace(/\s/g, '');
                        let nama = '-';
                        let tarif = '-';
                        let daya = '-';
                        
                        // Coba ekstrak NAMA, TARIF, DAYA menggunakan ExtJS API atau DOM fallback
                        try {
                            if (typeof Ext !== 'undefined' && Ext.ComponentMgr) {
                                Ext.ComponentMgr.all.each(function(cmp) {
                                    if (cmp.isXType && cmp.isXType('grid')) {
                                        if (cmp.el && cmp.el.dom && cmp.el.dom.offsetParent !== null) {
                                            const store = cmp.getStore();
                                            if (store) {
                                                for (let i = 0; i < store.getCount(); i++) {
                                                    const rec = store.getAt(i);
                                                    let hasToken = false;
                                                    for (let key in rec.data) {
                                                        if (String(rec.data[key]).replace(/\s/g, '') === token) hasToken = true;
                                                    }
                                                    if (hasToken) {
                                                        const cm = cmp.getColumnModel();
                                                        for (let j = 0; j < cm.getColumnCount(); j++) {
                                                            const header = cm.getColumnHeader(j).toUpperCase();
                                                            const dIndex = cm.getDataIndex(j);
                                                            if (header.includes('NAMA')) nama = rec.data[dIndex] || nama;
                                                            if (header.includes('TARIF')) tarif = rec.data[dIndex] || tarif;
                                                            if (header.includes('DAYA')) daya = rec.data[dIndex] || daya;
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                });
                            }
                            
                            // DOM Fallback jika ExtJS gagal atau nilainya masih kosong
                            if (nama === '-' || tarif === '-') {
                                const gridHeader = document.querySelector('.x-grid3-header') || document.querySelector('thead');
                                if (gridHeader) {
                                    const hdCells = Array.from(gridHeader.querySelectorAll('td, th, .x-grid3-hd'));
                                    let nIdx = -1, tIdx = -1, dIdx = -1;
                                    hdCells.forEach((hd, idx) => {
                                        const txt = hd.textContent.toUpperCase();
                                        if (txt.includes('NAMA')) nIdx = idx;
                                        if (txt.includes('TARIF')) tIdx = idx;
                                        if (txt.includes('DAYA')) dIdx = idx;
                                    });
                                    
                                    const trCells = Array.from(row3.querySelectorAll('td, .x-grid3-cell'));
                                    if (nIdx >= 0 && trCells[nIdx]) nama = trCells[nIdx].textContent.trim();
                                    if (tIdx >= 0 && trCells[tIdx]) tarif = trCells[tIdx].textContent.trim();
                                    if (dIdx >= 0 && trCells[dIdx]) daya = trCells[dIdx].textContent.trim();
                                }
                            }
                        } catch(e) {}
                        
                        return { token: token, nama: nama, tarif: tarif, daya: daya };
                    }
                    return 'WAIT'; // Baris 3 ada tapi token belum muncul atau masih No Agenda saja
                }
                return null; // Belum ada baris status 3
            }, noAgenda);

            if (foundData && foundData !== 'WAIT') {
                tokenCT = foundData.token;
                namaCT = foundData.nama || '-';
                tarifCT = foundData.tarif || '-';
                dayaCT = foundData.daya || '-';
                break;
            }

            retries++;
            if (retries % 6 === 0) bot.sendMessage(chatId, `⏳ Masih menunggu status menjadi '3'...`);
        }

        if (tokenCT) {
            // Kirim token Clear Tamper beserta detail lainnya ke Telegram
            bot.sendMessage(chatId, `🎉 *TOKEN CLEAR TAMPER:*\n\`${tokenCT}\`\n\n👤 NAMA: ${namaCT}\n💳 IDPEL: ${idpel}\n⚡ TARIF/DAYA: ${tarifCT}/${dayaCT}`, { parse_mode: 'Markdown' });

            // Mengirim data ke Google Sheets Webhook
            if (process.env.GOOGLE_SHEETS_URL) {
                try {
                    const axios = require('axios');
                    const waktu = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
                    await axios.post(process.env.GOOGLE_SHEETS_URL, {
                        waktu: waktu,
                        idpel: idpel,
                        nama: namaCT,
                        tarif: tarifCT,
                        daya: dayaCT,
                        nogan: nogan,
                        token: tokenCT,
                        pembuat: pembuat || 'Tidak Diketahui'
                    });
                    console.log(`Berhasil mencatat rekap ke Google Sheets untuk IDPEL: ${idpel}`);
                } catch (sheetErr) {
                    console.error("Gagal mengirim rekap ke Google Sheets:", sheetErr.message);
                }
            }

            // Bersihkan memori (state) CT untuk IDPEL ini karena sudah selesai sukses
            // Sehingga pembuatan CT selanjutnya untuk IDPEL yang sama akan dimulai dari awal lagi
            clearCTState(idpel);
        } else {
            bot.sendMessage(chatId, `⚠️ Waktu habis. Status belum '3' atau Token CLEAR TAMPER belum muncul di tabel.`);
        }

        // Rapikan tab HANYA JIKA SUKSES
        await page.evaluate(() => {
            const tabs = Array.from(document.querySelectorAll('.x-tab-strip-closable'));
            tabs.forEach(t => {
                const text = t.textContent;
                if (text.includes('Aktivasi') || text.includes('Pengaduan')) {
                    const close = t.querySelector('.x-tab-strip-close');
                    if (close) close.click();
                }
            });
        });
        } // End of MONITORING block

    } catch (e) {
        console.error("CT Error:", e);
        bot.sendMessage(chatId, `❌ Terjadi error saat proses CT: ${e.message}\n\n*Catatan:* Browser SENGAJA DIBIARKAN TERBUKA agar Anda bisa mengecek layar PC untuk melihat pesan error aslinya. Tutup tab secara manual di PC jika sudah selesai.`, { parse_mode: 'Markdown' });

        // Jika error karena logout, coba login ulang sekali
        if (e.message.includes('not found') || e.message.includes('disconnected')) {
            bot.sendMessage(chatId, `🔄 Sesi terputus, mencoba memulihkan...`);
            isLoggedIn = false;
        }
    }
}

// ===== FUNGSI: Ambil IDPEL dari Nomor Meter =====
async function getIdpelFromNomet(nomet, chatId) {
    bot.sendMessage(chatId, `🔍 Nomor Meter (11 digit) terdeteksi. Mengambil ID Pelanggan dari Info Pelanggan...`);
    await clickMenu(page, ['INFO PELANGGAN', 'Info Pelanggan']);
    await new Promise(r => setTimeout(r, 1500));
    
    // Bersihkan popup jika ada
    for (let i = 0; i < 2; i++) { await closePopups(page); await new Promise(r => setTimeout(r, 500)); }

    let infoFrame = null;
    for (const frame of page.frames()) {
        const isInfo = await frame.evaluate(() => document.body.innerText.includes('Unit UPI') || document.body.innerText.includes('Main Result')).catch(()=>false);
        if (isInfo) { infoFrame = frame; break; }
    }
    if (!infoFrame) infoFrame = page;

    // 1. Ubah Dropdown
    const filterComboId = await infoFrame.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('.x-form-text'));
        const combo = inputs.find(i => i.value === 'Id Pelanggan' || i.value === 'Nomor Meter' || i.value === 'Nama');
        if (combo) {
            combo.id = 'filter_combo_nomet_auto';
            return combo.id;
        }
        return null;
    });

    if (filterComboId) {
        // Klik trigger combo agar ExtJS merender list item
        await infoFrame.evaluate(() => {
            const input = document.getElementById('filter_combo_nomet_auto');
            if (input && input.parentElement) {
                const trigger = input.parentElement.querySelector('.x-form-trigger');
                if (trigger) trigger.click();
            }
        });
        await new Promise(r => setTimeout(r, 1000));
        
        // Klik opsi "Nomor Meter" dari menu yang muncul
        await infoFrame.evaluate(() => {
            const items = Array.from(document.querySelectorAll('.x-combo-list-item'));
            const targetItem = items.find(i => i.textContent.toUpperCase().includes('NOMOR METER'));
            if (targetItem) targetItem.click();
        });
        await new Promise(r => setTimeout(r, 1000));
    }

    // 2. Isi target input dengan nomet
    const filterInputId = await infoFrame.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('.x-form-text'));
        let combo = inputs.find(i => i.id === 'filter_combo_nomet_auto');
        if (!combo) {
            combo = inputs.find(i => i.value === 'Id Pelanggan' || i.value === 'Nomor Meter' || i.value === 'Nama');
        }
        if (!combo) return null;
        
        const comboIdx = inputs.indexOf(combo);
        if (comboIdx >= 0 && comboIdx + 1 < inputs.length) {
            const targetInput = inputs[comboIdx + 1];
            targetInput.id = 'filter_input_nomet_auto';
            return targetInput.id;
        }
        return null;
    });

    if (!filterInputId) {
        bot.sendMessage(chatId, `❌ Gagal menemukan kolom input di halaman Info Pelanggan.`);
        return null;
    }

    await infoFrame.click(`#${filterInputId}`, { clickCount: 3 }).catch(() => null);
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.press('Backspace');
    await infoFrame.type(`#${filterInputId}`, nomet, { delay: 50 });
    await new Promise(r => setTimeout(r, 500));

    // Klik Search
    await infoFrame.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
        const searchBtn = btns.find(b => b.textContent.includes('Search') && b.offsetParent !== null);
        if (searchBtn) searchBtn.click();
    });
    
    bot.sendMessage(chatId, `⏳ Sedang mencari ID Pelanggan...`);
    await new Promise(r => setTimeout(r, 2000));

    // Handle popup "Master Nedisys"
    const checkNedisys = async (frame) => {
        return await frame.evaluate(() => {
            const wins = Array.from(document.querySelectorAll('.x-window'));
            const nedisys = wins.find(w => w.textContent.includes('Master Nedisys') && w.offsetParent !== null);
            if (nedisys) {
                let extractedIdpel = null;
                const labels = Array.from(nedisys.querySelectorAll('label'));
                const idpelLabel = labels.find(l => l.textContent.includes('Id Pelanggan'));
                if (idpelLabel) {
                    const formItem = idpelLabel.closest('.x-form-item');
                    if (formItem) {
                        const inp = formItem.querySelector('input');
                        if (inp && inp.value) extractedIdpel = inp.value.trim();
                    }
                }

                const closeBtn = nedisys.querySelector('.x-tool-close');
                if (closeBtn) {
                    closeBtn.id = 'nedisys_close_btn_target_' + Math.floor(Math.random()*10000);
                    return { btnId: closeBtn.id, idpel: extractedIdpel };
                }
            }
            return null;
        }).catch(() => null);
    };

    let nedisysData = await checkNedisys(infoFrame);
    let nFrame = infoFrame;
    if (!nedisysData) { nedisysData = await checkNedisys(page); nFrame = page; }

    if (nedisysData && nedisysData.btnId) {
        bot.sendMessage(chatId, `🔍 Popup Master Nedisys terdeteksi, mengambil screenshot...`);
        const ssNedisys = await page.screenshot().catch(() => null);
        if (ssNedisys) await bot.sendPhoto(chatId, ssNedisys, { caption: "Data Master Nedisys" });
        
        await nFrame.click(`#${nedisysData.btnId}`).catch(() => null);
        await new Promise(r => setTimeout(r, 1000));
        
        if (nedisysData.idpel) {
            return nedisysData.idpel; // Langsung kembalikan IDPEL untuk /ct!
        }
    }

    // Ekstrak IDPEL dari Grid
    return await infoFrame.evaluate(() => {
        let result = null;
        try {
            if (typeof Ext !== 'undefined' && Ext.ComponentMgr) {
                Ext.ComponentMgr.all.each(function(cmp) {
                    if (cmp.isXType && cmp.isXType('grid')) {
                        if (cmp.el && cmp.el.dom && cmp.el.dom.offsetParent !== null) {
                            const store = cmp.getStore();
                            if (store && store.getCount() > 0) {
                                const cm = cmp.getColumnModel();
                                for (let j = 0; j < cm.getColumnCount(); j++) {
                                    const header = cm.getColumnHeader(j).toUpperCase();
                                    const dIndex = cm.getDataIndex(j);
                                    if (header.includes('ID PELANGGAN') || header === 'IDPEL' || header.includes('ID_PELANGGAN')) {
                                        result = String(store.getAt(0).data[dIndex]).trim();
                                    }
                                }
                            }
                        }
                    }
                });
            }
            if (!result) {
                const cells = Array.from(document.querySelectorAll('.x-grid3-cell-inner'));
                const idpelCell = cells.find(c => /^\d{12}$/.test(c.textContent.trim()));
                if (idpelCell) result = idpelCell.textContent.trim();
            }
        } catch(e) {}
        return result;
    });
}

// ===== FUNGSI: Eksekusi Cari Nomor Meter (/nomet) =====
async function processCariPelanggan(target, chatId) {
    if (!browser || !page || page.isClosed() || !isLoggedIn) {
        const ok = await login('main', chatId);
        if (!ok) return bot.sendMessage(chatId, `[!] Gagal login ke AP2T otomatis.`);
        isLoggedIn = true;
        currentAccount = 'main';
    }

    try {
        bot.sendMessage(chatId, `[*] Membuka menu Info Pelanggan...`);
        await clickMenu(page, ['INFO PELANGGAN', 'Info Pelanggan']);
        await new Promise(r => setTimeout(r, 2000));

        // Bersihkan popup jika muncul
        bot.sendMessage(chatId, `[*] Menghapus popup jika ada...`);
        for (let i = 0; i < 3; i++) {
            await closePopups(page);
            await new Promise(r => setTimeout(r, 500));
        }

        // Cari frame Info Pelanggan
        let infoFrame = null;
        const frames = page.frames();
        for (const frame of frames) {
            try {
                const isInfo = await frame.evaluate(() => {
                    return document.body.innerText.includes('Unit UPI') || document.body.innerText.includes('Main Result');
                });
                if (isInfo) {
                    infoFrame = frame;
                    break;
                }
            } catch (e) { }
        }
        if (!infoFrame) infoFrame = page;

        // Pembersihan ekstra: Kadang popup lambat muncul dan menutupi form
        await closePopups(page);
        await new Promise(r => setTimeout(r, 500));

        bot.sendMessage(chatId, `[*] Mencari data pelanggan: ${target}...`);

        // Tentukan tipe pencarian (11 digit = Nomor Meter, 12 digit = Id Pelanggan)
        const isNomet = target.length === 11;
        const dropdownText = isNomet ? 'Nomor Meter' : 'Id Pelanggan';

        // 1. Ubah Dropdown
        const filterComboId = await infoFrame.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('.x-form-text'));
            const combo = inputs.find(i => i.value === 'Id Pelanggan' || i.value === 'Nomor Meter' || i.value === 'Nama');
            if (combo) {
                combo.id = 'filter_combo_nomet';
                return combo.id;
            }
            return null;
        });

        if (filterComboId) {
            // Klik trigger combo agar ExtJS merender list item
            await infoFrame.evaluate(() => {
                const input = document.getElementById('filter_combo_nomet');
                if (input && input.parentElement) {
                    const trigger = input.parentElement.querySelector('.x-form-trigger');
                    if (trigger) trigger.click();
                }
            });
            await new Promise(r => setTimeout(r, 1000)); // Tunggu list terbuka
            
            // Klik opsi "Id Pelanggan" atau "Nomor Meter" dari menu yang muncul
            await infoFrame.evaluate((fType) => {
                const items = Array.from(document.querySelectorAll('.x-combo-list-item'));
                const targetItem = items.find(i => i.textContent.toUpperCase().includes(fType.toUpperCase()));
                if (targetItem) targetItem.click();
            }, dropdownText);
            await new Promise(r => setTimeout(r, 1000));
        }

        // 2. Isi Input
        const filterInputId = await infoFrame.evaluate(() => {
            const inputs = Array.from(document.querySelectorAll('.x-form-text'));
            let combo = inputs.find(i => i.id === 'filter_combo_nomet');
            if (!combo) {
                // ExtJS DOM mungkin di-rebuild saat dropdown diganti, cari ulang by value
                combo = inputs.find(i => i.value === 'Id Pelanggan' || i.value === 'Nomor Meter' || i.value === 'Nama');
            }
            if (!combo) return null;
            
            const comboIdx = inputs.indexOf(combo);
            // Kolom input selalu elemen form-text selanjutnya setelah combo di ExtJS
            if (comboIdx >= 0 && comboIdx + 1 < inputs.length) {
                const targetInput = inputs[comboIdx + 1];
                targetInput.id = 'filter_input_nomet';
                return targetInput.id;
            }
            return null;
        });

        if (!filterInputId) throw new Error("Kolom input tidak ditemukan.");

        await infoFrame.click(`#${filterInputId}`, { clickCount: 3 }).catch(() => null);
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Backspace');
        await page.keyboard.type(target, { delay: 100 });
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 1000));

        // 3. Klik Search
        bot.sendMessage(chatId, `[*] Mencari data pelanggan...`);
        await infoFrame.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
            const searchBtn = btns.find(b => b.textContent.trim() === 'Search' && b.offsetParent !== null);
            if (searchBtn) searchBtn.click();
        });

        // 4. Tunggu hasil
        await new Promise(r => setTimeout(r, 2000));

        // Handle popup "Master Nedisys"
        const checkNedisys2 = async (frame) => {
            return await frame.evaluate(() => {
                const wins = Array.from(document.querySelectorAll('.x-window'));
                const nedisys = wins.find(w => w.textContent.includes('Master Nedisys') && w.offsetParent !== null);
                if (nedisys) {
                    let extractedIdpel = null;
                    const labels = Array.from(nedisys.querySelectorAll('label'));
                    const idpelLabel = labels.find(l => l.textContent.includes('Id Pelanggan'));
                    if (idpelLabel) {
                        const formItem = idpelLabel.closest('.x-form-item');
                        if (formItem) {
                            const inp = formItem.querySelector('input');
                            if (inp && inp.value) extractedIdpel = inp.value.trim();
                        }
                    }

                    const closeBtn = nedisys.querySelector('.x-tool-close');
                    if (closeBtn) {
                        closeBtn.id = 'nedisys_close_btn_target_' + Math.floor(Math.random()*10000);
                        return { btnId: closeBtn.id, idpel: extractedIdpel };
                    }
                }
                return null;
            }).catch(() => null);
        };

        let nedisysData2 = await checkNedisys2(infoFrame);
        let nFrame2 = infoFrame;
        if (!nedisysData2) { nedisysData2 = await checkNedisys2(page); nFrame2 = page; }

        if (nedisysData2 && nedisysData2.btnId) {
            bot.sendMessage(chatId, `🔍 Popup Master Nedisys terdeteksi, mengirim screenshot...`);
            const ssNedisys = await page.screenshot().catch(() => null);
            if (ssNedisys) await bot.sendPhoto(chatId, ssNedisys, { caption: "Data Master Nedisys" });
            
            await nFrame2.click(`#${nedisysData2.btnId}`).catch(() => null);
            await new Promise(r => setTimeout(r, 1000));
            
            if (nedisysData2.idpel) {
                bot.sendMessage(chatId, `🔄 Menemukan ID Pelanggan dari popup: ${nedisysData2.idpel}. Melakukan pencarian ulang...`);
                
                // Ubah Dropdown ke 'Id Pelanggan'
                await infoFrame.evaluate(() => {
                    const inputs = Array.from(document.querySelectorAll('.x-form-text'));
                    const combo = inputs.find(i => i.value === 'Id Pelanggan' || i.value === 'Nomor Meter' || i.value === 'Nama' || i.id === 'filter_combo_nomet');
                    if (combo) combo.id = 'filter_combo_nomet_retry';
                });
                
                await infoFrame.click('#filter_combo_nomet_retry', { clickCount: 3 }).catch(() => null);
                await new Promise(r => setTimeout(r, 500));
                await page.keyboard.press('Backspace');
                await infoFrame.type('#filter_combo_nomet_retry', 'Id Pelanggan', { delay: 50 });
                await page.keyboard.press('Enter');
                await new Promise(r => setTimeout(r, 1000));
                
                // Isi target input
                await infoFrame.evaluate(() => {
                    const inputs = Array.from(document.querySelectorAll('.x-form-text'));
                    const combo = inputs.find(i => i.id === 'filter_combo_nomet_retry');
                    if (combo) {
                        const comboIdx = inputs.indexOf(combo);
                        if (comboIdx >= 0 && comboIdx + 1 < inputs.length) {
                            inputs[comboIdx + 1].id = 'filter_input_nomet_retry';
                        }
                    }
                });
                
                await infoFrame.click('#filter_input_nomet_retry', { clickCount: 3 }).catch(() => null);
                await new Promise(r => setTimeout(r, 500));
                await page.keyboard.press('Backspace');
                await infoFrame.type('#filter_input_nomet_retry', nedisysData2.idpel, { delay: 50 });
                await new Promise(r => setTimeout(r, 500));
                
                // Klik Search lagi
                await infoFrame.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
                    const searchBtn = btns.find(b => b.textContent.includes('Search') && b.offsetParent !== null);
                    if (searchBtn) searchBtn.click();
                });
                await new Promise(r => setTimeout(r, 2000));
            }
        }
        // 5. Ekstrak Hasil dari Grid secara dinamis
        const result = await infoFrame.evaluate(() => {
            const gridView = document.querySelector('.x-grid3');
            if (!gridView) return null;

            const headers = Array.from(gridView.querySelectorAll('.x-grid3-hd-inner')).map(h => h.textContent.trim().toUpperCase());
            const row = gridView.querySelector('.x-grid3-row');
            if (row) {
                const cells = Array.from(row.querySelectorAll('.x-grid3-cell-inner')).map(c => c.textContent.trim());
                let data = {};
                for (let i = 0; i < headers.length; i++) {
                    if (headers[i]) data[headers[i]] = cells[i] || '-';
                }

                // Fallback jika headers tidak terbaca dengan baik
                if (Object.keys(data).length < 2 && cells.length >= 2) {
                    data['IDPEL'] = cells[0];
                    data['NAMA'] = cells[1];
                    if (cells.length > 2) data['KOLOM_3'] = cells[2];
                    if (cells.length > 3) data['KOLOM_4'] = cells[3];
                }
                return data;
            }
            return null;
        });

        if (result) {
            // Cari field yang relevan
            const idpel = result['IDPEL'] || result['ID PELANGGAN'] || '-';
            const nama = result['NAMA'] || result['NAMA PELANGGAN'] || '-';
            const nomet = result['NOMOR METER'] || result['NO METER'] || result['NOMET'] || '-';
            const tarif = result['TARIF'] || '-';
            const daya = result['DAYA'] || '-';

            let msg = `✅ *Data Pelanggan Ditemukan:*\n\n` +
                `ID PELANGGAN: \`${idpel}\`\n` +
                `NAMA: ${nama}\n` +
                `TARIF/DAYA: ${tarif} / ${daya}`;

            bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, `[-] Data pelanggan tidak ditemukan untuk ${target}.`);
        }

    } catch (e) {
        bot.sendMessage(chatId, `[x] Error cek pelanggan: ${e.message}`);
    }
}

async function searchMonitoringToken(page, target, chatId) {
    let filterType = 'PER NOAGENDA';
    if (target.length === 11) {
        filterType = 'PER NOMOR METER';
    } else if (target.length === 12) {
        filterType = 'PER IDPEL';
    }

    if (chatId) {
        let loadingWait = 0;
        while (loadingWait < 20000) {
            const isLoading = await page.evaluate(() => {
                const text = document.body.innerText;
                return text.includes('Loading Monitoring Permohonan Token') || 
                       !!document.querySelector('.ext-el-mask-msg');
            });
            if (!isLoading) break;
            
            if (loadingWait === 5000) {
                bot.sendMessage(chatId, `⏳ AP2T masih memuat data... Mohon bersabar.`);
                const ss = await page.screenshot().catch(() => null);
                if (ss) await bot.sendPhoto(chatId, ss);
            }
            await new Promise(r => setTimeout(r, 2000));
            loadingWait += 5000;
        }
    }

    let monitorFrame = null;
    // Tunggu sampai iframe dengan 'Jenis Permohonan' muncul (max 15 detik)
    for (let wait = 0; wait < 15; wait++) {
        const frames = page.frames();
        for (const frame of frames) {
            try {
                const found = await frame.evaluate(() => {
                    return !!Array.from(document.querySelectorAll('*')).find(el =>
                        el.innerText && el.innerText.includes('Jenis Permohonan') && el.offsetParent !== null
                    );
                });
                if (found) { monitorFrame = frame; break; }
            } catch (e) { /* skip */ }
        }
        if (monitorFrame) break;
        await new Promise(r => setTimeout(r, 1000));
    }
    if (!monitorFrame) monitorFrame = page;

    // Beri jeda agar popup (seperti Pesta Siap Bongkar/Informasi) yang muncul setelah form render bisa ditangkap
    await new Promise(r => setTimeout(r, 1500));

    // Bersihkan semua popup sebelum mulai mengisi form
    if (chatId) bot.sendMessage(chatId, `🔍 Membersihkan popup jika ada...`);
    for (let i = 0; i < 3; i++) {
        await closePopups(page);
        await new Promise(r => setTimeout(r, 500));
    }

    const visualResult = await monitorFrame.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        const label = allElements.find(el =>
            el.innerText && el.innerText.trim().includes('Jenis Permohonan') &&
            el.offsetParent !== null && el.children.length === 0
        );

        if (label) {
            const rect = label.getBoundingClientRect();
            const inputs = Array.from(document.querySelectorAll('input, select')).filter(i => {
                const iRect = i.getBoundingClientRect();
                return iRect.left > rect.left &&
                    Math.abs(iRect.top - rect.top) < 15 &&
                    i.offsetParent !== null;
            });
            inputs.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

            if (inputs.length >= 2) {
                inputs[0].id = 'final_dropdown_visual';
                inputs[1].id = 'final_agenda_visual';
                return 'OK';
            }
            return 'ONLY_FOUND_' + inputs.length;
        }
        return 'LABEL_NOT_FOUND';
    });

    if (visualResult === 'OK') {
        const dropdownEl = await monitorFrame.$('#final_dropdown_visual');
        if (dropdownEl) {
            // Coba klik trigger combobox ExtJS
            await monitorFrame.evaluate(() => {
                const input = document.getElementById('final_dropdown_visual');
                if (input && input.parentElement) {
                    const trigger = input.parentElement.querySelector('.x-form-trigger');
                    if (trigger) trigger.click();
                }
            });
            await new Promise(r => setTimeout(r, 1000)); // Tunggu dropdown terbuka
            
            // Klik item dropdown yang sesuai
            const clicked = await monitorFrame.evaluate((fType) => {
                const items = Array.from(document.querySelectorAll('.x-combo-list-item'));
                
                // Cari berdasar keyword spesifik karena spasi/penulisan di AP2T sering tidak konsisten
                let keyword = fType.toUpperCase().replace(/\s+/g, '');
                let targetItem = items.find(i => i.textContent.toUpperCase().replace(/\s+/g, '') === keyword);
                
                // Jika tidak ketemu secara persis, gunakan fuzzy match (Pencarian sebagian)
                if (!targetItem) {
                    if (fType.includes('METER')) {
                        targetItem = items.find(i => i.textContent.toUpperCase().includes('METER'));
                    } else if (fType.includes('IDPEL')) {
                        targetItem = items.find(i => i.textContent.toUpperCase().includes('IDPEL'));
                    } else if (fType.includes('AGENDA')) {
                        targetItem = items.find(i => i.textContent.toUpperCase().includes('AGENDA'));
                    }
                }

                if (targetItem) {
                    targetItem.click();
                    return true;
                }
                return false;
            }, filterType);
            
            await new Promise(r => setTimeout(r, 500));
            
            // Fallback jika tidak bisa diklik (misal dropdown gagal render)
            if (!clicked) {
                await dropdownEl.click({ clickCount: 3 }).catch(() => null);
                await page.keyboard.press('Backspace');
                await page.keyboard.type(filterType, { delay: 100 });
                await page.keyboard.press('Tab'); // Gunakan Tab daripada Enter untuk memastikan blur event terpanggil
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        const agendaEl = await monitorFrame.$('#final_agenda_visual');
        if (agendaEl) {
            await agendaEl.click({ clickCount: 3 }).catch(() => null);
            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('Backspace');
            await page.keyboard.type(target, { delay: 100 });
            await page.keyboard.press('Enter');
            await new Promise(r => setTimeout(r, 1000));
        }

        await monitorFrame.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
            const filterBtn = btns.find(b => b.textContent.trim() === 'Filter' && b.offsetParent !== null);
            if (filterBtn) filterBtn.click();
        });
        
        await new Promise(r => setTimeout(r, 1500));
        return monitorFrame;
    } else {
        throw new Error(`Gagal mendeteksi field Monitoring: ${visualResult}`);
    }
}

async function capturePdfAsImage(pdfUrl, browser, outputPath) {
    const pdfPage = await browser.newPage();
    try {
        await pdfPage.goto('https://ap2t.pln.co.id/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        
        const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js"></script>
            <style>
                body { margin: 0; padding: 0; background: white; display: flex; justify-content: center; }
                canvas { display: block; }
            </style>
        </head>
        <body>
            <canvas id="pdf-canvas"></canvas>
            <script>
                pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
                
                async function renderPdf(url) {
                    try {
                        const loadingTask = pdfjsLib.getDocument(url);
                        const pdf = await loadingTask.promise;
                        const page = await pdf.getPage(1);
                        
                        const scale = 2.0; 
                        const viewport = page.getViewport({scale: scale});
                        
                        const canvas = document.getElementById('pdf-canvas');
                        const context = canvas.getContext('2d');
                        
                        // HACK TERBAIK: Nonaktifkan fungsi clipping pada canvas!
                        // Crystal Reports sering memiliki bounding-box/clipping-path yang terlalu sempit.
                        // Jika server tidak memiliki font asli (sehingga menggunakan font substitusi yang lebih lebar),
                        // PDF.js akan mematuhi clipping-path tersebut dan memotong huruf terluar.
                        // Dengan mematikan clip(), semua teks akan digambar secara utuh walau melewati batas kotak!
                        context.clip = function() {};
                        
                        // Lebarkan sedikit kanvas agar teks yang bebas dari clipping tidak keluar dari kanvas
                        canvas.height = viewport.height;
                        canvas.width = viewport.width + 150;
                        
                        // Latar putih
                        context.fillStyle = 'white';
                        context.fillRect(0, 0, canvas.width, canvas.height);
                        
                        const renderContext = {
                            canvasContext: context,
                            viewport: viewport,
                            // Geser sedikit ke kanan agar ada ruang untuk teks kiri yang melebar
                            transform: [viewport.transform[0], viewport.transform[1], viewport.transform[2], viewport.transform[3], viewport.transform[4] + 50, viewport.transform[5]]
                        };
                        await page.render(renderContext).promise;
                        
                        // Auto Crop Tinggi (Memotong bagian bawah yang kosong saja)
                        const imgData = context.getImageData(0, 0, canvas.width, canvas.height);
                        const data = imgData.data;
                        let maxY = 0;
                        
                        for (let y = 0; y < canvas.height; y++) {
                            for (let x = 0; x < canvas.width; x++) {
                                const i = (y * canvas.width + x) * 4;
                                // Ignore white/transparent pixels (detect only dark text)
                                if (data[i+3] > 0 && (data[i] < 250 || data[i+1] < 250 || data[i+2] < 250)) {
                                    if (y > maxY) maxY = y;
                                }
                            }
                        }
                        
                        // Crop bagian bawah dengan padding agar rapi, biarkan atas dan lebar utuh
                        const cropHeight = Math.min(canvas.height, maxY + 60);
                        
                        if (cropHeight > 0 && cropHeight < canvas.height) {
                            const tempCanvas = document.createElement('canvas');
                            tempCanvas.width = canvas.width;
                            tempCanvas.height = cropHeight;
                            tempCanvas.getContext('2d').putImageData(context.getImageData(0, 0, canvas.width, cropHeight), 0, 0);
                            
                            canvas.height = cropHeight;
                            canvas.getContext('2d').drawImage(tempCanvas, 0, 0);
                        }

                        window.pdfRendered = true;
                    } catch (e) {
                        window.pdfError = e.message;
                    }
                }
            </script>
        </body>
        </html>
        `;
        await pdfPage.setContent(html);
        
        const base64Pdf = await pdfPage.evaluate(async (url) => {
            const response = await fetch(url);
            if (!response.ok) throw new Error("Fetch failed: " + response.status);
            const arrayBuffer = await response.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return window.btoa(binary);
        }, pdfUrl);
        
        await pdfPage.evaluate((b64) => {
            const pdfData = atob(b64);
            const uint8Array = new Uint8Array(pdfData.length);
            for (let i = 0; i < pdfData.length; i++) {
                uint8Array[i] = pdfData.charCodeAt(i);
            }
            renderPdf(uint8Array);
        }, base64Pdf);
        
        await pdfPage.waitForFunction('window.pdfRendered === true || window.pdfError', {timeout: 30000});
        
        const err = await pdfPage.evaluate(() => window.pdfError);
        if (err) throw new Error("PDF render error: " + err);
        
        const canvas = await pdfPage.$('#pdf-canvas');
        return await canvas.screenshot();
        
    } finally {
        await pdfPage.close().catch(()=>{});
    }
}

bot.onText(/\/ambil_token (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const target = match[1].trim();

    commandQueue.push(async () => {
        activeChatId = chatId;
        let statusMsg = await bot.sendMessage(chatId, `⏳ Mengambil token untuk ${target}...`);
        try {
            if (!isLoggedIn || !browser || !page || page.isClosed()) {
                const ok = await login('main', chatId);
                if (!ok) throw new Error("Gagal login ke AP2T otomatis.");
                isLoggedIn = true;
                currentAccount = 'main';
            }

            await clickMenu(page, ['PELAYANAN PELANGGAN', 'Monitoring', 'Monitoring Permohonan Token']);
            const monitorFrame = await searchMonitoringToken(page, target, chatId);

            const result = await monitorFrame.evaluate(() => {
                const firstRow = document.querySelector('.x-grid3-row');
                if (!firstRow) return { found: false, token: null, isClearTamper: false };

                const textContent = firstRow.textContent.toUpperCase();
                const isClearTamper = textContent.includes('CLEAR TAMPER');

                const cells = Array.from(firstRow.querySelectorAll('.x-grid3-cell-inner'));
                const tokenCell = cells.find(c => {
                    const txt = c.textContent.replace(/\D/g, '');
                    return txt.length === 20;
                });
                const token = tokenCell ? tokenCell.textContent.replace(/\D/g, '') : null;

                return { found: true, token, isClearTamper };
            });

            if (!result.found) {
                await bot.editMessageText(`❌ Data tidak ditemukan untuk ${target}.`, { chat_id: chatId, message_id: statusMsg.message_id });
            } else if (!result.isClearTamper) {
                await bot.editMessageText(`❌ Ini tidak ada CT (Transaksi bukan CLEAR TAMPER).`, { chat_id: chatId, message_id: statusMsg.message_id });
            } else if (result.token) {
                await bot.editMessageText(`✅ **Token Berhasil Diambil:**\n\n\`${result.token}\``, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' });
            } else {
                await bot.editMessageText(`❌ Status CLEAR TAMPER, tapi token 20 digit tidak ditemukan di tabel.`, { chat_id: chatId, message_id: statusMsg.message_id });
            }
        } catch (e) {
            await bot.editMessageText(`❌ Error ambil_token: ${e.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
        }
    });

    if (!isProcessingCT) {
        processQueue();
    } else {
        bot.sendMessage(chatId, `[i] Menunggu antrean... Saat ini ada ${commandQueue.length} permintaan.`);
    }
});

bot.onText(/\/cetak_token (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    let input = match[1].trim().split(/\s+/);
    const target = input[0];
    let rowNum = 1; // Default to row 1
    if (input.length > 1 && !isNaN(input[1])) {
        rowNum = parseInt(input[1], 10);
    }
    const rowIndex = rowNum - 1; // 0-indexed for DOM

    commandQueue.push(async () => {
        activeChatId = chatId;
        let statusMsg = await bot.sendMessage(chatId, `⏳ Mengambil data transaksi pada baris ke-${rowNum} untuk dicetak...`);
        try {
            if (!isLoggedIn || !browser || !page || page.isClosed()) {
                const ok = await login('main', chatId);
                if (!ok) throw new Error("Gagal login ke AP2T otomatis.");
                isLoggedIn = true;
                currentAccount = 'main';
            }

            await clickMenu(page, ['PELAYANAN PELANGGAN', 'Monitoring', 'Monitoring Permohonan Token']);
            const monitorFrame = await searchMonitoringToken(page, target, chatId);

            // Cari token dan klik baris menggunakan ExtJS API yang jauh lebih akurat (mengabaikan grid tersembunyi)
            const extractionResult = await monitorFrame.evaluate((rowIndex) => {
                let success = false;
                let errorMsg = `Tidak ada baris ke-${rowIndex + 1} di tabel aktif.`;
                let nama = '-';
                let idpel = '-';
                if (typeof Ext !== 'undefined' && Ext.ComponentMgr) {
                    Ext.ComponentMgr.all.each(function(cmp) {
                        if (cmp.isXType && cmp.isXType('grid')) {
                            if (cmp.el && cmp.el.dom) {
                                const rect = cmp.el.dom.getBoundingClientRect();
                                // Pastikan kita HANYA mengambil grid yang sedang aktif/terlihat di layar
                                if (rect.width > 0 && rect.left > -5000 && rect.top > -5000) {
                                    const view = cmp.getView();
                                    const store = cmp.getStore();
                                    const sm = cmp.getSelectionModel();
                                    const cm = cmp.getColumnModel();
                                    
                                    if (store.getCount() > rowIndex) {
                                        // Pilih baris di ExtJS
                                        if (sm && sm.selectRow) {
                                            sm.selectRow(rowIndex);
                                        }
                                        
                                        // Ekstrak IDPEL dan NAMA dari kolom yang tersedia
                                        for (let i = 0; i < cm.getColumnCount(); i++) {
                                            const header = cm.getColumnHeader(i).toUpperCase();
                                            try {
                                                const cell = view.getCell(rowIndex, i);
                                                if (cell) {
                                                    if (header.includes('IDPEL') || header.includes('NO METER')) idpel = cell.innerText.trim();
                                                    if (header.includes('NAMA')) nama = cell.innerText.trim();
                                                }
                                            } catch(e) {}
                                        }

                                        // Cari elemen DOM barisnya dan klik secara fisik untuk trigger event cetak
                                        const rowEl = view.getRow(rowIndex);
                                        if (rowEl) {
                                            rowEl.scrollIntoView({ block: 'center' });
                                            rowEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
                                            rowEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
                                            rowEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                            
                                            // Validasi apakah baris ini memiliki token 20 digit
                                            const cells = Array.from(rowEl.querySelectorAll('.x-grid3-cell-inner'));
                                            const hasToken = cells.some(c => c.textContent.replace(/\D/g, '').length === 20);
                                            
                                            if (hasToken) {
                                                success = true;
                                            } else {
                                                errorMsg = `Baris ke-${rowIndex + 1} ditemukan, tetapi tidak mengandung token 20 digit.`;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    });
                }
                return { success, errorMsg, nama, idpel };
            }, rowIndex);

            if (!extractionResult.success) {
                return bot.editMessageText(`❌ ${extractionResult.errorMsg} Silakan cek ulang datanya.`, { chat_id: chatId, message_id: statusMsg.message_id });
            }
            await new Promise(r => setTimeout(r, 1500));

            await bot.editMessageText(`⏳ Menunggu hasil cetak Token PDF...`, { chat_id: chatId, message_id: statusMsg.message_id });

            let newPage = null;
            try {
                const newPagePromise = new Promise(x => browser.once('targetcreated', target => x(target.page())));
                
                // Klik tombol Cetak
                await monitorFrame.evaluate(() => {
                    const btns = Array.from(document.querySelectorAll('button, .x-btn-text'));
                    const cetak = btns.find(b => b.textContent.toLowerCase().includes('cetak') && b.offsetParent !== null);
                    if (cetak) cetak.click();
                });

                const timeoutPromise = new Promise(r => setTimeout(r, 8000));
                const targetPage = await Promise.race([newPagePromise, timeoutPromise]);
                if (targetPage) {
                    await targetPage.waitForFunction(() => location.href !== 'about:blank', { timeout: 10000 }).catch(() => {});
                    newPage = targetPage;
                }
            } catch (e) {
                console.error(e);
            }

            if (newPage) {
                await new Promise(r => setTimeout(r, 2000)); // Tunggu render
                const pdfUrl = newPage.url();
                let ssBuffer = null;
                let downloadPdfUrl = pdfUrl;
                
                if (pdfUrl.includes('.rpt') || pdfUrl.includes('ReportServlet')) {
                    // MENGGUNAKAN NATIVE CHROME PDF VIEWER + SMART CROP
                    // Tambahkan #toolbar=0&view=FitH untuk menyembunyikan menu Chrome dan mem-fitkan kertas ke layar
                    downloadPdfUrl = pdfUrl.replace('.rpt', '.pdf').replace(/&format=\w+/g, '') + '&format=pdf#toolbar=0&view=FitH';
                    
                    await bot.editMessageText(`⏳ Merender PDF dan memotong *Background* abu-abu...`, { chat_id: chatId, message_id: statusMsg.message_id });
                    
                    await newPage.setViewport({ width: 1200, height: 1600 }); // Layar besar untuk resolusi tinggi
                    await newPage.goto(downloadPdfUrl, { waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
                    
                    // Tunggu render
                    await new Promise(r => setTimeout(r, 1500));
                    
                    // Screenshot mentah ke dalam Buffer (masih ada background abu-abu Chrome jika layar kebesaran)
                    const rawBuffer = await newPage.screenshot({ fullPage: false, captureBeyondViewport: false });
                    
                    // PROSES PEMOTONGAN PINTAR (SMART CROP)
                    const cropPage = await browser.newPage();
                    try {
                        const base64Image = rawBuffer.toString('base64');
                        const dataUrl = `data:image/png;base64,${base64Image}`;
                        
                        await cropPage.setContent(`
                            <!DOCTYPE html>
                            <html>
                            <body style="margin:0; padding:0; background: white;">
                                <canvas id="canvas"></canvas>
                            </body>
                            </html>
                        `);
                        
                        const cropBox = await cropPage.evaluate((imgUrl) => {
                            return new Promise((resolve) => {
                                const img = new Image();
                                img.onload = () => {
                                    const canvas = document.getElementById('canvas');
                                    canvas.width = img.width;
                                    canvas.height = img.height;
                                    const ctx = canvas.getContext('2d');
                                    ctx.drawImage(img, 0, 0);
                                    
                                    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                                    const data = imgData.data;
                                    
                                    // 1. Deteksi Batas Kertas Putih (Mengabaikan background abu-abu Chrome Viewer)
                                    let minPx = canvas.width, minPy = canvas.height, maxPx = 0, maxPy = 0;
                                    for (let y = 0; y < canvas.height; y++) {
                                        for (let x = 0; x < canvas.width; x++) {
                                            const i = (y * canvas.width + x) * 4;
                                            // Kertas = warna sangat terang (mendekati putih)
                                            if (data[i] > 200 && data[i+1] > 200 && data[i+2] > 200) {
                                                if (x < minPx) minPx = x;
                                                if (x > maxPx) maxPx = x;
                                                if (y < minPy) minPy = y;
                                                if (y > maxPy) maxPy = y;
                                            }
                                        }
                                    }
                                    
                                    if (minPx >= maxPx) { minPx = 0; minPy = 0; maxPx = canvas.width; maxPy = canvas.height; }
                                    
                                    // 2. Deteksi Batas Teks/Tinta di dalam kertas tersebut
                                    let minTx = canvas.width, minTy = canvas.height, maxTx = 0, maxTy = 0;
                                    for (let y = minPy; y <= maxPy; y++) {
                                        for (let x = minPx; x <= maxPx; x++) {
                                            const i = (y * canvas.width + x) * 4;
                                            // Tinta = warna gelap atau berwarna (seperti logo kuning/biru PLN)
                                            // Kita deteksi pixel yang BUKAN abu-abu background dan BUKAN putih kertas
                                            // Batas abu-abu Chrome Viewer biasanya R=82 G=86 B=89.
                                            // Jadi kalau R, G, B kurang dari 220, kita anggap itu tulisan/logo.
                                            if (data[i] < 220 || data[i+1] < 220 || data[i+2] < 220) {
                                                if (x < minTx) minTx = x;
                                                if (x > maxTx) maxTx = x;
                                                if (y < minTy) minTy = y;
                                                if (y > maxTy) maxTy = y;
                                            }
                                        }
                                    }
                                    
                                    if (minTx >= maxTx) { minTx = minPx; minTy = minPy; maxTx = maxPx; maxTy = maxPy; }
                                    
                                    // Beri padding rapi 20 pixel keliling
                                    const pad = 20;
                                    resolve({
                                        x: Math.max(0, minTx - pad),
                                        y: Math.max(0, minTy - pad),
                                        width: Math.min(canvas.width, (maxTx - minTx) + (pad * 2)),
                                        height: Math.min(canvas.height, (maxTy - minTy) + (pad * 2))
                                    });
                                };
                                img.src = imgUrl;
                            });
                        }, dataUrl);
                        
                        const canvasEl = await cropPage.$('#canvas');
                        ssBuffer = await canvasEl.screenshot({ clip: cropBox });
                    } finally {
                        await cropPage.close().catch(() => {});
                    }
                } else {
                    ssBuffer = await newPage.screenshot({ fullPage: true });
                }
                const infoData = `\n👤 NAMA: ${extractionResult.nama}\n💳 IDPEL: ${extractionResult.idpel}`;

                // Opsional: Kirim juga file PDF aslinya sebagai Document agar hasil 100% sempurna
                try {
                    const cookies = await newPage.cookies();
                    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                    const axios = require('axios');
                    const response = await axios.get(downloadPdfUrl, { headers: { Cookie: cookieStr }, responseType: 'arraybuffer' });
                    const pdfBuffer = Buffer.from(response.data);
                    await bot.sendDocument(chatId, pdfBuffer, { caption: `📄 Dokumen PDF Asli (Garansi 100% Utuh)\nTarget: ${target}${infoData}` }, { filename: `cetak_${target}.pdf`, contentType: 'application/pdf' });
                } catch (e) {
                    console.log("Gagal download PDF:", e.message);
                }
                
                await bot.sendPhoto(chatId, ssBuffer, { caption: `📸 Hasil Screenshot Cetak Token\nTarget: ${target}${infoData}` }, { filename: `cetak_${target}.png`, contentType: 'image/png' });
                await newPage.close().catch(() => {});
                await bot.editMessageText(`✅ Selesai mengekstrak dan mengirim gambar cetak Token.`, { chat_id: chatId, message_id: statusMsg.message_id });
            } else {
                await new Promise(r => setTimeout(r, 2000));
                const infoData = `\n👤 NAMA: ${extractionResult.nama}\n💳 IDPEL: ${extractionResult.idpel}`;
                const popupBuffer = await page.screenshot();
                await bot.sendPhoto(chatId, popupBuffer, { caption: `✅ Hasil Cetak Token\nTarget: ${target}${infoData}\n(Gagal buka PDF, mengirim Screenshot)` }, { filename: `cetak_${target}_popup.png`, contentType: 'image/png' });
                await bot.editMessageText(`✅ Selesai mengeksekusi cetak_token.`, { chat_id: chatId, message_id: statusMsg.message_id });
            }

        } catch (e) {
            await bot.editMessageText(`❌ Error cetak_token: ${e.message}`, { chat_id: chatId, message_id: statusMsg.message_id });
        }
    });

    if (!isProcessingCT) {
        processQueue();
    } else {
        bot.sendMessage(chatId, `[i] Menunggu antrean... Saat ini ada ${commandQueue.length} permintaan.`);
    }
});

bot.onText(/\/cek_token (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const target = match[1].trim();
    
    commandQueue.push(async () => {
        activeChatId = chatId;
        let statusMsg = await bot.sendMessage(chatId, `⏳ Membuka Monitoring Permohonan Token untuk ${target}...`);
        try {
            if (!isLoggedIn || !browser || !page || page.isClosed()) {
                const ok = await login('main', chatId);
                if (!ok) throw new Error("Gagal login ke AP2T otomatis.");
                isLoggedIn = true;
                currentAccount = 'main';
            }

            await clickMenu(page, ['PELAYANAN PELANGGAN', 'Monitoring', 'Monitoring Permohonan Token']);
            const monitorFrame = await searchMonitoringToken(page, target, chatId);
            
            await bot.editMessageText(`⏳ Mengekstrak data dari tabel...`, { chat_id: chatId, message_id: statusMsg.message_id });

            const gridData = await monitorFrame.evaluate(async () => {
                let result = { headers: [], rows: [] };
                if (typeof Ext !== 'undefined' && Ext.ComponentMgr) {
                    Ext.ComponentMgr.all.each(function(cmp) {
                        if (cmp.isXType && cmp.isXType('grid')) {
                            if (cmp.el && cmp.el.dom) {
                                const rect = cmp.el.dom.getBoundingClientRect();
                                if (rect.width > 0 && rect.left > -5000 && rect.top > -5000) {
                                    const view = cmp.getView();
                                    const cm = cmp.getColumnModel();
                                    const store = cmp.getStore();
                                    
                                    // Extract headers
                                    for (let i = 0; i < cm.getColumnCount(); i++) {
                                        if (!cm.isHidden(i)) {
                                            let header = cm.getColumnHeader(i).replace(/<[^>]*>?/gm, '').trim();
                                            if (header && header !== '&#160;') {
                                                result.headers.push({ index: i, text: header });
                                            }
                                        }
                                    }
                                    
                                    // Extract all rows
                                    for (let r = 0; r < store.getCount(); r++) {
                                        let rowData = {};
                                        for (let h = 0; h < result.headers.length; h++) {
                                            const colIndex = result.headers[h].index;
                                            let value = '';
                                            try {
                                                const cell = view.getCell(r, colIndex);
                                                if (cell) {
                                                    value = cell.innerText.trim();
                                                }
                                            } catch(e) {}
                                            rowData[result.headers[h].text] = value;
                                        }
                                        result.rows.push(rowData);
                                    }
                                }
                            }
                        }
                    });
                }
                return result;
            });

            if (gridData && gridData.headers.length > 0) {
                // Generate HTML table that looks like Excel/Spreadsheet
                let html = `
                <html>
                <head>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; background: #f0f2f5; margin: 0; }
                    .table-container { background: #fff; padding: 15px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); display: inline-block; }
                    h2 { color: #1a73e8; margin-top: 0; font-size: 18px; margin-bottom: 15px; }
                    table { border-collapse: collapse; white-space: nowrap; font-size: 12px; }
                    th { background-color: #1a73e8; color: #fff; font-weight: 600; border: 1px solid #ccc; padding: 8px 12px; text-transform: uppercase; }
                    td { border: 1px solid #ccc; padding: 6px 12px; color: #333; }
                    tr:nth-child(even) { background-color: #f8f9fa; }
                    tr:hover { background-color: #e8f0fe; }
                </style>
                </head>
                <body>
                    <div class="table-container">
                        <h2>Data Monitoring Token - ${target}</h2>
                        <table>
                            <thead>
                                <tr>
                                    ${gridData.headers.map(h => `<th>${h.text}</th>`).join('')}
                                </tr>
                            </thead>
                            <tbody>
                                ${gridData.rows.map(row => `
                                    <tr>
                                        ${gridData.headers.map(h => `<td>${row[h.text] || ''}</td>`).join('')}
                                    </tr>
                                `).join('')}
                            </tbody>
                        </table>
                    </div>
                </body>
                </html>
                `;

                await bot.editMessageText(`⏳ Menyusun data ke dalam format tabel (Excel)...`, { chat_id: chatId, message_id: statusMsg.message_id });

                const tablePage = await browser.newPage();
                await tablePage.setContent(html, { waitUntil: 'networkidle0' });
                
                const bodyHandle = await tablePage.$('.table-container');
                const boundingBox = await bodyHandle.boundingBox();
                
                await tablePage.setViewport({
                    width: Math.max(1024, Math.ceil(boundingBox.width) + 40),
                    height: Math.max(768, Math.ceil(boundingBox.height) + 40)
                });
                
                // Screenshot exactly the table container but limit dimensions for Telegram
                const ssBuffer = await tablePage.screenshot({ 
                    clip: {
                        x: 0,
                        y: 0,
                        width: Math.min(4000, Math.ceil(boundingBox.width) + 40),
                        height: Math.min(8000, Math.ceil(boundingBox.height) + 40)
                    } 
                });
                await tablePage.close();

                await bot.sendPhoto(chatId, ssBuffer, { caption: `? Data Monitoring Token untuk ${target} (Format Tabel)` }, { filename: `monitoring_${target}.png`, contentType: `image/png` });
                await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
            } else {
                await bot.editMessageText(`❌ Data tidak ditemukan dalam tabel.`, { chat_id: chatId, message_id: statusMsg.message_id });
            }

        } catch (e) {
            await bot.editMessageText(`❌ Error cek_token: ${e.message}`, {
                chat_id: chatId,
                message_id: statusMsg.message_id
            });
        }
    });

    if (!isProcessingCT) {
        processQueue();
    } else {
        bot.sendMessage(chatId, `[i] Menunggu antrean... Saat ini ada ${commandQueue.length} permintaan.`);
    }
});

console.log('🤖 Bot AP2T berjalan. Kirim /start di Telegram.');

bot.onText(/\/cek_pelanggan (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const target = match[1].trim();
    if (target.length < 5) {
        return bot.sendMessage(chatId, `[!] Format salah. Gunakan: \n\`/cek_pelanggan <idpel_atau_nometer>\``, { parse_mode: 'Markdown' });
    }
    commandQueue.push(async () => {
        activeChatId = chatId;
        bot.sendMessage(chatId, `[*] Memproses /cek_pelanggan untuk: ${target}`);
        await processCariPelanggan(target, chatId);
    });

    if (!isProcessingCT) {
        processQueue();
    } else {
        bot.sendMessage(chatId, `[i] Menunggu antrean... Saat ini ada ${commandQueue.length} permintaan.`);
    }
});

// Setup Menu Bawah Kiri di Telegram
const standardCommands = [
    { command: 'start', description: '⚡ Menu Utama' },
    { command: 'login', description: '🔑 Masuk ke sistem AP2T' },
    { command: 'ct', description: '🛠️ Buat Clear Tamper otomatis' },
    { command: 'reset_ct', description: '🔄 Reset memori proses CT' },
    { command: 'cetak_token', description: '🖨️ Cetak tiket Token PDF' },
    { command: 'cek_token', description: '🔍 Monitoring Token Excel' },
    { command: 'ambil_token', description: '🎟️ Cari & Ambil Token 20 Digit' },
    { command: 'cek_pelanggan', description: '👤 Cek Data Pelanggan' },
    { command: 'status', description: '📸 Cek status layar bot' },
    { command: 'reset_akun', description: '⚠️ Restart browser jika macet' },
    { command: 'pause_bot', description: '⏸️ Hentikan paksa / Bekukan bot' },
    { command: 'resume_bot', description: '▶️ Lanjutkan bot kembali' },
    { command: 'logout', description: '🚪 Keluar dari akun AP2T' },
    { command: 'stop_bot', description: '🛑 Matikan bot dari jarak jauh' }
];

bot.setMyCommands(standardCommands);

if (adminChatId) {
    const adminCommands = [
        ...standardCommands,
        { command: 'tambah_user', description: '👑 Tambah Staf' },
        { command: 'hapus_user', description: '👑 Hapus Staf' },
        { command: 'keygen', description: '👑 Buat Lisensi HWID' },
        { command: 'upload_perbaikan', description: '⬆️ Upload Update GitHub' },
        { command: 'update_bot', description: '⬇️ Download Update GitHub' },
        { command: 'lapor_status', description: '📡 Kirim Laporan Telemetri PC' }
    ];
    bot.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: adminChatId } }).catch(e => console.log("Failed to set admin commands", e.message));
}

// ============================================
// GITHUB TELEMETRY SYSTEM
// ============================================
async function updateGitHubStatus() {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;
    const branch = process.env.GITHUB_BRANCH || 'main';
    const pcName = process.env.PC_NAME || require('os').hostname();
    
    if (!token || !repo) return false;
    
    const axios = require('axios');
    const usersPath = path.join(__dirname, 'users.json');
    let usersData = { users: [] };
    if (fs.existsSync(usersPath)) {
        try { usersData = JSON.parse(fs.readFileSync(usersPath, 'utf8')); } catch(e){}
    }
    
    const normalizedUsers = usersData.users.map(u => {
        return typeof u === 'object' ? u : { id: u, nama: 'Tanpa Nama' };
    });
    
    let lastUpdated = 'Unknown';
    try {
        const stats = fs.statSync(__filename);
        lastUpdated = new Date(stats.mtime).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    } catch(e){}
    
    const payloadData = {
        pc_name: pcName,
        last_online: new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }),
        last_updated: lastUpdated,
        registered_users: normalizedUsers
    };
    
    const fileContent = JSON.stringify(payloadData, null, 2);
    const contentBase64 = Buffer.from(fileContent).toString('base64');
    
    const url = `https://api.github.com/repos/${repo}/contents/fleet/${pcName}.json?ref=${branch}`;
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
    
    try {
        let sha = null;
        try {
            const getRes = await axios.get(url, { headers });
            sha = getRes.data.sha;
        } catch (e) {
            if (e.response && e.response.status !== 404) throw e;
        }
        
        const payload = {
            message: `Update telemetry for ${pcName}`,
            content: contentBase64,
            branch: branch
        };
        if (sha) payload.sha = sha;
        
        await axios.put(url, payload, { headers });
        console.log(`Telemetry for ${pcName} updated on GitHub.`);
        return true;
    } catch (error) {
        console.error("Gagal update telemetry:", error.message);
        return false;
    }
}

setTimeout(updateGitHubStatus, 5000);

bot.onText(/\/lapor_status/, async (msg) => {
    if (msg.chat.id.toString() !== adminChatId) return bot.sendMessage(msg.chat.id, "⛔ Akses ditolak.");
    const loadMsg = await bot.sendMessage(msg.chat.id, "📡 Mengirim sinyal telemetri PC ini ke GitHub...");
    const success = await updateGitHubStatus();
    if (success) {
        bot.editMessageText("✅ Laporan telemetri berhasil dikirim ke GitHub!", { chat_id: msg.chat.id, message_id: loadMsg.message_id });
    } else {
        bot.editMessageText("❌ Gagal mengirim laporan telemetri. Cek konfigurasi GitHub Token/Repo di web.", { chat_id: msg.chat.id, message_id: loadMsg.message_id });
    }
});

// ============================================
// PROGRESS TRACKER (EDITABLE MESSAGES)
// ============================================
class ProgressTracker {
    constructor(bot, chatId, initialText) {
        this.bot = bot;
        this.chatId = chatId;
        this.text = initialText;
        this.messageId = null;
    }
    
    async start() {
        try {
            const sent = await this.bot.sendMessage(this.chatId, this.text, { parse_mode: 'Markdown' });
            this.messageId = sent.message_id;
        } catch (e) { console.error("Error starting tracker", e.message); }
    }
    
    async update(newText) {
        this.text = newText;
        if (this.messageId) {
            try {
                await this.bot.editMessageText(this.text, { chat_id: this.chatId, message_id: this.messageId, parse_mode: 'Markdown' });
            } catch(e) {}
        } else {
            await this.start();
        }
    }
}
global.ProgressTracker = ProgressTracker;
