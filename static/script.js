// Глобальные переменные
let currentTab = null;
let editingCardId = null;
let tabsData = [];
let cardsData = {};
let editMode = false;
let searchDebounceTimer = null;
let searchModalOpen = false;
let currentSearchQuery = '';

// ---------- Модальные окна ----------
let confirmCallback = null;
let promptCallback = null;

function showNotification(message, title = 'Уведомление') {
    document.getElementById('notificationTitle').textContent = title;
    document.getElementById('notificationMessage').innerHTML = message;
    document.getElementById('notificationModal').classList.remove('hidden');
}
function closeNotificationModal() {
    document.getElementById('notificationModal').classList.add('hidden');
}

function showConfirm(message, callback, title = 'Подтверждение') {
    confirmCallback = callback;
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').innerHTML = message;
    document.getElementById('confirmModal').classList.remove('hidden');
}
function confirmYes() {
    if (confirmCallback) confirmCallback(true);
    confirmCallback = null;
    document.getElementById('confirmModal').classList.add('hidden');
}
function confirmNo() {
    if (confirmCallback) confirmCallback(false);
    confirmCallback = null;
    document.getElementById('confirmModal').classList.add('hidden');
}

function showPrompt(message, callback, defaultValue = '', title = 'Ввод') {
    promptCallback = callback;
    document.getElementById('promptTitle').textContent = title;
    document.getElementById('promptMessage').innerHTML = message;
    const input = document.getElementById('promptInput');
    input.value = defaultValue;
    document.getElementById('promptModal').classList.remove('hidden');
    input.focus();
}
function promptOk() {
    const value = document.getElementById('promptInput').value;
    if (promptCallback) promptCallback(value);
    promptCallback = null;
    document.getElementById('promptModal').classList.add('hidden');
}
function promptCancel() {
    if (promptCallback) promptCallback(null);
    promptCallback = null;
    document.getElementById('promptModal').classList.add('hidden');
}

// ---------- API ----------
async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
        ...options
    });
    if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Ошибка запроса');
    }
    return res.json();
}

async function loadAllData() {
    try {
        const tabs = await apiFetch('/api/tabs');
        tabsData = tabs;
        if (!tabs.length) return;
        if (!currentTab || !tabsData.find(t => t.id === currentTab))
            currentTab = tabsData[0].id;
        // Загружаем карточки для ВСЕХ вкладок
        await loadAllCards();
        renderTabs();
        renderContent();
    } catch (err) {
        console.error(err);
        showNotification('Ошибка загрузки: ' + err.message);
    }
}

async function loadAllCards() {
    // Загружаем карточки для всех вкладок сразу
    for (const tab of tabsData) {
        try {
            const cards = await apiFetch(`/api/tabs/${tab.id}/cards`);
            cardsData[tab.id] = cards;
        } catch (err) {
            console.error(err);
            cardsData[tab.id] = [];
        }
    }
}

async function loadCardsForTab(tabId) {
    try {
        const cards = await apiFetch(`/api/tabs/${tabId}/cards`);
        cardsData[tabId] = cards;
    } catch (err) {
        console.error(err);
        cardsData[tabId] = [];
    }
}

// ---------- Рендер вкладок ----------
function renderTabs() {
    const container = document.getElementById('tabs');
    container.innerHTML = '';
    tabsData.forEach(tab => {
        const active = tab.id === currentTab ? 'tab-active' : 'hover:bg-white/10';
        const tabDiv = document.createElement('div');
        tabDiv.className = `tab-item px-7 py-3 rounded-t-3xl cursor-pointer transition-all flex items-center gap-3 text-base font-medium ${active}`;
        tabDiv.setAttribute('data-id', tab.id);
        tabDiv.setAttribute('draggable', 'true');
        tabDiv.innerHTML = `
            <span class="tab-name" ondblclick="event.stopPropagation(); renameTabPrompt(${tab.id})">${escapeHtml(tab.name)}</span>
            <button class="tab-delete text-white/40 hover:text-red-400" onclick="event.stopImmediatePropagation(); deleteTab(${tab.id});">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;
        if (editMode) tabDiv.classList.add('edit-mode');
        tabDiv.addEventListener('click', (e) => {
            if (!e.target.closest('button')) switchTab(tab.id);
        });
        tabDiv.addEventListener('dragstart', handleTabDragStart);
        tabDiv.addEventListener('dragover', handleTabDragOver);
        tabDiv.addEventListener('dragleave', handleTabDragLeave);
        tabDiv.addEventListener('drop', handleTabDrop);
        tabDiv.addEventListener('dragover', (e) => e.preventDefault());
        tabDiv.addEventListener('drop', handleCardDropOnTab);
        container.appendChild(tabDiv);
    });
}

let draggedTabId = null;
function handleTabDragStart(e) {
    draggedTabId = parseInt(e.currentTarget.getAttribute('data-id'));
    e.dataTransfer.setData('text/plain', draggedTabId);
    e.currentTarget.classList.add('dragging');
}
function handleTabDragOver(e) { e.preventDefault(); const target = e.currentTarget; if (draggedTabId && parseInt(target.getAttribute('data-id')) !== draggedTabId) target.classList.add('drag-over'); }
function handleTabDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }
async function handleTabDrop(e) {
    e.preventDefault();
    const targetTab = e.currentTarget;
    targetTab.classList.remove('drag-over');
    const targetId = parseInt(targetTab.getAttribute('data-id'));
    if (!draggedTabId || draggedTabId === targetId) return;
    const draggedIndex = tabsData.findIndex(t => t.id === draggedTabId);
    const targetIndex = tabsData.findIndex(t => t.id === targetId);
    if (draggedIndex === -1 || targetIndex === -1) return;
    const [moved] = tabsData.splice(draggedIndex, 1);
    tabsData.splice(targetIndex, 0, moved);
    const updates = tabsData.map((t, idx) => ({ id: t.id, position: idx + 1 }));
    try {
        await apiFetch('/api/tabs/reorder', { method: 'PATCH', body: JSON.stringify(updates) });
        await loadAllData();
    } catch (err) { showNotification('Ошибка порядка вкладок: ' + err.message); await loadAllData(); }
    draggedTabId = null;
}
async function handleCardDropOnTab(e) {
    e.preventDefault();
    const targetTabDiv = e.currentTarget;
    const targetTabId = parseInt(targetTabDiv.getAttribute('data-id'));
    const cardIdStr = e.dataTransfer.getData('text/plain');
    if (!cardIdStr) return;
    const draggedCardId = parseInt(cardIdStr);
    if (isNaN(draggedCardId)) return;
    let fromTabId = null;
    for (const [tabId, cards] of Object.entries(cardsData)) {
        if (cards.find(c => c.id === draggedCardId)) { fromTabId = parseInt(tabId); break; }
    }
    if (!fromTabId || fromTabId === targetTabId) return;
    try {
        await apiFetch('/api/cards/move', {
            method: 'PATCH',
            body: JSON.stringify({ card_id: draggedCardId, to_tab_id: targetTabId })
        });
        await loadCardsForTab(fromTabId);
        await loadCardsForTab(targetTabId);
        if (currentTab === fromTabId || currentTab === targetTabId) {
            if (currentTab === fromTabId) currentTab = targetTabId;
            renderContent();
        }
        renderTabs();
    } catch (err) { showNotification('Ошибка перемещения: ' + err.message); }
}

// ---------- Действия с вкладками ----------
async function switchTab(id) {
    currentTab = id;
    await loadCardsForTab(id);
    renderTabs();
    renderContent();
}
async function renameTabPrompt(tabId) {
    const tab = tabsData.find(t => t.id === tabId);
    if (!tab) return;
    showPrompt('Введите новое название вкладки:', (newName) => {
        if (newName && newName.trim() !== '') {
            apiFetch(`/api/tabs/${tabId}`, { method: 'PUT', body: JSON.stringify({ name: newName.trim() }) })
                .then(() => loadAllData())
                .catch(err => showNotification('Ошибка: ' + err.message));
        }
    }, tab.name, 'Переименование вкладки');
}
async function deleteTab(tabId) {
    if (tabsData.length <= 1) {
        showNotification('Нельзя удалить последнюю вкладку');
        return;
    }
    showConfirm('Удалить вкладку со всеми закладками?', async (confirmed) => {
        if (confirmed) {
            try {
                await apiFetch(`/api/tabs/${tabId}`, { method: 'DELETE' });
                await loadAllData();
            } catch (err) { showNotification('Ошибка: ' + err.message); }
        }
    });
}
async function addNewTab() { document.getElementById('addTabModal').classList.remove('hidden'); }
function closeTabModal() { document.getElementById('addTabModal').classList.add('hidden'); document.getElementById('tabName').value = ''; }
async function saveNewTab() {
    const name = document.getElementById('tabName').value.trim();
    if (!name) { showNotification('Введите название'); return; }
    try {
        await apiFetch('/api/tabs', { method: 'POST', body: JSON.stringify({ name }) });
        closeTabModal();
        await loadAllData();
    } catch (err) { showNotification('Ошибка: ' + err.message); }
}
function toggleEditMode() {
    editMode = !editMode;
    const btn = document.getElementById('editModeBtn');
    if (editMode) {
        btn.style.background = "linear-gradient(90deg, rgb(139 92 246), rgb(167 139 250))";
        btn.style.color = "white";
        btn.style.boxShadow = "0 0 20px rgba(139, 92 246, 0.5)";
    } else {
        btn.style.background = "";
        btn.style.color = "";
        btn.style.boxShadow = "";
    }
    renderTabs();
}
// ---------- Выбор количества колонок ----------
const COLS_KEY = 'bookmark_cols';
const colsClassMap = {
    '1': 'grid-cols-1',
    '2': 'grid-cols-1 md:grid-cols-2',
    '3': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
    '4': 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
};

function initColsSelect() {
    const saved = localStorage.getItem(COLS_KEY) || '4';
    const sel = document.getElementById('colsSelect');
    if (sel) sel.value = saved;
}

function onColsChange(val) {
    localStorage.setItem(COLS_KEY, val);
    applyColsToGrid();
}

function applyColsToGrid() {
    const grid = document.getElementById('cardsGrid');
    if (!grid) return;
    const val = localStorage.getItem(COLS_KEY) || '4';
    // Убрать все cols-классы и поставить нужный
    grid.className = grid.className
        .replace(/grid-cols-\S+/g, '')
        .replace(/md:grid-cols-\S+/g, '')
        .replace(/lg:grid-cols-\S+/g, '')
        .replace(/xl:grid-cols-\S+/g, '')
        .trim();
    const cls = colsClassMap[val] || colsClassMap['4'];
    cls.split(' ').forEach(c => grid.classList.add(c));
}
// ---------- Рендер карточек ----------
function renderContent() {
    const content = document.getElementById('content');
    const tab = tabsData.find(t => t.id === currentTab);
    if (!tab) { content.innerHTML = '<div class="text-center py-20">Ошибка</div>'; return; }
    let html = `<div id="cardsGrid" class="grid gap-5 items-stretch"></div>`;
    content.innerHTML = html;
    applyColsToGrid();
    const grid = document.getElementById('cardsGrid');
    const cards = cardsData[currentTab] || [];
    if (cards.length === 0) { grid.innerHTML = `<div class="col-span-full text-center py-20 text-white/40"><p class="text-xl">Пока пусто...</p></div>`; return; }
    cards.forEach(card => {
        const cardEl = document.createElement('div');
        cardEl.className = 'card bg-slate-900/80 border border-white/10 rounded-3xl p-5 group cursor-pointer draggable-card flex flex-col h-full';
        cardEl.draggable = true;
        cardEl.setAttribute('data-id', card.id);
        cardEl.innerHTML = `
            <div class="flex items-start justify-between mb-4">
                <div class="flex items-center gap-4 flex-1">
                    ${card.image ? `<img src="${escapeHtml(card.image)}" class="card-img" onerror="this.style.display='none'">` : ''}
                    <h3 class="text-xl font-semibold leading-tight">${escapeHtml(card.title)}</h3>
                </div>
                <button onclick="event.stopImmediatePropagation(); deleteCard(${card.id});" class="text-white/30 hover:text-red-400 opacity-0 group-hover:opacity-100"><i class="fa-solid fa-trash"></i></button>
            </div>
            <div class="card-content flex-grow"><p class="text-white/70 line-clamp-5 text-[15px]">${escapeHtml(card.description || '')}</p></div>
            <a href="${escapeHtml(card.url)}" target="_blank" onclick="event.stopImmediatePropagation()" class="go-btn opacity-0 translate-y-2 mt-auto inline-flex items-center justify-center gap-3 w-full px-5 py-3 bg-white/5 hover:bg-white/10 border border-white/20 rounded-2xl transition-all group-hover:border-violet-400">Перейти <i class="fa-solid fa-arrow-up-right-from-square"></i></a>
        `;
        cardEl.addEventListener('click', (e) => { if (!e.target.closest('a') && !e.target.closest('button')) editCard(card.id); });
        cardEl.addEventListener('dragstart', handleCardDragStart);
        cardEl.addEventListener('dragend', () => cardEl.classList.remove('dragging'));
        cardEl.addEventListener('dragover', (e) => e.preventDefault());
        cardEl.addEventListener('drop', handleCardDropInside);
        grid.appendChild(cardEl);
    });
}

let draggedCardId = null;
function handleCardDragStart(e) {
    draggedCardId = parseInt(e.currentTarget.getAttribute('data-id'));
    e.dataTransfer.setData('text/plain', draggedCardId);
    e.currentTarget.classList.add('dragging');
}
async function handleCardDropInside(e) {
    e.preventDefault();
    const targetCardDiv = e.currentTarget;
    const targetCardId = parseInt(targetCardDiv.getAttribute('data-id'));
    if (!draggedCardId || draggedCardId === targetCardId) { draggedCardId = null; return; }
    const cards = cardsData[currentTab];
    const draggedIndex = cards.findIndex(c => c.id === draggedCardId);
    const targetIndex = cards.findIndex(c => c.id === targetCardId);
    if (draggedIndex === -1 || targetIndex === -1) { draggedCardId = null; return; }
    const [moved] = cards.splice(draggedIndex, 1);
    cards.splice(targetIndex, 0, moved);
    const updates = cards.map((c, idx) => ({ id: c.id, position: idx + 1 }));
    try {
        await apiFetch('/api/cards/reorder', { method: 'PATCH', body: JSON.stringify({ tab_id: currentTab, order: updates }) });
        cardsData[currentTab] = cards;
        renderContent();
    } catch (err) { showNotification('Ошибка порядка: ' + err.message); await loadCardsForTab(currentTab); renderContent(); }
    draggedCardId = null;
}

// ---------- Загрузка картинки ----------
function triggerImageUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('image', file);
        try {
            const response = await fetch('/api/upload_image', { method: 'POST', body: formData });
            const result = await response.json();
            if (result.url) {
                document.getElementById('cardImage').value = result.url;
                showNotification('Картинка загружена');
            } else {
                showNotification('Ошибка загрузки');
            }
        } catch (err) {
            showNotification('Ошибка: ' + err.message);
        }
    };
    input.click();
}

// ---------- CRUD карточек ----------
function showAddCardModal() {
    editingCardId = null;
    document.getElementById('modalTitle').textContent = 'Добавить закладку';
    document.getElementById('saveCardBtn').textContent = 'Добавить';
    document.getElementById('cardTitle').value = '';
    document.getElementById('cardDesc').value = '';
    document.getElementById('cardUrl').value = '';
    document.getElementById('cardImage').value = '';
    document.getElementById('cardModal').classList.remove('hidden');
}
function editCard(cardId) {
    const card = cardsData[currentTab]?.find(c => c.id === cardId);
    if (!card) return;
    editingCardId = cardId;
    document.getElementById('modalTitle').textContent = 'Редактировать закладку';
    document.getElementById('saveCardBtn').textContent = 'Сохранить';
    document.getElementById('cardTitle').value = card.title;
    document.getElementById('cardDesc').value = card.description || '';
    document.getElementById('cardUrl').value = card.url;
    document.getElementById('cardImage').value = card.image || '';
    document.getElementById('cardModal').classList.remove('hidden');
}
function closeCardModal() { document.getElementById('cardModal').classList.add('hidden'); }
async function saveCard() {
    const title = document.getElementById('cardTitle').value.trim();
    const description = document.getElementById('cardDesc').value.trim();
    let url = document.getElementById('cardUrl').value.trim();
    const image = document.getElementById('cardImage').value.trim();
    if (!title || !url) {
        showNotification('Название и ссылка обязательны');
        return;
    }
    if (!url.startsWith('http')) url = 'https://' + url;
    try {
        if (editingCardId) {
            await apiFetch(`/api/cards/${editingCardId}`, { method: 'PUT', body: JSON.stringify({ title, description, url, image }) });
        } else {
            await apiFetch('/api/cards', { method: 'POST', body: JSON.stringify({ tab_id: currentTab, title, description: description || 'Без описания', url, image }) });
        }
        closeCardModal();
        await loadCardsForTab(currentTab);
        renderContent();
    } catch (err) { showNotification('Ошибка сохранения: ' + err.message); }
}
async function deleteCard(cardId) {
    showConfirm('Удалить закладку?', async (confirmed) => {
        if (confirmed) {
            try {
                await apiFetch(`/api/cards/${cardId}`, { method: 'DELETE' });
                await loadCardsForTab(currentTab);
                renderContent();
            } catch (err) { showNotification('Ошибка удаления: ' + err.message); }
        }
    });
}

// ---------- Импорт из Chrome ----------
async function importFromChrome() {
    showConfirm('Импорт из Chrome добавит новую вкладку "Из Chrome" со всеми закладками. Продолжить?', async (confirmed) => {
        if (confirmed) {
            try {
                const result = await apiFetch('/api/import_chrome', { method: 'POST', body: JSON.stringify({}) });
                showNotification(result.message);
                await loadAllData();
                if (result.tab_id) {
                    await switchTab(result.tab_id);
                }
            } catch (err) {
                showNotification('Ошибка импорта: ' + err.message);
            }
        }
    });
}

// ---------- Экспорт / Импорт JSON ----------
async function exportData() {
    try {
        const data = await apiFetch('/api/export');
        const dataStr = JSON.stringify(data, null, 2);
        const link = document.createElement('a');
        link.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
        link.download = 'my-bookmarks.json';
        link.click();
    } catch (err) { showNotification('Ошибка экспорта: ' + err.message); }
}
async function importData(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function(ev) {
        try {
            const imported = JSON.parse(ev.target.result);
            if (!imported.tabs || !imported.cards) throw new Error('Неверный формат');
            showConfirm('Импорт полностью заменит текущие данные. Продолжить?', async (confirmed) => {
                if (confirmed) {
                    try {
                        await apiFetch('/api/import', { method: 'POST', body: JSON.stringify(imported) });
                        showNotification('Импорт успешно выполнен. Страница будет перезагружена.');
                        window.location.reload();
                    } catch (err) {
                        showNotification('Ошибка импорта: ' + err.message);
                    }
                }
            });
        } catch (err) { showNotification('Ошибка импорта: ' + err.message); }
    };
    reader.readAsText(file);
}

// ---------- Экспорт в Chrome HTML ----------
function exportToChrome() {
    document.getElementById('exportChromeModal').classList.remove('hidden');
}
function closeExportChromeModal() {
    document.getElementById('exportChromeModal').classList.add('hidden');
}

function doExportToChrome() {
    const useFolders = document.getElementById('exportFolders').checked;
    const now = Math.floor(Date.now() / 1000);

    // Формируем имя закладки: название + описание
    function bookmarkName(card) {
        const desc = card.description && card.description !== 'Без описания' ? card.description : '';
        return desc ? `${card.title} — ${desc}` : card.title;
    }

    function escapeAttr(str) {
        return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    let body = '';

    if (useFolders) {
        // Каждая вкладка → папка, внутри — закладки в порядке как есть
        tabsData.forEach(tab => {
            const cards = cardsData[tab.id] || [];
            body += `    <DT><H3 ADD_DATE="${now}">${escapeAttr(tab.name)}</H3>\n    <DL><p>\n`;
            cards.forEach(card => {
                body += `        <DT><A HREF="${escapeAttr(card.url)}" ADD_DATE="${now}">${escapeAttr(bookmarkName(card))}</A>\n`;
            });
            body += `    </DL><p>\n`;
        });
    } else {
        // Все закладки плоско, порядок: вкладка за вкладкой, внутри — по position
        tabsData.forEach(tab => {
            const cards = cardsData[tab.id] || [];
            cards.forEach(card => {
                body += `    <DT><A HREF="${escapeAttr(card.url)}" ADD_DATE="${now}">${escapeAttr(bookmarkName(card))}</A>\n`;
            });
        });
    }

    const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
${body}</DL><p>`;

    const link = document.createElement('a');
    link.href = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    link.download = 'bookmarks-chrome.html';
    link.click();
    closeExportChromeModal();
}
// ---------- Глобальный поиск с выпадающим списком (регистронезависимый) ----------
async function searchBookmarks(showFull = false) {
    const query = document.getElementById('searchInput').value;
    const searchQuery = query.trim();
    const clearBtn = document.getElementById('clearSearchBtn');
    const dropdown = document.getElementById('searchDropdown');
    const resultsContainer = document.getElementById('searchDropdownResults');

    if (!searchQuery) {
        clearBtn.classList.add('hidden');
        dropdown.classList.add('hidden');
        return;
    }
    clearBtn.classList.remove('hidden');

    if (searchQuery.length < 2) {
        dropdown.classList.add('hidden');
        return;
    }

    const lowerQuery = searchQuery.toLowerCase();

    try {
        const allCards = [];
        for (const tab of tabsData) {
            const cards = cardsData[tab.id] || [];
            for (const card of cards) {
                allCards.push({ ...card, tabName: tab.name, tabId: tab.id });
            }
        }

        // ОТЛАДКА: выводим первые несколько карточек и их заголовки
        console.log('=== ОТЛАДКА ПОИСКА ===');
        console.log('Ищем:', searchQuery, 'нижний регистр:', lowerQuery);
        console.log('Всего карточек:', allCards.length);
        console.log('Примеры заголовков первых 5 карточек:');
        for (let i = 0; i < Math.min(5, allCards.length); i++) {
            console.log(`  ${i+1}: "${allCards[i].title}" (нижний регистр: "${allCards[i].title.toLowerCase()}")`);
        }

        // Фильтрация
        const results = allCards.filter(card => {
            const titleMatch = card.title.toLowerCase().includes(lowerQuery);
            const descMatch = card.description && card.description.toLowerCase().includes(lowerQuery);
            const urlMatch = card.url.toLowerCase().includes(lowerQuery);
            if (titleMatch || descMatch || urlMatch) {
                console.log('СОВПАДЕНИЕ:', card.title);
            }
            return titleMatch || descMatch || urlMatch;
        });

        console.log('Найдено результатов:', results.length);
        console.log('========================');

        if (showFull) {
            if (results.length === 0) {
                showNotification('Ничего не найдено');
                return;
            }
            displaySearchResults(results, searchQuery);
            document.getElementById('searchModal').classList.remove('hidden');
            searchModalOpen = true;
            dropdown.classList.add('hidden');
            return;
        }

        // Выпадающий список (первые 10)
        if (results.length === 0) {
            resultsContainer.innerHTML = '<div class="text-center text-white/40 py-4">Ничего не найдено</div>';
        } else {
            resultsContainer.innerHTML = '';
            const displayResults = results.slice(0, 10);
            displayResults.forEach(card => {
                const div = document.createElement('div');
                div.className = 'bg-slate-800/70 rounded-xl p-3 hover:bg-slate-700/70 cursor-pointer transition-all';
                const titleHtml = highlightText(card.title, searchQuery);
                const descHtml = card.description ? highlightText(card.description, searchQuery) : '';
                div.innerHTML = `
                    <div class="flex items-center gap-3">
                        ${card.image ? `<img src="${escapeHtml(card.image)}" class="w-8 h-8 rounded object-contain" onerror="this.style.display='none'">` : ''}
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2">
                                <span class="font-medium">${titleHtml}</span>
                                <span class="text-xs text-violet-300">${escapeHtml(card.tabName)}</span>
                            </div>
                            ${descHtml ? `<div class="text-white/60 text-xs truncate">${descHtml}</div>` : ''}
                            <div class="text-violet-400 text-xs truncate">${highlightText(card.url, searchQuery)}</div>
                        </div>
                        <a href="${escapeHtml(card.url)}" target="_blank" class="px-3 py-1 bg-violet-600 rounded-lg text-xs hover:bg-violet-500" onclick="event.stopPropagation()">Перейти</a>
                    </div>
                `;
                div.addEventListener('click', (e) => {
                    if (!e.target.closest('a')) {
                        window.open(card.url, '_blank');
                    }
                });
                resultsContainer.appendChild(div);
            });
            if (results.length > 10) {
                const moreDiv = document.createElement('div');
                moreDiv.className = 'text-center text-violet-300 text-sm py-2 cursor-pointer hover:underline';
                moreDiv.textContent = `+ ещё ${results.length - 10} результатов. Нажмите Enter для полного списка.`;
                moreDiv.addEventListener('click', () => searchBookmarks(true));
                resultsContainer.appendChild(moreDiv);
            }
        }
        dropdown.classList.remove('hidden');
    } catch (err) {
        showNotification('Ошибка поиска: ' + err.message);
        console.error(err);
    }
}

// Подсветка совпадений (без учёта регистра)
function highlightText(text, query) {
    if (!text || !query) return text || '';
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');
    return text.replace(regex, '<mark>$1</mark>');
}

function displaySearchResults(results, query) {
    const container = document.getElementById('searchResults');
    container.innerHTML = '';
    if (results.length === 0) {
        container.innerHTML = '<div class="text-center text-white/40 py-8">Ничего не найдено</div>';
        return;
    }
    results.forEach(card => {
        const div = document.createElement('div');
        div.className = 'bg-slate-800/70 rounded-2xl p-4 border border-white/10 hover:border-violet-400 transition-all';
        const titleHtml = highlightText(card.title, query);
        const descHtml = card.description ? highlightText(card.description, query) : '';
        const urlHtml = highlightText(card.url, query);
        div.innerHTML = `
            <div class="flex items-start gap-4">
                ${card.image ? `<img src="${escapeHtml(card.image)}" class="w-12 h-12 rounded-lg object-contain flex-shrink-0" onerror="this.style.display='none'">` : ''}
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <h3 class="text-lg font-semibold">${titleHtml}</h3>
                        <span class="text-xs bg-violet-600/40 px-2 py-0.5 rounded-full">${escapeHtml(card.tabName)}</span>
                    </div>
                    ${descHtml ? `<p class="text-white/70 text-sm mt-1">${descHtml}</p>` : ''}
                    <div class="text-violet-300 text-xs mt-1 truncate">${urlHtml}</div>
                </div>
                <a href="${escapeHtml(card.url)}" target="_blank" class="px-4 py-2 bg-violet-600 hover:bg-violet-500 rounded-xl text-sm flex items-center gap-2 flex-shrink-0">Перейти <i class="fa-solid fa-arrow-up-right-from-square"></i></a>
            </div>
        `;
        container.appendChild(div);
    });
}

function closeSearchModal() {
    document.getElementById('searchModal').classList.add('hidden');
    searchModalOpen = false;
}

function clearSearch() {
    const input = document.getElementById('searchInput');
    input.value = '';
    document.getElementById('clearSearchBtn').classList.add('hidden');
    document.getElementById('searchDropdown').classList.add('hidden');
}

function setupSearchDropdown() {
    const input = document.getElementById('searchInput');
    const dropdown = document.getElementById('searchDropdown');
    document.addEventListener('click', (e) => {
        if (!input.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });
    input.addEventListener('blur', () => {
        setTimeout(() => {
            if (!dropdown.contains(document.activeElement)) {
                dropdown.classList.add('hidden');
            }
        }, 200);
    });
}

function setupSearch() {
    const input = document.getElementById('searchInput');
    let debounceTimer;
    input.addEventListener('input', (e) => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            searchBookmarks(false);
        }, 300);
    });
    input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            if (debounceTimer) clearTimeout(debounceTimer);
            searchBookmarks(true);
        }
    });
    setupSearchDropdown();
}

// ==================== WebSocket ====================
let socket;

function connectSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('🟢 WebSocket подключён');
    });

    socket.on('disconnect', () => {
        console.log('🔴 WebSocket отключён');
    });
}

// ---------- Вспомогательные ----------
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// ---------- Инициализация ----------
window.onload = () => {
    initColsSelect();
    loadAllData();
    setupSearch();
    connectSocket();
};