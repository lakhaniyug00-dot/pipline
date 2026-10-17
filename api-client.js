/**
 * ApiClient - Cloud Synchronization & Authentication Engine
 * Supports multi-device sync, MongoDB Atlas persistence, offline fallback, and safe migration.
 */
(function (window) {
    'use strict';

    const TOKEN_KEY = 'pipeline_auth_token';
    const USER_KEY = 'pipeline_user_info';
    const DEVICE_ID_KEY = 'pipeline_device_id';
    const STORAGE_KEY = 'data-tracker-v2';
    const HISTORY_KEY = 'data-tracker-deleted-history';
    const UNDO_KEY = 'data-tracker-undo-stack';

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

    // Helper for authenticated requests
    async function apiRequest(endpoint, options = {}) {
        const url = endpoint.startsWith('http') ? endpoint : endpoint;
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };

        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            const res = await fetch(url, {
                ...options,
                headers,
                cache: 'no-store'
            });

            const data = await res.json().catch(() => ({}));

            if (res.status === 401 && token) {
                // Token expired or invalid
                console.warn('Session expired. Logging out.');
                ApiClient.logout(false);
                updateUi();
                throw new Error(data.error || 'Session expired. Please sign in again.');
            }

            if (!res.ok) {
                throw new Error(data.error || `Request failed with status ${res.status}`);
            }

            isCloudAvailable = true;
            updateSyncBadge('synced', 'Cloud Synced');
            return data;
        } catch (err) {
            if (err.message && (err.message.includes('MONGODB_URI') || err.message.includes('503'))) {
                isCloudAvailable = false;
                updateSyncBadge('warning', 'Cloud DB not configured');
            } else if (!window.navigator.onLine || err.message.includes('Failed to fetch')) {
                updateSyncBadge('offline', 'Offline (Local Only)');
            }
            throw err;
        }
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

        // --- AUTHENTICATION ---
        async register(username, password) {
            updateSyncBadge('syncing', 'Creating account...');
            const data = await apiRequest('/api/auth/register', {
                method: 'POST',
                body: JSON.stringify({ username, password })
            });

            if (data.success && data.token) {
                token = data.token;
                currentUser = data.user;
                localStorage.setItem(TOKEN_KEY, token);
                localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
                notify('authChanged', currentUser);
                updateUi();
                this.startSync();
                // Check if user has local data that can be migrated
                await this.checkMigrationAfterAuth();
            }
            return data;
        },

        async login(username, password) {
            updateSyncBadge('syncing', 'Signing in...');
            const data = await apiRequest('/api/auth/login', {
                method: 'POST',
                body: JSON.stringify({ username, password })
            });

            if (data.success && data.token) {
                token = data.token;
                currentUser = data.user;
                localStorage.setItem(TOKEN_KEY, token);
                localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
                notify('authChanged', currentUser);
                updateUi();
                this.startSync();
                // Check if user has local data that can be migrated
                await this.checkMigrationAfterAuth();
            }
            return data;
        },

        logout(refresh = true) {
            token = null;
            currentUser = null;
            try {
                localStorage.removeItem(TOKEN_KEY);
                localStorage.removeItem(USER_KEY);
            } catch (e) { }
            this.stopSync();
            notify('authChanged', null);
            updateUi();
            if (refresh) {
                window.location.reload();
            }
        },

        // --- PIPELINE STATE OPERATIONS ---
        async getState() {
            if (!this.isLoggedIn()) {
                return this.getLocalState();
            }

            try {
                updateSyncBadge('syncing', 'Fetching cloud data...');
                const res = await apiRequest('/api/state');
                if (res.success && res.data) {
                    lastKnownVersion = res.data.version || 1;
                    if (Array.isArray(res.data.columns) && res.data.columns.length > 0) {
                        try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ columns: res.data.columns })); } catch (e) { }
                        if (Array.isArray(res.data.undoStack)) {
                            try { localStorage.setItem(UNDO_KEY, JSON.stringify(res.data.undoStack)); } catch (e) { }
                        }
                        updateSyncBadge('synced', 'Synced');
                        return { columns: res.data.columns };
                    }
                }
            } catch (err) {
                console.warn('Could not load remote state, falling back to local storage:', err.message);
            }

            return this.getLocalState();
        },

        getLocalState() {
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (parsed && Array.isArray(parsed.columns) && parsed.columns.length > 0) {
                    return parsed;
                }
            } catch (e) { }
            return null;
        },

        async saveState(state, undoStack) {
            // Immediately persist to localStorage for instant local responsiveness
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { }
            if (Array.isArray(undoStack)) {
                try { localStorage.setItem(UNDO_KEY, JSON.stringify(undoStack)); } catch (e) { }
            }

            if (!this.isLoggedIn()) {
                updateSyncBadge('local', 'Saved locally');
                return;
            }

            try {
                updateSyncBadge('syncing', 'Syncing...');
                const res = await apiRequest('/api/state', {
                    method: 'POST',
                    body: JSON.stringify({
                        state,
                        undoStack,
                        senderDeviceId: deviceId
                    })
                });

                if (res.success) {
                    lastKnownVersion = res.version;
                    updateSyncBadge('synced', 'Synced across devices');
                }
            } catch (err) {
                console.warn('Failed to sync state to cloud:', err.message);
                updateSyncBadge('warning', 'Saved locally (Sync pending)');
            }
        },

        // --- HISTORY OPERATIONS ---
        async getHistory() {
            if (!this.isLoggedIn()) {
                return this.getLocalHistory();
            }

            try {
                const res = await apiRequest('/api/history');
                if (res.success && Array.isArray(res.data)) {
                    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(res.data)); } catch (e) { }
                    return res.data;
                }
            } catch (err) {
                console.warn('Failed to load remote history, falling back to local:', err.message);
            }

            return this.getLocalHistory();
        },

        getLocalHistory() {
            try {
                const raw = localStorage.getItem(HISTORY_KEY);
                return raw ? JSON.parse(raw) : [];
            } catch (e) {
                return [];
            }
        },

        async saveHistoryEntry(entry) {
            // Local update
            try {
                const raw = localStorage.getItem(HISTORY_KEY);
                const history = raw ? JSON.parse(raw) : [];
                history.unshift(entry);
                localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            } catch (e) { }

            if (!this.isLoggedIn()) return;

            try {
                await apiRequest('/api/history', {
                    method: 'POST',
                    body: JSON.stringify({ entry })
                });
            } catch (err) {
                console.warn('Failed to sync history entry:', err.message);
            }
        },

        async saveHistory(fullHistory) {
            try { localStorage.setItem(HISTORY_KEY, JSON.stringify(fullHistory)); } catch (e) { }

            if (!this.isLoggedIn()) return;

            try {
                await apiRequest('/api/history', {
                    method: 'POST',
                    body: JSON.stringify({ fullHistory })
                });
            } catch (err) {
                console.warn('Failed to save full history:', err.message);
            }
        },

        async deleteHistoryItem(hid) {
            try {
                const raw = localStorage.getItem(HISTORY_KEY);
                if (raw) {
                    const history = JSON.parse(raw).filter(e => e.hid !== hid);
                    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
                }
            } catch (e) { }

            if (!this.isLoggedIn()) return;

            try {
                await apiRequest(`/api/history/${encodeURIComponent(hid)}`, {
                    method: 'DELETE'
                });
            } catch (err) {
                console.warn('Failed to delete history item on server:', err.message);
            }
        },

        async clearHistory() {
            try { localStorage.removeItem(HISTORY_KEY); } catch (e) { }

            if (!this.isLoggedIn()) return;

            try {
                await apiRequest('/api/history', {
                    method: 'DELETE'
                });
            } catch (err) {
                console.warn('Failed to clear remote history:', err.message);
            }
        },

        // --- BACKGROUND MULTI-DEVICE SYNC ENGINE ---
        startSync() {
            this.stopSync();
            if (!this.isLoggedIn()) return;

            // Poll every 6 seconds for changes made on other devices
            pollTimer = setInterval(() => {
                this.checkRemoteSync();
            }, 6000);

            // Immediate sync when tab or window regains focus
            window.addEventListener('focus', () => this.checkRemoteSync());
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    this.checkRemoteSync();
                }
            });
        },

        stopSync() {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        },

        async checkRemoteSync() {
            if (!this.isLoggedIn() || isSyncing || !window.navigator.onLine) return;

            try {
                isSyncing = true;
                const status = await apiRequest('/api/sync-status');
                if (status.success && status.version) {
                    // If server version is newer and was updated by another device
                    if (status.version > lastKnownVersion && status.lastUpdatedByDevice !== deviceId) {
                        console.log('🔄 Detected update from another device. Synchronizing...');
                        updateSyncBadge('syncing', 'Updating from cloud...');
                        const remoteState = await apiRequest('/api/state');
                        if (remoteState.success && remoteState.data) {
                            lastKnownVersion = remoteState.data.version;
                            notify('stateUpdated', { columns: remoteState.data.columns });
                            showNotificationToast('☁️ Data updated from your other device.');
                            updateSyncBadge('synced', 'Synced across devices');
                        }
                    }
                }
            } catch (e) {
                // Silently keep polling
            } finally {
                isSyncing = false;
            }
        },

        // --- DATA MIGRATION ---
        async checkMigrationAfterAuth() {
            const localState = this.getLocalState();
            const localHistory = this.getLocalHistory();

            const hasLocalItems = localState &&
                Array.isArray(localState.columns) &&
                localState.columns.some(c => Array.isArray(c.items) && c.items.length > 0);

            if (!hasLocalItems && (!localHistory || localHistory.length === 0)) {
                // No local data to migrate, just load cloud data
                const fresh = await this.getState();
                if (fresh) notify('stateUpdated', fresh);
                return;
            }

            // Check if server already has data
            try {
                const cloud = await apiRequest('/api/state');
                const cloudHasItems = cloud && cloud.data &&
                    Array.isArray(cloud.data.columns) &&
                    cloud.data.columns.some(c => Array.isArray(c.items) && c.items.length > 0);

                if (!cloudHasItems) {
                    // Cloud account is empty! Automatically migrate local data safely
                    await apiRequest('/api/migrate', {
                        method: 'POST',
                        body: JSON.stringify({ localState, localHistory, overwrite: true })
                    });
                    showNotificationToast('✨ Your local records were safely uploaded to your cloud account!');
                } else {
                    // Both have data: prompt the user
                    showMigrationModal(localState, localHistory);
                }
            } catch (e) {
                console.warn('Migration check error:', e);
            }
        },

        async forceUploadLocalToCloud() {
            const localState = this.getLocalState();
            const localHistory = this.getLocalHistory();
            if (!localState) {
                alert('No local records to upload.');
                return;
            }
            updateSyncBadge('syncing', 'Uploading local data...');
            await apiRequest('/api/migrate', {
                method: 'POST',
                body: JSON.stringify({ localState, localHistory, overwrite: true })
            });
            showNotificationToast('✅ Local data uploaded to your cloud account!');
            const fresh = await this.getState();
            if (fresh) notify('stateUpdated', fresh);
        }
    };

    // --- TOAST & UI NOTIFICATION HELPERS ---
    function showNotificationToast(msg) {
        let toast = document.getElementById('pipeline-cloud-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'pipeline-cloud-toast';
            toast.style.cssText = `
                position: fixed;
                bottom: 24px;
                right: 24px;
                background: #1a3a8a;
                color: #fff;
                padding: 12px 22px;
                border-radius: 999px;
                box-shadow: 0 8px 24px rgba(26,58,138,0.35);
                font-family: 'Patrick Hand', cursive, sans-serif;
                font-size: 17px;
                z-index: 99999;
                transition: opacity 0.3s ease, transform 0.3s ease;
                display: flex;
                align-items: center;
                gap: 10px;
            `;
            document.body.appendChild(toast);
        }
        toast.textContent = msg;
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(10px)';
        }, 4000);
    }

    function updateSyncBadge(status, text) {
        const badge = document.getElementById('cloud-sync-badge');
        if (!badge) return;

        let dotColor = '#10b981'; // green
        if (status === 'syncing') dotColor = '#3b82f6'; // blue
        else if (status === 'warning') dotColor = '#f59e0b'; // amber
        else if (status === 'offline' || status === 'local') dotColor = '#6b7280'; // gray

        badge.innerHTML = `<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${dotColor}; margin-right:6px; animation:${status === 'syncing' ? 'pulse 1s infinite' : 'none'};"></span><span>${text}</span>`;
    }

    // --- UI COMPONENT: ACCOUNT BAR & MODAL INJECTION ---
    function renderAccountWidget() {
        if (document.getElementById('cloud-account-bar')) return;

        const bar = document.createElement('div');
        bar.id = 'cloud-account-bar';
        bar.className = 'no-print';
        bar.style.cssText = `
            max-width: 1200px;
            margin: 0 auto 14px;
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 12px;
            font-family: 'Patrick Hand', cursive, sans-serif;
            font-size: 16px;
        `;

        bar.innerHTML = `
            <div id="cloud-sync-badge" style="display: flex; align-items: center; background: rgba(26,58,138,0.06); border: 1px solid rgba(26,58,138,0.15); padding: 5px 14px; border-radius: 999px; color: #1a3a8a; font-size: 14px;">
                <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#10b981; margin-right:6px;"></span>
                <span>Connecting...</span>
            </div>

            <div id="account-actions" style="display: flex; align-items: center; gap: 8px;">
                <!-- Will be populated dynamically -->
            </div>
        `;

        // Prepend above toolbar or main header
        const header = document.querySelector('.main-header') || document.querySelector('.toolbar') || document.body.firstChild;
        if (header && header.parentNode) {
            header.parentNode.insertBefore(bar, header);
        } else {
            document.body.prepend(bar);
        }

        // Create Auth Modal in DOM
        renderAuthModal();
        updateUi();
    }

    function updateUi() {
        const container = document.getElementById('account-actions');
        if (!container) return;

        if (ApiClient.isLoggedIn()) {
            const user = ApiClient.getUser();
            container.innerHTML = `
                <div style="display:flex; align-items:center; gap:8px; background:#fff; border:1.5px solid #1a3a8a; border-radius:999px; padding:4px 6px 4px 14px; box-shadow:0 2px 8px rgba(26,58,138,0.1);">
                    <span style="color:#1a3a8a; font-weight:bold; display:flex; align-items:center; gap:6px;">
                        <span>👤</span> <span>${escapeHtml(user.username)}</span>
                    </span>
                    <button id="account-sync-btn" title="Force Sync Now" style="background:#e3f3ff; border:none; border-radius:999px; padding:4px 10px; cursor:pointer; color:#1a3a8a; font-family:'Patrick Hand'; font-size:14px; transition:transform 0.15s;">🔄 Sync</button>
                    <button id="account-logout-btn" title="Sign Out" style="background:#ffe6e6; border:none; border-radius:999px; padding:4px 12px; cursor:pointer; color:#b3261e; font-family:'Patrick Hand'; font-size:14px;">Logout</button>
                </div>
            `;

            document.getElementById('account-sync-btn')?.addEventListener('click', async () => {
                showNotificationToast('🔄 Syncing with cloud...');
                const state = await ApiClient.getState();
                if (state) notify('stateUpdated', state);
                showNotificationToast('✅ Cloud sync complete!');
            });

            document.getElementById('account-logout-btn')?.addEventListener('click', () => {
                if (confirm('Are you sure you want to log out?')) {
                    ApiClient.logout(true);
                }
            });
            updateSyncBadge('synced', 'Synced across devices');
        } else {
            container.innerHTML = `
                <button id="open-auth-btn" style="background:#1a3a8a; color:#fff; border:none; border-radius:999px; padding:6px 18px; font-family:'Patrick Hand', cursive; font-size:16px; cursor:pointer; box-shadow:0 2px 8px rgba(26,58,138,0.25); display:flex; align-items:center; gap:6px; transition:transform 0.15s, background 0.15s;">
                    <span>☁️</span> <span>Sign In / Register</span>
                </button>
            `;

            document.getElementById('open-auth-btn')?.addEventListener('click', () => {
                openAuthModal();
            });
            updateSyncBadge('local', 'Offline / Local Mode');
        }
    }

    function renderAuthModal() {
        if (document.getElementById('auth-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'auth-modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(20, 25, 45, 0.65);
            backdrop-filter: blur(4px);
            z-index: 100000;
            display: none;
            align-items: center;
            justify-content: center;
            padding: 16px;
        `;

        overlay.innerHTML = `
            <div id="auth-modal-card" style="background: #fffdf5; border: 2px solid #1a3a8a; border-radius: 20px; box-shadow: 0 16px 40px rgba(0,0,0,0.25); width: 100%; max-width: 420px; padding: 28px 24px; position: relative; font-family: 'Patrick Hand', cursive, sans-serif;">
                <button id="auth-close-btn" style="position: absolute; top: 14px; right: 18px; background: none; border: none; font-size: 24px; cursor: pointer; color: #1a3a8a;">✕</button>

                <div style="text-align: center; margin-bottom: 20px;">
                    <h2 id="auth-modal-title" style="font-family: 'Caveat', cursive; font-size: 34px; color: #1a3a8a; margin: 0 0 6px 0;">Cloud Account</h2>
                    <p id="auth-modal-sub" style="margin: 0; font-size: 16px; color: #5a5030;">Sign in to sync your data across all your phones, tablets, and computers.</p>
                </div>

                <!-- Tabs: Login vs Register -->
                <div style="display: flex; gap: 8px; margin-bottom: 18px; background: #f0e7d0; padding: 4px; border-radius: 999px;">
                    <button id="tab-login" style="flex: 1; padding: 8px; border: none; border-radius: 999px; background: #1a3a8a; color: #fff; font-family: 'Patrick Hand'; font-size: 16px; cursor: pointer;">Sign In</button>
                    <button id="tab-register" style="flex: 1; padding: 8px; border: none; border-radius: 999px; background: transparent; color: #1a3a8a; font-family: 'Patrick Hand'; font-size: 16px; cursor: pointer;">New Account</button>
                </div>

                <div id="auth-error-msg" style="display: none; background: #ffe6e6; border: 1px solid #b3261e; color: #b3261e; padding: 8px 14px; border-radius: 8px; font-size: 14px; margin-bottom: 14px;"></div>

                <form id="auth-form" style="display: flex; flex-direction: column; gap: 14px;">
                    <div>
                        <label style="display: block; font-size: 15px; color: #1a3a8a; margin-bottom: 4px;">Username or Email</label>
                        <input type="text" id="auth-username" required placeholder="e.g. alex2026" autocomplete="username" style="width: 100%; box-sizing: border-box; padding: 10px 14px; border: 1.5px solid #d9c98a; border-radius: 10px; font-family: 'Inter', sans-serif; font-size: 15px; outline: none; background: #fff;" />
                    </div>

                    <div>
                        <label style="display: block; font-size: 15px; color: #1a3a8a; margin-bottom: 4px;">Password</label>
                        <input type="password" id="auth-password" required placeholder="Minimum 6 characters" autocomplete="current-password" style="width: 100%; box-sizing: border-box; padding: 10px 14px; border: 1.5px solid #d9c98a; border-radius: 10px; font-family: 'Inter', sans-serif; font-size: 15px; outline: none; background: #fff;" />
                    </div>

                    <button type="submit" id="auth-submit-btn" style="background: #1a3a8a; color: #fff; border: none; border-radius: 10px; padding: 12px; font-family: 'Patrick Hand', cursive; font-size: 19px; cursor: pointer; transition: transform 0.15s, background 0.15s; margin-top: 6px;">
                        Sign In
                    </button>
                </form>

                <div style="margin-top: 18px; padding-top: 14px; border-top: 1px dashed #d9c98a; font-size: 13px; color: #6b5d2a; text-align: center;">
                    🔒 All data is securely encrypted, isolated per account, and synced in real-time to MongoDB Atlas.
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        let activeTab = 'login';
        const tabLogin = document.getElementById('tab-login');
        const tabRegister = document.getElementById('tab-register');
        const submitBtn = document.getElementById('auth-submit-btn');
        const errDiv = document.getElementById('auth-error-msg');
        const form = document.getElementById('auth-form');

        function setTab(tab) {
            activeTab = tab;
            errDiv.style.display = 'none';
            if (tab === 'login') {
                tabLogin.style.background = '#1a3a8a';
                tabLogin.style.color = '#fff';
                tabRegister.style.background = 'transparent';
                tabRegister.style.color = '#1a3a8a';
                submitBtn.textContent = 'Sign In';
            } else {
                tabRegister.style.background = '#1a3a8a';
                tabRegister.style.color = '#fff';
                tabLogin.style.background = 'transparent';
                tabLogin.style.color = '#1a3a8a';
                submitBtn.textContent = 'Create Cloud Account';
            }
        }

        tabLogin.addEventListener('click', () => setTab('login'));
        tabRegister.addEventListener('click', () => setTab('register'));

        document.getElementById('auth-close-btn').addEventListener('click', () => {
            overlay.style.display = 'none';
        });

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.style.display = 'none';
        });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            errDiv.style.display = 'none';
            submitBtn.disabled = true;
            submitBtn.textContent = 'Connecting...';

            const u = document.getElementById('auth-username').value.trim();
            const p = document.getElementById('auth-password').value;

            try {
                if (activeTab === 'login') {
                    await ApiClient.login(u, p);
                    showNotificationToast(`👋 Welcome back, ${u}!`);
                } else {
                    await ApiClient.register(u, p);
                    showNotificationToast(`🎉 Account created for ${u}!`);
                }
                overlay.style.display = 'none';
                form.reset();
                // Refresh data
                const state = await ApiClient.getState();
                if (state) notify('stateUpdated', state);
            } catch (err) {
                errDiv.textContent = err.message || 'Operation failed. Please try again.';
                errDiv.style.display = 'block';
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = activeTab === 'login' ? 'Sign In' : 'Create Cloud Account';
            }
        });
    }

    function openAuthModal() {
        const overlay = document.getElementById('auth-modal-overlay');
        if (overlay) {
            overlay.style.display = 'flex';
            document.getElementById('auth-username')?.focus();
        }
    }

    function showMigrationModal(localState, localHistory) {
        if (document.getElementById('migration-modal-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'migration-modal-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(20, 25, 45, 0.7);
            backdrop-filter: blur(4px);
            z-index: 100001;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 16px;
        `;

        overlay.innerHTML = `
            <div style="background: #fffdf5; border: 2px solid #1a3a8a; border-radius: 20px; box-shadow: 0 16px 40px rgba(0,0,0,0.25); width: 100%; max-width: 460px; padding: 28px 24px; font-family: 'Patrick Hand', cursive, sans-serif; text-align: center;">
                <h2 style="font-family: 'Caveat', cursive; font-size: 32px; color: #1a3a8a; margin: 0 0 10px 0;">Existing Local Data Found!</h2>
                <p style="font-size: 17px; color: #4a4020; margin-bottom: 22px; line-height: 1.4;">
                    We noticed you have existing pipeline/expense records on this browser. What would you like to do?
                </p>

                <div style="display: flex; flex-direction: column; gap: 12px;">
                    <button id="mig-upload-btn" style="background: #1a3a8a; color: #fff; border: none; border-radius: 12px; padding: 14px; font-family: 'Patrick Hand'; font-size: 18px; cursor: pointer; box-shadow: 0 4px 12px rgba(26,58,138,0.2);">
                        ☁️ Upload Local Data to Cloud (Overwrite Cloud)
                    </button>
                    <button id="mig-keep-cloud-btn" style="background: #e3f3ff; color: #1a3a8a; border: 1.5px solid #1a3a8a; border-radius: 12px; padding: 14px; font-family: 'Patrick Hand'; font-size: 18px; cursor: pointer;">
                        📥 Download Cloud Data (Replace this Device)
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);

        document.getElementById('mig-upload-btn')?.addEventListener('click', async () => {
            overlay.remove();
            await ApiClient.forceUploadLocalToCloud();
        });

        document.getElementById('mig-keep-cloud-btn')?.addEventListener('click', async () => {
            overlay.remove();
            showNotificationToast('📥 Loading cloud records...');
            const fresh = await ApiClient.getState();
            if (fresh) notify('stateUpdated', fresh);
        });
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Auto-initialize on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            renderAccountWidget();
            if (ApiClient.isLoggedIn()) ApiClient.startSync();
        });
    } else {
        renderAccountWidget();
        if (ApiClient.isLoggedIn()) ApiClient.startSync();
    }

    window.ApiClient = ApiClient;
})(window);
