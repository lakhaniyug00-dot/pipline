require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
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

// Ensure database connection middleware for /api routes
async function ensureDb(req, res, next) {
    try {
        await connectToDatabase();
        next();
    } catch (err) {
        console.error('Database connection error:', err.message);
        if (err.code === 'NO_MONGO_URI') {
            return res.status(503).json({
                success: false,
                code: 'MONGODB_URI_MISSING',
                error: 'MongoDB Atlas is not configured yet. Please set the MONGODB_URI environment variable in your Vercel project settings or .env file.'
            });
        }
        return res.status(503).json({
            success: false,
            code: 'DB_CONNECTION_FAILED',
            error: 'Could not connect to MongoDB Atlas. Please verify that your MongoDB connection string is correct and your IP Access List allows connections from anywhere (0.0.0.0/0).'
        });
    }
}

// ==================== HEALTH & DIAGNOSTICS ====================
app.get(['/api/health', '/health'], async (req, res) => {
    let dbStatus = 'disconnected';
    let dbError = null;

    if (process.env.MONGODB_URI) {
        try {
            await connectToDatabase();
            dbStatus = 'connected';
        } catch (err) {
            dbStatus = 'error';
            dbError = err.message;
        }
    } else {
        dbStatus = 'not_configured';
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
    const { username, password } = req.body;
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
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'Please enter both username and password.' });
    }
    req.cleanUsername = String(username).trim().toLowerCase();
    next();
}

// Register new account
app.post('/api/auth/register', validateRegisterInput, ensureDb, async (req, res) => {
    try {
        const { password } = req.body;
        const cleanUsername = req.cleanUsername;

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

        // Initialize default pipeline state for the new user
        await PipelineData.create({
            userId: newUser._id,
            columns: [{ name: '', items: [] }],
            undoStack: [],
            version: 1
        });

        const token = generateToken(newUser);

        res.status(201).json({
            success: true,
            message: 'Account created successfully!',
            token,
            user: {
                id: newUser._id,
                username: newUser.username
            }
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ success: false, error: 'Failed to create account. ' + err.message });
    }
});

// Login
app.post('/api/auth/login', validateLoginInput, ensureDb, async (req, res) => {
    try {
        const { password } = req.body;
        const cleanUsername = req.cleanUsername;

        const user = await User.findOne({ username: cleanUsername });
        if (!user) {
            return res.status(401).json({ success: false, error: 'Invalid username or password.' });
        }

        const isMatch = await bcrypt.compare(password, user.passwordHash);
        if (!isMatch) {
            return res.status(401).json({ success: false, error: 'Invalid username or password.' });
        }

        const token = generateToken(user);

        res.json({
            success: true,
            message: 'Signed in successfully!',
            token,
            user: {
                id: user._id,
                username: user.username
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ success: false, error: 'Sign in failed. ' + err.message });
    }
});

// Get Current User Profile
app.get('/api/auth/me', requireAuth, ensureDb, async (req, res) => {
    try {
        const user = await User.findById(req.user.userId).select('username createdAt');
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found.' });
        }
        res.json({
            success: true,
            user: {
                id: user._id,
                username: user.username,
                createdAt: user.createdAt
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== PIPELINE / EXPENSE STATE ROUTES ====================
// Get current user's state
app.get('/api/state', requireAuth, ensureDb, async (req, res) => {
    try {
        let doc = await PipelineData.findOne({ userId: req.user.userId });
        if (!doc) {
            doc = await PipelineData.create({
                userId: req.user.userId,
                columns: [{ name: '', items: [] }],
                undoStack: [],
                version: 1
            });
        }

        res.json({
            success: true,
            data: {
                columns: doc.columns || [{ name: '', items: [] }],
                undoStack: doc.undoStack || [],
                version: doc.version || 1,
                updatedAt: doc.updatedAt
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to retrieve state: ' + err.message });
    }
});

// Save current user's state
app.post('/api/state', requireAuth, ensureDb, async (req, res) => {
    try {
        const { state, undoStack, senderDeviceId } = req.body;

        if (!state || !Array.isArray(state.columns)) {
            return res.status(400).json({ success: false, error: 'Invalid state format. Columns array is required.' });
        }

        // Clean & sanitize columns
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

        res.json({
            success: true,
            version: doc.version,
            updatedAt: doc.updatedAt
        });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to save state: ' + err.message });
    }
});

// Real-time synchronization heartbeat / check
app.get('/api/sync-status', requireAuth, ensureDb, async (req, res) => {
    try {
        const doc = await PipelineData.findOne({ userId: req.user.userId })
            .select('version updatedAt lastUpdatedByDevice');

        if (!doc) {
            return res.json({ success: true, version: 1, updatedAt: new Date(), lastUpdatedByDevice: '' });
        }

        res.json({
            success: true,
            version: doc.version || 1,
            updatedAt: doc.updatedAt,
            lastUpdatedByDevice: doc.lastUpdatedByDevice || ''
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Undo stack operations
app.get('/api/undo', requireAuth, ensureDb, async (req, res) => {
    try {
        const doc = await PipelineData.findOne({ userId: req.user.userId }).select('undoStack');
        res.json({ success: true, data: doc && doc.undoStack ? doc.undoStack : [] });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/undo', requireAuth, ensureDb, async (req, res) => {
    try {
        const { undoStack } = req.body;
        const list = Array.isArray(undoStack) ? undoStack.slice(-50) : [];
        await PipelineData.findOneAndUpdate(
            { userId: req.user.userId },
            { $set: { undoStack: list } },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== HISTORY ROUTES (DELETED ITEMS) ====================
// Get deleted history entries
app.get('/api/history', requireAuth, ensureDb, async (req, res) => {
    try {
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

        res.json({ success: true, data: formatted });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Failed to fetch history: ' + err.message });
    }
});

// Save history entry (single or batch)
app.post('/api/history', requireAuth, ensureDb, async (req, res) => {
    try {
        const { entry, fullHistory } = req.body;

        if (entry && entry.hid) {
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
            return res.json({ success: true });
        }

        if (Array.isArray(fullHistory)) {
            // Replace full history safely
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
        await HistoryEntry.deleteOne({ userId: req.user.userId, hid });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Clear all history
app.delete('/api/history', requireAuth, ensureDb, async (req, res) => {
    try {
        await HistoryEntry.deleteMany({ userId: req.user.userId });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== MIGRATION / LOCALSTORAGE SYNC ====================
app.post('/api/migrate', requireAuth, ensureDb, async (req, res) => {
    try {
        const { localState, localHistory, overwrite } = req.body;

        const currentDoc = await PipelineData.findOne({ userId: req.user.userId });
        const hasCloudData = currentDoc &&
            Array.isArray(currentDoc.columns) &&
            currentDoc.columns.some(col => col.items && col.items.length > 0);

        if (hasCloudData && !overwrite) {
            return res.json({
                success: true,
                needsDecision: true,
                message: 'Your cloud account already has existing data. Please choose whether to keep cloud data or overwrite with this device\'s local data.'
            });
        }

        if (localState && Array.isArray(localState.columns)) {
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
        }

        if (Array.isArray(localHistory) && localHistory.length > 0) {
            for (const item of localHistory) {
                if (item && item.hid) {
                    await HistoryEntry.findOneAndUpdate(
                        { userId: req.user.userId, hid: item.hid },
                        {
                            $set: {
                                userId: req.user.userId,
                                hid: item.hid,
                                value: String(item.value || ''),
                                date: String(item.date || ''),
                                colDates: Array.isArray(item.colDates) ? item.colDates : [],
                                deletedAt: Number(item.deletedAt) || Date.now(),
                                fromColIdx: Number(item.fromColIdx) || 0,
                                fromColName: String(item.fromColName || ''),
                                rawJson: item
                            }
                        },
                        { upsert: true }
                    );
                }
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
        console.log(`☁️  MongoDB URI:  ${process.env.MONGODB_URI ? 'Configured ✅' : 'Not configured ⚠️ (Local offline mode active)'}`);
        console.log(`🔒 Auth System:  JWT with bcrypt password security`);
        console.log(`🔄 Sync Engine:  Multi-device cloud synchronization enabled`);
        console.log(`======================================================\n`);
    });
}

module.exports = app;
