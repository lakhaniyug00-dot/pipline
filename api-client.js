/**
 * ApiClient - Cloud Synchronization & Multi-Account Engine
 * Features:
 *  - 1-Click Multi-Account switcher with instant isolated cloud sync
 *  - Premium avatar chip widget matching exact [V] Valam design
 *  - Real-time MongoDB Atlas & Fallback Cloud Synchronization
 *  - Zero password roadblock for seamless daily bookkeeping
 */
(function (window) {
    'use strict';

    const TOKEN_KEY = 'pipeline_auth_token';
    const USER_KEY = 'pipeline_user_info';
    const ACCOUNTS_KEY = 'pipeline_accounts';
    const DEVICE_ID_KEY = 'pipeline_device_id';
    const STORAGE_KEY = 'data-tracker-v2';
    const HISTORY_KEY = 'data-tracker-deleted-history';
    const UNDO_KEY = 'data-tracker-undo-stack';

    const AVATAR_COLORS = ['#0F172A', '#D97706', '#2563EB', '#7C3AED', '#059669', '#DB2777', '#DC2626', '#0891B2'];

    // Generate or retrieve unique device ID
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (!deviceId) {
        deviceId = 'dev_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        try { localStorage.setItem(DEVICE_ID_KEY, deviceId); } catch (e) { }
    }

    let token = localStorage.getItem(TOKEN_KEY) || null;
    let currentUser = null;
    try {
        const u = localStorage.getItem(USER_KEY);
        if (u) currentUser = JSON.parse(u);
    } catch (e) { }

    let lastKnownVersion = 0;
    let isSyncing = false;
    let pollTimer = null;
    let isCloudAvailable = true;
    let manageMode = false;

    const listeners = {
        stateUpdated: [],
        historyUpdated: [],
        authChanged: [],
        syncStatusChanged: []
    };

    function notify(event, payload) {
        if (listeners[event]) {
            listeners[event].forEach(cb => {
                try { cb(payload); } catch (e) { console.error('Listener error:', e); }
            });
        }
    }

    function capitalize(s) {
        if (!s) return '';
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Helper for authenticated requests
    async function apiRequest(endpoint, options = {}) {
        const url = endpoint;
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };

        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
        }

        try {
            const res = await fetch(url, {
                ...options,
                headers,
                cache: 'no-store'
            });

            const data = await res.json().catch(() => ({}));

            if (res.status === 401 && token) {
                console.warn('Session expired. Re-authenticating...');
                // Automatically re-authenticate current user
                if (currentUser && currentUser.username) {
                    await ApiClient.selectAccount(currentUser.username, false);
                } else {
                    ApiClient.logout(false);
                    updateUi();
                }
                throw new Error(data.error || 'Session expired.');
            }

            if (!res.ok) {
                throw new Error(data.error || ('Request failed with status ' + res.status));
            }

            isCloudAvailable = true;
            updateSyncBadge('synced', 'Cloud Synced');
            return data;
        } catch (err) {
            if (!window.navigator.onLine || (err.message && err.message.includes('Failed to fetch'))) {
                updateSyncBadge('offline', 'Offline (Local Only)');
            }
            throw err;
        }
    }

    function updateSyncBadge(status, text) {
        const badge = document.getElementById('cloud-sync-badge');
        if (!badge) return;

        let dotColor = '#10b981';
        let bg = 'rgba(26,58,138,0.06)';
        let border = 'rgba(26,58,138,0.15)';
        let textColor = '#1a3a8a';

        if (status === 'syncing') {
            dotColor = '#3b82f6';
            text = text || 'Syncing...';
        } else if (status === 'synced') {
            dotColor = '#10b981';
            text = text || 'Cloud Synced';
        } else if (status === 'local') {
            dotColor = '#64748b';
            text = text || 'Local Mode';
        } else if (status === 'offline') {
            dotColor = '#f59e0b';
            bg = 'rgba(245, 158, 11, 0.1)';
            border = '#fcd34d';
            textColor = '#92400e';
        }

        badge.style.background = bg;
        badge.style.borderColor = border;
        badge.style.color = textColor;
        badge.innerHTML = '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:' + dotColor + '; margin-right:6px; animation:' + (status === 'syncing' ? 'pulse 1s infinite' : 'none') + ';"></span><span>' + text + '</span>';
    }

    function showNotificationToast(msg, isError = false) {
        let toast = document.getElementById('pipeline-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'pipeline-toast';
            toast.style.cssText = 'position:fixed; bottom:24px; right:24px; background:#0F172A; color:#fff; padding:12px 20px; border-radius:12px; font-family:"Patrick Hand", cursive, sans-serif; font-size:17px; box-shadow:0 10px 25px rgba(0,0,0,0.25); z-index:999999; display:none; transition:all 0.25s ease; border:1px solid rgba(255,255,255,0.15);';
            document.body.appendChild(toast);
        }
        toast.style.background = isError ? '#b3261e' : '#0F172A';
        toast.textContent = msg;
        toast.style.display = 'block';
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
            setTimeout(() => toast.style.display = 'none', 250);
        }, 3200);
    }

    const ApiClient = {
        getDeviceId() {
            return deviceId;
        },

        getToken() {
            return token;
        },

        getUser() {
            return currentUser;
        },

        isLoggedIn() {
            return Boolean(token && currentUser);
        },

        on(event, callback) {
            if (listeners[event]) listeners[event].push(callback);
        },

        // --- MULTI-ACCOUNT MANAGEMENT ---
        async loadAccounts() {
            try {
                const data = await apiRequest('/api/auth/accounts');
                if (data && data.success && Array.isArray(data.accounts)) {
                    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(data.accounts));
                    return data.accounts;
                }
            } catch (e) { }

            try {
                const raw = localStorage.getItem(ACCOUNTS_KEY);
                if (raw) return JSON.parse(raw);
            } catch (e) { }

            const def = [{ username: 'valam' }];
            localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(def));
            return def;
        },

        async selectAccount(rawUname, notifyToast = true) {
            const username = (rawUname || '').trim();
            if (!username) return;

            updateSyncBadge('syncing', 'Switching to ' + capitalize(username) + '...');
            try {
                const data = await apiRequest('/api/auth/select', {
                    method: 'POST',
                    body: JSON.stringify({ username })
                });

                if (data.success && data.token) {
                    token = data.token;
                    currentUser = data.user;
                    localStorage.setItem(TOKEN_KEY, token);
                    localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
                    
                    // Add to local accounts list
                    const accounts = await this.loadAccounts();
                    if (!accounts.some(a => (a.username || '').toLowerCase() === username.toLowerCase())) {
                        accounts.push({ username });
                        localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
                    }

                    notify('authChanged', currentUser);
                    updateUi();
                    this.startSync();

                    // Immediately fetch and render cloud data for this user
                    const state = await this.getState();
                    if (state) notify('stateUpdated', state);

                    if (notifyToast) showNotificationToast('⚡ Switched to account: ' + capitalize(username));
                    return data;
                }
                throw new Error(data.error || 'Failed to select account.');
            } catch (err) {
                console.warn('Server account switch fallback to local mode:', err.message);
                const localToken = 'local_' + Date.now().toString(36);
                token = localToken;
                currentUser = { id: 'u_' + username.toLowerCase(), username: username };
                localStorage.setItem(TOKEN_KEY, token);
                localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
                notify('authChanged', currentUser);
                updateUi();
                updateSyncBadge('local', 'Local Profile: ' + capitalize(username));
                if (notifyToast) showNotificationToast('⚡ Switched to ' + capitalize(username) + ' (Local)');
                return { success: true, token: localToken, user: currentUser };
            }
        },

        async deleteAccount(username) {
            try {
                await apiRequest('/api/auth/accounts/' + encodeURIComponent(username), { method: 'DELETE' });
            } catch (e) { }

            const accounts = (await this.loadAccounts()).filter(a => (a.username || '').toLowerCase() !== username.toLowerCase());
            localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));

            // If current user was deleted, switch to another account or Valam
            if (currentUser && currentUser.username.toLowerCase() === username.toLowerCase()) {
                if (accounts.length > 0) {
                    await this.selectAccount(accounts[0].username);
                } else {
                    await this.selectAccount('valam');
                }
            }
        },

        logout(refresh = true) {
            token = null;
            currentUser = null;
            try {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
            } catch (e) { }

            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }

            notify('authChanged', null);
            updateUi();
            updateSyncBadge('local', 'Offline / Local Mode');
            showNotificationToast('Signed out.');
            if (refresh) {
                // Prompt account selection
                openAccountModal();
            }
        },

        // --- PIPELINE DATA SYNC ---
        async getState() {
            if (!this.isLoggedIn()) return null;
            try {
                const data = await apiRequest('/api/state');
                if (data.success && data.state) {
                    lastKnownVersion = data.version || 0;
                    return data.state;
                }
            } catch (err) {
                console.warn('Failed to fetch cloud pipeline state:', err.message);
            }
            return null;
        },

        async saveState(state, undoStack = []) {
            if (!this.isLoggedIn()) return;
            try {
                const data = await apiRequest('/api/state', {
                    method: 'POST',
                    body: JSON.stringify({
                        state,
                        undoStack,
                        deviceId
                    })
                });
                if (data.success) {
                    lastKnownVersion = data.version || lastKnownVersion + 1;
                    updateSyncBadge('synced', 'Cloud Synced');
                }
            } catch (err) {
                console.warn('Cloud save queued or deferred:', err.message);
            }
        },

        async getHistory() {
            if (!this.isLoggedIn()) return null;
            try {
                const data = await apiRequest('/api/history');
                if (data.success && Array.isArray(data.history)) {
                    return data.history;
                }
            } catch (err) { }
            return null;
        },

        async saveHistoryEntry(entry) {
            if (!this.isLoggedIn()) return;
            try {
                await apiRequest('/api/history', {
                    method: 'POST',
                    body: JSON.stringify(entry)
                });
            } catch (err) { }
        },

        async deleteHistoryItem(hid) {
            if (!this.isLoggedIn()) return;
            try {
                await apiRequest('/api/history/' + encodeURIComponent(hid), {
                    method: 'DELETE'
                });
            } catch (err) { }
        },

        async clearHistory() {
            if (!this.isLoggedIn()) return;
            try {
                await apiRequest('/api/history', {
                    method: 'DELETE'
                });
            } catch (err) { }
        },

        // --- BACKGROUND SYNC POLLER ---
        startSync(intervalMs = 4000) {
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(async () => {
                if (!this.isLoggedIn() || isSyncing) return;
                try {
                    isSyncing = true;
                    const status = await apiRequest('/api/sync-status?deviceId=' + encodeURIComponent(deviceId));
                    if (status.success && status.version > lastKnownVersion) {
                        const newState = await this.getState();
                        if (newState) {
                            notify('stateUpdated', newState);
                            updateSyncBadge('synced', 'Synced across devices');
                        }
                    }
                } catch (err) {
                    // Handled gracefully in apiRequest
                } finally {
                    isSyncing = false;
                }
            }, intervalMs);
        }
    };

    // --- UI COMPONENT: ACCOUNT BAR & MODAL INJECTION ---
    function renderAccountWidget() {
        if (document.getElementById('cloud-account-bar')) return;

        const bar = document.createElement('div');
        bar.id = 'cloud-account-bar';
        bar.className = 'no-print';
        bar.style.cssText = 'max-width:1200px; margin:0 auto 14px; display:flex; align-items:center; justify-content:flex-end; gap:12px; font-family:"Patrick Hand", cursive, sans-serif; font-size:16px; flex-wrap:wrap;';

        bar.innerHTML = '<div id="cloud-sync-badge" style="display:flex; align-items:center; background:rgba(26,58,138,0.06); border:1px solid rgba(26,58,138,0.15); padding:5px 14px; border-radius:999px; color:#1a3a8a; font-size:14px;">'
            + '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#10b981; margin-right:6px;"></span>'
            + '<span>Connecting...</span>'
            + '</div>'
            + '<div id="account-actions" style="display:flex; align-items:center; gap:8px;"></div>';

        const header = document.querySelector('.main-header') || document.querySelector('.toolbar') || document.body.firstChild;
        if (header && header.parentNode) {
            header.parentNode.insertBefore(bar, header);
        } else {
            document.body.prepend(bar);
        }

        renderAccountModal();
        updateUi();
    }

    function updateUi() {
        const container = document.getElementById('account-actions');
        if (!container) return;

        if (ApiClient.isLoggedIn()) {
            const user = ApiClient.getUser();
            const uname = user.username || 'Valam';
            const initial = uname.charAt(0).toUpperCase();
            const displayName = capitalize(uname);

            // EXACT CHIP DESIGN FROM USER'S SCREENSHOT
            container.innerHTML = '<div id="account-user-chip" title="Click to switch account / ખાતું બદલો" style="display:flex; align-items:center; gap:9px; background:#fff; border:1.5px solid #cbd5e1; border-radius:12px; padding:6px 14px; box-shadow:0 2px 8px rgba(0,0,0,0.06); cursor:pointer; user-select:none; transition:all 0.15s ease;">'
                + '<div style="width:28px; height:28px; border-radius:7px; background:#0F172A; color:#fff; display:flex; align-items:center; justify-content:center; font-family:'Inter', sans-serif; font-size:14px; font-weight:800; flex-shrink:0;">'
                + escapeHtml(initial)
                + '</div>'
                + '<span style="font-family:'Inter', -apple-system, sans-serif; font-size:15px; font-weight:700; color:#0F172A; letter-spacing:0.2px;">'
                + escapeHtml(displayName)
                + '</span>'
                + '</div>'
                + '<button id="account-switch-btn" title="Switch Account / ખાતું બદલો" style="background:#e3f3ff; border:1.5px solid #1a3a8a; border-radius:999px; padding:5px 12px; cursor:pointer; color:#1a3a8a; font-family:'Patrick Hand'; font-size:15px; transition:all 0.15s;">👥 Switch</button>'
                + '<button id="account-sync-btn" title="Force Sync Now" style="background:#fff; border:1.5px solid #1a3a8a; border-radius:999px; padding:5px 10px; cursor:pointer; color:#1a3a8a; font-family:'Patrick Hand'; font-size:14px;">🔄 Sync</button>';

            document.getElementById('account-user-chip')?.addEventListener('click', openAccountModal);
            document.getElementById('account-switch-btn')?.addEventListener('click', openAccountModal);

            document.getElementById('account-sync-btn')?.addEventListener('click', async () => {
                showNotificationToast('🔄 Syncing with cloud...');
                const state = await ApiClient.getState();
                if (state) notify('stateUpdated', state);
                showNotificationToast('✅ Cloud sync complete!');
            });

            updateSyncBadge('synced', 'Synced across devices');
        } else {
            container.innerHTML = '<button id="open-auth-btn" style="background:#1a3a8a; color:#fff; border:none; border-radius:999px; padding:7px 18px; font-family:'Patrick Hand', cursive; font-size:16px; cursor:pointer; box-shadow:0 2px 8px rgba(26,58,138,0.25); display:flex; align-items:center; gap:8px;">'
                + '<span>⚡</span> <span>Select Account</span>'
                + '</button>';

            document.getElementById('open-auth-btn')?.addEventListener('click', openAccountModal);
            updateSyncBadge('local', 'Offline / Local Mode');
        }
    }

    function renderAccountModal() {
        if (document.getElementById('account-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'account-modal-overlay';
        overlay.style.cssText = 'position:fixed; inset:0; background:rgba(15, 23, 42, 0.65); backdrop-filter:blur(4px); z-index:100000; display:none; align-items:center; justify-content:center; padding:16px;';

        overlay.innerHTML = '<div style="background:#fffdf5; border:2px solid #1a3a8a; border-radius:20px; box-shadow:0 16px 40px rgba(0,0,0,0.25); width:100%; max-width:440px; padding:24px 22px; position:relative; font-family:'Patrick Hand', cursive, sans-serif;">'
            + '<button id="modal-close-btn" style="position:absolute; top:14px; right:18px; background:none; border:none; font-size:24px; cursor:pointer; color:#1a3a8a; line-height:1;">✕</button>'
            + '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; padding-right:24px;">'
            + '<div>'
            + '<div style="font-family:'Caveat', cursive; font-size:28px; font-weight:700; color:#1a3a8a; line-height:1.1;">Select Account</div>'
            + '<div style="font-size:14px; color:#5a5030;">ઝડપી લૉગિન / 1-Click Multi-Account</div>'
            + '</div>'
            + '<div style="display:flex; gap:6px;">'
            + '<button id="modal-btn-add" style="background:#e8f9ef; border:1.5px solid #10b981; color:#0f766e; border-radius:8px; padding:5px 12px; font-size:13px; font-weight:700; cursor:pointer; font-family:'Patrick Hand';">＋ Add</button>'
            + '<button id="modal-btn-manage" style="background:#fff; border:1.5px solid #c9b97b; color:#1a3a8a; border-radius:8px; padding:5px 12px; font-size:13px; font-weight:700; cursor:pointer; font-family:'Patrick Hand';">✏️ Manage</button>'
            + '</div>'
            + '</div>'
            + '<div id="modal-add-panel" style="display:none; background:#f5eed8; border:1.5px solid #d9c98a; border-radius:12px; padding:12px; margin-bottom:14px;">'
            + '<label style="font-size:14px; font-weight:700; color:#1a3a8a; display:block; margin-bottom:6px;">New Account Name / નામ</label>'
            + '<div style="display:flex; gap:8px;">'
            + '<input type="text" id="modal-add-input" placeholder="e.g. valam" autocomplete="off" style="flex:1; padding:9px 12px; border:1.5px solid #c9b97b; border-radius:8px; font-family:'Patrick Hand'; font-size:16px; outline:none; background:#fff; color:#1a3a8a;" />'
            + '<button id="modal-add-save-btn" style="background:#1a3a8a; color:#fff; border:none; border-radius:8px; padding:9px 14px; font-family:'Patrick Hand'; font-size:15px; font-weight:700; cursor:pointer;">💾 Save</button>'
            + '</div>'
            + '</div>'
            + '<div id="modal-alert" style="display:none; padding:8px 12px; border-radius:8px; font-size:14px; margin-bottom:12px;"></div>'
            + '<div id="modal-accounts-grid" style="display:grid; grid-template-columns:1fr 1fr; gap:10px; max-height:280px; overflow-y:auto; padding:2px;"></div>'
            + '<div style="margin-top:16px; padding-top:12px; border-top:1px dashed #d9c98a; font-size:13px; color:#6b5d2a; text-align:center;">'
            + '🔒 Isolated workspace & real-time sync for each account across all devices.'
            + '</div>'
            + '</div>';

        document.body.appendChild(overlay);

        document.getElementById('modal-close-btn').addEventListener('click', closeAccountModal);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeAccountModal(); });

        const btnAdd = document.getElementById('modal-btn-add');
        const addPanel = document.getElementById('modal-add-panel');
        const inputNew = document.getElementById('modal-add-input');
        const btnSave = document.getElementById('modal-add-save-btn');
        const btnManage = document.getElementById('modal-btn-manage');

        btnAdd.addEventListener('click', () => {
            if (addPanel.style.display === 'none') {
                addPanel.style.display = 'block';
                inputNew.focus();
            } else {
                addPanel.style.display = 'none';
            }
        });

        btnManage.addEventListener('click', () => {
            manageMode = !manageMode;
            btnManage.textContent = manageMode ? '✓ Done' : '✏️ Manage';
            btnManage.style.background = manageMode ? '#fee2e2' : '#fff';
            btnManage.style.borderColor = manageMode ? '#ef4444' : '#c9b97b';
            btnManage.style.color = manageMode ? '#b3261e' : '#1a3a8a';
            renderModalChips();
        });

        async function handleSaveNew() {
            const raw = (inputNew.value || '').trim();
            if (!raw) {
                showModalAlert('Please enter an account name', true);
                return;
            }
            inputNew.value = '';
            addPanel.style.display = 'none';
            await ApiClient.selectAccount(raw);
            closeAccountModal();
        }

        btnSave.addEventListener('click', handleSaveNew);
        inputNew.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSaveNew(); }
        });
    }

    function showModalAlert(msg, isErr = false) {
        const el = document.getElementById('modal-alert');
        if (!el) return;
        el.textContent = msg;
        el.style.background = isErr ? '#fee2e2' : '#ecfdf5';
        el.style.color = isErr ? '#b3261e' : '#065f46';
        el.style.border = '1px solid ' + (isErr ? '#fca5a5' : '#6ee7b7');
        el.style.display = 'block';
        setTimeout(() => el.style.display = 'none', 3000);
    }

    async function renderModalChips() {
        const grid = document.getElementById('modal-accounts-grid');
        if (!grid) return;

        grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#5a5030; padding:14px;">Loading accounts...</div>';
        const accounts = await ApiClient.loadAccounts();
        grid.innerHTML = '';

        if (!accounts.length) {
            grid.innerHTML = '<div style="grid-column:1/-1; text-align:center; color:#5a5030; padding:14px;">No accounts yet. Click ＋ Add to create one.</div>';
            return;
        }

        const activeUname = (currentUser && currentUser.username || '').toLowerCase();

        accounts.forEach((acc, idx) => {
            const uname = acc.username || '';
            const isCurrent = uname.toLowerCase() === activeUname;
            const initial = uname.charAt(0).toUpperCase();
            const color = AVATAR_COLORS[idx % AVATAR_COLORS.length];

            const chip = document.createElement('div');
            chip.className = 'user-modal-chip';
            chip.style.cssText = 'background:' + (isCurrent ? '#eff6ff' : '#fff') + '; border:1.5px solid ' + (isCurrent ? '#2563eb' : '#d9c98a') + '; border-radius:12px; padding:10px 12px; display:flex; align-items:center; gap:10px; cursor:pointer; position:relative; transition:all 0.15s ease; box-shadow:0 2px 6px rgba(40,30,10,0.06);';

            chip.innerHTML = '<div style="width:32px; height:32px; border-radius:8px; background:' + color + '; color:#fff; display:flex; align-items:center; justify-content:center; font-family:'Inter', sans-serif; font-size:14px; font-weight:800; flex-shrink:0;">'
                + escapeHtml(initial)
                + '</div>'
                + '<div style="flex:1; min-width:0;">'
                + '<div style="font-family:'Inter', -apple-system, sans-serif; font-size:14.5px; font-weight:700; color:#0F172A; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">'
                + escapeHtml(capitalize(uname))
                + '</div>'
                + (isCurrent ? '<div style="font-size:11px; font-weight:700; color:#2563eb;">● Active</div>' : '')
                + '</div>'
                + (manageMode ? '<button class="chip-delete-btn" style="position:absolute; top:4px; right:4px; width:22px; height:22px; border-radius:50%; background:#ef4444; color:#fff; border:none; cursor:pointer; font-size:12px; font-weight:800; display:flex; align-items:center; justify-content:center; line-height:1;">✕</button>' : '');

            chip.addEventListener('click', async (e) => {
                if (e.target.closest('.chip-delete-btn')) {
                    e.stopPropagation();
                    if (confirm('Delete account "' + uname + '"?')) {
                        await ApiClient.deleteAccount(uname);
                        renderModalChips();
                    }
                    return;
                }
                if (manageMode) return;
                closeAccountModal();
                await ApiClient.selectAccount(uname);
            });

            grid.appendChild(chip);
        });
    }

    function openAccountModal() {
        renderAccountModal();
        const overlay = document.getElementById('account-modal-overlay');
        if (overlay) {
            overlay.style.display = 'flex';
            renderModalChips();
        }
    }

    function closeAccountModal() {
        const overlay = document.getElementById('account-modal-overlay');
        if (overlay) overlay.style.display = 'none';
        manageMode = false;
    }

    // Auto-initialize on load
    async function initClient() {
        renderAccountWidget();

        // If no user is logged in, auto-select 'valam' so user is instantly ready with [V] Valam
        if (!ApiClient.isLoggedIn()) {
            const storedUser = localStorage.getItem(USER_KEY);
            let uname = 'valam';
            if (storedUser) {
                try { uname = JSON.parse(storedUser).username || 'valam'; } catch (e) { }
            }
            await ApiClient.selectAccount(uname, false);
        } else {
            ApiClient.startSync();
            const state = await ApiClient.getState();
            if (state) notify('stateUpdated', state);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initClient);
    } else {
        initClient();
    }

    window.ApiClient = ApiClient;
})(window);
