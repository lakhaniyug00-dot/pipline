// ===== Unified Real-Time API Client for Pipe Management =====
// Connects to Node.js + SQLite backend with fallback to localStorage and real-time SSE syncing

(function (window) {
    const STORAGE_KEY = 'data-tracker-v2';
    const HISTORY_KEY = 'data-tracker-deleted-history';
    const UNDO_KEY = 'data-tracker-undo-stack';

    // Auto-detect backend base URL
    let baseUrl = window.location.origin;
    if (!baseUrl || baseUrl === 'null' || window.location.protocol === 'file:') {
        baseUrl = 'http://localhost:5000';
    }

    let clientId = null;
    let isConnected = false;
    let eventSource = null;
    const eventListeners = new Set();
    const statusListeners = new Set();

    // Visual connection indicator in toolbar
    function renderStatusBadge() {
        let badge = document.getElementById('server-status-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'server-status-badge';
            badge.className = 'server-status-badge no-print';

            // Find toolbar or insert at top
            const toolbar = document.querySelector('.toolbar') || document.querySelector('.hist-toolbar');
            if (toolbar) {
                // insert after first child or at end
                toolbar.appendChild(badge);
            } else {
                document.body.prepend(badge);
            }
        }

        if (isConnected) {
            badge.innerHTML = `
                <span class="badge-dot online"></span>
                <span class="badge-text">Live Sync</span>
            `;
            badge.title = `Connected to SQLite Backend Server (${baseUrl})\nReal-time multi-device sync is ACTIVE`;
            badge.setAttribute('data-status', 'online');
        } else {
            badge.innerHTML = `
                <span class="badge-dot offline"></span>
                <span class="badge-text">Local Mode</span>
            `;
            badge.title = `Server not connected. Data saved in browser storage.\nRun 'npm start' in terminal to enable multi-device sync!`;
            badge.setAttribute('data-status', 'offline');
        }
    }

    function setConnectionStatus(connected) {
        if (isConnected !== connected) {
            isConnected = connected;
            renderStatusBadge();
            statusListeners.forEach(fn => fn(connected));
        }
    }

    // Connect to SSE for real-time live events across devices/tabs
    function connectSSE() {
        if (eventSource) {
            eventSource.close();
        }

        try {
            eventSource = new EventSource(`${baseUrl}/api/events`);

            eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.type === 'connected') {
                        clientId = data.clientId;
                        setConnectionStatus(true);
                        return;
                    }

                    // Ignore events that originated from this same client tab
                    if (data.senderClientId && data.senderClientId === clientId) {
                        return;
                    }

                    // Notify subscribers of remote updates
                    eventListeners.forEach(listener => {
                        try {
                            listener(data);
                        } catch (e) {
                            console.error('Error in event listener:', e);
                        }
                    });
                } catch (err) {
                    console.error('Error parsing SSE message:', err);
                }
            };

            eventSource.onerror = () => {
                setConnectionStatus(false);
                if (eventSource) {
                    eventSource.close();
                    eventSource = null;
                }
                // Retry connection after 5 seconds
                setTimeout(connectSSE, 5000);
            };

            eventSource.onopen = () => {
                setConnectionStatus(true);
            };
        } catch (e) {
            setConnectionStatus(false);
            setTimeout(connectSSE, 5000);
        }
    }

    // API Client methods
    const ApiClient = {
        get isOnline() {
            return isConnected;
        },
        get clientId() {
            return clientId;
        },

        onStatusChange(fn) {
            statusListeners.add(fn);
        },

        onEvent(fn) {
            eventListeners.add(fn);
        },

        // --- State Operations ---
        async getState() {
            // First try loading from server
            try {
                const res = await fetch(`${baseUrl}/api/state`, { cache: 'no-store' });
                if (res.ok) {
                    const json = await res.json();
                    setConnectionStatus(true);
                    if (json.data && Array.isArray(json.data.columns) && json.data.columns.length > 0) {
                        // Update local cache
                        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(json.data)); } catch (e) { }
                        return json.data;
                    }

                    // If server has no state yet, check if there's local state to migrate to server
                    const localRaw = localStorage.getItem(STORAGE_KEY);
                    if (localRaw) {
                        try {
                            const localParsed = JSON.parse(localRaw);
                            if (localParsed && Array.isArray(localParsed.columns) && localParsed.columns.length > 0) {
                                // Upload local data to server
                                await this.saveState(localParsed);
                                return localParsed;
                            }
                        } catch (e) { }
                    }
                }
            } catch (err) {
                setConnectionStatus(false);
            }

            // Fallback to local storage
            try {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && Array.isArray(parsed.columns) && parsed.columns.length > 0) {
                        return parsed;
                    }
                }
            } catch (e) { }

            return null;
        },

        async saveState(state) {
            // Save to localStorage immediately
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { }

            // Sync to server
            try {
                await fetch(`${baseUrl}/api/state`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ state, senderClientId: clientId })
                });
                setConnectionStatus(true);
            } catch (err) {
                setConnectionStatus(false);
            }
        },

        // --- Undo Stack Operations ---
        async getUndoStack() {
            try {
                const res = await fetch(`${baseUrl}/api/undo`, { cache: 'no-store' });
                if (res.ok) {
                    const json = await res.json();
                    if (Array.isArray(json.data)) {
                        try { localStorage.setItem(UNDO_KEY, JSON.stringify(json.data)); } catch (e) { }
                        return json.data;
                    }
                }
            } catch (err) { }

            try {
                const raw = localStorage.getItem(UNDO_KEY);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) return parsed;
                }
            } catch (e) { }
            return [];
        },

        async saveUndoStack(undoStack) {
            try { localStorage.setItem(UNDO_KEY, JSON.stringify(undoStack)); } catch (e) { }
            try {
                await fetch(`${baseUrl}/api/undo`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ undoStack })
                });
            } catch (err) { }
        },

        // --- History Operations ---
        async getHistory() {
            try {
                const res = await fetch(`${baseUrl}/api/history`, { cache: 'no-store' });
                if (res.ok) {
                    const json = await res.json();
                    setConnectionStatus(true);
                    if (Array.isArray(json.data)) {
                        // If server history is empty but local has data, migrate up
                        if (json.data.length === 0) {
                            const localRaw = localStorage.getItem(HISTORY_KEY);
                            if (localRaw) {
                                try {
                                    const localHistory = JSON.parse(localRaw);
                                    if (Array.isArray(localHistory) && localHistory.length > 0) {
                                        await this.saveHistory(localHistory);
                                        return localHistory;
                                    }
                                } catch (e) { }
                            }
                        }
                        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(json.data)); } catch (e) { }
                        return json.data;
                    }
                }
            } catch (err) {
                setConnectionStatus(false);
            }

            try {
                const raw = localStorage.getItem(HISTORY_KEY);
                return raw ? JSON.parse(raw) : [];
            } catch (e) {
                return [];
            }
        },

        async saveDeletedItem(entry) {
            // Update local storage
            try {
                const raw = localStorage.getItem(HISTORY_KEY);
                const history = raw ? JSON.parse(raw) : [];
                history.unshift(entry);
                localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            } catch (e) { }

            // Sync to server
            try {
                await fetch(`${baseUrl}/api/history`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ entry, senderClientId: clientId })
                });
                setConnectionStatus(true);
            } catch (err) {
                setConnectionStatus(false);
            }
        },

        async saveHistory(fullHistory) {
            try { localStorage.setItem(HISTORY_KEY, JSON.stringify(fullHistory)); } catch (e) { }
            try {
                await fetch(`${baseUrl}/api/history`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fullHistory, senderClientId: clientId })
                });
                setConnectionStatus(true);
            } catch (err) {
                setConnectionStatus(false);
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

            try {
                await fetch(`${baseUrl}/api/history/${encodeURIComponent(hid)}?senderClientId=${encodeURIComponent(clientId || '')}`, {
                    method: 'DELETE'
                });
                setConnectionStatus(true);
            } catch (err) {
                setConnectionStatus(false);
            }
        },

        async clearHistory() {
            try { localStorage.removeItem(HISTORY_KEY); } catch (e) { }
            try {
                await fetch(`${baseUrl}/api/history?senderClientId=${encodeURIComponent(clientId || '')}`, {
                    method: 'DELETE'
                });
                setConnectionStatus(true);
            } catch (err) {
                setConnectionStatus(false);
            }
        }
    };

    // Auto-init on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            renderStatusBadge();
            connectSSE();
        });
    } else {
        renderStatusBadge();
        connectSSE();
    }

    window.ApiClient = ApiClient;
})(window);
