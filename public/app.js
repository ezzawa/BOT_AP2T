// Tab Switching Logic
let isAdmin = false;

document.querySelectorAll('.sidebar li').forEach(li => {
    li.addEventListener('click', () => {
        if (li.dataset.tab === 'users' && !isAdmin) {
            alert("Harap login sebagai Admin terlebih dahulu untuk melihat Control Panel.");
            return;
        }
        
        document.querySelectorAll('.sidebar li').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        
        li.classList.add('active');
        document.getElementById(li.dataset.tab).classList.add('active');
        
        // Refresh data based on tab
        if (li.dataset.tab === 'settings') loadEnv();
        if (li.dataset.tab === 'profiles') loadProfiles();
        if (li.dataset.tab === 'users') {
            loadUsers();
            loadFleet();
        }
    });
});

// --- API Calls ---

async function fetchStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        const botStatus = document.getElementById('botStatus');
        botStatus.textContent = 'Online 🟢';
        botStatus.style.background = 'rgba(16, 185, 129, 0.2)';
        botStatus.style.color = '#10b981';
        botStatus.style.borderColor = 'rgba(16, 185, 129, 0.4)';
        
        document.getElementById('hwidDisplay').textContent = data.hwid;
        
        const licenseStatus = document.getElementById('licenseStatus');
        if (data.isLicensed) {
            licenseStatus.textContent = "Valid License ✅";
            licenseStatus.style.color = "#10b981";
        } else {
            licenseStatus.textContent = "Unlicensed ❌";
            licenseStatus.style.color = "#ef4444";
        }
    } catch (e) {
        document.getElementById('botStatus').textContent = 'Offline';
        document.getElementById('botStatus').style.background = '#ef4444';
    }
}

async function adminLogin() {
    if (isAdmin) {
        alert("Anda sudah login sebagai Admin.");
        return;
    }
    
    const pwdInput = document.getElementById('adminPwdInput');
    const pwd = pwdInput.value;
    if (!pwd) return alert("Silakan masukkan password!");
    
    const res = await fetch('/api/admin_login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pwd })
    });
    const data = await res.json();
    
    if (data.success) {
        isAdmin = true;
        document.getElementById('adminLoginContainer').style.display = 'none';
        alert("Berhasil login sebagai Admin! Anda sekarang bisa mengakses semua pengaturan rahasia.");
        if (document.getElementById('settings').classList.contains('active')) {
            loadEnv(); // Reload to remove readonly
        }
    } else {
        alert("Password salah!");
        pwdInput.value = '';
    }
}

async function loadEnv() {
    const res = await fetch(`/api/env`);
    const env = await res.json();
    const container = document.getElementById('envFields');
    container.innerHTML = '';
    
    const fieldDescriptions = {
        'MAIN_USERNAME': 'Username akun AP2T yang saat ini aktif digunakan.',
        'MAIN_PASSWORD': 'Password akun AP2T.',
        'WEBMAIL_USERNAME': 'Email PLN (contoh: uid\\nama.staf) untuk buka tiket OWA.',
        'WEBMAIL_PASSWORD': 'Password Webmail PLN.',
        'TELEGRAM_BOT_TOKEN': 'Token dari BotFather (Wajib sama di semua PC jika pakai 1 bot).',
        'ADMIN_CHAT_ID': 'ID Telegram Anda (Admin Pusat). Ketik /id di bot Rose.',
        'LICENSE_KEY': 'Kunci lisensi HWID PC ini. Didapat dari perintah /keygen.',
        'GOOGLE_SHEETS_URL': 'URL Spreadsheet tempat laporan hasil bot direkap.',
        'GITHUB_TOKEN': 'Token akses GitHub (Wajib sama di semua PC).',
        'GITHUB_REPO': 'Nama repositori GitHub. Contoh: ezzawa/BOT_AP2T.',
        'GITHUB_BRANCH': 'Nama branch repositori (biasanya: main atau master).',
        'PC_NAME': 'Nama komputer ini (contoh: PC_LOKET_1) agar mudah dipantau di Dashboard.'
    };
    
    const addSection = (title, keys) => {
        const titleEl = document.createElement('h4');
        titleEl.style.color = '#60a5fa';
        titleEl.style.marginTop = '20px';
        titleEl.style.marginBottom = '10px';
        titleEl.style.paddingBottom = '5px';
        titleEl.style.borderBottom = '1px solid #333';
        titleEl.textContent = title;
        container.appendChild(titleEl);
        
        keys.forEach(key => {
            const isEditable = ['MAIN_USERNAME', 'MAIN_PASSWORD', 'WEBMAIL_USERNAME', 'WEBMAIL_PASSWORD'].includes(key);
            const readonlyAttr = (!isAdmin && !isEditable) ? 'readonly style="opacity: 0.6; cursor: not-allowed;"' : '';
            
            const desc = fieldDescriptions[key] || '';
            const descHtml = desc ? `<small style="display:block; color:#888; font-size:11px; margin-bottom:5px;"><i>${desc}</i></small>` : '';
            
            const isPassword = (key.includes('TOKEN') || key.includes('LICENSE')) && !key.includes('MAIN_PASSWORD') && !key.includes('WEBMAIL_PASSWORD');
            const inputType = isPassword ? 'password' : 'text';
            
            const div = document.createElement('div');
            div.style.marginBottom = '12px';
            div.innerHTML = `
                <label style="display:block; margin-bottom:0.2rem; color:var(--text-muted);">${key}</label>
                ${descHtml}
                <input type="${inputType}" name="${key}" value="${env[key] || ''}" ${readonlyAttr}>
            `;
            container.appendChild(div);
        });
    };
    
    addSection('Kredensial AP2T (Active Profile)', ['MAIN_USERNAME', 'MAIN_PASSWORD']);
    container.innerHTML += `<hr style="border-color: #333; margin: 20px 0;">`;
    addSection('Kredensial Webmail (Active Profile)', ['WEBMAIL_USERNAME', 'WEBMAIL_PASSWORD']);
    container.innerHTML += `<hr style="border-color: #333; margin: 20px 0;">`;
    
    const otherKeys = ['TELEGRAM_BOT_TOKEN', 'ADMIN_CHAT_ID', 'LICENSE_KEY', 'GOOGLE_SHEETS_URL', 'GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH', 'PC_NAME'];
    const remainingKeys = Object.keys(env).filter(k => !otherKeys.includes(k) && !['MAIN_USERNAME', 'MAIN_PASSWORD', 'WEBMAIL_USERNAME', 'WEBMAIL_PASSWORD'].includes(k));
    
    addSection('Pengaturan Sistem Server', [...otherKeys, ...remainingKeys]);
}

document.getElementById('envForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    
    const res = await fetch('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    
    const result = await res.json();
    alert(result.message);
    if (result.success) {
        setTimeout(() => location.reload(), 1500); // Reload page to reconnect after restart
    }
});

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
            <td>${ap2tUser || '-'}</td>
            <td>${webUser || '-'}</td>
            <td style="display: flex; gap: 5px;">
                <button class="btn-primary" style="background-color: #3b82f6; font-size: 11px; padding: 4px 8px;" onclick="editProfile('${name}')">Edit</button>
                <button class="btn-primary" style="background-color: #10b981; font-size: 11px; padding: 4px 8px;" onclick="applyProfile('${name}')">Pakai Akun</button>
                <button class="btn-danger" style="font-size: 11px; padding: 4px 8px;" onclick="deleteProfile('${name}')">Hapus</button>
            </td>
        `;
        tbody.appendChild(tr);
    }
}

async function saveProfileFromForm() {
    const name = document.getElementById('profName').value;
    if (!name) return;
    
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

async function applyProfile(name) {
    if (!confirm(`Terapkan profil ${name}? Bot akan di-restart.`)) return;
    
    const data = currentProfiles[name];
    const newEnv = {
        MAIN_USERNAME: data.ap2t ? data.ap2t.username : data.ap2t_user,
        MAIN_PASSWORD: data.ap2t ? data.ap2t.password : data.ap2t_pass,
        WEBMAIL_USERNAME: data.webmail ? data.webmail.username : data.web_user,
        WEBMAIL_PASSWORD: data.webmail ? data.webmail.password : data.web_pass
    };
    
    await fetch('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newEnv)
    });
    
    alert(`Profil ${name} aktif. Memuat ulang sistem...`);
    setTimeout(() => location.reload(), 3000);
}

async function saveEnvAsProfile() {
    const name = prompt("Masukkan Nama Profil Baru:");
    if (!name) return;
    
    const formData = new FormData(document.getElementById('envForm'));
    const data = Object.fromEntries(formData.entries());
    
    const res = await fetch('/api/profiles');
    const existingProfiles = await res.json();
    
    existingProfiles[name] = {
        ap2t: {
            username: data.MAIN_USERNAME || '',
            password: data.MAIN_PASSWORD || ''
        },
        webmail: {
            username: data.WEBMAIL_USERNAME || '',
            password: data.WEBMAIL_PASSWORD || ''
        }
    };
    
    await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(existingProfiles)
    });
    
    alert(`Profil ${name} berhasil disimpan dari Config!`);
    loadProfiles(); // Refresh background data
}

async function deleteProfile(name) {
    if (!isAdmin) return alert("Hanya Admin yang bisa menghapus profil!");
    if (!confirm(`Are you sure you want to delete profile: ${name}?`)) return;
    delete currentProfiles[name];
    await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentProfiles)
    });
    loadProfiles();
}

async function loadUsers() {
    const res = await fetch('/api/users');
    const data = await res.json();
    const usersData = data.users || [];
    const tbody = document.querySelector('#usersTable tbody');
    tbody.innerHTML = '';
    
    usersData.forEach(u => {
        let id = typeof u === 'object' ? u.id : u;
        let nama = typeof u === 'object' ? u.nama : 'Tanpa Nama';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${nama}</td>
            <td>${id}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function loadFleet() {
    const tbody = document.querySelector('#fleetTbody');
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Mengambil data dari GitHub...</td></tr>';
    
    try {
        const res = await fetch('/api/fleet');
        const data = await res.json();
        const fleetData = data.fleet || [];
        
        tbody.innerHTML = '';
        if (fleetData.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">Belum ada PC Cabang yang melapor ke GitHub.</td></tr>';
            return;
        }
        
        fleetData.forEach(pc => {
            const tr = document.createElement('tr');
            
            // Format users list
            const userStr = (pc.registered_users || []).map(u => typeof u === 'object' ? u.nama : u).join(', ');
            
            // Check if online recently (e.g. within 2 hours) -> this is just UI coloring
            // For now just output raw string
            tr.innerHTML = `
                <td><strong>${pc.pc_name || 'Unknown PC'}</strong></td>
                <td><span style="color: #4ade80;">${pc.last_online || '-'}</span></td>
                <td>${pc.last_updated || '-'}</td>
                <td>${userStr || 'Kosong'}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: red;">Error: ${e.message}</td></tr>`;
    }
}

// Initial Load
fetchStatus();
