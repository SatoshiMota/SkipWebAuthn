const POLL_MS = 1500;
const MAX_KEYS = 100;
const LANG_KEY = 'skipwebauthn_lang';

let currentTabId = null;
let pollTimer = null;
let lastRaw = '__init__';
let lang = 'en';

const STRINGS = {
  en: {
    importLabel:      'Import key (JSON)',
    importPlaceholder:'Paste key JSON or array...\n[{"id":"...","userName":"..."}]',
    btnImport:        'Add to site',
    btnClear:         'Clear',
    btnDeleteAll:     'Delete all',
    btnCopyAll:       'Copy all',
    noTab:            'No active tab',
    noKeys:           'No keys stored',
    added:            (n) => `Added ${n} key${n !== 1 ? 's' : ''}`,
    updated:          (n) => `Updated ${n} key${n !== 1 ? 's' : ''}`,
    addedAndUpdated:  (a, u) => `Added ${a}, updated ${u}`,
    pasteJson:        'Paste JSON first',
    invalidJson:      'Invalid JSON',
    unknownFormat:    'Unrecognised format',
    saveError:        (m) => `Save error: ${m}`,
    copied:           'Copied to clipboard',
    copyError:        'Copy failed',
    confirmDeleteAll: 'Delete ALL keys for this site?',
    keysHeader:       'Site keys',
    rpidLbl:          'rpId',
    signsLbl:         'Signs',
    createdLbl:       'Created',
    credIdLbl:        'ID',
    copyJson:         'Copy JSON',
    deleteLbl:        'Delete',
    limitNote:        (n) => `${n} / ${MAX_KEYS}`,
  },
  ru: {
    importLabel:      'Импорт ключа (JSON)',
    importPlaceholder:'Вставьте JSON ключа или массив...\n[{"id":"...","userName":"..."}]',
    btnImport:        'Добавить на сайт',
    btnClear:         'Очистить',
    btnDeleteAll:     'Удалить все',
    btnCopyAll:       'Скопировать все',
    noTab:            'Нет активной вкладки',
    noKeys:           'Ключей нет',
    added:            (n) => `Добавлено ${n} ключ${n === 1 ? '' : n < 5 ? 'а' : 'ей'}`,
    updated:          (n) => `Обновлено ${n} ключ${n === 1 ? '' : n < 5 ? 'а' : 'ей'}`,
    addedAndUpdated:  (a, u) => `Добавлено ${a}, обновлено ${u}`,
    pasteJson:        'Вставьте JSON',
    invalidJson:      'Невалидный JSON',
    unknownFormat:    'Формат не распознан',
    saveError:        (m) => `Ошибка: ${m}`,
    copied:           'Скопировано',
    copyError:        'Ошибка копирования',
    confirmDeleteAll: 'Удалить ВСЕ ключи сайта?',
    keysHeader:       'Ключи сайта',
    rpidLbl:          'rpId',
    signsLbl:         'Знаков',
    createdLbl:       'Создан',
    credIdLbl:        'ID',
    copyJson:         'Копировать',
    deleteLbl:        'Удалить',
    limitNote:        (n) => `${n} / ${MAX_KEYS}`,
  }
};

function t(key, ...args) {
  const s = STRINGS[lang][key];
  return typeof s === 'function' ? s(...args) : s;
}

function applyLang() {
  document.getElementById('importLabel').textContent  = t('importLabel');
  document.getElementById('importJson').placeholder   = t('importPlaceholder');
  document.getElementById('btnImport').textContent    = t('btnImport');
  document.getElementById('btnClear').textContent     = t('btnClear');
  document.getElementById('btnDeleteAll').textContent = t('btnDeleteAll');
  document.getElementById('btnCopyAll').textContent   = t('btnCopyAll');
  document.getElementById('keysHeader').textContent   = t('keysHeader');
  document.querySelectorAll('[data-lang]').forEach(el => {
    el.classList.toggle('active', el.dataset.lang === lang);
  });
  if (lastRaw !== '__init__') renderCreds(parseCredMap(lastRaw));
}

function execInTab(func, args = []) {
  return new Promise((resolve, reject) => {
    chrome.scripting.executeScript(
      { target: { tabId: currentTabId }, func, args, world: 'MAIN' },
      (results) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(results?.[0]?.result);
      }
    );
  });
}

function readStorageRaw()   { return localStorage.getItem('webauthn_credentials'); }
function writeStorageRaw(s) { localStorage.setItem('webauthn_credentials', s); window.dispatchEvent(new CustomEvent('webauthn_credentials_updated')); return true; }
function clearStorageFn()   { localStorage.removeItem('webauthn_credentials'); window.dispatchEvent(new CustomEvent('webauthn_credentials_updated')); return true; }

let msgTimer = null;
function setMsg(text, isError = false) {
  const el = document.getElementById('importMsg');
  el.textContent = text;
  el.className = 'msg' + (isError ? ' error' : '');
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => { el.textContent = ''; }, 3500);
}

function parseCredMap(raw) {
  if (!raw) return new Map();
  try {
    const p = JSON.parse(raw);
    if (!Array.isArray(p)) return new Map(Object.entries(p));
    if (p.length === 0) return new Map();
    if (Array.isArray(p[0])) return new Map(p);
    return new Map(p.map(c => [c.id, c]));
  } catch { return new Map(); }
}

function credMapToExportArray(map) {
  return Array.from(map.values());
}

function algoName(alg) {
  return { '-7': 'ES256', '-257': 'RS256', '-8': 'Ed25519' }[alg] || alg || '?';
}

function shortStr(s, n = 32) {
  if (!s) return '—';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function getDisplayName(cred) {
  if (cred.userName) return { name: cred.userName, raw: false };
  return { name: shortStr(cred.id, 28), raw: true };
}

function renderCreds(map) {
  const container = document.getElementById('credsList');
  document.getElementById('countBadge').textContent = t('limitNote', map.size);
  document.getElementById('btnCopyAll').disabled   = map.size === 0;
  document.getElementById('btnDeleteAll').disabled = map.size === 0;

  if (map.size === 0) {
    container.className   = 'empty';
    container.textContent = t('noKeys');
    return;
  }

  const groups = new Map();
  for (const [id, cred] of map) {
    const rp = cred.rpId || '(unknown)';
    if (!groups.has(rp)) groups.set(rp, []);
    groups.get(rp).push([id, cred]);
  }

  container.className = 'creds-list';
  container.innerHTML = '';

  for (const [rpId, entries] of groups) {
    if (groups.size > 1) {
      const label = document.createElement('div');
      label.className   = 'rpid-group-label';
      label.textContent = rpId;
      container.appendChild(label);
    }

    for (const [id, cred] of entries) {
      const { name: displayName, raw: isRaw } = getDisplayName(cred);

      const card = document.createElement('div');
      card.className = 'cred-card';
      card.innerHTML = `
        <div class="cred-top">
          <span class="algo-tag">${algoName(cred.algorithm)}</span>
          <span class="cred-username${isRaw ? ' raw' : ''}">${displayName}</span>
        </div>
        <div class="cred-meta">
          <span class="lbl">${t('rpidLbl')}</span><span class="val">${cred.rpId || '—'}</span>
          <span class="lbl">${t('credIdLbl')}</span><span class="val" title="${id}">${shortStr(id, 38)}</span>
          <span class="lbl">${t('signsLbl')}</span><span class="val">${cred.signCount ?? 0}</span>
          <span class="lbl">${t('createdLbl')}</span><span class="val">${cred.createdAt ? cred.createdAt.slice(0, 19).replace('T', ' ') : '—'}</span>
        </div>
        <div class="cred-actions">
          <button class="btn-secondary btn-icon" data-action="copy" data-id="${id}">${t('copyJson')}</button>
          <button class="btn-danger btn-icon" data-action="delete" data-id="${id}">${t('deleteLbl')}</button>
        </div>
      `;
      container.appendChild(card);
    }
  }

  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { action, id } = btn.dataset;
      if (action === 'copy') {
        const m = parseCredMap(await execInTab(readStorageRaw));
        const entry = m.get(id);
        if (entry) await copyToClipboard(JSON.stringify([entry], null, 2));
      } else if (action === 'delete') {
        await deleteCredential(id);
      }
    });
  });
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    setMsg(t('copied'));
  } catch {
    setMsg(t('copyError'), true);
  }
}

async function poll() {
  try {
    const raw = await execInTab(readStorageRaw);
    const normalized = raw ?? null;
    if (normalized !== lastRaw) {
      lastRaw = normalized;
      renderCreds(parseCredMap(normalized));
    }
  } catch {}
}

function startPolling() {
  clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, POLL_MS);
}

async function importCredentials() {
  const text = document.getElementById('importJson').value.trim();
  if (!text) { setMsg(t('pasteJson'), true); return; }

  let incoming;
  try { incoming = JSON.parse(text); }
  catch { setMsg(t('invalidJson'), true); return; }

  let pairs;
  if (Array.isArray(incoming)) {
    if (incoming.length === 0) { setMsg(t('unknownFormat'), true); return; }
    if (Array.isArray(incoming[0])) {
      pairs = incoming;
    } else if (typeof incoming[0] === 'object' && incoming[0].id) {
      pairs = incoming.map(c => [c.id, c]);
    } else {
      setMsg(t('unknownFormat'), true); return;
    }
  } else if (typeof incoming === 'object' && incoming.id) {
    pairs = [[incoming.id, incoming]];
  } else {
    setMsg(t('unknownFormat'), true); return;
  }

  try {
    const map = parseCredMap(await execInTab(readStorageRaw));
    let added = 0, updated = 0;
    for (const [id, cred] of pairs) {
      if (!id || typeof cred !== 'object') continue;
      map.has(id) ? updated++ : added++;
      map.set(id, cred);
    }
    await execInTab(writeStorageRaw, [JSON.stringify(Array.from(map.values()))]);
    const msg = added > 0 && updated > 0 ? t('addedAndUpdated', added, updated)
              : added > 0 ? t('added', added) : t('updated', updated);
    setMsg(msg);
    document.getElementById('importJson').value = '';
    poll();
  } catch (e) {
    setMsg(t('saveError', e.message), true);
  }
}

async function deleteCredential(id) {
  const map = parseCredMap(await execInTab(readStorageRaw));
  map.delete(id);
  await execInTab(writeStorageRaw, [JSON.stringify(Array.from(map.values()))]);
  poll();
}

async function deleteAllCredentials() {
  if (!confirm(t('confirmDeleteAll'))) return;
  await execInTab(clearStorageFn);
  lastRaw = '__force__';
  await poll();
}

async function copyAllCredentials() {
  const map = parseCredMap(await execInTab(readStorageRaw));
  if (map.size === 0) return;
  await copyToClipboard(JSON.stringify(credMapToExportArray(map), null, 2));
}

async function init() {
  lang = localStorage.getItem(LANG_KEY) === 'ru' ? 'ru' : 'en';

  document.querySelectorAll('[data-lang]').forEach(btn => {
    btn.addEventListener('click', () => {
      lang = btn.dataset.lang;
      localStorage.setItem(LANG_KEY, lang);
      applyLang();
    });
  });

  applyLang();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    const el = document.getElementById('credsList');
    el.className = 'empty';
    el.textContent = t('noTab');
    return;
  }

  currentTabId = tab.id;
  try {
    document.getElementById('originLabel').textContent = new URL(tab.url || '').hostname;
  } catch {
    document.getElementById('originLabel').textContent = tab.url || '?';
  }

  document.getElementById('btnImport').addEventListener('click', importCredentials);
  document.getElementById('btnClear').addEventListener('click', () => {
    document.getElementById('importJson').value = '';
    document.getElementById('importMsg').textContent = '';
  });
  document.getElementById('btnDeleteAll').addEventListener('click', deleteAllCredentials);
  document.getElementById('btnCopyAll').addEventListener('click', copyAllCredentials);
  document.getElementById('importJson').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') importCredentials();
  });

  startPolling();
}

document.addEventListener('DOMContentLoaded', init);
