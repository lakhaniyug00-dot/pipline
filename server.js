const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 5000;
const DB_FILE = path.join(__dirname, 'pipeline.db');

// Initialize SQLite database
const db = new DatabaseSync(DB_FILE);

// Enable WAL mode for better concurrency and reliability
try {
    db.exec('PRAGMA journal_mode = WAL;');
} catch (e) {
    console.warn('Could not set WAL mode:', e.message);
}

// Create tables if they do not exist
db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at INTEGER
    );
`);

db.exec(`
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

// Prepared statements for fast operations
const stmtGetKv = db.prepare('SELECT value FROM kv_store WHERE key = ?');
const stmtSetKv = db.prepare('INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)');

const stmtGetHistory = db.prepare('SELECT raw_json FROM history_entries ORDER BY deleted_at DESC');
const stmtInsertHistory = db.prepare(`
    INSERT OR REPLACE INTO history_entries (hid, value, date, col_dates, deleted_at, from_col_idx, from_col_name, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const stmtDeleteHistoryItem = db.prepare('DELETE FROM history_entries WHERE hid = ?');
const stmtClearHistory = db.prepare('DELETE FROM history_entries');

// In-memory list of connected SSE clients for live synchronization
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
        } catch (err) {
            // client disconnected
        }
    });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Server-Sent Events (SSE) for real-time live updates across all tabs and devices
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const clientId = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
    const client = { id: clientId, res };
    sseClients.push(client);

    // Initial greeting & client identification
    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    req.on('close', () => {
        sseClients = sseClients.filter(c => c.id !== clientId);
    });
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        database: 'SQLite',
        activeClients: sseClients.length,
        time: new Date().toISOString()
    });
});

// --- State Endpoints ---
app.get('/api/state', (req, res) => {
    try {
        const row = stmtGetKv.get('main_state');
        if (row && row.value) {
            return res.json({ success: true, data: JSON.parse(row.value) });
        }
        res.json({ success: true, data: null });
    } catch (err) {
        console.error('Error fetching state:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/state', (req, res) => {
    try {
        const { state, senderClientId } = req.body;
        if (!state || typeof state !== 'object') {
            return res.status(400).json({ success: false, error: 'Invalid state object' });
        }
        stmtSetKv.run('main_state', JSON.stringify(state), Date.now());
        broadcast('state_updated', state, senderClientId);
        res.json({ success: true });
    } catch (err) {
        console.error('Error saving state:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Undo Stack Endpoints ---
app.get('/api/undo', (req, res) => {
    try {
        const row = stmtGetKv.get('undo_stack');
        if (row && row.value) {
            return res.json({ success: true, data: JSON.parse(row.value) });
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
        stmtSetKv.run('undo_stack', JSON.stringify(list), Date.now());
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- History Endpoints ---
app.get('/api/history', (req, res) => {
    try {
        const rows = stmtGetHistory.all();
        const history = rows.map(r => JSON.parse(r.raw_json));
        res.json({ success: true, data: history });
    } catch (err) {
        console.error('Error fetching history:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/history', (req, res) => {
    try {
        const { entry, fullHistory, senderClientId } = req.body;
        if (entry && entry.hid) {
            stmtInsertHistory.run(
                entry.hid,
                entry.value || '',
                entry.date || '',
                JSON.stringify(entry.colDates || []),
                entry.deletedAt || Date.now(),
                entry.fromColIdx ?? 0,
                entry.fromColName || '',
                JSON.stringify(entry)
            );
            broadcast('history_item_added', entry, senderClientId);
            return res.json({ success: true });
        }

        if (Array.isArray(fullHistory)) {
            // Replace full history
            stmtClearHistory.run();
            fullHistory.forEach(item => {
                if (item && item.hid) {
                    stmtInsertHistory.run(
                        item.hid,
                        item.value || '',
                        item.date || '',
                        JSON.stringify(item.colDates || []),
                        item.deletedAt || Date.now(),
                        item.fromColIdx ?? 0,
                        item.fromColName || '',
                        JSON.stringify(item)
                    );
                }
            });
            broadcast('history_updated', fullHistory, senderClientId);
            return res.json({ success: true });
        }

        res.status(400).json({ success: false, error: 'Invalid history payload' });
    } catch (err) {
        console.error('Error saving history:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/history/:hid', (req, res) => {
    try {
        const { hid } = req.params;
        const senderClientId = req.query.senderClientId;
        stmtDeleteHistoryItem.run(hid);
        broadcast('history_item_deleted', { hid }, senderClientId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/history', (req, res) => {
    try {
        const senderClientId = req.query.senderClientId;
        stmtClearHistory.run();
        broadcast('history_cleared', {}, senderClientId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Serve frontend static files
app.use(express.static(__dirname));

// Route default / to index1.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index1.html'));
});

// Helper to get local network IP
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

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Pipe Management Dynamic Server running on port ${PORT}`);
    console.log(`📁 Database: SQLite (${DB_FILE})`);
    console.log(`💻 Local access:   http://localhost:${PORT}`);
    const networkIps = getNetworkIps();
    if (networkIps.length > 0) {
        console.log(`📱 Network access: http://${networkIps[0]}:${PORT}`);
    }
    console.log(`⚡ Real-time dynamic sync enabled via Server-Sent Events`);
    console.log(`======================================================\n`);
});
