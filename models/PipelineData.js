const mongoose = require('mongoose');

const ItemColDateSchema = new mongoose.Schema({
    colIdx: { type: Number, default: 0 },
    colName: { type: String, default: '' },
    date: { type: String, default: '' }
}, { _id: false });

const ItemSchema = new mongoose.Schema({
    id: { type: String, required: true },
    value: { type: String, required: true },
    date: { type: String, default: '' },
    moved: { type: Boolean, default: false },
    colDates: [ItemColDateSchema]
}, { _id: false });

const ColumnSchema = new mongoose.Schema({
    name: { type: String, default: '' },
    items: [ItemSchema]
}, { _id: false });

const PipelineDataSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true
    },
    columns: {
        type: [ColumnSchema],
        default: [{ name: '', items: [] }]
    },
    undoStack: {
        type: Array,
        default: []
    },
    version: {
        type: Number,
        default: 1
    },
    lastUpdatedByDevice: {
        type: String,
        default: ''
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.models.PipelineData || mongoose.model('PipelineData', PipelineDataSchema);
