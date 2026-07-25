// === TAB MANAGEMENT & ROLE ===
let isAdmin = false;

function checkAuth() {
    const savedRole = localStorage.getItem('role');
    if (savedRole === 'admin') {
        isAdmin = true;
        document.getElementById('loginOverlay').classList.add('hidden');
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'flex');
        // default tab for admin could be livelog or config
    } else if (savedRole === 'user') {
        isAdmin = false;
        document.getElementById('loginOverlay').classList.add('hidden');
        document.querySelectorAll('.admin-only').forEach(el => el.style.display = 'none');
    }
}
checkAuth();

async function attemptLogin() {
    const pwd = document.getElementById('adminPwd').value;
    if (!pwd) return alert("Silakan masukkan password Admin!");
    
    const res = await fetch('/api/admin_login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
    });
    const data = await res.json();
    
    if (data.success) {
        localStorage.setItem('role', 'admin');
        checkAuth();
        switchTab('livelog');
    } else {
        alert("Password Admin Salah!");
    }
}

function loginAsUser() {
    localStorage.setItem('role', 'user');
    checkAuth();
    switchTab('livelog');
}

function logoutAdmin() {
    localStorage.removeItem('role');
    location.reload();
}

async function saveAdminPassword() {
    const pwd = document.getElementById('adminPassword').value;
    if (!pwd) return;
    if (!confirm("Yakin ingin mengubah password Admin?")) return;
    
    const res = await fetch('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ADMIN_PASSWORD: pwd })
    });
    const data = await res.json();
    alert("Password Admin berhasil diubah! Silakan login ulang.");
    logoutAdmin();
}

function switchTab(tabId) {
    if (document.getElementById('tab-' + tabId).style.display === 'none') {
        return; // Prevent user from clicking hidden tabs manually via console
    }
    document.querySelectorAll('.sidebar li').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    
    document.getElementById('tab-' + tabId).classList.add('active');
    document.getElementById(tabId).classList.add('active');
    
    let title = "Dashboard";
    if (tabId === 'livelog') title = "Live Log (Status Proses)";
    if (tabId === 'config') { title = "Pengaturan Config"; loadEnv(); }
    if (tabId === 'akun') { title = "Manajemen Akun AP2T"; loadProfiles(); }
    if (tabId === 'users') { title = "Fleet Monitor & Users"; loadUsers(); loadFleet(); }
    if (tabId === 'panduan') title = "Panduan Setup Bot";
    
    document.getElementById('pageTitle').textContent = title;
}

// === LIVE LOG ===
async function fetchLiveLogs() {
    try {
        const res = await fetch('/api/livelogs');
        const logs = await res.json();
        const box = document.getElementById('liveLogBox');
        
        if (logs.length === 0) {
            box.innerHTML = '<div style="color: #64748b; text-align: center; margin-top: 20px;">Belum ada aktivitas bot saat ini...</div>';
            return;
        }
        
        box.innerHTML = '';
        logs.forEach(log => {
            const div = document.createElement('div');
            div.className = 'log-entry';
            let msgHtml = log.msg;
            if (msgHtml.includes('✅')) msgHtml = `<span class="log-msg success">${msgHtml}</span>`;
            else if (msgHtml.includes('❌')) msgHtml = `<span class="log-msg error">${msgHtml}</span>`;
            else if (msgHtml.includes('⚠️')) msgHtml = `<span class="log-msg warning">${msgHtml}</span>`;
            
            div.innerHTML = `<span class="log-time">[${log.time}]</span> ${msgHtml}`;
            box.appendChild(div);
        });
    } catch (e) {
        console.log("Error fetching logs", e);
    }
}
setInterval(fetchLiveLogs, 2000);
if (document.getElementById('livelog').classList.contains('active')) fetchLiveLogs();

// === STATUS API ===
async function fetchStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        const botStatus = document.getElementById('serverStatus');
        botStatus.innerHTML = '<i class="fas fa-check-circle"></i> Node Server Online';
        botStatus.style.background = 'rgba(16, 185, 129, 0.15)';
        botStatus.style.color = 'var(--accent)';
        botStatus.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    } catch (e) {
        const botStatus = document.getElementById('serverStatus');
        botStatus.innerHTML = '<i class="fas fa-times-circle"></i> Server Offline';
        botStatus.style.background = 'rgba(239, 68, 68, 0.15)';
        botStatus.style.color = 'var(--danger)';
        botStatus.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    }
}
fetchStatus();
setInterval(fetchStatus, 5000);

// === CONFIG (ENV) ===
async function loadEnv() {
    const res = await fetch(`/api/env`);
    const env = await res.json();
    
    document.getElementById('tgToken').value = env.TELEGRAM_BOT_TOKEN || '';
    document.getElementById('adminChatId').value = env.ADMIN_CHAT_ID || '';
    document.getElementById('gsUrl').value = env.GOOGLE_SHEETS_URL || '';
    document.getElementById('ghToken').value = env.GITHUB_TOKEN || '';
    document.getElementById('ghRepo').value = env.GITHUB_REPO || '';
}

async function saveEnv() {
    const data = {
        TELEGRAM_BOT_TOKEN: document.getElementById('tgToken').value,
        ADMIN_CHAT_ID: document.getElementById('adminChatId').value,
        GOOGLE_SHEETS_URL: document.getElementById('gsUrl').value,
        GITHUB_TOKEN: document.getElementById('ghToken').value,
        GITHUB_REPO: document.getElementById('ghRepo').value
    };
    
    const res = await fetch('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    
    const result = await res.json();
    alert(result.message);
    if (result.success) {
        setTimeout(() => location.reload(), 1500);
    }
}

// === PROFILES ===
let currentProfiles = {};
async function loadProfiles() {
    const res = await fetch('/api/profiles');
    currentProfiles = await res.json();
    const tbody = document.querySelector('#profilesTable tbody');
    tbody.innerHTML = '';
    
    for (const [name, data] of Object.entries(currentProfiles)) {
        const ap2tUser = data.ap2t ? data.ap2t.username : data.ap2t_user;
        const webUser = data.webmail ? data.webmail.username : data.web_user;
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${name}</td>
            <td><code style="background:rgba(0,0,0,0.3);padding:2px 5px;border-radius:4px;">${ap2tUser || '-'}</code></td>
            <td><code style="background:rgba(0,0,0,0.3);padding:2px 5px;border-radius:4px;">${webUser || '-'}</code></td>
            <td style="display: flex; gap: 5px;">
                <button class="btn-primary" style="font-size: 11px; padding: 6px 10px;" onclick="editProfile('${name}')"><i class="fas fa-edit"></i> Edit</button>
                <button class="btn-danger" style="font-size: 11px; padding: 6px 10px;" onclick="deleteProfile('${name}')"><i class="fas fa-trash"></i> Hapus</button>
            </td>
        `;
        tbody.appendChild(tr);
    }
}

async function saveProfileFromForm() {
    const name = document.getElementById('profName').value;
    if (!name) return alert("Pilih profil dari tabel (klik Edit)");
    
    currentProfiles[name] = {
        ap2t: {
            username: document.getElementById('profAp2tUser').value,
            password: document.getElementById('profAp2tPass').value
        },
        webmail: {
            username: document.getElementById('profWebUser').value,
            password: document.getElementById('profWebPass').value
        }
    };
    
    await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentProfiles)
    });
    
    alert(`Profil ${name} berhasil disimpan!`);
    document.getElementById('profileForm').reset();
    loadProfiles();
}

function editProfile(name) {
    const data = currentProfiles[name];
    if (!data) return;
    
    document.getElementById('profName').value = name;
    document.getElementById('profAp2tUser').value = data.ap2t ? data.ap2t.username : (data.ap2t_user || '');
    document.getElementById('profAp2tPass').value = data.ap2t ? data.ap2t.password : (data.ap2t_pass || '');
    document.getElementById('profWebUser').value = data.webmail ? data.webmail.username : (data.web_user || '');
    document.getElementById('profWebPass').value = data.webmail ? data.webmail.password : (data.web_pass || '');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteProfile(name) {
    if (!confirm(`Hapus profil: ${name}?`)) return;
    delete currentProfiles[name];
    await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentProfiles)
    });
    loadProfiles();
}

// === FLEET & USERS ===
let globalMaintenance = false;

async function loadUsers() {
    const res = await fetch('/api/users');
    const data = await res.json();
    const usersData = data.users || [];
    const tbody = document.querySelector('#usersTable tbody');
    tbody.innerHTML = '';
    
    usersData.forEach(u => {
        let id = typeof u === 'object' ? u.id : u;
        let nama = typeof u === 'object' ? u.nama : 'Tanpa Nama';
        let full_name = (typeof u === 'object' && u.full_name) ? u.full_name : nama;
        let username = (typeof u === 'object' && u.username) ? u.username : '-';
        let disabled = (typeof u === 'object' && u.disabled) ? true : false;
        
        const tr = document.createElement('tr');
        if (disabled) tr.style.opacity = '0.5';
        
        tr.innerHTML = `
            <td>${nama}</td>
            <td>${full_name}</td>
            <td><span style="color: var(--primary);">${username}</span></td>
            <td><code>${id}</code></td>
            <td style="text-align: center;">
                <button class="btn-outline" style="padding: 4px 8px; font-size: 12px; ${disabled ? 'color: var(--accent); border-color: var(--accent);' : 'color: #f59e0b; border-color: #f59e0b;'}" onclick="toggleLocalUser('${id}')">
                    ${disabled ? '<i class="fas fa-play"></i> Enable' : '<i class="fas fa-pause"></i> Disable'}
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function toggleLocalUser(id) {
    const res = await fetch('/api/users');
    const data = await res.json();
    const usersData = data.users || [];
    
    const userIndex = usersData.findIndex(u => (typeof u === 'object' ? u.id : u) === id);
    if (userIndex > -1) {
        if (typeof usersData[userIndex] !== 'object') {
            usersData[userIndex] = { id: usersData[userIndex], disabled: false };
        }
        usersData[userIndex].disabled = !usersData[userIndex].disabled;
        
        await fetch('/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ users: usersData })
        });
        loadUsers();
    }
}

async function toggleGlobalMaintenance() {
    const newState = !globalMaintenance;
    if(!confirm(`Yakin ingin ${newState ? 'MENONAKTIFKAN' : 'MENGAKTIFKAN'} SELURUH PC secara bersamaan?`)) return;
    
    document.getElementById('btnGlobalMaintenance').innerHTML = `<i class="fas fa-spinner fa-spin"></i> Processing...`;
    await fetch('/api/fleet/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'global', maintenance: newState })
    });
    loadFleet();
}

async function toggleRemotePC(pcName, currentState) {
    const newState = !currentState;
    if(!confirm(`Yakin ingin ${newState ? 'MENONAKTIFKAN' : 'MENGAKTIFKAN'} PC: ${pcName}?`)) return;
    
    const tbody = document.querySelector('#fleetTbody');
    const oldHTML = tbody.innerHTML;
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;"><i class="fas fa-spinner fa-spin"></i> Menyimpan ke GitHub...</td></tr>';
    
    try {
        await fetch('/api/fleet/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: pcName, maintenance: newState })
        });
        await new Promise(r => setTimeout(r, 3000));
        loadFleet();
    } catch (e) {
        alert("Gagal: " + e.message);
        tbody.innerHTML = oldHTML;
    }
}

async function deleteFleet(pcName) {
    if(!confirm(`Hapus PC '${pcName}' dari Fleet?`)) return;
    await fetch(`/api/fleet/${encodeURIComponent(pcName)}`, { method: 'DELETE' });
    loadFleet();
}

async function loadFleet() {
    const tbody = document.querySelector('#fleetTbody');
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;"><i class="fas fa-circle-notch fa-spin"></i> Mengambil data GitHub...</td></tr>';
    
    try {
        const [fleetRes, configRes] = await Promise.all([
            fetch('/api/fleet'),
            fetch('/api/fleet/config')
        ]);
        
        const data = await fleetRes.json();
        const configData = await configRes.json();
        const configs = configData.configs || {};
        
        globalMaintenance = configs['global'] || false;
        const btnGlobal = document.getElementById('btnGlobalMaintenance');
        if (btnGlobal) {
            if (globalMaintenance) {
                btnGlobal.innerHTML = `<i class="fas fa-power-off"></i> Global Maint (ON)`;
                btnGlobal.style.color = '#fff';
                btnGlobal.style.background = '#ff4757';
            } else {
                btnGlobal.innerHTML = `<i class="fas fa-power-off"></i> Global Maint (OFF)`;
                btnGlobal.style.color = '#ff4757';
                btnGlobal.style.background = 'transparent';
            }
        }
        
        const fleetData = data.fleet || [];
        tbody.innerHTML = '';
        if (fleetData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">Belum ada PC Cabang di GitHub.</td></tr>';
            return;
        }
        
        fleetData.forEach(pc => {
            const isMaintenance = configs[pc.pc_name] || false;
            const tr = document.createElement('tr');
            if (isMaintenance) tr.style.opacity = '0.6';
            
            const userStr = (pc.registered_users || []).map(u => typeof u === 'object' ? u.nama : u).join(', ');
            
            tr.innerHTML = `
                <td><strong>${pc.pc_name || 'Unknown'}</strong> ${isMaintenance ? '<span style="color:#ef4444;font-size:11px;">(Disabled)</span>' : ''}</td>
                <td><span style="color: var(--primary); background: rgba(59,130,246,0.1); padding: 2px 6px; border-radius: 4px;">v${pc.bot_version || '1.0'}</span></td>
                <td><span style="color: var(--accent);">${pc.last_online || '-'}</span></td>
                <td><span style="font-size: 12px; color: #888;">${userStr || 'Kosong'}</span></td>
                <td style="text-align: center; display:flex; gap:5px; justify-content:center;">
                    <button class="btn" style="padding: 4px 8px; font-size: 12px; color: #fff; background-color: ${isMaintenance ? 'var(--accent)' : '#f59e0b'}; border: none; cursor: pointer; border-radius: 4px;" onclick="toggleRemotePC('${pc.pc_name}', ${isMaintenance})">
                        ${isMaintenance ? 'Enable' : 'Disable'}
                    </button>
                    <button class="btn" style="padding: 4px 8px; font-size: 12px; color: #fff; background-color: var(--danger); border: none; cursor: pointer; border-radius: 4px;" onclick="deleteFleet('${pc.pc_name}')">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger);">Error: ${e.message}</td></tr>`;
    }
}

