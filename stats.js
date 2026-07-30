const fs = require('fs');
const path = require('path');
const statsPath = path.join(__dirname, 'stats.json');
const failedLogsPath = path.join(__dirname, 'failed_logs.json');

/**
 * Record a stat entry
 * @param {string} action - e.g. 'cetak_token', 'aktivasi_no_meter', 'ambil_token', 'cek_pelanggan'
 * @param {string} status - 'success' or 'fail'
 * @param {string} profileName - Active profile name
 * @param {object|null} userInfo - { id, nama } from Telegram msg.from
 */
function recordStat(action, status, profileName = 'Unknown', userInfo = null) {
    try {
        let stats = {};
        if (fs.existsSync(statsPath)) {
            stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
        }

        const todayDate = new Date().toISOString().split('T')[0];
        const currentMonth = todayDate.substring(0, 7); // YYYY-MM

        // Reset hari baru
        if (!stats.today || stats.today.date !== todayDate) {
            stats.today = {
                date: todayDate,
                cetak_token: { success: 0, fail: 0 },
                aktivasi_no_meter: { success: 0, fail: 0 },
                ambil_token: { success: 0, fail: 0 },
                cek_pelanggan: { success: 0, fail: 0 },
                profiles: {},
                users: {}
            };
        }
        
        // Cek struktur bulanan
        if (!stats.monthly) stats.monthly = {};
        if (!stats.monthly[currentMonth]) {
            stats.monthly[currentMonth] = {
                cetak_token: { success: 0, fail: 0 },
                aktivasi_no_meter: { success: 0, fail: 0 },
                ambil_token: { success: 0, fail: 0 },
                cek_pelanggan: { success: 0, fail: 0 }
            };
        }

        if (!stats.total) {
            stats.total = {
                cetak_token: { success: 0, fail: 0 },
                aktivasi_no_meter: { success: 0, fail: 0 },
                ambil_token: { success: 0, fail: 0 },
                cek_pelanggan: { success: 0, fail: 0 }
            };
        }

        // Per profil
        if (!stats.today.profiles) stats.today.profiles = {};
        if (!stats.today.profiles[profileName]) {
            stats.today.profiles[profileName] = {
                cetak_token: { success: 0, fail: 0 },
                aktivasi_no_meter: { success: 0, fail: 0 },
                ambil_token: { success: 0, fail: 0 },
                cek_pelanggan: { success: 0, fail: 0 }
            };
        }

        // Per user
        if (!stats.today.users) stats.today.users = {};
        if (userInfo && userInfo.id) {
            const userName = userInfo.nama || userInfo.first_name || String(userInfo.id);
            const userId = String(userInfo.id);
            if (!stats.today.users[userId]) {
                stats.today.users[userId] = {
                    nama: userName,
                    cetak_token: { success: 0, fail: 0 },
                    aktivasi_no_meter: { success: 0, fail: 0 },
                    ambil_token: { success: 0, fail: 0 },
                    cek_pelanggan: { success: 0, fail: 0 }
                };
            }
            if (!stats.today.users[userId][action]) stats.today.users[userId][action] = { success: 0, fail: 0 };
            stats.today.users[userId][action][status]++;
            stats.today.users[userId].nama = userName;
        }

        // Global hari ini
        if (!stats.today[action]) stats.today[action] = { success: 0, fail: 0 };
        if (!stats.total[action]) stats.total[action] = { success: 0, fail: 0 };
        if (!stats.monthly[currentMonth][action]) stats.monthly[currentMonth][action] = { success: 0, fail: 0 };
        if (!stats.today.profiles[profileName][action]) stats.today.profiles[profileName][action] = { success: 0, fail: 0 };

        stats.today[action][status]++;
        stats.total[action][status]++;
        stats.monthly[currentMonth][action][status]++;
        stats.today.profiles[profileName][action][status]++;

        fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
    } catch (e) {
        console.error('Error recording stat:', e);
    }
}

/**
 * Record a failed action log
 */
function recordFailedLog(action, target, reason, profileName = 'Unknown', userInfo = null) {
    try {
        let logs = [];
        if (fs.existsSync(failedLogsPath)) {
            logs = JSON.parse(fs.readFileSync(failedLogsPath, 'utf8'));
        }
        
        const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        const userName = userInfo ? (userInfo.nama || userInfo.first_name || String(userInfo.id)) : 'Unknown';
        
        logs.unshift({
            waktu: timestamp,
            perintah: action,
            target: target,
            profil: profileName,
            user: userName,
            alasan: reason
        });
        
        // Batasi 100 log terakhir agar tidak kepenuhan
        if (logs.length > 100) logs = logs.slice(0, 100);
        
        fs.writeFileSync(failedLogsPath, JSON.stringify(logs, null, 2));
    } catch (e) {
        console.error('Error recording failed log:', e);
    }
}

function getStats() {
    try {
        if (!fs.existsSync(statsPath)) return null;
        return JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    } catch (e) {
        return null;
    }
}

function getFailedLogs() {
    try {
        if (!fs.existsSync(failedLogsPath)) return [];
        return JSON.parse(fs.readFileSync(failedLogsPath, 'utf8'));
    } catch (e) {
        return [];
    }
}


function resetAllStats() {
    try {
        if (fs.existsSync(statsPath)) fs.unlinkSync(statsPath);
        if (fs.existsSync(failedLogsPath)) fs.unlinkSync(failedLogsPath);
    } catch (e) {
        console.error('Failed to reset stats:', e);
        throw e;
    }
}

module.exports = { recordStat, getStats, recordFailedLog, getFailedLogs, resetAllStats };
