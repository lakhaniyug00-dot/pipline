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

// ---- Render ----
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
            return v.includes(query) || d.includes(query);
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
                    <th>Date</th>
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
                <td class="td-date">${entry.date ? escapeHtml(entry.date) : '<span style="color:#ccc">—</span>'}</td>
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

    // Pick target column: use original column index if it still exists, else column 0
    const targetColIdx = (entry.fromColIdx < mainState.columns.length)
        ? entry.fromColIdx
        : 0;
    const targetCol = mainState.columns[targetColIdx];

    // Check for duplicate number
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

    // Add back to the target column
    const restored = { id: uid(), value: entry.value, date: entry.date || '' };
    targetCol.items.push(restored);
    sortItems(targetCol.items);
    saveMainState(mainState);

    // Remove from history
    history.splice(idx, 1);
    saveHistory(history);

    const colName = targetCol.name && targetCol.name.trim()
        ? targetCol.name
        : `Column ${targetColIdx + 1}`;
    showToast(`✅ "${entry.value}" restored to ${colName}!`);
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

// ---- Clear all history ----
document.getElementById('clear-all-btn').addEventListener('click', () => {
    const history = loadHistory();
    if (history.length === 0) { showToast('History is already empty!'); return; }
    if (!confirm(`Clear all ${history.length} history entries permanently?`)) return;
    saveHistory([]);
    showToast('🗑 All history cleared.');
    render();
});

// ---- Search Input Listener ----
const searchEl = document.getElementById('hist-search-input');
if (searchEl) {
    searchEl.addEventListener('input', () => {
        render();
    });
}

// ---- Init ----
render();
