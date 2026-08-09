const STORAGE_KEY = 'data-tracker-v2';
let state = loadState() || { columns: [{ name: '', items: [] }] };
let deleteMode = false;

function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { }
}
function loadState() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (
            parsed && Array.isArray(parsed.columns) && parsed.columns.length > 0 &&
            parsed.columns.every(c => c && typeof c === 'object' && Array.isArray(c.items))
        ) return parsed;
    } catch (e) { }
    return null;
}

function uid() {
    return 'i_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}
const COLOR_VARS = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];
function colorForColumn(index) { return `var(${COLOR_VARS[index % COLOR_VARS.length]})`; }

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// === Extract name from value: takes segment after first '-' ===
function extractName(value) {
    const s = String(value).trim();
    const dashIdx = s.indexOf('-');
    if (dashIdx === -1) return null; // no dash → skip
    // get first segment after the dash, stop at next dash
    const afterDash = s.slice(dashIdx + 1);
    const nextDash = afterDash.indexOf('-');
    const name = (nextDash === -1 ? afterDash : afterDash.slice(0, nextDash)).trim().toLowerCase();
    return name === '' ? null : name;
}

function displayName(col, idx) {
    const n = (col.name || '').trim();
    return n !== '' ? n : `Column ${idx + 1}`;
}

// === Total PIP helpers ===
function getTotalPipCount() {
    return state.columns.reduce((sum, col) => {
        return sum + col.items.filter(i => !i.moved).length;
    }, 0);
}

function updateTotalPip(bump = false) {
    const el = document.getElementById('total-pip-value');
    if (!el) return;
    const total = getTotalPipCount();
    el.textContent = total;
    if (bump) {
        el.classList.remove('bump');
        void el.offsetWidth;
        el.classList.add('bump');
    }
}

// === Manual edit helpers ===
// Rename any column (including Column 1)
function renameColumn(colIdx) {
    const current = state.columns[colIdx].name || '';
    const next = prompt('Enter Column Name', current);
    if (next === null) return;
    state.columns[colIdx].name = String(next).trim();
    saveState();
    render();
}

// Edit an item's value manually
function editItem(colIdx, itemId) {
    const list = state.columns[colIdx].items;
    const item = list.find(i => i.id === itemId);
    if (!item) return;
    const next = prompt('Edit data', item.value);
    if (next === null) return;
    const v = String(next).trim();
    if (v === '') return;
    item.value = v;
    saveState();
    render();
}

// Edit an item's date manually
function editItemDate(colIdx, itemId) {
    const list = state.columns[colIdx].items;
    const item = list.find(i => i.id === itemId);
    if (!item) return;
    const next = prompt('Enter Date (e.g. 07/07/2026 or any format)', item.date || '');
    if (next === null) return;
    item.date = String(next).trim();
    saveState();
    render();
}

function render(newlyAddedId = null) {
    const root = document.getElementById('columns');
    root.innerHTML = '';
    const lastIndex = state.columns.length - 1;

    state.columns.forEach((column, colIdx) => {
        const items = column.items;
        const isLast = colIdx === lastIndex;

        const col = document.createElement('div');
        col.className = 'column';
        col.style.setProperty('--col-bg', colorForColumn(colIdx));

        const head = document.createElement('div');
        head.className = 'col-head';

        const title = document.createElement('div');
        title.className = 'col-title';
        title.title = 'Click to rename';
        title.innerHTML =
            `<span class="col-num">${colIdx + 1}</span>` +
            escapeHtml(displayName(column, colIdx));
        title.addEventListener('click', () => renameColumn(colIdx));
        head.appendChild(title);

        if (state.columns.length > 1) {
            const rm = document.createElement('button');
            rm.className = 'col-remove';
            rm.title = 'Remove column';
            rm.textContent = '×';
            rm.addEventListener('click', (e) => {
                e.stopPropagation();
                removeColumn(colIdx);
            });
            head.appendChild(rm);
        }
        col.appendChild(head);

        const ul = document.createElement('ul');
        ul.className = 'items';

        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '— empty —';
            ul.appendChild(empty);
        } else {
            items.forEach(item => {
                const li = document.createElement('li');
                li.className = 'item';

                // Value text node
                const valueSpan = document.createElement('span');
                valueSpan.className = 'item-value';
                valueSpan.textContent = item.value;
                li.appendChild(valueSpan);

                if (item.moved) li.classList.add('moved');
                else if (isLast) li.classList.add('last-col');
                if (item.id === newlyAddedId) li.classList.add('added');

                li.addEventListener('click', () => {
                    if (deleteMode) deleteItem(colIdx, item.id);
                    else if (!item.moved) moveToNext(colIdx, item.id);
                });

                // Manual edit (pencil) — hidden via CSS for moved/last-col items
                if (!item.moved) {
                    const editBtn = document.createElement('button');
                    editBtn.className = 'item-edit';
                    editBtn.title = 'Edit value';
                    editBtn.textContent = '✎';
                    editBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        editItem(colIdx, item.id);
                    });
                    li.appendChild(editBtn);
                }

                // Date badge — small white box on left, click to change manually
                const dateBadge = document.createElement('span');
                dateBadge.className = 'item-date' + (item.date ? ' has-date' : '');
                dateBadge.title = 'Click to set / change date';
                dateBadge.textContent = item.date ? item.date : '—';
                dateBadge.addEventListener('click', (e) => {
                    e.stopPropagation();
                    editItemDate(colIdx, item.id);
                });
                li.appendChild(dateBadge);

                ul.appendChild(li);
            });
        }
        col.appendChild(ul);

        const liveCount = items.filter(i => !i.moved).length;
        const total = document.createElement('div');
        total.className = 'total';
        total.innerHTML = `
          <span class="rule">----------</span>
          <span class="value">${liveCount}</span>
        `;
        col.appendChild(total);

        root.appendChild(col);
    });

    updateTotalPip(newlyAddedId !== null);
    renderSummaryTable();
    renderSuffixTable();
}

// === Render Name Count Summary Table ===
function renderSummaryTable() {
    const wrap = document.getElementById('summary-table-wrap');
    if (!wrap) return;

    const columns = state.columns;

    // 1. Collect all unique names (extracted from item values across all columns)
    const allNames = new Set();
    columns.forEach(col => {
        col.items.forEach(item => {
            if (item.moved) return; // skip struck-through (moved) items
            const n = extractName(item.value);
            if (n) allNames.add(n);
        });
    });

    if (allNames.size === 0) {
        wrap.innerHTML = '<div class="summary-empty">Add some data to see the summary table.</div>';
        return;
    }

    // Sort names alphabetically for stable display
    const nameList = Array.from(allNames).sort();

    // 2. Build count map: countMap[name][colIdx] = count
    const countMap = {};
    nameList.forEach(n => { countMap[n] = new Array(columns.length).fill(0); });
    columns.forEach((col, colIdx) => {
        col.items.forEach(item => {
            if (item.moved) return; // skip struck-through (moved) items
            const n = extractName(item.value);
            if (n && countMap[n]) countMap[n][colIdx]++;
        });
    });

    // 3. Column totals (Actual live totals of all un-moved items, including unnamed ones)
    const colTotals = columns.map(col => col.items.filter(i => !i.moved).length);

    // 3b. Row totals & grand total
    const rowTotals = {};
    nameList.forEach(n => {
        rowTotals[n] = countMap[n].reduce((s, c) => s + c, 0);
    });
    const grandTotal = colTotals.reduce((s, c) => s + c, 0);

    // 4. Build table HTML — STANDARD: rows = names, columns = main columns
    let html = '<table class="summary-table" id="summary-table">';

    // Header: "Name" + each main column name + "Total"
    html += '<thead><tr>';
    html += '<th>Name</th>';
    columns.forEach((col, ci) => {
        html += `<th>${escapeHtml(displayName(col, ci))}</th>`;
    });
    html += '<th class="th-total">Total</th>';
    html += '</tr></thead>';

    // Body
    html += '<tbody>';
    nameList.forEach(name => {
        html += '<tr>';
        html += `<td>${escapeHtml(name.charAt(0).toUpperCase() + name.slice(1))}</td>`;
        columns.forEach((col, ci) => {
            const c = countMap[name][ci];
            if (c > 0) {
                html += `<td><span class="count-badge has-count">${c}</span></td>`;
            } else {
                html += `<td><span class="count-badge zero-count">—</span></td>`;
            }
        });
        html += `<td><span class="count-badge row-total-badge">${rowTotals[name]}</span></td>`;
        html += '</tr>';
    });
    html += '</tbody>';

    // Footer: total per main column + grand total
    html += '<tfoot><tr>';
    html += '<td>Total</td>';
    columns.forEach((_, ci) => {
        html += `<td>${colTotals[ci]}</td>`;
    });
    html += `<td class="grand-total-cell">${grandTotal}</td>`;
    html += '</tr></tfoot>';

    html += '</table>';
    wrap.innerHTML = html;
}

// === Extract the leading number from a value like "4-shubh" → "4" ===
function extractNumber(value) {
    const s = String(value).trim();
    const dashIdx = s.indexOf('-');
    if (dashIdx === -1) {
        return /^\d+$/.test(s) ? s : null;
    }
    const prefix = s.slice(0, dashIdx).trim();
    return /^\d+$/.test(prefix) ? prefix : null; // only pure numeric prefix
}

function addData(rawValue) {
    const value = String(rawValue);
    if (value.trim() === '') return;

    // Duplicate number-prefix check across ALL columns
    const newNum = extractNumber(value);
    if (newNum !== null) {
        let duplicate = null;
        for (const col of state.columns) {
            for (const item of col.items) {
                if (item.moved) continue; // ignore struck-through items
                if (extractNumber(item.value) === newNum) {
                    duplicate = item.value;
                    break;
                }
            }
            if (duplicate) break;
        }
        if (duplicate) {
            alert(`⚠️ Number "${newNum}" is already used!\nExisting entry: "${duplicate}"\n\nPlease use a different number.`);
            return; // block the entry
        }
    }

    const item = { id: uid(), value: value, date: '' };
    state.columns[0].items.push(item);
    saveState();
    render(item.id);
}

function moveToNext(colIdx, itemId) {
    const lastIndex = state.columns.length - 1;
    if (colIdx >= lastIndex) return;
    const fromList = state.columns[colIdx].items;
    const original = fromList.find(i => i.id === itemId);
    if (!original || original.moved) return;
    original.moved = true;
    const copy = { id: uid(), value: original.value, date: original.date || '' };
    state.columns[colIdx + 1].items.push(copy);
    saveState();
    render(copy.id);
}

function deleteItem(colIdx, itemId) {
    const list = state.columns[colIdx].items;
    const idx = list.findIndex(i => i.id === itemId);
    if (idx === -1) return;

    const lastIndex = state.columns.length - 1;
    const targetValue = list[idx].value;

    if (colIdx === lastIndex) {
        // Last column delete: remove all items matching this value from EVERY column
        state.columns.forEach(col => {
            col.items = col.items.filter(i => i.value !== targetValue);
        });
    } else {
        list.splice(idx, 1);
    }

    saveState();
    render();
}

function addColumn() {
    const columnName = prompt('Enter Column Name');
    if (columnName === null) return;
    const name = (columnName || '').trim();
    state.columns.push({ name: name, items: [] });
    saveState();
    render();
}

function removeColumn(colIdx) {
    if (state.columns.length <= 1) return;
    state.columns.splice(colIdx, 1);
    saveState();
    render();
}

function resetAll() {
    if (!confirm('Reset all data and columns?')) return;
    state = { columns: [{ name: '', items: [] }] };
    saveState();
    render();
}

function toggleDeleteMode() {
    deleteMode = !deleteMode;
    const btn = document.getElementById('toggle-delete-btn');
    btn.textContent = 'Delete: ' + (deleteMode ? 'On' : 'Off');
    btn.classList.toggle('on', deleteMode);
    document.body.classList.toggle('delete-mode', deleteMode);
}

// === Extract suffix from value: takes segment after LAST '-' ===
function extractSuffix(value) {
    const s = String(value).trim();
    const lastDashIdx = s.lastIndexOf('-');
    if (lastDashIdx === -1) return null;

    // Only return suffix if there are at least 2 dashes (e.g. number-name-suffix)
    const firstDashIdx = s.indexOf('-');
    if (firstDashIdx === lastDashIdx) return null;

    const suffix = s.slice(lastDashIdx + 1).trim().toLowerCase();
    return suffix === '' ? null : suffix;
}

// === Render Suffix Count Summary Table ===
function renderSuffixTable() {
    const wrap = document.getElementById('suffix-table-wrap');
    if (!wrap) return;

    const columns = state.columns;
    const targetColIndices = [1, 2].filter(i => i < columns.length);

    if (targetColIndices.length === 0) {
        wrap.innerHTML = '<div class="summary-empty">Add data to the second and third columns to see this summary.</div>';
        return;
    }

    const allSuffixes = new Set();
    targetColIndices.forEach(ci => {
        columns[ci].items.forEach(item => {
            if (item.moved) return;
            const s = extractSuffix(item.value);
            if (s) allSuffixes.add(s);
        });
    });

    if (allSuffixes.size === 0) {
        wrap.innerHTML = '<div class="summary-empty">Add data to the second and third columns to see this summary.</div>';
        return;
    }

    const suffixList = Array.from(allSuffixes).sort();
    const countMap = {};
    suffixList.forEach(s => { countMap[s] = new Array(targetColIndices.length).fill(0); });

    targetColIndices.forEach((ci, loopIdx) => {
        columns[ci].items.forEach(item => {
            if (item.moved) return;
            const s = extractSuffix(item.value);
            if (s && countMap[s]) countMap[s][loopIdx]++;
        });
    });

    const colTotals = new Array(targetColIndices.length).fill(0);
    targetColIndices.forEach((ci, loopIdx) => {
        colTotals[loopIdx] = columns[ci].items.filter(i => !i.moved && extractSuffix(i.value) !== null).length;
    });

    const rowTotals = {};
    suffixList.forEach(s => {
        rowTotals[s] = countMap[s].reduce((sum, c) => sum + c, 0);
    });
    const grandTotal = colTotals.reduce((s, c) => s + c, 0);

    let html = '<table class="summary-table" id="suffix-table">';
    html += '<thead><tr>';
    html += '<th>Name</th>';
    targetColIndices.forEach(ci => {
        html += `<th>${escapeHtml(displayName(columns[ci], ci))}</th>`;
    });
    html += '<th class="th-total">Total</th>';
    html += '</tr></thead>';

    html += '<tbody>';
    suffixList.forEach(suffix => {
        html += '<tr>';
        html += `<td>${escapeHtml(suffix.charAt(0).toUpperCase() + suffix.slice(1))}</td>`;
        targetColIndices.forEach((_, loopIdx) => {
            const c = countMap[suffix][loopIdx];
            if (c > 0) {
                html += `<td><span class="count-badge has-count">${c}</span></td>`;
            } else {
                html += `<td><span class="count-badge zero-count">—</span></td>`;
            }
        });
        html += `<td><span class="count-badge row-total-badge">${rowTotals[suffix]}</span></td>`;
        html += '</tr>';
    });
    html += '</tbody>';

    html += '<tfoot><tr>';
    html += '<td>Total</td>';
    targetColIndices.forEach((_, loopIdx) => {
        html += `<td>${colTotals[loopIdx]}</td>`;
    });
    html += `<td class="grand-total-cell">${grandTotal}</td>`;
    html += '</tr></tfoot>';

    html += '</table>';
    wrap.innerHTML = html;
}

document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('add-form');
    const input = document.getElementById('data-input');

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = input.value;
        if (v.trim() === '') { input.focus(); return; }
        addData(v);
        input.value = '';
        input.focus();
    });

    document.getElementById('add-column-btn').addEventListener('click', addColumn);
    document.getElementById('reset-btn').addEventListener('click', resetAll);
    document.getElementById('toggle-delete-btn').addEventListener('click', toggleDeleteMode);

    // Search logic for residue / missing numbers
    const searchBtn = document.getElementById('col-search-btn');
    const searchInput = document.getElementById('col-search-input');
    if (searchBtn && searchInput) {
        searchBtn.addEventListener('click', () => {
            const query = searchInput.value.trim().toLowerCase();
            const resBox = document.getElementById('search-result-container');
            if (!query) {
                resBox.style.display = 'none';
                return;
            }

            let searchColQuery = query;
            let searchFilter = null;

            // Check if user is searching for a column and a specific name/suffix (e.g. "moklela pipe-sartin" or "moklela pipe-mg")
            const dashIdx = query.lastIndexOf('-');
            if (dashIdx !== -1) {
                const potentialCol = query.substring(0, dashIdx).trim();
                const potentialFilter = query.substring(dashIdx + 1).trim();

                // Verify if the part before the dash matches any column
                const match = state.columns.find((c, i) => displayName(c, i).toLowerCase().includes(potentialCol));
                if (match) {
                    searchColQuery = potentialCol;
                    searchFilter = potentialFilter;
                }
            }

            // Find column by name
            let targetCol = null;
            let colName = '';
            for (let i = 0; i < state.columns.length; i++) {
                const name = displayName(state.columns[i], i).toLowerCase();
                if (name.includes(searchColQuery)) {
                    targetCol = state.columns[i];
                    colName = displayName(state.columns[i], i);
                    break;
                }
            }

            if (!targetCol) {
                resBox.style.display = 'block';
                resBox.innerHTML = `<strong>Search:</strong> No column found matching "${query}"`;
                return;
            }

            // Find ACTIVE numbers in the target column
            const activeNumbers = [];
            targetCol.items.forEach(item => {
                if (!item.moved) { // only active items
                    // Filter by name or suffix if user requested one
                    if (searchFilter) {
                        const term = searchFilter.toLowerCase();

                        // Extract Name (part 2) and Suffix (part 3) manually to ensure accurate matching
                        const parts = String(item.value).trim().split('-');
                        let itemName = parts.length >= 2 ? parts[1].trim().toLowerCase() : '';
                        let itemSuffix = parts.length >= 3 ? parts.slice(2).join('-').trim().toLowerCase() : '';

                        if (!itemName.includes(term) && !itemSuffix.includes(term)) {
                            return; // skip if neither name nor suffix matches
                        }
                    }

                    const num = extractNumber(item.value);
                    if (num !== null) {
                        activeNumbers.push(parseInt(num, 10));
                    }
                }
            });

            // Sort numbers numerically
            activeNumbers.sort((a, b) => a - b);

            resBox.style.display = 'block';

            // Format title
            const displayTitle = searchFilter ? `${colName} (matching "-${searchFilter}")` : colName;

            if (activeNumbers.length === 0) {
                resBox.innerHTML = `<strong>${displayTitle}</strong>: Null`;
            } else {
                resBox.innerHTML = `<strong>${displayTitle}:</strong> <strong style="color: #1a3a8a; font-size: 22px;">${activeNumbers.join(', ')}</strong>`;
            }
        });

        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchBtn.click();
            }
        });
    }

    const downloadPdfBtn = document.getElementById('download-pdf-btn');
    if (downloadPdfBtn) {
        downloadPdfBtn.addEventListener('click', () => {
            if (typeof html2pdf === 'undefined') {
                alert("PDF library is still loading or failed to load. Please try again.");
                return;
            }

            const originalText = downloadPdfBtn.textContent;
            downloadPdfBtn.textContent = 'Generating PDF...';
            downloadPdfBtn.disabled = true;

            // Apply ultra-compact styling
            document.body.classList.add('exporting-pdf');
            window.scrollTo(0, 0);

            // Configure PDF for 1-2 pages maximum by scaling it down
            const opt = {
                margin: 0.2, // Small margins
                filename: 'data-tracker-compact.pdf',
                image: { type: 'jpeg', quality: 1.0 }, // max quality
                html2canvas: {
                    scale: 4, // Much higher scale for extremely clear fonts
                    useCORS: false,
                    scrollY: 0,
                    letterRendering: true
                },
                jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' }
            };

            try {
                html2pdf().set(opt).from(document.body).save().then(() => {
                    // Restore original UI
                    downloadPdfBtn.textContent = originalText;
                    downloadPdfBtn.disabled = false;
                    document.body.classList.remove('exporting-pdf');
                }).catch(err => {
                    console.error("PDF generation error:", err);
                    alert("Error generating PDF: " + (err.message || "Unknown error"));
                    downloadPdfBtn.textContent = originalText;
                    downloadPdfBtn.disabled = false;
                    document.body.classList.remove('exporting-pdf');
                });
            } catch (err) {
                console.error("Sync error:", err);
                alert("Error: " + err.message);
                downloadPdfBtn.textContent = originalText;
                downloadPdfBtn.disabled = false;
                document.body.classList.remove('exporting-pdf');
            }
        });
    }

    render();
});
