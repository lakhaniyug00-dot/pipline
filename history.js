// ===== History Page Logic =====
const HISTORY_KEY = 'data-tracker-deleted-history';
const MAIN_KEY = 'data-tracker-v2';

// ---- Helpers ----
function loadHistory() {
    try {
        const raw = localStorage.getItem(HISTORY_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
}

function saveHistory(history) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) { }
}

function loadMainState() {
    try {
        const raw = localStorage.getItem(MAIN_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.columns)) return parsed;
    } catch (e) { }
    return null;
}

function saveMainState(state) {
    try { localStorage.setItem(MAIN_KEY, JSON.stringify(state)); } catch (e) { }
}

function uid() {
    return 'i_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function extractNumber(value) {
    const s = String(value).trim();
    const dashIdx = s.indexOf('-');
    if (dashIdx === -1) return /^\d+$/.test(s) ? s : null;
    const prefix = s.slice(0, dashIdx).trim();
    return /^\d+$/.test(prefix) ? prefix : null;
}

function sortItems(items) {
    items.sort((a, b) => {
        const na = extractNumber(a.value);
        const nb = extractNumber(b.value);
        const ia = na !== null ? parseInt(na, 10) : Infinity;
        const ib = nb !== null ? parseInt(nb, 10) : Infinity;
        return ia - ib;
    });
}

function formatDateTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    return `${date}, ${time}`;
}

// ---- Toast ----
let toastTimer = null;
function showToast(msg) {
    const t = document.getElementById('hist-toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---- Helper: render all column dates for a history entry ----
function renderColDates(entry) {
    const colDates = Array.isArray(entry.colDates) && entry.colDates.length > 0
        ? entry.colDates
        : null;

    if (!colDates) {
        // Fallback for old entries that only have a single date
        if (!entry.date) return '<span style="color:#ccc">—</span>';
        return `<span style="color:#888;font-size:13px">${escapeHtml(entry.date)}</span>`;
    }

    let html = '<table style="border-collapse:collapse;font-size:12px;min-width:180px">';
    colDates.forEach(cd => {
        html += `<tr>
            <td style="padding:2px 8px 2px 0;color:#a0935a;font-family:\'Inter\',sans-serif;font-size:11px;white-space:nowrap;font-weight:600">${escapeHtml(cd.colName || `Col ${cd.colIdx + 1}`)}</td>
            <td style="padding:2px 0;color:#1a3a8a;font-weight:500;white-space:nowrap">${cd.date ? escapeHtml(cd.date) : '<span style="color:#ccc">—</span>'}</td>
        </tr>`;
    });
    html += '</table>';
    return html;
}

function render() {
    let history = loadHistory();
    const wrap = document.getElementById('hist-table-wrap');
    const countEl = document.getElementById('hist-count');
    const searchInput = document.getElementById('hist-search-input');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';

    if (query) {
        history = history.filter(entry => {
            const v = (entry.value || '').toLowerCase();
            const d = (entry.date || '').toLowerCase();
            // Also search inside colDates
            const colDatesStr = Array.isArray(entry.colDates)
                ? entry.colDates.map(cd => (cd.colName + ' ' + cd.date).toLowerCase()).join(' ')
                : '';
            return v.includes(query) || d.includes(query) || colDatesStr.includes(query);
        });
    }

    countEl.textContent = `${history.length} ${history.length === 1 ? 'entry' : 'entries'}`;

    if (history.length === 0) {
        wrap.innerHTML = `
            <div class="hist-empty">
                <span>📭</span>
                No deleted items yet.<br>Delete something from the tracker to see it here.
            </div>`;
        return;
    }

    let html = `
        <table class="hist-table">
            <thead>
                <tr>
                    <th class="th-center">#</th>
                    <th>Name</th>
                    <th>Column Dates</th>
                    <th>From Column</th>
                    <th>Deleted At</th>
                    <th class="th-center">Actions</th>
                </tr>
            </thead>
            <tbody>`;

    history.forEach((entry, i) => {
        html += `
            <tr id="row-${entry.hid}">
                <td class="td-num">${i + 1}</td>
                <td class="td-value">${escapeHtml(entry.value)}</td>
                <td class="td-date">${renderColDates(entry)}</td>
                <td class="td-col">${escapeHtml(entry.fromColName || `Column ${entry.fromColIdx + 1}`)}</td>
                <td class="td-deleted">${formatDateTime(entry.deletedAt)}</td>
                <td class="td-actions">
                    <button class="act-btn restore" onclick="restoreItem('${entry.hid}')">↩ Restore</button>
                    <button class="act-btn del" onclick="deleteFromHistory('${entry.hid}')">✕ Delete</button>
                </td>
            </tr>`;
    });

    html += `</tbody></table>`;
    wrap.innerHTML = html;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---- Restore item back to main tracker ----
function restoreItem(hid) {
    const history = loadHistory();
    const idx = history.findIndex(e => e.hid === hid);
    if (idx === -1) return;

    const entry = history[idx];
    const mainState = loadMainState();
    if (!mainState) {
        showToast('⚠️ Could not find main tracker data!');
        return;
    }

    // Check for duplicate number (only against active/non-moved items)
    const newNum = extractNumber(entry.value);
    if (newNum !== null) {
        for (const col of mainState.columns) {
            for (const item of col.items) {
                if (!item.moved && extractNumber(item.value) === newNum) {
                    showToast(`⚠️ Number "${newNum}" already exists in tracker!`);
                    return;
                }
            }
        }
    }

    const colDates = Array.isArray(entry.colDates) && entry.colDates.length > 0
        ? entry.colDates : null;

    if (colDates) {
        // === Full restore: put back struck-through copies in all intermediate columns ===
        colDates.forEach(cd => {
            const ci = cd.colIdx;
            if (ci >= mainState.columns.length) return;
            const col = mainState.columns[ci];

            // Use historical value if recorded, otherwise clean up or default to entry.value
            let val = cd.value || entry.value;
            // For legacy intermediate columns (like column 0), if cd.value is missing, we can try to restore just the clean number
            if (!cd.value && ci === 0) {
                const num = extractNumber(entry.value);
                if (num !== null) val = num;
            }

            // Avoid duplicates (match by exact value or leading number)
            const valNum = extractNumber(val);
            const exists = col.items.some(i => {
                if (i.value === val) return true;
                if (valNum !== null) {
                    const iNum = extractNumber(i.value);
                    if (iNum === valNum) return true;
                }
                return false;
            });

            if (!exists) {
                col.items.push({
                    id: uid(),
                    value: val,
                    date: cd.date || '',
                    moved: true,   // struck-through, same as original state
                    colDates: []
                });
                sortItems(col.items);
            }
        });

        // === Restore the active copy in the final (fromColIdx) column ===
        const finalColIdx = (entry.fromColIdx < mainState.columns.length)
            ? entry.fromColIdx : mainState.columns.length - 1;
        const finalCol = mainState.columns[finalColIdx];

        // Retrieve active value (historical final value or entry.value)
        const finalVal = entry.value;
        const finalValNum = extractNumber(finalVal);

        // Remove any accidental moved copies we might have just added above for this value/number
        finalCol.items = finalCol.items.filter(i => {
            if (i.value === finalVal && i.moved) return false;
            if (finalValNum !== null) {
                const iNum = extractNumber(i.value);
                if (iNum === finalValNum && i.moved) return false;
            }
            return true;
        });

        // Add active copy if it doesn't exist
        const activeExists = finalCol.items.some(i => {
            if (i.value === finalVal && !i.moved) return true;
            if (finalValNum !== null) {
                const iNum = extractNumber(i.value);
                if (iNum === finalValNum && !i.moved) return true;
            }
            return false;
        });

        if (!activeExists) {
            finalCol.items.push({
                id: uid(),
                value: finalVal,
                date: entry.date || '',
                moved: false,
                colDates: colDates
            });
            sortItems(finalCol.items);
        }

        saveMainState(mainState);
        history.splice(idx, 1);
        saveHistory(history);

        const colName = finalCol.name && finalCol.name.trim()
            ? finalCol.name : `Column ${finalColIdx + 1}`;
        showToast(`✅ "${entry.value}" fully restored (all ${colDates.length} columns)!`);

    } else {
        // === Fallback for old entries without colDates ===
        const targetColIdx = (entry.fromColIdx < mainState.columns.length)
            ? entry.fromColIdx : 0;
        const targetCol = mainState.columns[targetColIdx];
        const restored = { id: uid(), value: entry.value, date: entry.date || '', colDates: [] };
        targetCol.items.push(restored);
        sortItems(targetCol.items);
        saveMainState(mainState);

        history.splice(idx, 1);
        saveHistory(history);

        const colName = targetCol.name && targetCol.name.trim()
            ? targetCol.name : `Column ${targetColIdx + 1}`;
        showToast(`✅ "${entry.value}" restored to ${colName}!`);
    }

    render();
}

// ---- Delete a single entry from history ----
function deleteFromHistory(hid) {
    const history = loadHistory();
    const idx = history.findIndex(e => e.hid === hid);
    if (idx === -1) return;
    const entry = history[idx];
    history.splice(idx, 1);
    saveHistory(history);
    showToast(`🗑 "${entry.value}" removed from history.`);
    render();
}

function initHistory() {
    const clearBtn = document.getElementById('clear-all-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            const history = loadHistory();
            if (history.length === 0) { showToast('History is already empty!'); return; }
            if (!confirm(`Clear all ${history.length} history entries permanently?`)) return;
            saveHistory([]);
            showToast('🗑 All history cleared.');
            render();
        });
    }

    const searchEl = document.getElementById('hist-search-input');
    if (searchEl) {
        searchEl.addEventListener('input', () => {
            render();
        });
    }

    render();
}

// Guaranteed execution whether DOM is loading or already parsed
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initHistory);
} else {
    initHistory();
}


