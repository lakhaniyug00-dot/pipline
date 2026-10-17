const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'pipeline-secret-key-change-in-production-2026';

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            error: 'Authentication required. Please sign in to sync your data.'
        });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({
            success: false,
            error: 'Malformed authorization token.'
        });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = {
            userId: decoded.userId,
            username: decoded.username
        };
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({
                success: false,
                error: 'Your session has expired. Please sign in again.'
            });
        }
        return res.status(401).json({
            success: false,
            error: 'Invalid authentication token.'
        });
    }
}

function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            req.user = {
                userId: decoded.userId,
                username: decoded.username
            };
        } catch (e) {
            // Ignore invalid token in optional auth
        }
    }
    next();
}

function generateToken(user) {
    return jwt.sign(
        { userId: user._id.toString(), username: user.username },
        JWT_SECRET,
        { expiresIn: '30d' } // 30-day persistent session for mobile/desktop
    );
}

module.exports = { requireAuth, optionalAuth, generateToken, JWT_SECRET };
