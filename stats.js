const fs = require('fs');
const path = require('path');
const statsPath = path.join(__dirname, 'stats.json');

/**
 * Record a stat entry
 * @param {string} action - e.g. 'cetak_token', 'aktivasi_no_meter', 'ambil_token', 'cek_pelanggan'
 * @param {string} status - 'success' or 'fail'
 * @param {string} profileName - Active profile name
 * @param {object|null} userInfo - { id, nama } from Telegram msg.from
 */
function recordStat(action, status, profileName = 'Unknown', userInfo = null, reason = '') {
    try {
        let stats = {};
        if (fs.existsSync(statsPath)) {
            stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
        }

        const todayDate = new Date().toISOString().split('T')[0];

        // Reset hari baru
        if (!stats.today || stats.today.date !== todayDate) {
            stats.today = {
                date: todayDate,
                cetak_token: { success: 0, fail: 0 },
                aktivasi_no_meter: { success: 0, fail: 0 },
                ambil_token: { success: 0, fail: 0 },
                cek_pelanggan: { success: 0, fail: 0 },
                profiles: {},
                users: {},
                ct_history: [],
                fail_reasons: []
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
        if (!stats.today.fail_reasons) stats.today.fail_reasons = [];

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
        let userName = "System";
        if (userInfo && userInfo.id) {
            userName = userInfo.nama || userInfo.first_name || String(userInfo.id);
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
        if (!stats.today.profiles[profileName][action]) stats.today.profiles[profileName][action] = { success: 0, fail: 0 };

        stats.today[action][status]++;
        stats.total[action][status]++;
        stats.today.profiles[profileName][action][status]++;

        if (status === 'fail' && reason) {
            stats.today.fail_reasons.push({
                time: new Date().toLocaleTimeString('id-ID', {timeZone: 'Asia/Jakarta'}),
                action,
                user: userName,
                reason
            });
        }

        fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
    } catch (e) {
        console.error('Error recording stat:', e);
    }
}

function getStats() {
    try {
        if (!fs.existsSync(statsPath)) return null;
        const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
        return {
            today: { ...stats.today },
            total: { ...stats.total }
        };
    } catch (e) {
        return null;
    }
}

/**
 * Cek apakah CT dengan IdPel dan No Pengaduan ini sudah sukses hari ini
 */
function isCTDuplicate(idpel, noPengaduan) {
    try {
        if (fs.existsSync(statsPath)) {
            const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            const todayDate = new Date().toISOString().split('T')[0];
            if (stats.today && stats.today.date === todayDate && stats.today.ct_history) {
                return stats.today.ct_history.some(ct => ct.idpel === idpel && ct.noPengaduan === noPengaduan);
            }
        }
    } catch(e) {}
    return false;
}

/**
 * Catat CT yang sukses agar tidak terduplikat
 */
function recordSuccessfulCTData(idpel, noPengaduan) {
    try {
        let stats = {};
        if (fs.existsSync(statsPath)) {
            stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
        }
        const todayDate = new Date().toISOString().split('T')[0];
        if (!stats.today || stats.today.date !== todayDate) {
            stats.today = { date: todayDate, ct_history: [] };
        }
        if (!stats.today.ct_history) stats.today.ct_history = [];
        
        stats.today.ct_history.push({ idpel, noPengaduan, time: new Date().toISOString() });
        fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
    } catch (e) {}
}

module.exports = { recordStat, getStats, isCTDuplicate, recordSuccessfulCTData };
