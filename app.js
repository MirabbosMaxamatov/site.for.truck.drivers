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
			const req = indexedDB.open('truck-driver-db', 1);
			req.onupgradeneeded = (e) => {
				const db = e.target.result;
				if (!db.objectStoreNames.contains('finance')) db.createObjectStore('finance', { keyPath: 'id' });
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

	/* ---------- Finance logic ---------- */
	const financeKey = 'finance_weekly';

	function parseAmount(v) {
		if (v === null || v === undefined || v === '') return 0;
		return Number(String(v).replace(/[^0-9.-]+/g, '')) || 0;
	}

	function formatCurrency(n) {
		return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
	}

	function loadFinanceFromStorage() {
		const raw = localStorage.getItem(financeKey);
		if (raw) return JSON.parse(raw);
		return { id: 'weekly', gross: 0, expenses: 0, net: 0, updatedAt: Date.now() };
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
		if (grossInput) grossInput.value = formatCurrency(Number(fin.gross || 0));
		if (expInput) expInput.value = formatCurrency(Number(fin.expenses || 0));
		if (netEl) netEl.textContent = formatCurrency(fin.net);
	}

	function attachFinanceEditable() {
		const inputGross = $('#input-weekly-gross');
		const inputExp = $('#input-weekly-expenses');
		if (!inputGross || !inputExp) return;

		// Load stored values into inputs
			const fin = loadFinanceFromStorage();
			inputGross.value = formatCurrency(Number(fin.gross || 0));
			inputExp.value = formatCurrency(Number(fin.expenses || 0));

		const unformatForEdit = (val) => {
			const n = parseAmount(val);
			if (!n) return '';
			return Number(n).toFixed(2);
		};

		const saveFromInputs = async () => {
			const fin = loadFinanceFromStorage();
			fin.gross = parseAmount(inputGross.value);
			fin.expenses = parseAmount(inputExp.value);
			await persistFinance(fin);
			// write back formatted currency values
			inputGross.value = formatCurrency(fin.gross);
			inputExp.value = formatCurrency(fin.expenses);
		};

		// Save on blur or Enter key
		// On focus: show a clean numeric string for editing. On blur: persist and format as localized currency.
		inputGross.addEventListener('focus', (e) => {
			e.target.value = unformatForEdit(e.target.value);
			setTimeout(() => e.target.select(), 50);
		});
		inputExp.addEventListener('focus', (e) => {
			e.target.value = unformatForEdit(e.target.value);
			setTimeout(() => e.target.select(), 50);
		});

		inputGross.addEventListener('blur', saveFromInputs);
		inputExp.addEventListener('blur', saveFromInputs);

		[inputGross, inputExp].forEach((input) => {
			input.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					input.blur();
				}
			});
		});
	}

	/* ---------- Navigation ---------- */
	// Centralized section registry (clean architecture)
	const SECTIONS = ['finance-section', 'archive-section', 'wellness-section', 'chat-section'];

	// Map logical section ids to actual selectors in the DOM
	const SECTION_SELECTORS = {
		'finance-section': ['.dashboard'],
		'archive-section': ['#archive-section'],
		'wellness-section': ['#rest-timer-panel', '.wellness-card'],
		'chat-section': []
	};

	// Map view names (nav data-nav) to logical section ids
	const VIEW_TO_SECTION_ID = {
		finance: 'finance-section',
		archive: 'archive-section',
		wellness: 'wellness-section',
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
				} else {
					el.setAttribute('aria-hidden', 'true');
					el.classList.remove('active');
					el.classList.add('sr-only');
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
		const scanBolBtn = $('#btn-scan-bol') || $('#scan-bol-btn');
		const takePhotoBtn = $('#take-photo');
		const quickDownloadBtn = $('#download-pdf');
		const quickShareBtn = $('#share-pdf');
		const quickCloseBtn = $('#close-quick-share');
		const addExpenseBtn = $('#btn-add-expense');
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
		if (addExpenseBtn) addExpenseBtn.addEventListener('click', handleAddExpense);
		if (dotTimerBtn) dotTimerBtn.addEventListener('click', () => {
			switchTab('wellness-section');
			showRestTimerPanel();
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
			const goto = $('#goto-archive-btn');
			const shareBtn = $('#quick-share-doc-saved');
			const closeBtn = $('#close-doc-saved');
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
			// try saving with quota handling
			try {
				localStorage.setItem('saved_documents', JSON.stringify(docs));
			} catch (err) {
				// QuotaExceededError handling — try removing oldest items and retry
				console.warn('localStorage setItem failed, attempting to free space', err);
				if (isQuotaExceeded(err)) {
					while (docs.length > 1) {
						docs.pop();
						try {
							localStorage.setItem('saved_documents', JSON.stringify(docs));
							break;
						} catch (e2) {
							if (!isQuotaExceeded(e2)) throw e2;
							// else continue loop
						}
					}
					// if still failing
					try { localStorage.setItem('saved_documents', JSON.stringify(docs)); } catch (finalErr) {
						alert('Unable to save document. Storage full. Please delete old documents.');
						throw finalErr;
					}
				} else {
					throw err;
				}
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

	function openBase64Pdf(doc) {
		try {
			let blob = null;
			if (doc.pdfData) blob = dataUriToBlob(doc.pdfData);
			else if (doc.data) {
				const b = atob(doc.data);
				const len = b.length;
				const u8 = new Uint8Array(len);
				for (let i = 0; i < len; i++) u8[i] = b.charCodeAt(i);
				blob = new Blob([u8], { type: 'application/pdf' });
			} else return alert('No PDF available');
			const url = URL.createObjectURL(blob);
			window.open(url, '_blank');
			setTimeout(() => URL.revokeObjectURL(url), 2000);
		} catch (e) { console.warn('Open PDF failed', e); alert('Unable to open PDF'); }
	}

	function deleteSavedDoc(id) {
		let docs = loadSavedDocs();
		docs = docs.filter(d => d.id !== id);
		saveSavedDocs(docs);
		renderArchive();
	}

	function formatDateTime(ts) {
		try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
	}

	function renderArchive() {
		const container = $('#saved-docs-list');
		if (!container) return;
		const docs = loadSavedDocs();
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

			card.querySelector('.btn-view').addEventListener('click', () => openBase64Pdf(doc));
			card.querySelector('.btn-download').addEventListener('click', () => downloadBase64Pdf(doc));
			card.querySelector('.btn-delete').addEventListener('click', () => {
				if (!confirm('Delete this document?')) return;
				deleteSavedDoc(doc.id);
			});
		});
	}

	/* ---------- Seed sample PDF for UI testing if archive empty ---------- */
	async function seedSamplePdfIfEmpty() {
		try {
			const docs = loadSavedDocs();
			if (docs && docs.length) return;
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
			const file = new File([latestPdfBlob], latestPdfName, { type: 'application/pdf' });
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
	async function handleAddExpense() {
		try {
			const raw = prompt('Enter fuel expense amount (e.g. 12.34):');
			if (raw === null) return; // cancelled
			const amount = parseAmount(raw);
			if (isNaN(amount) || amount <= 0) {
				alert('Please enter a valid amount greater than 0');
				return;
			}
			const fin = loadFinanceFromStorage();
			fin.expenses = Number((fin.expenses + amount).toFixed(2));
			await persistFinance(fin);
			// brief confirmation
			const prev = document.activeElement;
			alert(`Added fuel expense ${formatCurrency(amount)}. Expenses updated.`);
			if (prev && prev.focus) prev.focus();
		} catch (err) {
			console.warn('Failed to add expense', err);
		}
	}

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
			switchTab('wellness-section');
			showRestTimerPanel();
		} else {
			panel.setAttribute('aria-hidden', 'true');
			panel.classList.add('sr-only');
		}
	}

	/* ---------- Buy a Gallon modal flow ---------- */
	function attachBuyFlow() {
		const trigger = $('#buy-diesel-btn');
		const modal = $('#buy-modal');
		const yes = $('#buy-yes');
		const no = $('#buy-no');
		const thanks = $('#buy-thanks');
		const decline = $('#buy-decline');
		const copyBtn = $('#copy-card');
		const copyClose = $('#copy-close');
		const declineClose = $('#decline-close');

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

	function applyTranslations(lang) {
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
				el.textContent = text;
			}
		});
		// update placeholders specifically
		$$('[data-i18n-placeholder]').forEach(el => {
			const key = el.dataset.i18nPlaceholder;
			if (!key) return;
			const parts = key.split('.');
			let node = translations[lang];
			for (const p of parts) { if (!node) break; node = node[p]; }
			if (node && typeof node === 'string') el.setAttribute('placeholder', node);
			else if (node && node.title && typeof node.title === 'string') el.setAttribute('placeholder', node.title);
		});
	}

	function changeLanguage(lang) {
		if (!lang) return;
		localStorage.setItem('user_lang', lang);
		// update legacy key too for backward compatibility
		localStorage.setItem('app_language', lang);
		applyTranslations(lang);
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
		attachHelpHandlers();
		attachLangSwitcher();
		attachTripsHandlers();

		// Ensure archive list is ready
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

