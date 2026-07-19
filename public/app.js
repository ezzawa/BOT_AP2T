// Tab Switching Logic
document.querySelectorAll('.sidebar li').forEach(li => {
    li.addEventListener('click', () => {
        document.querySelectorAll('.sidebar li').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        
        li.classList.add('active');
        document.getElementById(li.dataset.tab).classList.add('active');
        
        // Refresh data based on tab
        if (li.dataset.tab === 'settings') loadEnv();
        if (li.dataset.tab === 'profiles') loadProfiles();
        if (li.dataset.tab === 'users') loadUsers();
    });
});

// --- API Calls ---

async function fetchStatus() {
    try {
        const res = await fetch('/api/status');
        const data = await res.json();
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
        document.getElementById('botStatus').textContent = "Offline";
        document.getElementById('botStatus').style.color = "#ef4444";
        document.getElementById('botStatus').style.backgroundColor = "rgba(239, 68, 68, 0.1)";
    }
}

async function loadEnv() {
    const res = await fetch('/api/env');
    const env = await res.json();
    const container = document.getElementById('envFields');
    container.innerHTML = '';
    
    // We only want to show important ones, but for now we'll show all existing keys plus defaults
    const defaults = ['TELEGRAM_BOT_TOKEN', 'ADMIN_CHAT_ID', 'LICENSE_KEY', 'MAIN_USERNAME', 'MAIN_PASSWORD', 'WEBMAIL_USERNAME', 'WEBMAIL_PASSWORD', 'GOOGLE_SHEETS_URL', 'GITHUB_TOKEN', 'GITHUB_REPO', 'GITHUB_BRANCH'];
    const keysToRender = new Set([...defaults, ...Object.keys(env)]);
    
    keysToRender.forEach(key => {
        const div = document.createElement('div');
        div.innerHTML = `
            <label style="display:block; margin-bottom:0.5rem; color:var(--text-muted);">${key}</label>
            <input type="text" name="${key}" value="${env[key] || ''}">
        `;
        container.appendChild(div);
    });
}

document.getElementById('envForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    const data = Object.fromEntries(formData.entries());
    
    await fetch('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    });
    alert('Settings saved successfully!');
    fetchStatus();
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
            <td><button class="btn-danger" onclick="deleteProfile('${name}')">Delete</button></td>
        `;
        tbody.appendChild(tr);
    }
}

async function deleteProfile(name) {
    if (!confirm(`Are you sure you want to delete profile: ${name}?`)) return;
    delete currentProfiles[name];
    await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentProfiles)
    });
    loadProfiles();
}

let currentUsers = [];
async function loadUsers() {
    const res = await fetch('/api/users');
    const data = await res.json();
    currentUsers = data.users || [];
    const tbody = document.querySelector('#usersTable tbody');
    tbody.innerHTML = '';
    
    currentUsers.forEach(userId => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${userId}</td>
            <td><button class="btn-danger" onclick="deleteUser('${userId}')">Remove</button></td>
        `;
        tbody.appendChild(tr);
    });
}

async function deleteUser(userId) {
    if (!confirm(`Remove user ${userId}?`)) return;
    currentUsers = currentUsers.filter(u => u !== userId);
    await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: currentUsers })
    });
    loadUsers();
}

// Initial Load
fetchStatus();
