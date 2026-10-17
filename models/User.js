const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: [true, 'Username is required'],
        unique: true,
        trim: true,
        lowercase: true,
        minlength: [3, 'Username must be at least 3 characters'],
        maxlength: [40, 'Username cannot exceed 40 characters'],
        match: [/^[a-zA-Z0-9_\-\.@]+$/, 'Username can only contain letters, numbers, _, -, ., @']
    },
    passwordHash: {
        type: String,
        required: [true, 'Password hash is required']
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

// Avoid recompiling model if already defined
module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
