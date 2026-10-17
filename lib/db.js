const mongoose = require('mongoose');

// Global cache for Mongoose connection across Vercel serverless invocations
let cached = global._mongooseConn;
if (!cached) {
    cached = global._mongooseConn = { conn: null, promise: null };
}

async function connectToDatabase() {
    if (cached.conn && mongoose.connection.readyState === 1) {
        return cached.conn;
    }

    const uri = process.env.MONGODB_URI;
    if (!uri) {
        const err = new Error('MONGODB_URI environment variable is not configured. Please set MONGODB_URI in Vercel or your .env file.');
        err.code = 'NO_MONGO_URI';
        throw err;
    }

    if (!cached.promise) {
        const opts = {
            bufferCommands: false,
            maxPoolSize: 10,
            serverSelectionTimeoutMS: 6000,
            socketTimeoutMS: 20000,
        };

        cached.promise = mongoose.connect(uri, opts).then((m) => m);
    }

    try {
        cached.conn = await cached.promise;
    } catch (e) {
        cached.promise = null;
        throw e;
    }

    return cached.conn;
}

function isDbConnected() {
    return mongoose.connection.readyState === 1;
}

module.exports = { connectToDatabase, isDbConnected };
