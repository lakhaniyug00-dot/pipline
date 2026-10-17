const mongoose = require('mongoose');

const HistoryEntrySchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    hid: {
        type: String,
        required: true
    },
    value: {
        type: String,
        required: true
    },
    date: {
        type: String,
        default: ''
    },
    colDates: {
        type: Array,
        default: []
    },
    deletedAt: {
        type: Number,
        default: () => Date.now(),
        index: true
    },
    fromColIdx: {
        type: Number,
        default: 0
    },
    fromColName: {
        type: String,
        default: ''
    },
    rawJson: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
});

// Compound index for fast queries and per-user uniqueness of hid
HistoryEntrySchema.index({ userId: 1, hid: 1 }, { unique: true });
HistoryEntrySchema.index({ userId: 1, deletedAt: -1 });

module.exports = mongoose.models.HistoryEntry || mongoose.model('HistoryEntry', HistoryEntrySchema);
