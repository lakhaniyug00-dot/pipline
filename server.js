require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const { connectToDatabase, isDbConnected } = require('./lib/db');
const User = require('./models/User');
const PipelineData = require('./models/PipelineData');
const HistoryEntry = require('./models/HistoryEntry');
const { requireAuth, generateToken } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 5000;
const isVercel = Boolean(process.env.VERCEL);

// Middlewares
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ==================== FALLBACK STORAGE ENGINE ====================
// Used if MONGODB_URI is not configured yet, so accounts & sync work immediately!
const FALLBACK_DIR = isVercel ? '/tmp' : __dirname;
const FALLBACK_FILE = path.join(FALLBACK_DIR, 'local_pipeline_cloud.json');

let memoryStore = {
    users: [],
    pipelines: {},
    history: []
};

function loadFallbackStore() {
    try {
        if (fs.existsSync(FALLBACK_FILE)) {
            const raw = fs.readFileSync(FALLBACK_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                memoryStore.users = Array.isArray(parsed.users) ? parsed.users : [];
                memoryStore.pipelines = parsed.pipelines && typeof parsed.pipelines === 'object' ? parsed.pipelines : {};
                memoryStore.history = Array.isArray(parsed.history) ? parsed.history : [];
            }
        }
    } catch (e) { }
}

function saveFallbackStore() {
    try {
        fs.writeFileSync(FALLBACK_FILE, JSON.stringify(memoryStore, null, 2), 'utf8');
    } catch (e) { }
}
loadFallbackStore();

// Database attachment middleware
async function ensureDb(req, res, next) {
    if (process.env.MONGODB_URI) {
        try {
            await connectToDatabase();
            req.useMongo = true;
            return next();
        } catch (err) {
            console.warn('MongoDB Atlas connection failed, using fallback cloud store:', err.message);
            req.useMongo = false;
            return next();
        }
    } else {
        req.useMongo = false;
        return next();
    }
}

// ==================== HEALTH & DIAGNOSTICS ====================
app.get(['/api/health', '/health'], async (req, res) => {
    let dbStatus = 'fallback_cloud';
    let dbError = null;

    if (process.env.MONGODB_URI) {
        try {
            await connectToDatabase();
            dbStatus = 'connected_mongodb_atlas';
        } catch (err) {
            dbStatus = 'mongodb_error_using_fallback';
            dbError = err.message;
        }
    } else {
        dbStatus = 'fallback_cloud_ready';
    }

    res.json({
        status: 'ok',
        database: dbStatus,
        dbError,
        isVercel,
        hasMongoUri: Boolean(process.env.MONGODB_URI),
        timestamp: new Date().toISOString()
    });
});

// ==================== AUTHENTICATION ROUTES ====================
function validateRegisterInput(req, res, next) {
    const { username, password } = req.body || {};
    if (!username || typeof username !== 'string') {
        return res.status(400).json({ success: false, error: 'Username is required.' });
    }
    if (!password || typeof password !== 'string') {
        return res.status(400).json({ success: false, error: 'Password is required.' });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername.length < 3) {
        return res.status(400).json({ success: false, error: 'Username must be at least 3 characters long.' });
    }
    if (cleanUsername.length > 40) {
        return res.status(400).json({ success: false, error: 'Username cannot exceed 40 characters.' });
    }
    if (!/^[a-zA-Z0-9_\-\.@]+$/.test(cleanUsername)) {
        return res.status(400).json({ success: false, error: 'Username can only contain letters, numbers, _, -, ., @' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long.' });
    }
    req.cleanUsername = cleanUsername;
    next();
}

function validateLoginInput(req, res, next) {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Please enter both username and password.' });
    }
    req.cleanUsername = String(username).trim().toLowerCase();
    next();
}

// Register new account
app.post(['/api/auth/register', '/auth/register'], validateRegisterInput, ensureDb, async (req, res) => {
    try {
        const { password } = req.body;
        const cleanUsername = req.cleanUsername;

        if (req.useMongo) {
            const existing = await User.findOne({ username: cleanUsername });
            if (existing) {
                return res.status(409).json({ success: false, error: 'An account with this username already exists.' });
            }

            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash(password, salt);

            const newUser = await User.create({
                username: cleanUsername,
                passwordHash
            });

            await PipelineData.create({
                userId: newUser._id,
                columns: [{ name: '', items: [] }],
                undoStack: [],
                version: 1
            });

            const token = generateToken(newUser);

            return res.status(201).json({
                success: true,
                message: 'Account created successfully!',
                token,
                user: { id: newUser._id.toString(), username: newUser.username }
            });
        } else {
            // Fallback storage
            const existing = memoryStore.users.find(u => u.username === cleanUsername);
            if (existing) {
                return res.status(409).json({ success: false, error: 'An account with this username already exists.' });
            }

            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash(password, salt);
            const newId = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);

            const newUser = {
                _id: newId,
                username: cleanUsername,
                passwordHash,
                createdAt: new Date()
            };

            memoryStore.users.push(newUser);
            memoryStore.pipelines[newId] = {
                userId: newId,
                columns: [{ name: '', items: [] }],
                undoStack: [],
                version: 1,
                updatedAt: new Date()
            };
            saveFallbackStore();

            const token = generateToken(newUser);

            return res.status(201).json({
                success: true,
                message: 'Account created successfully!',
                token,
                user: { id: newUser._id, username: newUser.username }
            });
        }
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ success: false, error: 'Failed to create account. ' + err.message });
    }
});

// Login
app.post(['/api/auth/login', '/auth/login'], validateLoginInput, ensureDb, async (req, res) => {
    try {
        const { password } = req.body;
        const cleanUsername = req.cleanUsername;

        if (req.useMongo) {
            const user = await User.findOne({ username: cleanUsername });
            if (!user) {
                return res.status(401).json({ success: false, error: 'Invalid username or password.' });
            }

            const isMatch = await bcrypt.compare(password, user.passwordHash);
            if (!isMatch) {
                return res.status(401).json({ success: false, error: 'Invalid username or password.' });
            }

            const token = generateToken(user);

            return res.json({
                success: true,
                message: 'Signed in successfully!',
                token,
                user: { id: user._id.toString(), username: user.username }
            });
        } else {
            // Fallback storage
            const user = memoryStore.users.find(u => u.username === cleanUsername);
            if (!user) {
                return res.status(401).json({ success: false, error: 'Invalid username or password.' });
            }

            const isMatch = await bcrypt.compare(password, user.passwordHash);
            if (!isMatch) {
                return res.status(401).json({ success: false, error: 'Invalid username or password.' });
            }

            const token = generateToken(user);

            return res.json({
                success: true,
                message: 'Signed in successfully!',
                token,
                user: { id: user._id, username: user.username }
            });
        }
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, error: 'Sign in failed. ' + err.message });
    }
});

// Get Current User Profile
app.get(['/api/auth/me', '/auth/me'], requireAuth, ensureDb, async (req, res) => {
    try {
        if (req.useMongo) {
            const user = await User.findById(req.user.userId).select('username createdAt');
            if (!user) {
                return res.status(404).json({ success: false, error: 'User not found.' });
            }
            return res.json({
                success: true,
                user: { id: user._id.toString(), username: user.username, createdAt: user.createdAt }
            });
        } else {
            const user = memoryStore.users.find(u => u._id === req.user.userId);
            if (!user) {
                return res.status(404).json({ success: false, error: 'User not found.' });
            }
            return res.json({
                success: true,
                user: { id: user._id, username: user.username, createdAt: user.createdAt }
            });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== MULTI-ACCOUNT QUICK SWITCHER & MANAGEMENT ====================
// Get all available accounts
app.get(['/api/auth/accounts', '/api/accounts'], ensureDb, async (req, res) => {
    try {
        let accounts = [];
        if (req.useMongo) {
            const users = await User.find({}).sort({ createdAt: 1 }).select('username createdAt');
            accounts = users.map(u => ({ username: u.username, createdAt: u.createdAt }));
        } else {
            accounts = (memoryStore.users || []).map(u => ({ username: u.username, createdAt: u.createdAt }));
        }
        // Always ensure 'valam' is available
        const hasValam = accounts.some(a => (a.username || '').toLowerCase() === 'valam');
        if (!hasValam) {
            accounts.unshift({ username: 'valam' });
        }
        res.json({ success: true, accounts });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Quick select / create account without password (1-click account access)
app.post(['/api/auth/select', '/api/auth/quick-login'], ensureDb, async (req, res) => {
    try {
        const rawUname = (req.body.username || '').trim();
        if (!rawUname) {
            return res.status(400).json({ success: false, error: 'Username is required.' });
        }
        const cleanUsername = rawUname.toLowerCase();

        if (req.useMongo) {
            let user = await User.findOne({ username: cleanUsername });
            if (!user) {
                const salt = await bcrypt.genSalt(10);
                const passwordHash = await bcrypt.hash('ValamPass123!', salt);
                user = await User.create({
                    username: cleanUsername,
                    passwordHash
                });
                await PipelineData.create({
                    userId: user._id,
                    columns: [{ name: '', items: [] }],
                    undoStack: [],
                    version: 1
                });
            }
            const token = generateToken(user);
            return res.json({
                success: true,
                token,
                user: { id: user._id.toString(), username: user.username }
            });
        } else {
            let user = (memoryStore.users || []).find(u => u.username === cleanUsername);
            if (!user) {
                const salt = await bcrypt.genSalt(10);
                const passwordHash = await bcrypt.hash('ValamPass123!', salt);
                const newId = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
                user = {
                    _id: newId,
                    username: cleanUsername,
                    passwordHash,
                    createdAt: new Date()
                };
                memoryStore.users.push(user);
                memoryStore.pipelines[newId] = {
                    userId: newId,
                    columns: [{ name: '', items: [] }],
                    undoStack: [],
                    version: 1,
                    updatedAt: new Date()
                };
                saveFallbackStore();
            }
            const token = generateToken(user);
            return res.json({
                success: true,
                token,
                user: { id: user._id, username: user.username }
            });
        }
    } catch (err) {
        console.error('Account select error:', err);
        res.status(500).json({ success: false, error: 'Failed to select account: ' + err.message });
    }
});

// Delete account
app.delete(['/api/auth/accounts/:username', '/api/accounts/:username'], ensureDb, async (req, res) => {
    try {
        const cleanUsername = String(req.params.username || '').trim().toLowerCase();
        if (!cleanUsername) return res.status(400).json({ success: false, error: 'Username required' });

        if (req.useMongo) {
            const user = await User.findOne({ username: cleanUsername });
            if (user) {
                await PipelineData.deleteOne({ userId: user._id });
                await HistoryEntry.deleteMany({ userId: user._id });
                await User.deleteOne({ _id: user._id });
            }
        } else {
            const user = (memoryStore.users || []).find(u => u.username === cleanUsername);
            if (user) {
                delete memoryStore.pipelines[user._id];
                if (memoryStore.history && memoryStore.history[user._id]) delete memoryStore.history[user._id];
                memoryStore.users = memoryStore.users.filter(u => u._id !== user._id);
                saveFallbackStore();
            }
        }
        res.json({ success: true, message: 'Account deleted' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== PIPELINE / EXPENSE STATE ROUTES ====================
// Get current user's state
app.get(['/api/state', '/state'], requireAuth, ensureDb, async (req, res) => {
    try {
        if (req.useMongo) {
            let doc = await PipelineData.findOne({ userId: req.user.userId });
            if (!doc) {
                doc = await PipelineData.create({
                    userId: req.user.userId,
                    columns: [{ name: '', items: [] }],
                    undoStack: [],
                    version: 1
                });
            }

            return res.json({
                success: true,
                data: {
                    columns: doc.columns || [{ name: '', items: [] }],
                    undoStack: doc.undoStack || [],
                    version: doc.version || 1,
                    updatedAt: doc.updatedAt
                }
            });
        } else {
            let doc = memoryStore.pipelines[req.user.userId];
            if (!doc) {
                doc = memoryStore.pipelines[req.user.userId] = {
                    userId: req.user.userId,
                    columns: [{ name: '', items: [] }],
                    undoStack: [],
                    version: 1,
                    updatedAt: new Date()
                };
                saveFallbackStore();
            }

            return res.json({
                success: true,
                data: {
                    columns: doc.columns || [{ name: '', items: [] }],
                    undoStack: doc.undoStack || [],
                    version: doc.version || 1,
                    updatedAt: doc.updatedAt
                }
            });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to retrieve state: ' + err.message });
    }
});

// Save current user's state
app.post(['/api/state', '/state'], requireAuth, ensureDb, async (req, res) => {
    try {
        const { state, undoStack, senderDeviceId } = req.body;

        if (!state || !Array.isArray(state.columns)) {
            return res.status(400).json({ success: false, error: 'Invalid state format. Columns array is required.' });
        }

        const cleanColumns = state.columns.map((col, idx) => ({
            name: typeof col.name === 'string' ? col.name : `Column ${idx + 1}`,
            items: Array.isArray(col.items) ? col.items.map(item => ({
                id: item.id || ('i_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)),
                value: String(item.value || '').trim(),
                date: String(item.date || '').trim(),
                moved: Boolean(item.moved),
                colDates: Array.isArray(item.colDates) ? item.colDates : []
            })) : []
        }));

        const cleanUndo = Array.isArray(undoStack) ? undoStack.slice(-50) : undefined;

        if (req.useMongo) {
            const updateData = {
                columns: cleanColumns,
                updatedAt: new Date(),
                lastUpdatedByDevice: senderDeviceId || ''
            };

            if (cleanUndo !== undefined) {
                updateData.undoStack = cleanUndo;
            }

            const doc = await PipelineData.findOneAndUpdate(
                { userId: req.user.userId },
                {
                    $set: updateData,
                    $inc: { version: 1 }
                },
                { new: true, upsert: true }
            );

            return res.json({
                success: true,
                version: doc.version,
                updatedAt: doc.updatedAt
            });
        } else {
            let doc = memoryStore.pipelines[req.user.userId] || {
                userId: req.user.userId,
                version: 0
            };

            doc.columns = cleanColumns;
            if (cleanUndo !== undefined) doc.undoStack = cleanUndo;
            doc.version = (doc.version || 0) + 1;
            doc.updatedAt = new Date();
            doc.lastUpdatedByDevice = senderDeviceId || '';

            memoryStore.pipelines[req.user.userId] = doc;
            saveFallbackStore();

            return res.json({
                success: true,
                version: doc.version,
                updatedAt: doc.updatedAt
            });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save state: ' + err.message });
    }
});

// Real-time synchronization heartbeat / check
app.get(['/api/sync-status', '/sync-status'], requireAuth, ensureDb, async (req, res) => {
    try {
        if (req.useMongo) {
            const doc = await PipelineData.findOne({ userId: req.user.userId })
                .select('version updatedAt lastUpdatedByDevice');

            if (!doc) {
                return res.json({ success: true, version: 1, updatedAt: new Date(), lastUpdatedByDevice: '' });
            }

            return res.json({
                success: true,
                version: doc.version || 1,
                updatedAt: doc.updatedAt,
                lastUpdatedByDevice: doc.lastUpdatedByDevice || ''
            });
        } else {
            const doc = memoryStore.pipelines[req.user.userId];
            if (!doc) {
                return res.json({ success: true, version: 1, updatedAt: new Date(), lastUpdatedByDevice: '' });
            }

            return res.json({
                success: true,
                version: doc.version || 1,
                updatedAt: doc.updatedAt,
                lastUpdatedByDevice: doc.lastUpdatedByDevice || ''
            });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Undo stack operations
app.get(['/api/undo', '/undo'], requireAuth, ensureDb, async (req, res) => {
    try {
        if (req.useMongo) {
            const doc = await PipelineData.findOne({ userId: req.user.userId }).select('undoStack');
            return res.json({ success: true, data: doc && doc.undoStack ? doc.undoStack : [] });
        } else {
            const doc = memoryStore.pipelines[req.user.userId];
            return res.json({ success: true, data: doc && doc.undoStack ? doc.undoStack : [] });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post(['/api/undo', '/undo'], requireAuth, ensureDb, async (req, res) => {
    try {
        const { undoStack } = req.body;
        const list = Array.isArray(undoStack) ? undoStack.slice(-50) : [];

        if (req.useMongo) {
            await PipelineData.findOneAndUpdate(
                { userId: req.user.userId },
                { $set: { undoStack: list } },
                { upsert: true }
            );
        } else {
            let doc = memoryStore.pipelines[req.user.userId];
            if (!doc) {
                doc = memoryStore.pipelines[req.user.userId] = { userId: req.user.userId, version: 1 };
            }
            doc.undoStack = list;
            saveFallbackStore();
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== HISTORY ROUTES (DELETED ITEMS) ====================
// Get deleted history entries
app.get('/api/history', requireAuth, ensureDb, async (req, res) => {
    try {
        if (req.useMongo) {
            const entries = await HistoryEntry.find({ userId: req.user.userId })
                .sort({ deletedAt: -1 })
                .limit(300);

            const formatted = entries.map(e => ({
                hid: e.hid,
                value: e.value,
                date: e.date,
                colDates: e.colDates,
                deletedAt: e.deletedAt,
                fromColIdx: e.fromColIdx,
                fromColName: e.fromColName,
                rawJson: e.rawJson
            }));

            return res.json({ success: true, data: formatted });
        } else {
            const list = memoryStore.history
                .filter(e => e.userId === req.user.userId)
                .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0))
                .slice(0, 300);

            return res.json({ success: true, data: list });
        }
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch history: ' + err.message });
    }
});

// Save history entry (single or batch)
app.post('/api/history', requireAuth, ensureDb, async (req, res) => {
    try {
        const { entry, fullHistory } = req.body;

        if (entry && entry.hid) {
            if (req.useMongo) {
                await HistoryEntry.findOneAndUpdate(
                    { userId: req.user.userId, hid: entry.hid },
                    {
                        $set: {
                            userId: req.user.userId,
                            hid: entry.hid,
                            value: String(entry.value || ''),
                            date: String(entry.date || ''),
                            colDates: Array.isArray(entry.colDates) ? entry.colDates : [],
                            deletedAt: Number(entry.deletedAt) || Date.now(),
                            fromColIdx: Number(entry.fromColIdx) || 0,
                            fromColName: String(entry.fromColName || ''),
                            rawJson: entry
                        }
                    },
                    { upsert: true, new: true }
                );
            } else {
                memoryStore.history = memoryStore.history.filter(
                    e => !(e.userId === req.user.userId && e.hid === entry.hid)
                );
                memoryStore.history.unshift({
                    userId: req.user.userId,
                    hid: entry.hid,
                    value: String(entry.value || ''),
                    date: String(entry.date || ''),
                    colDates: Array.isArray(entry.colDates) ? entry.colDates : [],
                    deletedAt: Number(entry.deletedAt) || Date.now(),
                    fromColIdx: Number(entry.fromColIdx) || 0,
                    fromColName: String(entry.fromColName || ''),
                    rawJson: entry
                });
                saveFallbackStore();
            }
            return res.json({ success: true });
        }

        if (Array.isArray(fullHistory)) {
            if (req.useMongo) {
                await HistoryEntry.deleteMany({ userId: req.user.userId });
                if (fullHistory.length > 0) {
                    const docs = fullHistory.slice(0, 300).map(e => ({
                        userId: req.user.userId,
                        hid: e.hid || ('h_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)),
                        value: String(e.value || ''),
                        date: String(e.date || ''),
                        colDates: Array.isArray(e.colDates) ? e.colDates : [],
                        deletedAt: Number(e.deletedAt) || Date.now(),
                        fromColIdx: Number(e.fromColIdx) || 0,
                        fromColName: String(e.fromColName || ''),
                        rawJson: e
                    }));
                    await HistoryEntry.insertMany(docs);
                }
            } else {
                memoryStore.history = memoryStore.history.filter(e => e.userId !== req.user.userId);
                const items = fullHistory.slice(0, 300).map(e => ({
                    userId: req.user.userId,
                    hid: e.hid || ('h_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)),
                    value: String(e.value || ''),
                    date: String(e.date || ''),
                    colDates: Array.isArray(e.colDates) ? e.colDates : [],
                    deletedAt: Number(e.deletedAt) || Date.now(),
                    fromColIdx: Number(e.fromColIdx) || 0,
                    fromColName: String(e.fromColName || ''),
                    rawJson: e
                }));
                memoryStore.history.unshift(...items);
                saveFallbackStore();
            }
            return res.json({ success: true });
        }

        res.status(400).json({ success: false, error: 'Invalid history payload.' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save history: ' + err.message });
    }
});

// Delete a single history item
app.delete('/api/history/:hid', requireAuth, ensureDb, async (req, res) => {
    try {
        const { hid } = req.params;
        if (req.useMongo) {
            await HistoryEntry.deleteOne({ userId: req.user.userId, hid });
        } else {
            memoryStore.history = memoryStore.history.filter(
                e => !(e.userId === req.user.userId && e.hid === hid)
            );
            saveFallbackStore();
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Clear all history
app.delete('/api/history', requireAuth, ensureDb, async (req, res) => {
    try {
        if (req.useMongo) {
            await HistoryEntry.deleteMany({ userId: req.user.userId });
        } else {
            memoryStore.history = memoryStore.history.filter(e => e.userId !== req.user.userId);
            saveFallbackStore();
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== MIGRATION / LOCALSTORAGE SYNC ====================
app.post(['/api/migrate', '/migrate'], requireAuth, ensureDb, async (req, res) => {
    try {
        const { localState, localHistory, overwrite } = req.body;

        if (localState && Array.isArray(localState.columns)) {
            if (req.useMongo) {
                await PipelineData.findOneAndUpdate(
                    { userId: req.user.userId },
                    {
                        $set: {
                            columns: localState.columns,
                            updatedAt: new Date()
                        },
                        $inc: { version: 1 }
                    },
                    { upsert: true }
                );
            } else {
                let doc = memoryStore.pipelines[req.user.userId] || { userId: req.user.userId, version: 1 };
                doc.columns = localState.columns;
                doc.version = (doc.version || 1) + 1;
                doc.updatedAt = new Date();
                memoryStore.pipelines[req.user.userId] = doc;
                saveFallbackStore();
            }
        }

        res.json({ success: true, message: 'Local data migrated successfully to cloud account!' });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Migration failed: ' + err.message });
    }
});

// Serve frontend static files
app.use(express.static(__dirname));

// Route default / to index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Route /history to history.html
app.get('/history', (req, res) => {
    res.sendFile(path.join(__dirname, 'history.html'));
});

// Start local server if executed directly
if (!isVercel && require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`\n======================================================`);
        console.log(`🚀 Pipe & Expense Management Cloud Server`);
        console.log(`💻 Local URL:    http://localhost:${PORT}`);
        console.log(`☁️  MongoDB URI:  ${process.env.MONGODB_URI ? 'Configured ✅ (MongoDB Atlas)' : 'Instant Fallback Cloud Store Active ✅'}`);
        console.log(`🔒 Auth System:  JWT with bcrypt password security`);
        console.log(`🔄 Sync Engine:  Multi-device cloud synchronization enabled`);
        console.log(`======================================================\n`);
    });
}

module.exports = app;
