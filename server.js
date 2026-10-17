const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 5000;
const isVercel = Boolean(process.env.VERCEL);

// In Vercel serverless functions, writable storage is in /tmp
const DATA_DIR = isVercel ? '/tmp' : __dirname;
const DB_FILE = path.join(DATA_DIR, 'pipeline.db');
const JSON_FILE = path.join(DATA_DIR, 'pipeline.json');

let storageType = 'json';
let dbInstance = null;
let jsonStore = { kv: {}, history: [] };

// Try loading SQLite via built-in node:sqlite
try {
    const { DatabaseSync } = require('node:sqlite');
    dbInstance = new DatabaseSync(DB_FILE);
    try {
        dbInstance.exec('PRAGMA journal_mode = WAL;');
    } catch (e) { }

    dbInstance.exec(`
        CREATE TABLE IF NOT EXISTS kv_store (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at INTEGER
        );
    `);

    dbInstance.exec(`
        CREATE TABLE IF NOT EXISTS history_entries (
            hid TEXT PRIMARY KEY,
            value TEXT,
            date TEXT,
            col_dates TEXT,
            deleted_at INTEGER,
            from_col_idx INTEGER,
            from_col_name TEXT,
            raw_json TEXT
        );
    `);

    storageType = 'sqlite';
} catch (err) {
    storageType = 'json';
    try {
        if (fs.existsSync(JSON_FILE)) {
            const raw = fs.readFileSync(JSON_FILE, 'utf8');
            jsonStore = JSON.parse(raw);
        }
    } catch (e) { }
}

function saveJsonStore() {
    try {
        fs.writeFileSync(JSON_FILE, JSON.stringify(jsonStore, null, 2), 'utf8');
    } catch (e) { }
}

// Storage Operations
const db = {
    getKv(key) {
        if (storageType === 'sqlite' && dbInstance) {
            const stmt = dbInstance.prepare('SELECT value FROM kv_store WHERE key = ?');
            const row = stmt.get(key);
            return row ? row.value : null;
        }
        return jsonStore.kv[key] || null;
    },

    setKv(key, value) {
        if (storageType === 'sqlite' && dbInstance) {
            const stmt = dbInstance.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)');
            stmt.run(key, value, Date.now());
        } else {
            jsonStore.kv[key] = value;
            saveJsonStore();
        }
    },

    getHistory() {
        if (storageType === 'sqlite' && dbInstance) {
            const stmt = dbInstance.prepare('SELECT raw_json FROM history_entries ORDER BY deleted_at DESC');
            const rows = stmt.all();
            return rows.map(r => JSON.parse(r.raw_json));
        }
        return jsonStore.history || [];
    },

    insertHistory(entry) {
        if (storageType === 'sqlite' && dbInstance) {
            const stmt = dbInstance.prepare(`
                INSERT OR REPLACE INTO history_entries (hid, value, date, col_dates, deleted_at, from_col_idx, from_col_name, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(
                entry.hid,
                entry.value || '',
                entry.date || '',
                JSON.stringify(entry.colDates || []),
                entry.deletedAt || Date.now(),
                entry.fromColIdx ?? 0,
                entry.fromColName || '',
                JSON.stringify(entry)
            );
        } else {
            jsonStore.history = (jsonStore.history || []).filter(h => h.hid !== entry.hid);
            jsonStore.history.unshift(entry);
            saveJsonStore();
        }
    },

    replaceFullHistory(list) {
        if (storageType === 'sqlite' && dbInstance) {
            dbInstance.exec('DELETE FROM history_entries');
            const stmt = dbInstance.prepare(`
                INSERT OR REPLACE INTO history_entries (hid, value, date, col_dates, deleted_at, from_col_idx, from_col_name, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            (list || []).forEach(entry => {
                stmt.run(
                    entry.hid,
                    entry.value || '',
                    entry.date || '',
                    JSON.stringify(entry.colDates || []),
                    entry.deletedAt || Date.now(),
                    entry.fromColIdx ?? 0,
                    entry.fromColName || '',
                    JSON.stringify(entry)
                );
            });
        } else {
            jsonStore.history = Array.isArray(list) ? list : [];
            saveJsonStore();
        }
    },

    deleteHistoryItem(hid) {
        if (storageType === 'sqlite' && dbInstance) {
            const stmt = dbInstance.prepare('DELETE FROM history_entries WHERE hid = ?');
            stmt.run(hid);
        } else {
            jsonStore.history = (jsonStore.history || []).filter(h => h.hid !== hid);
            saveJsonStore();
        }
    },

    clearHistory() {
        if (storageType === 'sqlite' && dbInstance) {
            dbInstance.exec('DELETE FROM history_entries');
        } else {
            jsonStore.history = [];
            saveJsonStore();
        }
    }
};

// In-memory list of connected SSE clients
let sseClients = [];

function broadcast(eventType, payload, senderClientId = null) {
    const message = JSON.stringify({
        type: eventType,
        payload,
        senderClientId,
        timestamp: Date.now()
    });

    sseClients.forEach(client => {
        try {
            client.res.write(`data: ${message}\n\n`);
        } catch (err) { }
    });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Server-Sent Events (SSE) for live sync
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const clientId = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const client = { id: clientId, res };
    sseClients.push(client);

    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        storage: storageType,
        isVercel,
        activeClients: sseClients.length,
        time: new Date().toISOString()
    });
});

// --- State Endpoints ---
app.get('/api/state', (req, res) => {
    try {
        const raw = db.getKv('main_state');
        if (raw) {
            return res.json({ success: true, data: JSON.parse(raw) });
        }
        res.json({ success: true, data: null });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/state', (req, res) => {
    try {
        const { state, senderClientId } = req.body;
        if (!state || typeof state !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid state object' });
        }
        db.setKv('main_state', JSON.stringify(state));
        broadcast('state_updated', state, senderClientId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Undo Stack Endpoints ---
app.get('/api/undo', (req, res) => {
    try {
        const raw = db.getKv('undo_stack');
        if (raw) {
            return res.json({ success: true, data: JSON.parse(raw) });
        }
        res.json({ success: true, data: [] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/undo', (req, res) => {
    try {
        const { undoStack } = req.body;
        const list = Array.isArray(undoStack) ? undoStack : [];
        db.setKv('undo_stack', JSON.stringify(list));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- History Endpoints ---
app.get('/api/history', (req, res) => {
    try {
        const history = db.getHistory();
        res.json({ success: true, data: history });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/history', (req, res) => {
    try {
        const { entry, fullHistory, senderClientId } = req.body;
        if (entry && entry.hid) {
            db.insertHistory(entry);
            broadcast('history_item_added', entry, senderClientId);
            return res.json({ success: true });
        }

        if (Array.isArray(fullHistory)) {
            db.replaceFullHistory(fullHistory);
            broadcast('history_updated', fullHistory, senderClientId);
            return res.json({ success: true });
        }

        res.status(400).json({ success: false, error: 'Invalid history payload' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/history/:hid', (req, res) => {
    try {
        const { hid } = req.params;
        const senderClientId = req.query.senderClientId;
        db.deleteHistoryItem(hid);
        broadcast('history_item_deleted', { hid }, senderClientId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/history', (req, res) => {
    try {
        const senderClientId = req.query.senderClientId;
        db.clearHistory();
        broadcast('history_cleared', {}, senderClientId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Serve frontend static files
app.use(express.static(__dirname));

// Route default / to index.html or index1.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Only start the local server if not running in Vercel serverless environment
if (!isVercel && require.main === module) {
    function getNetworkIps() {
        const interfaces = os.networkInterfaces();
        const ips = [];
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    ips.push(iface.address);
                }
            }
        }
        return ips;
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n======================================================`);
        console.log(`🚀 Pipe Management Server running on port ${PORT}`);
        console.log(`📁 Storage: ${storageType.toUpperCase()} (${DATA_DIR})`);
        console.log(`💻 Local:   http://localhost:${PORT}`);
        const networkIps = getNetworkIps();
        if (networkIps.length > 0) {
            console.log(`📱 Network: http://${networkIps[0]}:${PORT}`);
        }
        console.log(`⚡ Real-time dynamic sync enabled`);
        console.log(`======================================================\n`);
    });
}

module.exports = app;
