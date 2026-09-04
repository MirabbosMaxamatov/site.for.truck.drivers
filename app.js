// Client-side logic for Truck Driver Web App
// Features: view navigation, guest mode, finance calc (localStorage+IndexedDB), PWA install prompt,
// service worker registration, and camera scanner placeholder.

(() => {
	'use strict';

	/* ---------- Utilities ---------- */
	const $ = (sel, ctx = document) => ctx.querySelector(sel);
	const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

	/* Simple UUID v4 for guest id */
	const uuidv4 = () => {
		return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
			const r = (Math.random() * 16) | 0;
			const v = c === 'x' ? r : (r & 0x3) | 0x8;
			return v.toString(16);
		});
	};

	/* ---------- Guest Mode ---------- */
	function ensureGuestId() {
		let id = localStorage.getItem('guest_id');
		if (!id) {
			id = `guest-${uuidv4()}`;
			localStorage.setItem('guest_id', id);
			console.info('Generated guest_id', id);
		}
		return id;
	}

	/* ---------- IndexedDB helper ---------- */
	function openDb() {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open('truck-driver-db', 2);
			req.onupgradeneeded = (e) => {
				const db = e.target.result;
				if (!db.objectStoreNames.contains('finance')) db.createObjectStore('finance', { keyPath: 'id' });
				if (!db.objectStoreNames.contains('documents')) db.createObjectStore('documents', { keyPath: 'id' });
			};
			req.onsuccess = (e) => resolve(e.target.result);
			req.onerror = (e) => reject(e.target.error);
		});
	}

	async function saveFinanceToIDB(record) {
		try {
			const db = await openDb();
			const tx = db.transaction('finance', 'readwrite');
			const store = tx.objectStore('finance');
			store.put(record);
			return new Promise((res, rej) => {
				tx.oncomplete = () => res(true);
				tx.onerror = () => rej(tx.error);
			});
		} catch (err) {
			console.warn('IndexedDB save failed', err);
			return false;
		}
	}

	async function readFinanceFromIDB(id = 'weekly') {
		try {
			const db = await openDb();
			const tx = db.transaction('finance', 'readonly');
			const store = tx.objectStore('finance');
			return new Promise((res, rej) => {
				const r = store.get(id);
				r.onsuccess = () => res(r.result);
				r.onerror = () => rej(r.error);
			});
		} catch (err) {
			console.warn('IndexedDB read failed', err);
			return null;
		}
	}

	async function saveDocumentToIDB(doc) {
		const db = await openDb();
		const tx = db.transaction('documents', 'readwrite');
		tx.objectStore('documents').put(doc);
		return new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve(true);
			tx.onerror = () => reject(tx.error);
		});
	}

	async function loadDocumentsFromIDB() {
		try {
			const db = await openDb();
			const tx = db.transaction('documents', 'readonly');
			return new Promise((resolve, reject) => {
				const request = tx.objectStore('documents').getAll();
				request.onsuccess = () => resolve(request.result || []);
				request.onerror = () => reject(request.error);
			});
		} catch (err) {
			console.warn('IndexedDB document read failed', err);
			return [];
		}
	}

	/* ---------- Finance logic ---------- */
	const financeKey = 'finance_weekly';
	const incomesKey = 'weekly_incomes';
	const expensesKey = 'weekly_expenses';
	const financialArchivesKey = 'archived_financial_reports';
	let editingFinanceEntry = null;

	function parseAmount(v) {
		if (v === null || v === undefined || v === '') return 0;
		return Number(String(v).replace(/[^0-9.-]+/g, '')) || 0;
	}

	function formatToInputDate(dateStr) {
		if (!dateStr) return new Date().toISOString().split('T')[0];
		if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
		const parsed = new Date(dateStr);
		if (isNaN(parsed.getTime())) return new Date().toISOString().split('T')[0];
		const year = parsed.getFullYear();
		const month = String(parsed.getMonth() + 1).padStart(2, '0');
		const day = String(parsed.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	function normalizeTelegramText(str) {
		return String(str || '')
			.normalize('NFKD')
			.replace(/[\uD835][\uDC00-\uDFFF]/g, (char) => {
				const code = char.codePointAt(0);
				if (code >= 0x1D400 && code <= 0x1D419) return String.fromCharCode(code - 0x1D400 + 65);
				if (code >= 0x1D41A && code <= 0x1D433) return String.fromCharCode(code - 0x1D41A + 97);
				if (code >= 0x1D5D4 && code <= 0x1D5ED) return String.fromCharCode(code - 0x1D5D4 + 65);
				if (code >= 0x1D5EE && code <= 0x1D607) return String.fromCharCode(code - 0x1D5EE + 97);
				return char;
			})
			.replace(/\u00A0/g, ' ')
			.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
	}

	function createLoadObject({ tripId, rateAmount, rpmValue, originCityState, destCityState, milesValue, durationValue, parsedDate, extractedFinesArray = [] }) {
		return {
			id: tripId || 'N/A',
			gross: Number(rateAmount || 0),
			rpm: rpmValue || null,
			origin: originCityState || 'Cicero, IL',
			destination: destCityState || 'Pontiac, MI',
			miles: milesValue || '0',
			duration: durationValue || '0d 0h',
			date: parsedDate || new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
			fines: extractedFinesArray
		};
	}

	function parseTelegramText(text) {
		const cleanText = normalizeTelegramText(text).replace(/\r/g, '');
		const source = cleanText;
		const match = (pattern) => source.match(pattern)?.[1]?.trim() || '';
		const tripId = match(/Trip\s*ID\s*:\s*([A-Za-z0-9]+)/i) || match(/1#:\s*([A-Za-z0-9]+)/i) || 'N/A';
		const rateMatch = source.match(/(?:Rate|💰\s*Rate)\s*:\s*\$?([\d,]+(?:\.\d{2})?)/i);
		const rate = rateMatch ? parseFloat(rateMatch[1].replace(/,/g, '')) : null;
		let gross = rate;
		if (!gross) {
			const fallbackMatch = source.match(/\$\s*([\d,]+(?:\.\d{2})?)/);
			gross = fallbackMatch ? parseFloat(fallbackMatch[1].replace(/,/g, '')) : null;
		}
		gross = gross || 0;
		const miles = parseFloat(match(/Trip:\s*([\d.]+)\s*mi/i)) || 0;
		const parsedRpm = parseFloat(match(/Per\s*mile:\s*\$?([\d.]+)/i)) || 0;
		const duration = match(/Duration\s*:\s*([0-9]+\s*[dh](?:\s*[0-9]+\s*[hm])?)/i).replace(/[©®&]/g, '').trim();
		const stopBlocks = [...source.matchAll(/(?:^|\n)[^\r\n]*?(?:[123]#|Stop\s*[123])\s*:\s*([\s\S]*?)(?=\n[^\r\n]*?(?:[123]#|Stop\s*[123])\s*:|\n\s*(?:Rate|Trip\s*ID|Trip:|Per\s*mile|Late|Duration)\s*:|$)/gi)].map(matchResult => matchResult[1]);
		const cityState = (block) => {
			const exact = String(block || '').match(/([A-Za-z][A-Za-z .'-]*),\s*([A-Z]{2})\s*\d{5}(?:-\d{4})?/);
			if (exact) return `${exact[1].replace(/\s+/g, ' ').trim()}, ${exact[2]}`;
			const lines = String(block || '').split('\n').map(line => line.replace(/[©®&]/g, '').trim()).filter(Boolean);
			return lines.at(-1) || '';
		};
		const origin = cityState(stopBlocks[0]);
		const destination = cityState(stopBlocks.at(-1));
		const dateMatch = stopBlocks[0]?.match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*([A-Za-z]+\s+\d+)/i);
		const date = dateMatch ? `${dateMatch[1]}, ${new Date().getFullYear()}` : new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
		const latePuFine = parseFloat(match(/Late\s*PU:\s*\$?([\d,]+)/i).replace(/,/g, '')) || 0;
		return createLoadObject({
			tripId,
			rateAmount: Number(gross.toFixed(2)),
			rpmValue: parsedRpm || (miles > 0 ? Number((gross / miles).toFixed(2)) : null),
			originCityState: origin,
			destCityState: destination,
			milesValue: miles > 0 ? miles : '0',
			durationValue: duration,
			parsedDate: date,
			extractedFinesArray: latePuFine > 0 ? [{ type: 'Late PU', amount: latePuFine }] : []
		});
	}

	async function saveParsedLoad() {
		const status = $('#load-parser-status');
		const parsed = parseTelegramText($('#paste-load-text')?.value);
		if (!parsed.gross) {
			if (status) {
				status.textContent = 'Could not find a Rate in the dispatch text.';
				status.classList.add('is-error');
			}
			return;
		}
		const income = { ...parsed, dateAdded: new Date().toISOString(), pickupDate: parsed.date, deliveryDate: '' };
		const incomes = loadEntries(incomesKey);
		incomes.push(income);
		saveEntries(incomesKey, incomes);
		await persistFinance(loadFinanceFromStorage());
		if (status) {
			status.textContent = `Imported ${income.tripId || 'load'} at ${formatCurrency(income.gross)}.`;
			status.classList.remove('is-error');
		}
		switchTab('finance-section');
		showToast('Load imported successfully!');
	}

	async function runLoadOcr(file) {
		const status = $('#load-parser-status');
		if (!file || !file.type.startsWith('image/')) return;
		if (!window.Tesseract) {
			if (status) status.textContent = 'OCR library is still loading. Please try again.';
			return;
		}
		if (status) {
			status.textContent = 'Reading screenshot...';
			status.classList.remove('is-error');
		}
		try {
			const result = await window.Tesseract.recognize(file, 'eng', {
				logger: message => {
					if (status && message.status === 'recognizing text' && message.progress) status.textContent = `Reading screenshot... ${Math.round(message.progress * 100)}%`;
				}
			});
			$('#paste-load-text').value = result.data.text;
			if (status) status.textContent = 'Screenshot text extracted. Review it, then parse and save.';
		} catch (error) {
			console.warn('Load OCR failed', error);
			if (status) {
				status.textContent = 'Could not read that screenshot.';
				status.classList.add('is-error');
			}
		}
	}

	function attachLoadParserHandlers() {
		const input = $('#upload-screenshot-input');
		const dropzone = $('#upload-screenshot-dropzone');
		const selectFile = () => input?.click();
		if (input) input.addEventListener('change', event => {
			runLoadOcr(event.target.files?.[0]);
			event.target.value = '';
		});
		if (!dropzone) return;
		dropzone.addEventListener('click', selectFile);
		dropzone.addEventListener('keydown', event => {
			if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectFile(); }
		});
		['dragenter', 'dragover'].forEach(type => dropzone.addEventListener(type, event => {
			event.preventDefault(); dropzone.classList.add('is-dragging');
		}));
		['dragleave', 'drop'].forEach(type => dropzone.addEventListener(type, event => {
			event.preventDefault(); dropzone.classList.remove('is-dragging');
		}));
		dropzone.addEventListener('drop', event => runLoadOcr(event.dataTransfer.files?.[0]));
		$('#parse-save-load-btn')?.addEventListener('click', saveParsedLoad);
	}

	function formatCurrency(n) {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
	}

	function makeEntry(amount, label) {
		return { id: uuidv4(), amount: Number(amount.toFixed(2)), label: label || '', createdAt: Date.now() };
	}

	function loadEntries(key) {
		try {
			const raw = localStorage.getItem(key);
			return raw ? JSON.parse(raw) : [];
		} catch (err) {
			console.warn(`Failed to read ${key}`, err);
			return [];
		}
	}

	function saveEntries(key, entries) {
		localStorage.setItem(key, JSON.stringify(entries));
	}

	function loadFinanceFromStorage() {
		const raw = localStorage.getItem(financeKey);
		const fin = raw ? JSON.parse(raw) : { id: 'weekly', gross: 0, expenses: 0, net: 0, updatedAt: Date.now() };
		if (!localStorage.getItem(incomesKey) && Number(fin.gross) > 0) saveEntries(incomesKey, [makeEntry(Number(fin.gross), 'Weekly gross')]);
		if (!localStorage.getItem(expensesKey) && Number(fin.expenses) > 0) saveEntries(expensesKey, [makeEntry(Number(fin.expenses), 'Existing expenses')]);
		const incomes = loadEntries(incomesKey);
		const expenses = loadEntries(expensesKey);
		fin.gross = incomes.reduce((sum, entry) => sum + parseAmount(entry.gross ?? entry.amount), 0);
		fin.expenses = expenses.reduce((sum, entry) => sum + parseAmount(entry.amount), 0);
		fin.net = Number((fin.gross - fin.expenses).toFixed(2));
		return fin;
	}

	async function persistFinance(fin) {
		fin.net = Number((fin.gross - fin.expenses).toFixed(2));
		fin.updatedAt = Date.now();
		localStorage.setItem(financeKey, JSON.stringify(fin));
		// store to indexedDB (best-effort)
		try { await saveFinanceToIDB(fin); } catch (e) { /* ignore */ }
		renderFinance(fin);
	}

	function renderFinance(fin) {
		const grossInput = $('#input-weekly-gross');
		const expInput = $('#input-weekly-expenses');
		const netEl = $('#weekly-net');
		if (grossInput) grossInput.textContent = formatCurrency(Number(fin.gross || 0));
		if (expInput) expInput.textContent = formatCurrency(Number(fin.expenses || 0));
		if (netEl) netEl.textContent = formatCurrency(fin.net);
		renderFinanceBreakdown();
	}

	function renderFinanceBreakdown() {
		const container = $('#finance-history-list');
		if (!container) return;
		container.textContent = '';
		const categoryIcons = { Fuel: '⛽', Tolls: '🛣️', Maintenance: '🛠️', Food: '🍔', Other: '📦' };
		const entries = [
			...loadEntries(incomesKey).map(entry => ({ ...entry, type: 'income', title: entry.loadNo || entry.tripId || entry.id || entry.label || 'Load' })),
			...loadEntries(expensesKey).map(entry => ({
				...entry,
				type: 'expense',
				title: entry.category ? `${categoryIcons[entry.category] || ''} ${entry.category}${entry.note ? ` - ${entry.note}` : ''}`.trim() : (entry.label || 'Expense')
			}))
		].sort((a, b) => new Date(b.dateAdded || b.date || b.createdAt || 0) - new Date(a.dateAdded || a.date || a.createdAt || 0));
		if (!entries.length) return;

		const heading = document.createElement('h4');
		heading.textContent = 'Income & Expense History';
		container.appendChild(heading);
		const list = document.createElement('ul');
		list.className = 'finance-breakdown-list';
		entries.forEach(entry => {
			const item = document.createElement('li');
			const entryGross = parseAmount(entry.gross ?? entry.amount);
			const entryMiles = parseAmount(entry.miles);
			const entryRpm = entry.type === 'income' && entryMiles > 0 ? (parseAmount(entry.rpm) || entryGross / entryMiles).toFixed(2) : '';
			const formatFine = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: Number(value) % 1 ? 2 : 0 }).format(value);
			const formatTripDate = value => {
				if (!value) return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
				const parsed = new Date(String(value).length === 10 && String(value).includes('-') ? `${value}T00:00:00` : value);
				return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
			};
			const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
			if (entry.type === 'income') {
				const fine = parseAmount(entry.fines?.find(item => item.type === 'Late PU')?.amount ?? entry.driverMore?.latePuFine);
				item.innerHTML = `
					<div class="income-entry-details">
						<div class="finance-entry-title"><strong>Trip: ${escapeHtml(entry.tripId || entry.id || entry.title)}</strong><span class="income-amount"> | +${formatCurrency(entryGross)}${entryRpm ? ` ($${entryRpm}/mi)` : ''}</span></div>
						<div class="finance-entry-meta finance-route">📍 ${escapeHtml(entry.origin || 'Origin not set')} ➔ ${escapeHtml(entry.destination || 'Destination not set')}</div>
						<div class="finance-entry-meta finance-metrics">🚚 ${entryMiles > 0 ? `${entryMiles} mi` : '-- mi'} | ⏱️ ${escapeHtml(entry.duration || '--')}</div>
						<div class="finance-entry-meta finance-date">📅 ${escapeHtml(formatTripDate(entry.date || entry.pickupDate))}</div>
						${fine > 0 ? `<span class="fine-badge">❌ Late PU: ${formatFine(fine)}</span>` : ''}
					</div>`;
			} else {
				item.innerHTML = `<div class="expense-entry-details"><div class="finance-entry-title"><strong>${escapeHtml(entry.title)}:</strong> <span class="expense-amount">-${formatCurrency(entryGross)}</span></div></div>`;
			}
			const actions = document.createElement('div');
			actions.className = 'finance-entry-actions';
			const deleteButton = document.createElement('button');
			deleteButton.className = 'delete-finance-entry';
			deleteButton.type = 'button';
			deleteButton.dataset.entryType = entry.type;
			deleteButton.dataset.entryId = entry.id;
			deleteButton.setAttribute('aria-label', `Delete ${entry.title}`);
			deleteButton.textContent = '🗑️';
			const editButton = document.createElement('button');
			editButton.className = 'edit-finance-entry';
			editButton.type = 'button';
			editButton.dataset.entryType = entry.type;
			editButton.dataset.entryId = entry.id;
			editButton.setAttribute('aria-label', `Edit ${entry.title}`);
			editButton.textContent = '✏️';
			actions.append(editButton, deleteButton);
			item.appendChild(actions);
			list.appendChild(item);
		});
		container.appendChild(list);
	}

	function closeIncomeModal() {
		const modal = $('#add-income-modal');
		if (modal) modal.setAttribute('aria-hidden', 'true');
		$('#add-income-form')?.reset();
		$('#income-stops-list').textContent = '';
		setDriverMoreState(false);
		updateIncomeRpm();
		editingFinanceEntry = null;
	}

	function openIncomeModal() {
		const modal = $('#add-income-modal');
		if (!modal) return;
		modal.setAttribute('aria-hidden', 'false');
		updateLanguage(getSavedLang());
		$('#income-gross')?.focus();
	}

	function editFinanceEntry(type, id) {
		const key = type === 'income' ? incomesKey : expensesKey;
		const entry = loadEntries(key).find(item => item.id === id);
		if (!entry) return;
		editingFinanceEntry = { type, id };
		if (type === 'income') {
			$('#income-trip-id').value = entry.tripId || '';
			$('#income-load-number').value = entry.loadNo || entry.label || '';
			$('#income-gross').value = entry.gross ?? entry.amount ?? '';
			$('#income-origin').value = entry.origin || '';
			$('#income-destination').value = entry.destination || '';
			$('#income-pickup-date').value = formatToInputDate(entry.pickupDate || entry.date);
			$('#income-delivery-date').value = formatToInputDate(entry.deliveryDate || entry.date);
			$('#income-duration').value = entry.duration || '';
			$('#income-miles').value = entry.miles || '';
			$('#income-stops-list').textContent = '';
			(entry.stops || []).forEach(stop => addIncomeStop(stop));
			const fines = entry.driverMore || {};
			$('#driver-more-checkbox').checked = Boolean(entry.driverMore);
			setDriverMoreState(Boolean(entry.driverMore));
			$('#fine-late-pu').value = fines.latePuFine || '';
			$('#fine-no-photos').value = fines.noPhotosFine || '';
			$('#fine-custom-notes').value = fines.customNotes || '';
			openIncomeModal();
		} else {
			$('#expense-amount').value = entry.amount || '';
			$('#expense-category').value = entry.category || 'Other';
			$('#expense-note-input').value = entry.note || '';
			openExpenseModal();
		}
	}

	function updateIncomeRpm() {
		const rpmLabel = $('#income-rpm-label');
		if (!rpmLabel) return;
		const gross = parseAmount($('#income-gross')?.value);
		const miles = parseAmount($('#income-miles')?.value);
		if (gross > 0 && miles > 0) {
			rpmLabel.textContent = `RPM: $${(gross / miles).toFixed(2)}/mi`;
		} else {
			rpmLabel.textContent = getTranslation('income.rpm_calc') || 'RPM: Add miles to calculate';
		}
	}

	function addIncomeStop(value = '') {
		const list = $('#income-stops-list');
		if (!list) return;
		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'modal-input income-intermediate-stop';
		input.maxLength = 120;
		input.dataset.i18nPlaceholder = 'income.intermediate_placeholder';
		input.placeholder = getTranslation('income.intermediate_placeholder') || 'Intermediate stop, e.g. Marinette, WI';
		input.value = value;
		input.setAttribute('aria-label', 'Intermediate stop');
		list.appendChild(input);
		input.focus();
	}

	function setDriverMoreState(isEnabled) {
		const container = $('#driver-more-container');
		if (container) {
			container.classList.toggle('is-open', isEnabled);
			container.setAttribute('aria-hidden', isEnabled ? 'false' : 'true');
		}
		$$('.driver-more-input').forEach(input => {
			input.disabled = !isEnabled;
			if (!isEnabled) input.value = '';
		});
	}

	function closeExpenseModal() {
		const modal = $('#expense-modal');
		if (modal) modal.setAttribute('aria-hidden', 'true');
		$('#expense-form')?.reset();
		editingFinanceEntry = null;
	}

	function openExpenseModal() {
		const modal = $('#expense-modal');
		if (!modal) return;
		modal.setAttribute('aria-hidden', 'false');
		$('#expense-amount')?.focus();
	}

	async function handleAddIncome(event) {
		event.preventDefault();
		const gross = parseAmount($('#income-gross')?.value);
		if (gross <= 0) {
			alert('Please enter a valid amount greater than 0');
			return;
		}
		const tripId = $('#income-trip-id')?.value.trim() || $('#income-load-number')?.value.trim() || 'N/A';
		const miles = parseAmount($('#income-miles')?.value);
		const driverMore = $('#driver-more-checkbox')?.checked;
		const incomes = loadEntries(incomesKey);
		const income = {
			...createLoadObject({
				tripId,
				rateAmount: Number(gross.toFixed(2)),
				rpmValue: miles > 0 ? Number((gross / miles).toFixed(2)) : null,
				originCityState: $('#income-origin')?.value.trim(),
				destCityState: $('#income-destination')?.value.trim(),
				milesValue: miles > 0 ? miles : '0',
				durationValue: $('#income-duration')?.value.trim(),
				parsedDate: $('#income-pickup-date')?.value || '',
				extractedFinesArray: driverMore && parseAmount($('#fine-late-pu')?.value) > 0
					? [{ type: 'Late PU', amount: parseAmount($('#fine-late-pu')?.value) }]
					: []
			}),
			dateAdded: new Date().toISOString(),
			pickupDate: $('#income-pickup-date')?.value || '',
			deliveryDate: $('#income-delivery-date')?.value || ''
		};
		if (editingFinanceEntry?.type === 'income') {
			const index = incomes.findIndex(entry => entry.id === editingFinanceEntry.id);
			if (index >= 0) incomes[index] = income;
		} else {
			incomes.push(income);
		}
		saveEntries(incomesKey, incomes);
		await persistFinance(loadFinanceFromStorage());
		editingFinanceEntry = null;
		closeIncomeModal();
	}

	async function handleAddExpense(event) {
		event.preventDefault();
		const amount = parseAmount($('#expense-amount')?.value);
		if (amount <= 0) {
			alert('Please enter a valid amount greater than 0');
			return;
		}
		const category = $('#expense-category')?.value || 'Other';
		const note = $('#expense-note-input')?.value.trim() || '';
		const expenses = loadEntries(expensesKey);
		const expense = { id: editingFinanceEntry?.type === 'expense' ? editingFinanceEntry.id : uuidv4(), amount: Number(amount.toFixed(2)), category, note, date: new Date().toISOString() };
		if (editingFinanceEntry?.type === 'expense') {
			const index = expenses.findIndex(entry => entry.id === editingFinanceEntry.id);
			if (index >= 0) expenses[index] = expense;
		} else expenses.push(expense);
		saveEntries(expensesKey, expenses);
		await persistFinance(loadFinanceFromStorage());
		editingFinanceEntry = null;
		closeExpenseModal();
	}

	async function deleteFinanceEntry(type, id) {
		const key = type === 'income' ? incomesKey : expensesKey;
		const entries = loadEntries(key).filter(entry => entry.id !== id);
		saveEntries(key, entries);
		await persistFinance(loadFinanceFromStorage());
	}

	function attachFinanceEditable() {
		renderFinance(loadFinanceFromStorage());
	}

	/* ---------- Navigation ---------- */
	// Centralized section registry (clean architecture)
	const SECTIONS = ['finance-section', 'archive-section', 'load-parser-section', 'chat-section'];

	// Map logical section ids to actual selectors in the DOM
	const SECTION_SELECTORS = {
		'finance-section': ['.dashboard'],
		'archive-section': ['#archive-section'],
		'load-parser-section': ['#load-parser-section'],
		'chat-section': []
	};

	// Map view names (nav data-nav) to logical section ids
	const VIEW_TO_SECTION_ID = {
		finance: 'finance-section',
		archive: 'archive-section',
		'load-parser': 'load-parser-section',
		chat: 'chat-section'
	};

	function switchTab(targetSectionId) {
		const main = $('#main');
		if (!main) return;

		// Ensure each registered section element has the tab-content class
		SECTIONS.forEach(secId => {
			const sels = SECTION_SELECTORS[secId] || ['#' + secId];
			sels.forEach(sel => {
				const el = $(sel);
				if (!el) return;
				if (!el.classList.contains('tab-content')) el.classList.add('tab-content');
			});
		});

		// Show only the selectors that belong to the target section
		SECTIONS.forEach(secId => {
			const shouldShowSection = (secId === targetSectionId);
			const sels = SECTION_SELECTORS[secId] || ['#' + secId];
			sels.forEach(sel => {
				const el = $(sel);
				if (!el) return;
				if (shouldShowSection) {
					el.setAttribute('aria-hidden', 'false');
					el.classList.add('active');
					el.classList.remove('sr-only');
					el.style.display = '';
				} else {
					el.setAttribute('aria-hidden', 'true');
					el.classList.remove('active');
					el.classList.add('sr-only');
					el.style.display = 'none';
				}
			});
		});

		// Update nav button active state (reverse lookup)
		$$('.nav-btn').forEach(btn => {
			const viewName = btn.dataset.nav;
			const mapped = VIEW_TO_SECTION_ID[viewName];
			const isActive = mapped === targetSectionId;
			btn.classList.toggle('active', isActive);
			btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
		});

		// Special actions for certain sections
		if (targetSectionId === 'archive-section') renderArchive();
		if (targetSectionId === 'chat-section') alert('Chat is not implemented yet — placeholder.');
	}

	// Runtime sanity check to ensure no registered section elements are nested inside other sections
	function verifyTabIsolation() {
		let ok = true;
		SECTIONS.forEach(parentId => {
			const parentSelectors = SECTION_SELECTORS[parentId] || ['#' + parentId];
			parentSelectors.forEach(parentSel => {
				const parentEl = $(parentSel);
				if (!parentEl) return;
				// check other registered elements are not descendants of this parent
				SECTIONS.forEach(childId => {
					if (childId === parentId) return;
					const childSelectors = SECTION_SELECTORS[childId] || ['#' + childId];
					childSelectors.forEach(childSel => {
						const childEl = $(childSel);
						if (!childEl) return;
						if (parentEl.contains(childEl)) {
							console.error(`Tab isolation violation: element ${childSel} is nested inside ${parentSel}`);
							childEl.classList.add('tab-bleed-warning');
							ok = false;
						}
					});
				});
			});
		});
		if (!ok) {
			console.warn('verifyTabIsolation detected layout issues. Inspect elements with .tab-bleed-warning');
		}
		return ok;
	}

	function attachNavHandlers() {
		$$('.nav-btn').forEach(btn => {
			btn.addEventListener('click', (e) => {
				const view = btn.dataset.nav;
				const target = VIEW_TO_SECTION_ID[view] || view;
				switchTab(target);
			});
		});
	}

	function getActiveFinanceEntries() {
		return [
			...loadEntries(incomesKey).map(item => ({ ...item, type: 'income' })),
			...loadEntries(expensesKey).map(item => ({ ...item, type: 'expense' }))
		];
	}

	function openResetFinanceModal() {
		if (!getActiveFinanceEntries().length) return;
		$('#reset-finance-modal')?.setAttribute('aria-hidden', 'false');
	}

	function closeResetFinanceModal() {
		$('#reset-finance-modal')?.setAttribute('aria-hidden', 'true');
	}

	async function confirmResetFinances() {
		const items = getActiveFinanceEntries();
		if (!items.length) return closeResetFinanceModal();
		const fin = loadFinanceFromStorage();
		const dates = items.map(item => item.pickupDate || item.date || item.dateAdded).filter(Boolean).map(value => String(value).slice(0, 10)).sort();
		const range = dates.length ? `${dates[0]} - ${dates[dates.length - 1]}` : new Date().toLocaleDateString();
		const reports = loadEntries(financialArchivesKey);
		reports.unshift({
			id: uuidv4(),
			title: `Weekly Report (${range})`,
			gross: fin.gross,
			expenses: fin.expenses,
			netPay: fin.net,
			items,
			createdAt: new Date().toISOString()
		});
		saveEntries(financialArchivesKey, reports);
		localStorage.removeItem(financeKey);
		localStorage.removeItem(incomesKey);
		localStorage.removeItem(expensesKey);
		closeResetFinanceModal();
		renderFinance({ gross: 0, expenses: 0, net: 0 });
		saveFinanceToIDB({ id: 'weekly', gross: 0, expenses: 0, net: 0, updatedAt: Date.now() });
		renderFinancialArchives();
	}

	function resetFinances() {
		if (!getActiveFinanceEntries().length) return;
		openResetFinanceModal();
	}

	/* ---------- PWA install prompt ---------- */
	let deferredPrompt = null;
	function showInstallBanner(show = true) {
		const banner = $('#pwa-install');
		if (!banner) return;
		if (show) {
			banner.style.display = '';
			banner.setAttribute('aria-hidden', 'false');
		} else {
			banner.style.display = 'none';
			banner.setAttribute('aria-hidden', 'true');
		}
	}

	function attachInstallHandlers() {
		const installBtn = $('#install-btn');
		const dismiss = $('#dismiss-install');
		if (installBtn) {
			installBtn.addEventListener('click', async () => {
				if (!deferredPrompt) return;
				deferredPrompt.prompt();
				const { outcome } = await deferredPrompt.userChoice;
				console.log('User choice:', outcome);
				deferredPrompt = null;
				showInstallBanner(false);
			});
		}
		if (dismiss) {
			dismiss.addEventListener('click', () => showInstallBanner(false));
		}
	}

	window.addEventListener('beforeinstallprompt', (e) => {
		e.preventDefault();
		deferredPrompt = e;
		showInstallBanner(true);
	});

	window.addEventListener('appinstalled', () => {
		console.log('PWA installed');
		showInstallBanner(false);
	});

	/* ---------- Service Worker registration ---------- */
	async function registerServiceWorker() {
		if ('serviceWorker' in navigator) {
			try {
				const reg = await navigator.serviceWorker.register('sw.js');
				console.log('Service worker registered', reg);
			} catch (err) {
				console.warn('Service worker registration failed', err);
			}
		}
	}

	/* ---------- Camera / Scanner placeholder ---------- */
	let currentStream = null;
	let isProcessingUpload = false; // prevents double uploads while a save is pending
	async function openCamera() {
		try {
			const constraints = { video: { facingMode: 'environment' }, audio: false };
			const stream = await navigator.mediaDevices.getUserMedia(constraints);
			currentStream = stream;
			// show scanner and attach video
			let video = $('#scanner video');
			if (!video) {
				video = document.createElement('video');
				video.setAttribute('autoplay', '');
				video.setAttribute('playsinline', '');
				video.style.width = '100%';
				video.style.borderRadius = '8px';
				$('#scanner .modal-inner').appendChild(video);
			}
			video.srcObject = stream;
			// unhide scanner
			const scanner = $('#scanner');
			if (scanner) {
				scanner.setAttribute('aria-hidden', 'false');
				scanner.style.display = 'flex';
			}
		} catch (err) {
			console.warn('Camera access failed', err);
			alert('Camera access was denied or is not available.');
		}
	}

	function stopCamera() {
		if (currentStream) {
			currentStream.getTracks().forEach(t => t.stop());
			currentStream = null;
		}
		const scanner = $('#scanner');
		if (scanner) {
			scanner.setAttribute('aria-hidden', 'true');
			scanner.style.display = 'none';
			const video = $('#scanner video');
			if (video) video.remove();
		}
	}

	/* ---------- Camera Scanner helper (consolidated) ---------- */
	async function openCameraScanner() {
		// show scanner modal
		const scanner = $('#scanner');
		if (scanner) {
			scanner.setAttribute('aria-hidden', 'false');
			scanner.style.display = 'flex';
		}

		// Try WebRTC camera first, fallback to file input if unavailable
		try {
			const constraints = { video: { facingMode: 'environment' }, audio: false };
			const stream = await navigator.mediaDevices.getUserMedia(constraints);
			currentStream = stream;
			let video = $('#scanner video');
			if (!video) {
				video = document.createElement('video');
				video.setAttribute('autoplay', '');
				video.setAttribute('playsinline', '');
				video.style.width = '100%';
				video.style.borderRadius = '8px';
				$('#scanner .modal-inner').appendChild(video);
			}
			video.srcObject = stream;
			// ensure take-photo triggers capture and saving
			const takePhotoBtn = $('#take-photo');
			if (takePhotoBtn) {
				takePhotoBtn.onclick = async () => {
					await capturePhotoToPdf({ save: true });
				};
			}
		} catch (err) {
			console.warn('WebRTC camera unavailable, falling back to file input', err);
			// trigger hidden file input fallback
			const fallback = document.getElementById('bol-file-fallback');
			if (fallback) {
				// Just trigger the native file picker; attachScannerHandlers has a persistent listener
				fallback.click();
			} else {
				alert('Camera not available and no fallback input present.');
			}
		}
	}

	function stopCameraScanner() {
		stopCamera();
	}

	function attachScannerHandlers() {
		const openCameraBtn = $('#open-camera');
		const closeScannerBtn = $('#close-scanner');
		const scanBolBtn = $('#scan-bol-btn') || $('#btn-scan-bol');
		const takePhotoBtn = $('#take-photo');
		const quickDownloadBtn = $('#download-pdf');
		const quickShareBtn = $('#share-pdf');
		const quickCloseBtn = $('#close-quick-share');
		const addExpenseBtn = $('#add-expense-btn') || $('#btn-add-expense');
		const addIncomeBtn = $('#add-income-btn');
		const resetFinancesBtn = $('#reset-finances-btn');
		const dotTimerBtn = $('#dot-timer-btn');
		if (openCameraBtn) openCameraBtn.addEventListener('click', openCamera);
		if (closeScannerBtn) closeScannerBtn.addEventListener('click', stopCamera);
		if (scanBolBtn) scanBolBtn.addEventListener('click', (e) => {
			e.preventDefault();
			openCameraScanner();
		});
		if (takePhotoBtn) takePhotoBtn.addEventListener('click', async (e) => {
			e.preventDefault();
			await capturePhotoToPdf({ save: true });
		});

		// fallback file input listener (in case other flows trigger it)
		const fallback = document.getElementById('bol-file-fallback');
		if (fallback) {
			fallback.addEventListener('change', async (e) => {
				const file = e.target.files && e.target.files[0];
				if (file) await processImageFile(file);
				e.target.value = '';
			});
		}
		if (quickDownloadBtn) quickDownloadBtn.addEventListener('click', downloadLatestPdf);
		if (quickShareBtn) quickShareBtn.addEventListener('click', shareLatestPdf);
		if (quickCloseBtn) quickCloseBtn.addEventListener('click', closeQuickShareModal);
		$('#close-pdf-preview')?.addEventListener('click', closePdfPreview);
		$('#pdf-preview-modal')?.addEventListener('click', (event) => {
			if (event.target === $('#pdf-preview-modal')) closePdfPreview();
		});
		if (addExpenseBtn) addExpenseBtn.addEventListener('click', openExpenseModal);
		if (addIncomeBtn) addIncomeBtn.addEventListener('click', openIncomeModal);
		$('#add-income-form')?.addEventListener('submit', handleAddIncome);
		$('#add-stop-btn')?.addEventListener('click', addIncomeStop);
		$('#driver-more-checkbox')?.addEventListener('change', event => setDriverMoreState(event.target.checked));
		$('#income-gross')?.addEventListener('input', updateIncomeRpm);
		$('#income-miles')?.addEventListener('input', updateIncomeRpm);
		$('#cancel-income-btn')?.addEventListener('click', closeIncomeModal);
		$('#add-income-modal')?.addEventListener('click', (event) => {
			if (event.target.id === 'add-income-modal') closeIncomeModal();
		});
		$('#expense-form')?.addEventListener('submit', handleAddExpense);
		$('#cancel-expense-btn')?.addEventListener('click', closeExpenseModal);
		$('#expense-modal')?.addEventListener('click', (event) => {
			if (event.target.id === 'expense-modal') closeExpenseModal();
		});
		$('#cancel-reset-finances-btn')?.addEventListener('click', closeResetFinanceModal);
		$('#confirm-reset-finances-btn')?.addEventListener('click', confirmResetFinances);
		$('#reset-finance-modal')?.addEventListener('click', event => {
			if (event.target.id === 'reset-finance-modal') closeResetFinanceModal();
		});
		$('#finance-history-list')?.addEventListener('click', async (event) => {
			const button = event.target.closest('.delete-finance-entry');
			if (button) {
				await deleteFinanceEntry(button.dataset.entryType, button.dataset.entryId);
				return;
			}
			const editButton = event.target.closest('.edit-finance-entry');
			if (editButton) editFinanceEntry(editButton.dataset.entryType, editButton.dataset.entryId);
		});
		if (resetFinancesBtn) resetFinancesBtn.addEventListener('click', resetFinances);
		if (dotTimerBtn) dotTimerBtn.addEventListener('click', () => {
			switchTab('finance-section');
			showRestTimerPanel();
			if (restTimerInstance) restTimerInstance.start();
		});
	}

	/* ---------- Capture & PDF export / Quick Share ---------- */
	let latestPdfBlob = null;
	let latestPdfUrl = null;
	let latestPdfName = 'document.pdf';

	async function capturePhotoToPdf(opts = { save: false }) {
		if (opts.save && isProcessingUpload) return alert('A document is still being processed. Please wait.');
		try {
			if (opts.save) isProcessingUpload = true;
			const video = $('#scanner video');
			if (!video) return alert('Camera not available');
			// set up canvas with video resolution
			const w = video.videoWidth || video.clientWidth || 1280;
			const h = video.videoHeight || video.clientHeight || Math.floor(w * 0.75);
			const canvas = document.createElement('canvas');
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext('2d');
			ctx.drawImage(video, 0, 0, w, h);
			// Compress before embedding so the PDF fits localStorage limits.
			const imgData = canvas.toDataURL('image/jpeg', 0.6);

			// create PDF using jsPDF (UMD exposes window.jspdf.jsPDF)
			const jsPDFLib = window.jspdf && window.jspdf.jsPDF ? window.jspdf.jsPDF : null;
			if (!jsPDFLib) return alert('PDF library not loaded');
			const doc = new jsPDFLib();
			const pdfW = doc.internal.pageSize.getWidth();
			const pdfH = doc.internal.pageSize.getHeight();
			// Add image to PDF filling the page
			doc.addImage(imgData, 'JPEG', 0, 0, pdfW, pdfH);

			// output blob
			const blob = doc.output('blob');
			latestPdfBlob = blob;
			if (latestPdfUrl) URL.revokeObjectURL(latestPdfUrl);
			latestPdfUrl = URL.createObjectURL(blob);

			// stop camera and close scanner
			stopCamera();
			const scanner = $('#scanner');
			if (scanner) scanner.setAttribute('aria-hidden', 'true');

			// Save to archive if requested
			if (opts.save) {
				try {
					isProcessingUpload = true;
					const saved = await savePdfToStorage(blob);
					// Open confirmation modal with saved doc details
					openDocSavedModal(saved);
				} catch (e) { console.warn('Saving PDF failed', e); isProcessingUpload = false; }
			}

			if (!opts.save) openQuickShareModal();
		} catch (err) {
			console.warn('Capture failed', err);
			alert('Failed to capture photo');
		}
	}

		// Helper: show a simple toast message
		function showToast(msg, timeout = 2200) {
			try {
				let el = document.createElement('div');
				el.className = 'app-toast';
				el.textContent = msg;
				Object.assign(el.style, {position:'fixed',left:'50%',bottom:'80px',transform:'translateX(-50%)',background:'rgba(0,0,0,0.8)',color:'#fff',padding:'10px 14px',borderRadius:'10px',zIndex:12000,fontSize:'0.95rem'});
				document.body.appendChild(el);
				setTimeout(() => {
					el.style.transition = 'opacity 300ms ease';
					el.style.opacity = '0';
					setTimeout(() => el.remove(), 300);
				}, timeout);
			} catch (e) { console.warn('Toast failed', e); }
		}

		// Process an image File (from fallback or other sources) -> convert to PDF, save, render
		async function processImageFile(file) {
			try {
				const reader = new FileReader();
				const dataUrl = await new Promise((res, rej) => {
					reader.onload = () => res(reader.result);
					reader.onerror = rej;
					reader.readAsDataURL(file);
				});
				// compress the image by drawing into canvas at reasonable size
				const img = document.createElement('img');
				img.src = dataUrl;
				await new Promise((res, rej) => { img.onload = res; img.onerror = rej; });
				const maxW = 1280;
				const scale = Math.min(1, maxW / img.width);
				const cw = Math.round(img.width * scale);
				const ch = Math.round(img.height * scale);
				const canvas = document.createElement('canvas');
				canvas.width = cw;
				canvas.height = ch;
				const ctx = canvas.getContext('2d');
				ctx.drawImage(img, 0, 0, cw, ch);
				const compressed = canvas.toDataURL('image/jpeg', 0.6);
				// create PDF using jsPDF
				const jsPDFLib = window.jspdf && window.jspdf.jsPDF ? window.jspdf.jsPDF : null;
				if (!jsPDFLib) return alert('PDF library not loaded');
				const doc = new jsPDFLib();
				const pdfW = doc.internal.pageSize.getWidth();
				const pdfH = doc.internal.pageSize.getHeight();
				// add compressed image to PDF
				doc.addImage(compressed, 'JPEG', 0, 0, pdfW, pdfH);
				const blob = doc.output('blob');
				latestPdfBlob = blob;
				if (latestPdfUrl) URL.revokeObjectURL(latestPdfUrl);
				latestPdfUrl = URL.createObjectURL(blob);
				latestPdfName = `BOL_${new Date().toISOString().slice(0, 10)}.pdf`;
				isProcessingUpload = true;
				const saved = await savePdfToStorage(blob);
				renderArchive();
				// hide scanner modal if open
				const scanner = $('#scanner');
				if (scanner) {
					scanner.setAttribute('aria-hidden', 'true');
					scanner.style.display = 'none';
				}
				openDocSavedModal(saved);
			} catch (e) {
				console.warn('Processing image file failed', e);
				isProcessingUpload = false;
				alert('Failed to process selected image');
			}
		}

		// Open the 'Document Saved' confirmation modal with doc details
		function openDocSavedModal(doc) {
			const modal = $('#doc-saved-modal');
			if (!modal) return;
			const titleEl = $('#doc-saved-title');
			const subEl = $('#doc-saved-sub');
			if (titleEl) titleEl.textContent = `Saved: ${doc.title || doc.name}`;
			if (subEl) subEl.textContent = `Created: ${formatDateTime(doc.ts || doc.date)}`;
			modal.setAttribute('aria-hidden', 'false');
			// wire actions
			const goto = $('#go-to-archive-btn');
			const shareBtn = $('#quick-share-btn');
			const closeBtn = $('#close-modal-btn');
			if (shareBtn) shareBtn.onclick = shareLatestPdf;
			if (goto) {
				goto.onclick = () => {
					modal.setAttribute('aria-hidden', 'true');
					switchTab('archive-section');
					isProcessingUpload = false;
				};
			}
			if (closeBtn) {
				closeBtn.onclick = () => {
					modal.setAttribute('aria-hidden', 'true');
					isProcessingUpload = false;
				};
			}
			if (shareBtn) shareBtn.focus();
		}

	function openQuickShareModal() {
		const modal = $('#quick-share-modal');
		if (!modal) return;
		modal.setAttribute('aria-hidden', 'false');
		// focus the download button
		const dl = $('#download-pdf');
		if (dl) dl.focus();
	}

	function closeQuickShareModal() {
		const modal = $('#quick-share-modal');
		if (!modal) return;
		modal.setAttribute('aria-hidden', 'true');
		// revoke object URL to free memory
		if (latestPdfUrl) {
			URL.revokeObjectURL(latestPdfUrl);
			latestPdfUrl = null;
			latestPdfBlob = null;
		}
	}

	function downloadLatestPdf() {
		if (!latestPdfBlob) return alert('No PDF available');
		const a = document.createElement('a');
		a.href = latestPdfUrl;
		a.download = latestPdfName;
		document.body.appendChild(a);
		a.click();
		a.remove();
	}

	/* ---------- Archive storage helpers ---------- */
	let idbDocumentFallback = [];

	function loadSavedDocs() {
		try {
			const raw = localStorage.getItem('saved_documents');
			return raw ? JSON.parse(raw) : [];
		} catch (e) { return []; }
	}

	function saveSavedDocs(arr) {
		localStorage.setItem('saved_documents', JSON.stringify(arr || []));
	}

	function blobToBase64(blob) {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onloadend = () => resolve(reader.result.split(',')[1]);
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}

	function dataUriToBlob(dataUri) {
		const parts = dataUri.split(',');
		const meta = parts[0];
		const b64 = parts[1];
		const mimeMatch = meta.match(/data:([^;]+);/);
		const mime = mimeMatch ? mimeMatch[1] : 'application/pdf';
		const binary = atob(b64);
		const len = binary.length;
		const u8 = new Uint8Array(len);
		for (let i = 0; i < len; i++) u8[i] = binary.charCodeAt(i);
		return new Blob([u8], { type: mime });
	}

	async function savePdfToStorage(blobOrData) {
		try {
			let dataUri = null;
			if (typeof blobOrData === 'string' && blobOrData.indexOf('data:') === 0) {
				dataUri = blobOrData;
			} else if (blobOrData instanceof Blob) {
				const b64 = await blobToBase64(blobOrData);
				dataUri = 'data:application/pdf;base64,' + b64;
			} else {
				throw new Error('Unsupported input to savePdfToStorage');
			}
			const docs = loadSavedDocs();
			const newDoc = {
				id: 'doc_' + Date.now(),
				title: 'BOL_' + new Date().toISOString().slice(0, 10) + '.pdf',
				date: new Date().toLocaleString(),
				type: 'BOL/POD',
				pdfData: dataUri
			};
			// insert at front
			docs.unshift(newDoc);
			// Prefer localStorage for synchronous archive rendering.
			try {
				localStorage.setItem('saved_documents', JSON.stringify(docs));
			} catch (err) {
				if (!isQuotaExceeded(err)) throw err;
				await saveDocumentToIDB(newDoc);
				idbDocumentFallback = [newDoc, ...idbDocumentFallback.filter(doc => doc.id !== newDoc.id)];
				console.warn('Document saved to IndexedDB because localStorage is full');
			}
			// ensure UI updated
			renderArchive();
			return newDoc;
		} finally {
			// leave caller to clear isProcessingUpload where relevant
		}
	}

	function isQuotaExceeded(e) {
		if (!e) return false;
		if (e.code && (e.code === 22 || e.code === 1014)) return true;
		if (e.name && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED')) return true;
		return false;
	}

	function downloadBase64Pdf(doc) {
		try {
			let blob = null;
			if (doc.pdfData) {
				blob = dataUriToBlob(doc.pdfData);
			} else if (doc.data) {
				const b = atob(doc.data);
				const len = b.length;
				const u8 = new Uint8Array(len);
				for (let i = 0; i < len; i++) u8[i] = b.charCodeAt(i);
				blob = new Blob([u8], { type: 'application/pdf' });
			} else {
				return alert('No PDF data available');
			}
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = (doc.title || doc.name) || 'document.pdf';
			document.body.appendChild(a);
			a.click();
			a.remove();
			URL.revokeObjectURL(url);
		} catch (e) { console.warn('Download failed', e); alert('Download failed'); }
	}

	let previewUrl = null;

	function viewPdfDocument(base64Data, fileName) {
		try {
			if (!base64Data) return alert('No PDF available');
			const base64Clean = base64Data.split(',')[1] || base64Data;
			const byteCharacters = atob(base64Clean);
			const byteNumbers = new Array(byteCharacters.length);
			for (let i = 0; i < byteCharacters.length; i++) byteNumbers[i] = byteCharacters.charCodeAt(i);
			const byteArray = new Uint8Array(byteNumbers);
			const blob = new Blob([byteArray], { type: 'application/pdf' });
			const modal = $('#pdf-preview-modal');
			const frame = $('#pdf-preview-iframe');
			if (!modal || !frame) return;
			if (previewUrl) URL.revokeObjectURL(previewUrl);
			previewUrl = URL.createObjectURL(blob);
			$('#pdf-preview-title').innerText = fileName || 'Document Preview';
			frame.src = previewUrl;
			modal.setAttribute('aria-hidden', 'false');
			$('#close-pdf-preview')?.focus();
		} catch (error) {
			console.error('PDF Preview Error:', error);
			alert('Could not load PDF preview. Please use Download instead.');
		}
	}

	function openBase64Pdf(doc) {
		try {
			const data = doc.pdfData || doc.data;
			viewPdfDocument(data, doc.title || doc.name || 'Document Preview');
		} catch (error) {
			console.error('PDF Preview Error:', error);
			alert('Could not load PDF preview. Please use Download instead.');
		}
	}

	function closePdfPreview() {
		const modal = $('#pdf-preview-modal');
		const frame = $('#pdf-preview-iframe');
		if (modal) modal.setAttribute('aria-hidden', 'true');
		if (frame) frame.removeAttribute('src');
		if (previewUrl) {
			URL.revokeObjectURL(previewUrl);
			previewUrl = null;
		}
	}

	function deleteSavedDoc(id) {
		let docs = loadSavedDocs();
		docs = docs.filter(d => d.id !== id);
		saveSavedDocs(docs);
		renderArchive();
	}

	function renderFinancialArchives() {
		const container = $('#financial-archives-list');
		const empty = $('#empty-financial-archives');
		if (!container) return;
		const reports = loadEntries(financialArchivesKey);
		container.textContent = '';
		if (empty) empty.style.display = reports.length ? 'none' : 'block';
		reports.forEach(report => {
			const card = document.createElement('article');
			card.className = 'financial-archive-card';
			const title = document.createElement('h5');
			title.textContent = report.title;
			const summary = document.createElement('p');
			summary.textContent = `Gross ${formatCurrency(report.gross)} | Expenses ${formatCurrency(report.expenses)} | Net ${formatCurrency(report.netPay)}`;
			const count = document.createElement('small');
			count.textContent = `${Array.isArray(report.items) ? report.items.length : 0} financial entries`;
			card.append(title, summary, count);
			container.appendChild(card);
		});
	}

	function formatDateTime(ts) {
		try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
	}

	function renderArchive() {
		renderFinancialArchives();
		const container = $('#saved-docs-list');
		if (!container) return;
		const docs = [...loadSavedDocs(), ...idbDocumentFallback].filter((doc, index, all) => all.findIndex(item => item.id === doc.id) === index);
		container.innerHTML = '';
		if (!docs.length) {
			document.getElementById('empty-docs').style.display = 'block';
			return;
		} else {
			document.getElementById('empty-docs').style.display = 'none';
		}
		docs.forEach(doc => {
			const card = document.createElement('div');
			card.className = 'doc-card';
			const title = doc.title || doc.name || 'Document';
			const when = doc.date || doc.ts || Date.now();
			card.innerHTML = `
				<div class="doc-meta">
					<div class="doc-title">${title}</div>
					<div class="doc-time">${formatDateTime(when)}</div>
				</div>
				<div class="doc-actions">
					<button class="btn btn-ghost btn-view">👁️ View</button>
					<button class="btn btn-primary btn-download">📥 Download</button>
					<button class="btn btn-ghost btn-delete">🗑️ Delete</button>
				</div>`;
			container.appendChild(card);

			card.querySelector('.btn-view')?.addEventListener('click', () => openBase64Pdf(doc));
			card.querySelector('.btn-download')?.addEventListener('click', () => downloadBase64Pdf(doc));
			card.querySelector('.btn-delete')?.addEventListener('click', () => {
				if (!confirm('Delete this document?')) return;
				deleteSavedDoc(doc.id);
			});
		});
	}

	/* ---------- Seed sample PDF for UI testing if archive empty ---------- */
	async function seedSamplePdfIfEmpty() {
		try {
			const docs = loadSavedDocs();
			if ((docs && docs.length) || idbDocumentFallback.length) return;
			// create a tiny PDF using jsPDF (if available)
			const jsPDFLib = window.jspdf && window.jspdf.jsPDF ? window.jspdf.jsPDF : null;
			if (!jsPDFLib) return;
			const doc = new jsPDFLib({ unit: 'pt', format: 'letter' });
			doc.setFontSize(14);
			doc.text('Sample BOL / POD Document', 40, 80);
			doc.setFontSize(11);
			doc.text('This is a seeded sample PDF for archive UI testing.', 40, 110);
			const blob = doc.output('blob');
			await savePdfToStorage(blob);
			console.info('Seeded sample PDF into archive');
		} catch (e) {
			console.warn('Seeding sample PDF failed', e);
		}
	}

	async function shareLatestPdf() {
		if (!latestPdfBlob) return alert('No PDF available');
		try {
			const file = new File([latestPdfBlob], 'BOL_Document.pdf', { type: 'application/pdf' });
			if (navigator.canShare && navigator.canShare({ files: [file] })) {
				await navigator.share({ files: [file], title: 'Scanned Document', text: 'Scanned BOL/POD' });
			} else if (navigator.share) {
				// some platforms accept URLs or text fallback
				await navigator.share({ title: 'Scanned Document', text: 'Document saved. Please download to share.' });
				// fallback: prompt download
				downloadLatestPdf();
			} else {
				// no share API — fallback to download
				downloadLatestPdf();
				alert('Share API not available. PDF downloaded instead.');
			}
		} catch (err) {
			console.warn('Share failed', err);
			alert('Unable to share this file. Downloading instead.');
			downloadLatestPdf();
		}
	}

	/* ---------- Add Fuel Expense (prompt) ---------- */
	/* ---------- Rest Break Timer ---------- */
	class RestTimer {
		constructor(displayEl, opts = {}) {
			this.displayEl = displayEl;
			this.duration = opts.duration || 30 * 60; // seconds
			this.remaining = this.duration;
			this.interval = null;
			this.running = false;
			this.storageKey = 'rest_timer_state';
			this.loadState();
			this.updateDisplay();
		}

		loadState() {
			try {
				const raw = localStorage.getItem(this.storageKey);
				if (!raw) return;
				const data = JSON.parse(raw);
				if (data && typeof data.remaining === 'number') {
					this.remaining = data.remaining;
					this.running = !!data.running;
					// if running, we don't auto-start here; user can resume
				}
			} catch (e) { /* ignore */ }
		}

		saveState() {
			try {
				localStorage.setItem(this.storageKey, JSON.stringify({ remaining: this.remaining, running: this.running }));
			} catch (e) { /* ignore */ }
		}

		start() {
			if (this.running) return;
			this.running = true;
			this.interval = setInterval(() => this.tick(), 1000);
			this.saveState();
			this.updateDisplay();
		}

		pause() {
			if (!this.running) return;
			this.running = false;
			clearInterval(this.interval);
			this.interval = null;
			this.saveState();
			this.updateDisplay();
		}

		reset() {
			this.pause();
			this.remaining = this.duration;
			this.saveState();
			this.updateDisplay();
		}

		tick() {
			if (this.remaining <= 0) {
				this.complete();
				return;
			}
			this.remaining -= 1;
			this.updateDisplay();
			this.saveState();
			if (this.remaining <= 0) this.complete();
		}

		complete() {
			this.pause();
			this.remaining = 0;
			this.updateDisplay();
			try {
				if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
			} catch (e) { /* ignore */ }
			alert('Rest break complete — please resume driving safely.');
			this.saveState();
		}

		formatTime(seconds) {
			const m = Math.floor(seconds / 60).toString().padStart(2, '0');
			const s = (seconds % 60).toString().padStart(2, '0');
			return `${m}:${s}`;
		}

		updateDisplay() {
			if (this.displayEl) this.displayEl.textContent = this.formatTime(this.remaining);
		}
	}

	let restTimerInstance = null;

	function showRestTimerPanel() {
		const panel = $('#rest-timer-panel');
		if (!panel) return;
		panel.setAttribute('aria-hidden', 'false');
		panel.classList.remove('sr-only');
		panel.style.display = '';
		const disp = $('#rest-timer-display');
		if (!restTimerInstance) restTimerInstance = new RestTimer(disp);
		const startBtn = $('#rest-start');
		const pauseBtn = $('#rest-pause');
		const resetBtn = $('#rest-reset');
		if (startBtn) startBtn.onclick = () => restTimerInstance.start();
		if (pauseBtn) pauseBtn.onclick = () => restTimerInstance.pause();
		if (resetBtn) resetBtn.onclick = () => restTimerInstance.reset();
	}

	function toggleRestTimerPanel() {
		const panel = $('#rest-timer-panel');
		if (!panel) return;
		if (panel.getAttribute('aria-hidden') === 'true') {
			switchTab('finance-section');
			showRestTimerPanel();
		} else {
			panel.setAttribute('aria-hidden', 'true');
			panel.classList.add('sr-only');
			panel.style.display = 'none';
		}
	}

	/* ---------- Buy a Gallon modal flow ---------- */
	function attachBuyFlow() {
		const profileButton = $('.profile-btn');
		const trigger = $('#buy-diesel-btn');
		const modal = $('#buy-modal');
		const yes = $('#buy-yes');
		const no = $('#buy-no');
		const thanks = $('#buy-thanks');
		const decline = $('#buy-decline');
		const copyBtn = $('#copy-card');
		const copyClose = $('#copy-close');
		const declineClose = $('#decline-close');

		if (profileButton) profileButton.addEventListener('click', () => showToast('Guest Driver profile'));
		if (!trigger || !modal) return;

		const open = (el) => {
			el.setAttribute('aria-hidden', 'false');
			// focus first focusable
			const focusable = el.querySelector('button, [href], input, textarea, select');
			if (focusable) focusable.focus();
		};
		const close = (el) => {
			el.setAttribute('aria-hidden', 'true');
			trigger.focus();
		};

		trigger.addEventListener('click', () => open(modal));
		const estimatorInputs = ['#fuel-price', '#route-miles', '#truck-mpg'].map(sel => $(sel)).filter(Boolean);
		const updateEstimate = () => {
			const price = Number($('#fuel-price')?.value) || 0;
			const miles = Number($('#route-miles')?.value) || 0;
			const mpg = Number($('#truck-mpg')?.value) || 1;
			const estimate = $('#fuel-estimate');
			const savings = $('#fuel-savings');
			if (estimate) estimate.textContent = `Estimated fuel cost: ${formatCurrency((miles / mpg) * price)}`;
			if (savings) savings.textContent = `Estimated savings vs. 6 MPG: ${formatCurrency(Math.max(0, (miles / 6 - miles / mpg) * price))}`;
		};
		estimatorInputs.forEach(input => input.addEventListener('input', updateEstimate));

		if (yes) yes.addEventListener('click', () => {
			close(modal);
			open(thanks);
		});
		if (no) no.addEventListener('click', () => {
			close(modal);
			open(decline);
		});

		if (copyBtn) {
			copyBtn.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText('4023060100987097');
					const prev = copyBtn.textContent;
					copyBtn.textContent = 'Copied to Clipboard! ✅';
					copyBtn.classList.add('copying');
					setTimeout(() => {
						copyBtn.textContent = prev;
						copyBtn.classList.remove('copying');
						// close modal after short delay
						close(thanks);
					}, 1800);
				} catch (err) {
					console.warn('Clipboard failed', err);
					alert('Unable to copy — please copy manually: 4023 0601 0098 7097');
				}

				/* ---------- Help panel (How it works) ---------- */
				const helpContents = {
					finance: {
						title: 'Financial Summary',
						steps: [
							'Enter your Weekly Gross and Fuel Expenses in the boxes.',
							'The app automatically calculates your Net Pay (Gross - Expenses).',
							'All data is saved locally on your device for offline use.'
						]
					},
					scan: {
						title: 'Scan BOL / POD',
						steps: [
							'Tap the Scan button to open your camera and capture your Bill of Lading or Proof of Delivery.',
							'You can also upload an existing photo from your device if supported.',
							'Photos are compressed automatically to save space on your device.'
						]
					},
					addExpense: {
						title: 'Add Fuel Expense',
						steps: [
							'Tap Add Fuel Expense to quickly log fuel purchases or tolls.',
							'Enter the amount and the app will deduct it from your weekly gross automatically.',
							'Expenses and Net Pay are saved locally so you don\'t lose data while on the road.'
						]
					},
					restTimer: {
						title: 'Rest Break Timer',
						steps: [
							'Tap the Rest Break Timer to open the 30-minute DOT countdown.',
							'Use Start, Pause, and Reset controls to manage your break.',
							'When time is up you will get an alert and optional vibration (on supported devices).' 
						]
					},
					diesel: {
						title: 'Diesel Donation',
						steps: [
							'If you want to support server costs, copy our Visa card number and send a small contribution via your banking app.',
							'Tap Copy Card Number in the Thank You screen to copy the card to your clipboard.'
						]
					},
					pwaInstall: {
						title: 'Install TruckerHub',
						steps: [
							'Tap Install Now to add TruckerHub to your home screen for one-tap access.',
							'Installed apps run like native apps and can work offline.'
						]
					}
				};

				function openHelp(key) {
					const panel = $('#help-panel');
					const body = $('#help-body');
					const title = $('#help-title');
					if (!panel || !body || !title) return;
					const data = helpContents[key];
					if (!data) return;
					title.textContent = data.title || 'How it works';
					body.innerHTML = '';
					data.steps.forEach((s, i) => {
						const div = document.createElement('div');
						div.className = 'help-step';
						div.innerHTML = `<strong>Step ${i+1}:</strong> <div>${s}</div>`;
						body.appendChild(div);
					});
					panel.setAttribute('aria-hidden', 'false');
					const close = $('#help-close');
					if (close) close.focus();
				}

				function closeHelp() {
					const panel = $('#help-panel');
					if (!panel) return;
					panel.setAttribute('aria-hidden', 'true');
					// return focus to last focused element if any
				}

				function attachHelpHandlers() {
					$$('.help-btn').forEach(btn => {
						btn.addEventListener('click', (e) => {
							const key = btn.dataset.help;
							openHelp(key);
						});
					});
					const close = $('#help-close');
					if (close) close.addEventListener('click', closeHelp);
					// close on Escape
					document.addEventListener('keydown', (e) => {
						if (e.key === 'Escape') closeHelp();
					});
					// close on overlay click
					const panel = $('#help-panel');
					if (panel) panel.addEventListener('click', (e) => {
						if (e.target === panel) closeHelp();
					});
				}
			});
		}

		if (copyClose) copyClose.addEventListener('click', () => close(thanks));
		if (declineClose) declineClose.addEventListener('click', () => close(decline));

		// close on overlay click
		[modal, thanks, decline].forEach(el => {
			if (!el) return;
			el.addEventListener('click', (e) => {
				if (e.target === el) close(el);
			});
		});
	}

	/* ---------- Translations & i18n engine (EN / RU) ---------- */
	const translations = {
		en: {
			income: {
				title: 'Add Income (Load)', trip_id: 'Trip ID', load_num: 'Load / Trip Number', gross_pay: 'Gross Pay ($)',
				origin_loc: 'Origin Location', add_stop: '+ Add intermediate stop', dest_loc: 'Destination Location',
				pickup_date: 'Pickup Date', delivery_date: 'Delivery Date', trip_duration: 'Trip Duration', total_miles: 'Total Loaded Miles (optional)',
				rpm_calc: 'RPM: Add miles to calculate', driver_more: '⚙️ Driver More / Fine Conditions', late_pu: 'Late Pickup Penalty ($)',
				no_photos: 'No PU/DEL Trailer Photos Penalty ($)', custom_notes: 'Operational Warnings / Rules', cancel: 'Cancel', save: 'Save income',
				trip_id_placeholder: 'T-112TK8HW1', load_num_placeholder: '#102', gross_placeholder: '0.00', origin_placeholder: 'Chicago, IL',
				destination_placeholder: 'Dallas, TX', duration_placeholder: '0d 12h', miles_placeholder: '270.76', late_pu_placeholder: '1000',
				no_photos_placeholder: '200', custom_notes_placeholder: 'Enter custom notes or rules', intermediate_placeholder: 'Intermediate stop, e.g. Marinette, WI'
			},
			financial: { title: 'Financial Summary' },
			scan: { title: 'Scan BOL / POD' },
			expense: { title: 'Add Fuel Expense' },
			timer: { title: 'DOT Rest Break' },
			pwa: { title: 'Add to Home Screen' },
			diesel: { title: 'Buy a Gallon of Diesel' },
			trips: { title: 'Trip Archive' },
			documents: { title: '📄 Saved Documents & BOL Archive' },
			archive: { title: '📁 Archive' },
			install: { title: 'Add to Home Screen', text: 'Install this app for quick access and offline features.' },
			help: {
				financial: { title: 'Financial Summary', text: 'Tracks your weekly earnings. Enter Weekly Gross and Fuel Expenses; app calculates Net Pay.' },
				scan: { title: 'Scan BOL / POD', text: 'Capture photos of your Bill of Lading or Proof of Delivery and save as PDFs.' },
				expense: { title: 'Add Fuel Expense', text: 'Log fuel, toll, or repair costs to adjust weekly financial stats.' },
				timer: { title: 'DOT Rest Break', text: '30-minute DOT rest break timer with alerts.' },
				diesel: { title: 'Diesel Donation', text: 'Copy Visa card number to support the app.' },
				pwa: { title: 'Install App', text: 'Add the app to your home screen for offline access.' }
			}
		},
		ru: {
			income: {
				title: 'Добавить доход (груз)', trip_id: 'ID рейса', load_num: 'Номер груза / рейса', gross_pay: 'Валовый доход ($)',
				origin_loc: 'Пункт отправления', add_stop: '+ Добавить остановку', dest_loc: 'Пункт назначения', pickup_date: 'Дата загрузки',
				delivery_date: 'Дата разгрузки', trip_duration: 'Длительность рейса', total_miles: 'Всего миль (необязательно)',
				rpm_calc: 'RPM: Введите мили для расчета', driver_more: '⚙️ Штрафы и условия перевозки', late_pu: 'Штраф за позднюю загрузку ($)',
				no_photos: 'Штраф за фото при загрузке/разгрузке ($)', custom_notes: 'Операционные предупреждения / правила', cancel: 'Отмена', save: 'Сохранить доход',
				trip_id_placeholder: 'T-112TK8HW1', load_num_placeholder: '#102', gross_placeholder: '0,00', origin_placeholder: 'Чикаго, IL',
				destination_placeholder: 'Даллас, TX', duration_placeholder: '0д 12ч', miles_placeholder: '270,76', late_pu_placeholder: '1000',
				no_photos_placeholder: '200', custom_notes_placeholder: 'Введите заметки или правила', intermediate_placeholder: 'Промежуточная остановка, например Маринетт, WI'
			},
			financial: { title: 'Финансовый отчет' },
			scan: { title: 'Сканирование BOL / POD' },
			expense: { title: 'Добавить расходы' },
			timer: { title: 'Таймер отдыха DOT' },
			pwa: { title: 'Установить на экран' },
			diesel: { title: 'Купить галлон солярки' },
			trips: { title: 'Архив рейсов' },
			documents: { title: '📄 Сохраненные документы и архив BOL' },
			archive: { title: '📁 Архив' },
			install: { title: 'Установить на экран', text: 'Установите приложение для быстрого доступа и офлайн-функций.' },
			help: {
				financial: { title: 'Финансовый отчет', text: 'Отслеживает еженедельный доход. Введите Weekly Gross и расходы на топливо; приложение рассчитывает чистый доход.' },
				scan: { title: 'Сканирование BOL / POD', text: 'Сделайте фото накладной или акта приемки и сохраните в PDF.' },
				expense: { title: 'Добавить расходы', text: 'Записывайте расходы на дизель, дороги и ремонт, чтобы учесть их в расчетах.' },
				timer: { title: 'Таймер отдыха DOT', text: '30-минутный таймер перерыва DOT с оповещениями.' },
				diesel: { title: 'Пожертвование на дизель', text: 'Скопируйте номер карты Visa, чтобы поддержать приложение.' },
				pwa: { title: 'Установить приложение', text: 'Добавьте приложение на главный экран для работы офлайн.' }
			}
		}
	};

	function getSavedLang() { return localStorage.getItem('user_lang') || localStorage.getItem('app_language') || 'en'; }

	function getTranslation(key, lang = getSavedLang()) {
		const parts = key.split('.');
		let node = translations[lang] || translations.en;
		for (const part of parts) {
			if (!node) return null;
			node = node[part];
		}
		return typeof node === 'string' ? node : null;
	}

	function updateLanguage(lang) {
		if (!translations[lang]) lang = 'en';
		// update elements with data-i18n attribute (key like 'financial.title' or 'help.scan')
		$$('[data-i18n]').forEach(el => {
			const key = el.dataset.i18n; // e.g. 'financial.title' or 'help.scan'
			if (!key) return;
			const parts = key.split('.');
			let node = translations[lang];
			for (const p of parts) {
				if (!node) break;
				node = node[p];
			}
			const text = (node && typeof node === 'string') ? node : (node && node.title ? node.title : null);
			if (!text) return;
			// If element contains an inline help button, update only the text node to preserve the button
			const helpBtn = el.querySelector && el.querySelector('.help-btn');
			if (helpBtn) {
				// Find first text node child and update it; otherwise insert one before help button
				let textNode = null;
				for (const n of Array.from(el.childNodes)) {
					if (n.nodeType === Node.TEXT_NODE) { textNode = n; break; }
				}
				if (textNode) textNode.nodeValue = String(text) + ' ';
				else el.insertBefore(document.createTextNode(String(text) + ' '), helpBtn);
			} else {
				el.innerText = text;
			}
		});
		// update placeholders specifically
		$$('[data-i18n-placeholder]').forEach(el => {
			const key = el.dataset.i18nPlaceholder;
			if (!key) return;
			const parts = key.split('.');
			let node = translations[lang];
			for (const p of parts) { if (!node) break; node = node[p]; }
			if (node && typeof node === 'string') el.placeholder = node;
			else if (node && node.title && typeof node.title === 'string') el.placeholder = node.title;
		});
	}

	function changeLanguage(lang) {
		if (!lang) return;
		localStorage.setItem('user_lang', lang);
		// update legacy key too for backward compatibility
		localStorage.setItem('app_language', lang);
		updateLanguage(lang);
		// update UI controls
		const sel = $('#lang-switcher'); if (sel) sel.value = lang;
		$$('#lang-toggle .lang-btn').forEach(btn => btn.setAttribute('aria-pressed', btn.dataset.lang === lang ? 'true' : 'false'));
	}

	// attach select handler and initialize language on DOM ready
	function attachLangSwitcher() {
		const sel = $('#lang-switcher');
		if (!sel) return;
		sel.addEventListener('change', (e) => changeLanguage(e.target.value));
		// set initial value
		const lang = getSavedLang();
		sel.value = lang;
		changeLanguage(lang);
	}

	function openHelpModal(key) {
	    const modal = $('#help-modal');
	    const title = $('#help-modal-title');
	    const body = $('#help-modal-body');
	    if (!modal || !title || !body) return;
	    const lang = getSavedLang();
	    let entry = { title: 'How it works', text: 'Information not available.' };
	    if (translations[lang] && translations[lang].help && translations[lang].help[key]) {
	        entry = translations[lang].help[key];
	    } else if (translations[lang] && translations[lang][key]) {
	        entry = translations[lang][key];
	    }
	    title.textContent = entry.title || entry;
	    body.textContent = entry.text || entry;
	    modal.setAttribute('aria-hidden', 'false');
	    const ok = $('#help-modal-ok-btn');
	    if (ok) ok.focus();
	}

	function closeHelpModal() {
		const modal = $('#help-modal');
		if (!modal) return;
		modal.setAttribute('aria-hidden', 'true');
	}

	function attachHelpHandlers() {
		$$('.help-btn').forEach(btn => {
			btn.addEventListener('click', (e) => {
				const key = btn.dataset.help;
				openHelpModal(key);
			});
		});
		const ok = $('#help-modal-ok-btn');
		if (ok) ok.addEventListener('click', closeHelpModal);
		// close on Escape
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') closeHelpModal();
		});
		// close on overlay click
		const modal = $('#help-modal');
		if (modal) modal.addEventListener('click', (e) => {
			if (e.target === modal) closeHelpModal();
		});
	}

	/* ---------- Trips History: storage, render, filter, actions ---------- */
	const tripsKey = 'saved_trips_db';

	function loadTrips() {
		try {
			const raw = localStorage.getItem(tripsKey);
			return raw ? JSON.parse(raw) : [];
		} catch (e) { return []; }
	}

	function saveTrips(arr) {
		localStorage.setItem(tripsKey, JSON.stringify(arr || []));
	}

	function formatDateShort(d) {
		try {
			const dt = new Date(d);
			return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
		} catch (e) { return String(d || ''); }
	}

	function renderTrips(filterText = '') {
		const container = $('#trips-history-accordion');
		if (!container) return;
		const trips = loadTrips();
		filterText = (filterText || '').toLowerCase().trim();
		const results = trips.filter(t => {
			if (!filterText) return true;
			const id = (t.id || '').toString().toLowerCase();
			const dateStr = (t.date || '').toString().toLowerCase();
			const pretty = formatDateShort(t.date).toLowerCase();
			return id.includes(filterText) || dateStr.includes(filterText) || pretty.includes(filterText);
		});
		container.innerHTML = '';
		if (!results.length) {
			container.innerHTML = '<div class="empty-trips">No trips found.</div>';
			return;
		}
		results.forEach(trip => {
			const item = document.createElement('div');
			item.className = 'trip-item';
			item.dataset.tripId = trip.id || '';

			const header = document.createElement('div');
			header.className = 'trip-header';
			header.innerHTML = `
				<div class="meta">
					<div class="date">${formatDateShort(trip.date)}</div>
					<div class="trip-id">${trip.id || '—'}</div>
				</div>
				<div class="meta-right">
					<div class="rate">${formatCurrency(trip.total || 0)}</div>
					<span class="trip-arrow">▼</span>
				</div>`;

			const body = document.createElement('div');
			body.className = 'trip-body';
			body.innerHTML = `
				<div class="trip-field"><strong>Pickup:</strong> ${trip.pickup || '—'}</div>
				<div class="trip-field"><strong>Drop:</strong> ${trip.drop || '—'}</div>
				<div class="trip-field"><strong>Miles:</strong> ${trip.miles || '—'}</div>
				<div class="trip-field"><strong>Duration:</strong> ${trip.duration || '—'}</div>
				<div class="trip-actions">
					<button class="btn btn-ghost btn-edit">Edit ✏️</button>
					<button class="btn btn-ghost btn-delete">Delete 🗑️</button>
					<button class="btn btn-primary btn-export">Export PDF 📄</button>
				</div>`;

			item.appendChild(header);
			item.appendChild(body);
			container.appendChild(item);

			// Toggle
			header.addEventListener('click', () => {
				const isActive = item.classList.toggle('active');
				if (isActive) {
					body.style.maxHeight = body.scrollHeight + 'px';
				} else {
					body.style.maxHeight = 0;
				}
			});

			// Actions
			body.querySelector('.btn-delete').addEventListener('click', (e) => {
				e.stopPropagation();
				if (!confirm('Delete this trip?')) return;
				deleteTrip(trip.id);
			});

			body.querySelector('.btn-edit').addEventListener('click', (e) => {
				e.stopPropagation();
				const newRate = prompt('Edit total rate', String(trip.total || ''));
				if (newRate === null) return;
				trip.total = parseFloat(newRate) || trip.total;
				saveEditedTrip(trip);
			});

			body.querySelector('.btn-export').addEventListener('click', (e) => {
				e.stopPropagation();
				exportTripPdf(trip);
			});
		});
	}

	function saveEditedTrip(updated) {
		const arr = loadTrips();
		const idx = arr.findIndex(t => t.id === updated.id);
		if (idx !== -1) arr[idx] = updated;
		saveTrips(arr);
		renderTrips($('#trip-search-input')?.value || '');
	}

	function deleteTrip(id) {
		let arr = loadTrips();
		arr = arr.filter(t => t.id !== id);
		saveTrips(arr);
		renderTrips($('#trip-search-input')?.value || '');
	}

	function exportTripPdf(trip) {
		try {
			const jsPDFLib = window.jspdf && window.jspdf.jsPDF ? window.jspdf.jsPDF : null;
			if (!jsPDFLib) return alert('PDF library not loaded');
			const doc = new jsPDFLib();
			doc.setFontSize(14);
			doc.text('Trip Report', 14, 20);
			doc.setFontSize(11);
			doc.text(`Date: ${formatDateShort(trip.date)}`, 14, 36);
			doc.text(`Trip ID: ${trip.id || '—'}`, 14, 46);
			doc.text(`Total Rate: ${formatCurrency(trip.total || 0)}`, 14, 56);
			doc.text(`Pickup: ${trip.pickup || '—'}`, 14, 72);
			doc.text(`Drop: ${trip.drop || '—'}`, 14, 82);
			doc.text(`Miles: ${trip.miles || '—'}`, 14, 92);
			doc.text(`Duration: ${trip.duration || '—'}`, 14, 102);
			const name = `trip-${trip.id || Date.now()}.pdf`;
			doc.save(name);
		} catch (err) {
			console.warn('Export failed', err);
			alert('Failed to export PDF');
		}
	}

	function attachTripsHandlers() {
		const input = $('#trip-search-input');
		const dateIn = $('#trip-search-date');
		if (input) input.addEventListener('input', (e) => renderTrips(e.target.value));
		if (dateIn) dateIn.addEventListener('change', (e) => renderTrips(e.target.value));
		// initial render
		renderTrips();
	}

	/* ---------- Init ---------- */
	async function init() {
		ensureGuestId();
		attachNavHandlers();
		attachInstallHandlers();
		attachScannerHandlers();
		attachBuyFlow();
		attachFinanceEditable();
		attachLoadParserHandlers();
		attachHelpHandlers();
		attachLangSwitcher();
		attachTripsHandlers();

		// Ensure archive list is ready
		idbDocumentFallback = await loadDocumentsFromIDB();
		await seedSamplePdfIfEmpty();
		renderArchive();

		// load finance
		const persisted = loadFinanceFromStorage();
		// fallback to IDB if localStorage empty
		if (!persisted || !persisted.updatedAt) {
			const idbRec = await readFinanceFromIDB('weekly');
			if (idbRec) {
				await persistFinance(idbRec);
			} else {
				await persistFinance(persisted);
			}
		} else {
			renderFinance(persisted);
		}

		// default view — map to registered section id
		const defaultTarget = VIEW_TO_SECTION_ID['finance'];
		switchTab(defaultTarget);

		// runtime DOM sanity check to catch section bleed regressions early
		verifyTabIsolation();

		// service worker registration will occur on window load
		// (keeps registration after page fully loaded and avoids blocking init)
	}

	// Initialize on DOM ready
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}

	// Register service worker after window fully loads
	window.addEventListener('load', () => {
		registerServiceWorker();
	});

})();

