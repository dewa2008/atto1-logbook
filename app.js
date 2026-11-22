// =====================================================================
        // 1. CONSTANTS & VEHICLE SPECIFICATIONS (BYD ATTO 1 DYNAMIC)
        // =====================================================================
        const BATTERY_KWH = 30.08;        // BYD Atto 1 Dynamic Blade Battery LFP
        const CHARGER_KW = 1.3;           // 1.3 kW / 6A 220V portable charger
        const EFFECTIVE_KW = 1.2032;      // ~4.0% SoC/hour after ~8% AC-DC losses
        const PCT_PER_HOUR = 4.0;         // +4.0% SoC per hour
        const DAILY_DRAIN_PCT = 18;       // ~50 km/day (-18% SoC)
        const PLN_TARIFF_R2 = 1699.53;    // PLN R-2 5.500 VA tariff (Rp/kWh)

        const START_DATE = new Date(2026, 10, 22); // Minggu, 22 November 2026
        const TOTAL_DAYS = 366;                    // 22 Nov 2026 s.d. 22 Nov 2027
        const DEFAULT_INITIAL_SOC = 38;            // Kondisi baterai awal user (38%)

        const HARI_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
        const BULAN_ID = [
            'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
            'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
        ];

        // Application Runtime State
        let activeSession = null;
        let completedSessions = [];
        let scheduleRows = [];
        let startPhotoBase64 = '';
        let stopPhotoBase64 = '';
        let liveTimerInterval = null;
        let deferredInstallPrompt = null;

        // =====================================================================
        // 2. PWA DYNAMIC MANIFEST & ANDROID INSTALL SUPPORT
        // =====================================================================
                window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredInstallPrompt = e;
        });

        async function triggerNativePWAInstall() {
            if (deferredInstallPrompt) {
                deferredInstallPrompt.prompt();
                const { outcome } = await deferredInstallPrompt.userChoice;
                deferredInstallPrompt = null;
                if (outcome === 'accepted') {
                    closeInstallModal();
                    showToast('Berhasil Dipasang!', 'Aplikasi Atto 1 Charge Logbook telah ditambahkan ke Layar Utama Android Anda.');
                }
            } else {
                showToast(
                    'Gunakan Menu Chrome (⋮)',
                    'Ketuk ikon Titik Tiga (⋮) di pojok kanan atas Chrome Android lalu pilih "Tambahkan ke Layar Utama" / "Install App".'
                );
            }
        }


        // ===== Data validation (blocks malicious/corrupt backup files) =====
        const RE_PHOTO = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/;
        const RE_ID = /^SES-\d{10,16}$/;
        const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
        const RE_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} WIB$/;
        const RE_DUR = /^\d{2,}:\d{2}:\d{2}$/;
        function num(v, min, max) { const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new Error('angka tidak valid'); return n; }
        function numOrNull(v, min, max) { return (v === null || v === undefined || v === '') ? null : num(v, min, max); }
        function photoOrEmpty(v) { return (v === null || v === undefined || v === '') ? '' : str(v, RE_PHOTO); }
        function str(v, re) { if (typeof v !== 'string' || !re.test(v)) throw new Error('teks tidak valid'); return v; }
        function cleanActive(s) {
            if (!s) return null;
            return {
                id: str(s.id, RE_ID), dateKey: str(s.dateKey, RE_DATE),
                startEpoch: num(s.startEpoch, 0, 1e14), startTimestamp: str(s.startTimestamp, RE_TS),
                startSOC: num(s.startSOC, 0, 100), targetSOC: num(s.targetSOC, 0, 100),
                isCalibration: Boolean(s.isCalibration), startMeter: numOrNull(s.startMeter, 0, 1e9),
                startPhotoData: photoOrEmpty(s.startPhotoData)
            };
        }
        function cleanCompleted(s) {
            const a = cleanActive(s);
            return Object.assign(a, {
                endEpoch: num(s.endEpoch, 0, 1e14), endTimestamp: str(s.endTimestamp, RE_TS),
                durationSeconds: num(s.durationSeconds, 0, 1e8), durationFormatted: str(s.durationFormatted, RE_DUR),
                endSOC: num(s.endSOC, 0, 100), deltaSOC: num(s.deltaSOC, -100, 100),
                endMeter: numOrNull(s.endMeter, 0, 1e9), topupKwh: numOrNull(s.topupKwh, 0, 1e6), deltaKwh: numOrNull(s.deltaKwh, 0, 1e6),
                costRp: numOrNull(s.costRp, 0, 1e12), efficiencyPct: numOrNull(s.efficiencyPct, 0, 100),
                endPhotoData: photoOrEmpty(s.endPhotoData)
            });
        }
        function cleanState(obj) {
            const list = Array.isArray(obj && obj.completedSessions) ? obj.completedSessions : [];
            return { activeSession: cleanActive(obj && obj.activeSession), completedSessions: list.map(cleanCompleted) };
        }
        function viewSessionPhoto(id, which, n) {
            const s = completedSessions.find(x => x.id === id);
            if (!s) return;
            const isStart = which === 'start';
            viewPhotoFullscreen(isStart ? s.startPhotoData : s.endPhotoData,
                `Sesi #${n} — Sisa Token ${isStart ? 'Awal' : 'Akhir'} (${fmtKwh(isStart ? s.startMeter : s.endMeter)})`);
        }

        // =====================================================================
        // 3. INDEXEDDB PERSISTENCE LAYER (WITH LOCALSTORAGE FALLBACK)
        // =====================================================================
        const DB_NAME = 'Atto1ChargeTrackerDB';
        const DB_VERSION = 1;
        const STORE_NAME = 'appState';
        let dbInstance = null;

        function openDatabase() {
            return new Promise((resolve) => {
                if (!window.indexedDB) {
                    document.getElementById('storage-status-badge').textContent = 'LocalStorage Mode';
                    resolve(null);
                    return;
                }
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME);
                    }
                };
                req.onsuccess = (event) => {
                    dbInstance = event.target.result;
                    document.getElementById('storage-status-badge').textContent = 'IndexedDB Aktif ✓';
                    resolve(dbInstance);
                };
                req.onerror = () => {
                    document.getElementById('storage-status-badge').textContent = 'LocalStorage Fallback';
                    resolve(null);
                };
            });
        }

        async function savePersistedState() {
            const payload = {
                activeSession,
                completedSessions,
                updatedAt: new Date().toISOString()
            };

            if (dbInstance) {
                return new Promise((resolve) => {
                    try {
                        const tx = dbInstance.transaction(STORE_NAME, 'readwrite');
                        const store = tx.objectStore(STORE_NAME);
                        store.put(payload, 'mainData');
                        tx.oncomplete = () => resolve(true);
                        tx.onerror = () => {
                            saveToLocalStorageFallback(payload);
                            resolve(false);
                        };
                    } catch (e) {
                        saveToLocalStorageFallback(payload);
                        resolve(false);
                    }
                });
            } else {
                saveToLocalStorageFallback(payload);
            }
        }

        function saveToLocalStorageFallback(payload) {
            try {
                localStorage.setItem('atto1_pwa_charge_data_v1', JSON.stringify(payload));
            } catch (err) {
                showToast('Peringatan Penyimpanan', 'Memori browser penuh. Gunakan fitur Ekspor Backup JSON untuk mengamankan data.');
            }
        }

        async function loadPersistedState() {
            if (dbInstance) {
                return new Promise((resolve) => {
                    try {
                        const tx = dbInstance.transaction(STORE_NAME, 'readonly');
                        const store = tx.objectStore(STORE_NAME);
                        const req = store.get('mainData');
                        req.onsuccess = () => {
                            if (req.result) {
                                try { const c = cleanState(req.result); activeSession = c.activeSession; completedSessions = c.completedSessions; }
                                catch (e) { showToast('Data Lokal Bermasalah', 'Sebagian data tidak valid. Pulihkan dari backup JSON terakhir.'); }
                            }
                            resolve();
                        };
                        req.onerror = () => {
                            loadFromLocalStorageFallback();
                            resolve();
                        };
                    } catch (e) {
                        loadFromLocalStorageFallback();
                        resolve();
                    }
                });
            } else {
                loadFromLocalStorageFallback();
            }
        }

        function loadFromLocalStorageFallback() {
            try {
                const raw = localStorage.getItem('atto1_pwa_charge_data_v1');
                if (raw) {
                    const c = cleanState(JSON.parse(raw));
                    activeSession = c.activeSession; completedSessions = c.completedSessions;
                }
            } catch (e) {}
        }

        // =====================================================================
        // 4. AUTOMATIC IMAGE COMPRESSION (HTML5 CANVAS -> COMPACT JPEG)
        // =====================================================================
        function compressImageFile(file, maxDimension = 960, quality = 0.72) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = (e) => {
                    const img = new Image();
                    img.onload = () => {
                        let width = img.width;
                        let height = img.height;

                        if (width > maxDimension || height > maxDimension) {
                            if (width > height) {
                                height = Math.round((height * maxDimension) / width);
                                width = maxDimension;
                            } else {
                                width = Math.round((width * maxDimension) / height);
                                height = maxDimension;
                            }
                        }

                        const canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        const ctx = canvas.getContext('2d');
                        ctx.drawImage(img, 0, 0, width, height);

                        const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
                        const sizeKB = Math.round((compressedDataUrl.length * 3) / 4 / 1024);
                        resolve({ dataUrl: compressedDataUrl, sizeKB });
                    };
                    img.onerror = reject;
                    img.src = e.target.result;
                };
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        }

        // =====================================================================
        // 5. DATE, TIMESTAMP & FORMATTING HELPERS
        // =====================================================================
        function formatTimestampWIB(dateObj = new Date()) {
            const y = dateObj.getFullYear();
            const m = String(dateObj.getMonth() + 1).padStart(2, '0');
            const d = String(dateObj.getDate()).padStart(2, '0');
            const hh = String(dateObj.getHours()).padStart(2, '0');
            const mm = String(dateObj.getMinutes()).padStart(2, '0');
            const ss = String(dateObj.getSeconds()).padStart(2, '0');
            return `${y}-${m}-${d} ${hh}:${mm}:${ss} WIB`;
        }

        function getDateKey(dateObj) {
            const y = dateObj.getFullYear();
            const m = String(dateObj.getMonth() + 1).padStart(2, '0');
            const d = String(dateObj.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }

        function getMonthKey(dateObj) {
            const y = dateObj.getFullYear();
            const m = String(dateObj.getMonth() + 1).padStart(2, '0');
            return `${y}-${m}`;
        }

        function formatIndoDate(dateObj) {
            return `${HARI_ID[dateObj.getDay()]}, ${dateObj.getDate()} ${BULAN_ID[dateObj.getMonth()]} ${dateObj.getFullYear()}`;
        }

        function formatDurationFromSeconds(totalSeconds) {
            const hrs = Math.floor(totalSeconds / 3600);
            const mins = Math.floor((totalSeconds % 3600) / 60);
            const secs = Math.floor(totalSeconds % 60);
            return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        }

        function formatDurationHuman(hoursFloat) {
            const totalMins = Math.round(hoursFloat * 60);
            const h = Math.floor(totalMins / 60);
            const m = totalMins % 60;
            return `${h}j ${String(m).padStart(2, '0')}m`;
        }

        function formatRupiah(num) {
            return 'Rp' + Math.round(num).toLocaleString('id-ID');
        }


        // ===== Meter helpers + on-device OCR (Tesseract, no network) =====
        let ocrWorkerPromise = null;
        let ocrBusy = false;
        function fmtKwh(v) { return (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : `${Number(v).toFixed(2)} kWh`; }
        function fmtRp(v) { return (v === null || v === undefined || !Number.isFinite(Number(v))) ? '—' : formatRupiah(v); }
        function readMeterInput(id) {
            const raw = String(document.getElementById(id).value || '').trim().replace(',', '.');
            if (raw === '') return null;
            const n = parseFloat(raw);
            return (Number.isFinite(n) && n >= 0) ? n : NaN;
        }
        function setOcrStatus(id, text, tone) {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = text || '';
            el.className = 'text-[11px] font-bold mt-1.5 ' + (text ? '' : 'hidden ') +
                (tone === 'ok' ? 'text-emerald-800' : tone === 'warn' ? 'text-amber-800' : 'text-neutral-700');
        }
        function getOcrWorker() {
            if (!ocrWorkerPromise) {
                ocrWorkerPromise = Tesseract.createWorker('eng', 1, {
                    workerPath: './ocr/worker.min.js', corePath: './ocr/core', langPath: './ocr/lang',
                    workerBlobURL: false, gzip: true
                }).then(async (w) => {
                    await w.setParameters({ tessedit_char_whitelist: '0123456789.,', tessedit_pageseg_mode: '11' });
                    return w;
                }).catch((e) => { ocrWorkerPromise = null; throw e; });
            }
            return ocrWorkerPromise;
        }
        function preprocessForOcr(dataUrl) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    const scale = Math.min(2.5, 1600 / Math.max(img.width, img.height));
                    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
                    const c = document.createElement('canvas'); c.width = w; c.height = h;
                    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
                    const d = ctx.getImageData(0, 0, w, h); const p = d.data;
                    const hist = new Array(256).fill(0); const g = new Uint8Array(w * h);
                    for (let i = 0, j = 0; i < p.length; i += 4, j++) { const v = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0; g[j] = v; hist[v]++; }
                    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
                    let sumB = 0, wB = 0, best = 0, thr = 128; const total = w * h;
                    for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break; sumB += t * hist[t];
                        const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF); if (between > best) { best = between; thr = t; } }
                    let dark = 0; for (let j = 0; j < g.length; j++) if (g[j] < thr) dark++;
                    const invert = dark > g.length / 2; // keep dark digits on a light background
                    for (let i = 0, j = 0; i < p.length; i += 4, j++) { let v = g[j] < thr ? 0 : 255; if (invert) v = 255 - v; p[i] = p[i + 1] = p[i + 2] = v; }
                    ctx.putImageData(d, 0, 0); resolve(c);
                };
                img.onerror = reject; img.src = dataUrl;
            });
        }
        function pickMeterNumber(data) {
            let words = Array.isArray(data.words) ? data.words : [];
            if (!words.length && Array.isArray(data.blocks)) {
                data.blocks.forEach(b => (b.paragraphs || []).forEach(pa => (pa.lines || []).forEach(l => (l.words || []).forEach(w => words.push(w)))));
            }
            const cands = words.map(w => ({ t: String(w.text || '').replace(/,/g, '.').replace(/[^0-9.]/g, ''), h: w.bbox ? (w.bbox.y1 - w.bbox.y0) : 0, c: w.confidence || 0 }))
                .filter(x => /^\d{1,7}(\.\d{1,3})?$/.test(x.t) && x.t.replace('.', '').length >= 3)
                .sort((a, b) => (b.h - a.h) || (b.c - a.c));
            return cands.length ? cands[0].t : null;
        }
        async function runMeterOcr(dataUrl, inputId, statusId, validateFn) {
            ocrBusy = true; validateFn();
            setOcrStatus(statusId, '🔎 Membaca angka meteran dari foto...', 'info');
            try {
                const worker = await getOcrWorker();
                const canvas = await preprocessForOcr(dataUrl);
                const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
                const num = pickMeterNumber(data);
                const input = document.getElementById(inputId);
                if (num !== null) {
                    if (input.dataset.manual !== '1') input.value = num;
                    setOcrStatus(statusId, input.dataset.manual === '1'
                        ? `ℹ️ Foto terbaca ${num} kWh, tapi angka ketikan Anda dipakai.`
                        : `✅ Terbaca dari foto: ${num} kWh. Cek & koreksi bila keliru.`, 'ok');
                } else {
                    setOcrStatus(statusId, '⚠️ Angka tidak terbaca. Ketik manual, atau simpan dengan foto saja.', 'warn');
                }
            } catch (e) {
                setOcrStatus(statusId, '⚠️ Pembacaan otomatis gagal. Ketik manual, atau simpan dengan foto saja.', 'warn');
            } finally {
                ocrBusy = false; validateFn();
            }
        }

        // =====================================================================
        // 6. START CHARGE MODAL LOGIC
        // =====================================================================
        function getEstimatedCurrentSOC() {
            if (completedSessions.length === 0) {
                return DEFAULT_INITIAL_SOC; // 38% on Day 1
            }
            const lastSession = completedSessions[completedSessions.length - 1];
            const lastDateStr = lastSession.dateKey;
            const todayStr = getDateKey(new Date());

            // Calculate days elapsed since last completed session
            const d1 = new Date(lastDateStr + 'T00:00:00');
            const d2 = new Date(todayStr + 'T00:00:00');
            const daysDiff = Math.max(0, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
            const estimated = Math.max(10, lastSession.endSOC - (daysDiff * DAILY_DRAIN_PCT));
            return Math.round(estimated);
        }

        function getLastMeterReading() {
            for (let i = completedSessions.length - 1; i >= 0; i--) {
                const v = completedSessions[i].endMeter;
                if (v !== null && v !== undefined && Number.isFinite(Number(v))) return v;
            }
            return '';
        }

        function openStartChargeModal() {
            if (activeSession) {
                showToast('Sesi Cas Sedang Berjalan', 'Akhiri sesi cas yang sedang aktif terlebih dahulu sebelum memulai sesi baru.');
                return;
            }

            startPhotoBase64 = '';
            document.getElementById('input-start-photo').value = '';
            document.getElementById('start-photo-preview-box').classList.add('hidden');
            document.getElementById('start-photo-btn-label').textContent = 'Ambil Foto Meteran Awal (Kamera HP)';

            const estSoc = getEstimatedCurrentSOC();
            document.getElementById('input-start-soc').value = estSoc;

            const lastMeter = getLastMeterReading();
            document.getElementById('input-start-meter').value = '';
            document.getElementById('input-start-meter').dataset.manual = '0';
            setOcrStatus('start-ocr-status', '');

            const now = new Date();
            const isSaturday = now.getDay() === 6;
            const targetSoc = isSaturday ? 100 : 80;
            document.getElementById('start-target-info').textContent = isSaturday
                ? '🌟 Malam Minggu / Sabtu Malam: Target Kalibrasi LFP Penuh 100%!'
                : '🔵 Malam Reguler: Target berhenti di 80% untuk menjaga SoH baterai optimal.';

            document.getElementById('start-modal-live-ts').textContent = formatTimestampWIB(now);
            validateStartForm();
            document.getElementById('modal-start-charge').classList.remove('hidden');
        }

        function closeStartChargeModal() {
            document.getElementById('modal-start-charge').classList.add('hidden');
        }

        async function handleStartPhotoChange(event) {
            const file = event.target.files[0];
            if (!file) return;
            try {
                document.getElementById('start-photo-btn-label').textContent = 'Mengompresi Foto...';
                const { dataUrl, sizeKB } = await compressImageFile(file);
                startPhotoBase64 = dataUrl;
                document.getElementById('start-photo-preview-img').src = dataUrl;
                document.getElementById('start-photo-size').textContent = `${sizeKB} KB`;
                document.getElementById('start-photo-preview-box').classList.remove('hidden');
                document.getElementById('start-photo-btn-label').textContent = 'Ganti Foto Meteran Awal';
                validateStartForm();
                runMeterOcr(dataUrl, 'input-start-meter', 'start-ocr-status', validateStartForm);
            } catch (err) {
                showToast('Gagal Memproses Foto', 'Silakan coba ambil ulang foto meteran listrik Anda.');
            }
        }

        function validateStartForm() {
            const socVal = parseFloat(document.getElementById('input-start-soc').value);
            const meterVal = readMeterInput('input-start-meter');
            const hasPhoto = Boolean(startPhotoBase64);
            const isSocValid = !isNaN(socVal) && socVal >= 1 && socVal <= 99;
            const meterOk = meterVal !== null && !Number.isNaN(meterVal);
            const meterBad = Number.isNaN(meterVal);
            const allValid = isSocValid && !meterBad && (meterOk || hasPhoto) && !ocrBusy;

            const submitBtn = document.getElementById('btn-confirm-start');
            const msgBox = document.getElementById('start-validation-msg');
            submitBtn.disabled = !allValid;
            if (ocrBusy) {
                msgBox.className = 'text-xs font-bold text-neutral-800 bg-neutral-50 border-2 border-neutral-700 rounded-lg p-2.5';
                msgBox.textContent = '⏳ Sedang membaca angka dari foto...';
            } else if (allValid) {
                msgBox.className = 'text-xs font-bold text-emerald-900 bg-emerald-50 border-2 border-emerald-700 rounded-lg p-2.5';
                msgBox.textContent = meterOk
                    ? (hasPhoto ? '✅ Angka meteran + foto bukti lengkap. Siap mulai!' : '✅ Siap mulai (tanpa foto).')
                    : '✅ Siap mulai dengan foto saja. Angka kWh tidak tercatat, jadi biaya sesi ini tidak dihitung.';
            } else {
                msgBox.className = 'text-xs font-bold text-red-700 bg-red-50 border-2 border-red-700 rounded-lg p-2.5';
                msgBox.textContent = '⚠️ Isi Sisa Baterai (%), lalu isi Angka Meteran ATAU ambil Foto Meteran.';
            }
        }

        async function confirmStartCharge() {
            const socVal = parseInt(document.getElementById('input-start-soc').value, 10);
            const meterVal = readMeterInput('input-start-meter');
            if (isNaN(socVal) || Number.isNaN(meterVal) || (meterVal === null && !startPhotoBase64) || ocrBusy) return;

            const now = new Date();
            const isSaturday = now.getDay() === 6;
            const targetSOC = isSaturday ? 100 : (socVal >= 80 ? 100 : 80);

            activeSession = {
                id: 'SES-' + now.getTime(),
                dateKey: getDateKey(now),
                startEpoch: now.getTime(),
                startTimestamp: formatTimestampWIB(now),
                startSOC: socVal,
                targetSOC: targetSOC,
                isCalibration: targetSOC === 100,
                startMeter: meterVal,
                startPhotoData: startPhotoBase64 || ''
            };

            await savePersistedState();
            closeStartChargeModal();
            updateUIState();
            const parts = [];
            if (meterVal !== null) parts.push(`meteran ${meterVal} kWh`);
            if (startPhotoBase64) parts.push('foto');
            showToast('Sesi Cas Dimulai! ⚡', `Timestamp ${activeSession.startTimestamp} & ${parts.join(' + ')} berhasil dikunci.`);
        }

        // =====================================================================
        // 7. STOP CHARGE MODAL LOGIC & REAL-TIME CALCULATIONS
        // =====================================================================
        function openStopChargeModal() {
            if (!activeSession) return;

            stopPhotoBase64 = '';
            document.getElementById('input-stop-photo').value = '';
            document.getElementById('stop-photo-preview-box').classList.add('hidden');
            document.getElementById('stop-calc-preview').classList.add('hidden');
            document.getElementById('stop-photo-btn-label').textContent = 'Ambil Foto Meteran Akhir (Kamera HP)';
            setOcrStatus('stop-ocr-status', '');

            const elapsedHours = (Date.now() - activeSession.startEpoch) / (1000 * 3600);
            const estSocNow = Math.min(100, Math.round(activeSession.startSOC + elapsedHours * PCT_PER_HOUR));
            document.getElementById('input-stop-soc').value = estSocNow;

            const meterInput = document.getElementById('input-stop-meter');
            meterInput.dataset.manual = '0';
            meterInput.value = activeSession.startMeter !== null
                ? Math.max(0, activeSession.startMeter - elapsedHours * CHARGER_KW).toFixed(2) : '';
            document.getElementById('input-stop-topup').value = '';

            document.getElementById('stop-modal-live-ts').textContent = formatTimestampWIB(new Date());
            document.getElementById('stop-modal-start-ref').textContent =
                `SOC ${activeSession.startSOC}% • Sisa token ${fmtKwh(activeSession.startMeter)}`;

            validateStopForm();
            document.getElementById('modal-stop-charge').classList.remove('hidden');
        }

        function closeStopChargeModal() {
            document.getElementById('modal-stop-charge').classList.add('hidden');
        }

        async function handleStopPhotoChange(event) {
            const file = event.target.files[0];
            if (!file) return;
            try {
                document.getElementById('stop-photo-btn-label').textContent = 'Mengompresi Foto...';
                const { dataUrl, sizeKB } = await compressImageFile(file);
                stopPhotoBase64 = dataUrl;
                document.getElementById('stop-photo-preview-img').src = dataUrl;
                document.getElementById('stop-photo-size').textContent = `${sizeKB} KB`;
                document.getElementById('stop-photo-preview-box').classList.remove('hidden');
                document.getElementById('stop-photo-btn-label').textContent = 'Ganti Foto Meteran Akhir';
                validateStopForm();
                runMeterOcr(dataUrl, 'input-stop-meter', 'stop-ocr-status', validateStopForm);
            } catch (err) {
                showToast('Gagal Memproses Foto', 'Silakan ambil ulang foto meteran akhir Anda.');
            }
        }

        function validateStopForm() {
            if (!activeSession) return;

            const endSoc = parseFloat(document.getElementById('input-stop-soc').value);
            const endMeter = readMeterInput('input-stop-meter');
            const topupRaw = readMeterInput('input-stop-topup');
            const topup = topupRaw === null ? 0 : topupRaw;
            const hasPhoto = Boolean(stopPhotoBase64);
            const startMeter = activeSession.startMeter;
            // Prepaid (token) meter: the display counts DOWN while charging.
            const used = (endMeter !== null && !Number.isNaN(endMeter) && startMeter !== null && !Number.isNaN(topup))
                ? startMeter + topup - endMeter : null;

            const isSocValid = !isNaN(endSoc) && endSoc >= activeSession.startSOC && endSoc <= 100;
            const meterOk = endMeter !== null && !Number.isNaN(endMeter) && !Number.isNaN(topup) && (used === null || used >= 0);
            const meterBad = Number.isNaN(endMeter) || Number.isNaN(topup) || (used !== null && used < 0);

            const previewBox = document.getElementById('stop-calc-preview');
            if (!isNaN(endSoc) && endSoc >= activeSession.startSOC) {
                const deltaSoc = Math.max(0, endSoc - activeSession.startSOC);
                document.getElementById('calc-delta-soc').textContent = `+${deltaSoc}% (${activeSession.startSOC}% ➔ ${endSoc}%)`;
                if (meterOk && used !== null) {
                    const deltaKwh = used;
                    const batteryKwhGained = (deltaSoc / 100) * BATTERY_KWH;
                    const efficiencyPct = deltaKwh > 0 ? Math.min(100, (batteryKwhGained / deltaKwh) * 100) : 0;
                    document.getElementById('calc-delta-kwh').textContent = `${deltaKwh.toFixed(2)} kWh`;
                    document.getElementById('calc-cost-rp').textContent = formatRupiah(deltaKwh * PLN_TARIFF_R2);
                    document.getElementById('calc-efficiency').textContent = `${efficiencyPct.toFixed(1)}%`;
                } else {
                    document.getElementById('calc-delta-kwh').textContent = '— (butuh angka awal & akhir)';
                    document.getElementById('calc-cost-rp').textContent = '—';
                    document.getElementById('calc-efficiency').textContent = '—';
                }
                previewBox.classList.remove('hidden');
            } else {
                previewBox.classList.add('hidden');
            }

            const allValid = isSocValid && !meterBad && (meterOk || hasPhoto) && !ocrBusy;
            const btn = document.getElementById('btn-confirm-stop');
            const msgBox = document.getElementById('stop-validation-msg');
            btn.disabled = !allValid;
            if (ocrBusy) {
                msgBox.className = 'text-xs font-bold text-neutral-800 bg-neutral-50 border-2 border-neutral-700 rounded-lg p-2.5';
                msgBox.textContent = '⏳ Sedang membaca angka dari foto...';
            } else if (allValid) {
                msgBox.className = 'text-xs font-bold text-emerald-900 bg-emerald-50 border-2 border-emerald-700 rounded-lg p-2.5';
                msgBox.textContent = (meterOk && used !== null)
                    ? '✅ Validasi lengkap! Klik Simpan & Akhiri Sesi Cas.'
                    : '✅ Bisa disimpan. Biaya & kWh tidak dihitung karena angka sisa token awal/akhir tidak lengkap.';
            } else {
                msgBox.className = 'text-xs font-bold text-red-700 bg-red-50 border-2 border-red-700 rounded-lg p-2.5';
                msgBox.textContent = meterBad && used !== null
                    ? `⚠️ Sisa token akhir harus ≤ ${startMeter} kWh (token berkurang saat dipakai). Kalau sempat isi token, isi kolom "Token diisi".`
                    : `⚠️ Isi Baterai Akhir (${activeSession.startSOC}%–100%), lalu isi Sisa Token Akhir ATAU ambil Foto Meteran.`;
            }
        }

        async function confirmStopCharge() {
            if (!activeSession) return;

            const endSoc = parseInt(document.getElementById('input-stop-soc').value, 10);
            const endMeter = readMeterInput('input-stop-meter');
            const topupRaw = readMeterInput('input-stop-topup');
            const topup = topupRaw === null ? 0 : topupRaw;
            const startMeter = activeSession.startMeter;
            if (isNaN(endSoc) || Number.isNaN(endMeter) || Number.isNaN(topup) || ocrBusy) return;
            if (endMeter === null && !stopPhotoBase64) return;
            const hasKwh = endMeter !== null && startMeter !== null;
            if (hasKwh && startMeter + topup - endMeter < 0) return;

            const now = new Date();
            const durationSeconds = Math.max(1, Math.round((now.getTime() - activeSession.startEpoch) / 1000));
            const deltaSoc = endSoc - activeSession.startSOC;
            const deltaKwh = hasKwh ? Number((startMeter + topup - endMeter).toFixed(3)) : null;
            const costRp = hasKwh ? deltaKwh * PLN_TARIFF_R2 : null;
            const batteryKwhGained = (deltaSoc / 100) * BATTERY_KWH;
            const efficiencyPct = (hasKwh && deltaKwh > 0) ? Number(Math.min(100, (batteryKwhGained / deltaKwh) * 100).toFixed(1)) : null;

            const finishedRecord = {
                ...activeSession,
                endEpoch: now.getTime(),
                endTimestamp: formatTimestampWIB(now),
                durationSeconds,
                durationFormatted: formatDurationFromSeconds(durationSeconds),
                endSOC: endSoc,
                deltaSOC: deltaSoc,
                endMeter: endMeter,
                topupKwh: topupRaw === null ? null : topup,
                deltaKwh: deltaKwh,
                costRp: costRp,
                efficiencyPct: efficiencyPct,
                endPhotoData: stopPhotoBase64 || ''
            };

            completedSessions.push(finishedRecord);
            activeSession = null;

            await savePersistedState();
            closeStopChargeModal();
            updateUIState();

            showToast('Sesi Cas Tersimpan Permanen! ✅', hasKwh
                ? `Terisi +${deltaSoc}% (${deltaKwh.toFixed(2)} kWh PLN • ${formatRupiah(costRp)}). Jadwal 1 tahun telah diperbarui.`
                : `Terisi +${deltaSoc}%. kWh & biaya tidak dihitung (angka meteran tidak lengkap).`);
        }

        // =====================================================================
        // 8. DYNAMIC 1-YEAR SCHEDULE & UI RENDERING
        // =====================================================================
        function populateScheduleMonthFilter() {
            const sel = document.getElementById('sched-filter-month');
            const seen = new Set();
            for (let i = 0; i < TOTAL_DAYS; i++) {
                const d = new Date(START_DATE);
                d.setDate(START_DATE.getDate() + i);
                const mKey = getMonthKey(d);
                if (!seen.has(mKey)) {
                    seen.add(mKey);
                    const opt = document.createElement('option');
                    opt.value = mKey;
                    opt.textContent = `${BULAN_ID[d.getMonth()]} ${d.getFullYear()}`;
                    sel.appendChild(opt);
                }
            }
        }

        function rebuildDynamicSchedule() {
            scheduleRows = [];

            // Map completed sessions by dateKey
            const realizedByDate = {};
            completedSessions.forEach(s => {
                realizedByDate[s.dateKey] = s;
            });

            for (let i = 0; i < TOTAL_DAYS; i++) {
                const d = new Date(START_DATE);
                d.setDate(START_DATE.getDate() + i);
                const dateKey = getDateKey(d);
                const monthKey = getMonthKey(d);
                const dayOfWeek = d.getDay(); // 6 = Sabtu
                const realized = realizedByDate[dateKey] || null;

                let startSOC;
                if (i === 0) {
                    startSOC = DEFAULT_INITIAL_SOC; // 38%
                } else {
                    const prevEnd = scheduleRows[i - 1].endSOC;
                    startSOC = Math.max(10, prevEnd - DAILY_DRAIN_PCT);
                }

                let statusType = 'REST'; // 'REALIZED' | 'CHARGE_80' | 'CALIBRATION_100' | 'REST'
                let endSOC = startSOC;
                let durationStr = '—';
                let noteStr = '';

                if (realized) {
                    statusType = 'REALIZED';
                    startSOC = realized.startSOC;
                    endSOC = realized.endSOC;
                    durationStr = `${realized.durationFormatted} (${fmtKwh(realized.deltaKwh)})`;
                    noteStr = `Terealisasi: ${realized.startSOC}% ➔ ${realized.endSOC}% • Biaya ${fmtRp(realized.costRp)} • Sisa token ${fmtKwh(realized.startMeter)} ➔ ${fmtKwh(realized.endMeter)}${realized.topupKwh ? ` (isi token ${fmtKwh(realized.topupKwh)})` : ''}.`;
                } else {
                    const isChargeDay = (i % 2 === 0);
                    if (isChargeDay) {
                        const isSatCal = (dayOfWeek === 6);
                        statusType = isSatCal ? 'CALIBRATION_100' : 'CHARGE_80';
                        endSOC = isSatCal ? 100 : 80;
                        const gain = Math.max(0, endSOC - startSOC);
                        const hrs = gain / PCT_PER_HOUR;
                        durationStr = `±${formatDurationHuman(hrs)}`;
                        noteStr = isSatCal
                            ? `Kalibrasi LFP Sabtu Malam: Cas penuh ke 100% (+${gain}%) untuk cell balancing BMS.`
                            : `Jadwal Cas 2-Harian: Cas dari ${startSOC}% ➔ stop di 80% (+${gain}%) menjaga SoH optimal.`;
                    } else {
                        statusType = 'REST';
                        endSOC = startSOC;
                        noteStr = `Libur Cas: Pemakaian rutin ±50 km (-18%). Sisa akhir hari ~${endSOC}%.`;
                    }
                }

                scheduleRows.push({
                    dayNum: i + 1,
                    dateObj: d,
                    dateKey,
                    monthKey,
                    dateFormatted: formatIndoDate(d),
                    statusType,
                    startSOC,
                    endSOC,
                    durationStr,
                    noteStr,
                    realizedSession: realized
                });
            }
        }

        function renderScheduleTable() {
            const tbody = document.getElementById('schedule-tbody');
            const filterType = document.getElementById('sched-filter-type').value;
            const filterMonth = document.getElementById('sched-filter-month').value;
            const searchTxt = document.getElementById('sched-search').value.trim().toLowerCase();
            const todayKey = getDateKey(new Date());

            const filtered = scheduleRows.filter(r => {
                if (filterMonth !== 'ALL' && r.monthKey !== filterMonth) return false;
                if (filterType !== 'ALL' && r.statusType !== filterType) return false;
                if (searchTxt && !r.dateFormatted.toLowerCase().includes(searchTxt) && !`hari ${r.dayNum}`.includes(searchTxt)) {
                    return false;
                }
                return true;
            });

            document.getElementById('sched-count-badge').textContent = `${filtered.length} Hari`;

            if (filtered.length === 0) {
                tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center font-bold text-neutral-500">Tidak ada jadwal yang sesuai filter.</td></tr>`;
                return;
            }

            tbody.innerHTML = filtered.map(r => {
                const isToday = r.dateKey === todayKey || (r.dayNum === 1 && completedSessions.length === 0);

                let rowBg = 'bg-white';
                if (r.statusType === 'REALIZED') rowBg = 'bg-[#DCFCE7]';
                else if (r.statusType === 'CALIBRATION_100') rowBg = 'bg-[#FEF9C3]';
                else if (r.statusType === 'CHARGE_80') rowBg = 'bg-[#F0F9FF]';

                let badgeHtml = `<span class="nb-badge bg-[#E5E7EB] text-neutral-700 px-2 py-0.5 whitespace-nowrap">💤 LIBUR CAS</span>`;
                if (r.statusType === 'REALIZED') {
                    badgeHtml = `<span class="nb-badge bg-[#22C55E] text-[#111827] px-2 py-0.5 whitespace-nowrap">✅ REALISASI</span>`;
                } else if (r.statusType === 'CALIBRATION_100') {
                    badgeHtml = `<span class="nb-badge bg-[#FDE047] text-[#111827] px-2 py-0.5 whitespace-nowrap">🟡 KALIBRASI 100%</span>`;
                } else if (r.statusType === 'CHARGE_80') {
                    badgeHtml = `<span class="nb-badge bg-[#7DD3FC] text-[#111827] px-2 py-0.5 whitespace-nowrap">🔵 CAS 80%</span>`;
                }

                const socCell = r.statusType === 'REST'
                    ? `<span class="font-mono-code font-bold text-neutral-600">${r.endSOC}%</span>`
                    : `<span class="font-mono-code font-extrabold px-2 py-0.5 rounded border border-black ${r.statusType === 'REALIZED' ? 'bg-[#BEF264]' : 'bg-white'}">${r.startSOC}% ➔ ${r.endSOC}%</span>`;

                const photoBtnHtml = r.realizedSession
                    ? `<button onclick="switchTab('history')" class="ml-1.5 underline font-extrabold text-blue-700">Lihat Foto Meteran</button>`
                    : '';

                return `
                    <tr class="${rowBg}">
                        <td class="py-2.5 px-3 border-r-2 border-[#111827] text-center font-mono-code font-bold">#${r.dayNum}</td>
                        <td class="py-2.5 px-3.5 border-r-2 border-[#111827]">
                            <div class="font-bold text-[#111827]">${r.dateFormatted}</div>
                            ${isToday ? '<span class="text-[10px] font-extrabold uppercase text-red-700">★ HARI INI</span>' : ''}
                        </td>
                        <td class="py-2.5 px-3.5 border-r-2 border-[#111827] text-center">${badgeHtml}</td>
                        <td class="py-2.5 px-3.5 border-r-2 border-[#111827] text-center whitespace-nowrap">${socCell}</td>
                        <td class="py-2.5 px-3.5 border-r-2 border-[#111827] text-center font-mono-code font-bold whitespace-nowrap">${r.durationStr}</td>
                        <td class="py-2.5 px-3.5 text-neutral-800">${r.noteStr}${photoBtnHtml}</td>
                    </tr>
                `;
            }).join('');
        }

        function renderHistoryList() {
            const container = document.getElementById('history-list-container');
            document.getElementById('tab-history-count').textContent = completedSessions.length;

            if (completedSessions.length === 0) {
                container.innerHTML = `
                    <div class="nb-card p-8 bg-white text-center space-y-2">
                        <div class="text-3xl">📸</div>
                        <h4 class="font-display font-bold text-base">Belum Ada Riwayat Sesi Pengecasan</h4>
                        <p class="text-xs font-semibold text-neutral-600 max-w-md mx-auto">
                            Tekan tombol <b>MULAI CAS (START CHARGE)</b> saat mulai mencolok charger, lalu ketik angka meteran atau foto meteran listrik Anda.
                        </p>
                    </div>
                `;
                return;
            }

            const photoBlock = (s, which, n) => {
                const isStart = which === 'start';
                const photo = isStart ? s.startPhotoData : s.endPhotoData;
                const meter = isStart ? s.startMeter : s.endMeter;
                const bg = isStart ? 'bg-[#F0F9FF]' : 'bg-[#FEF9C3]';
                const label = isStart ? 'Sisa Token Awal' : 'Sisa Token Akhir';
                const media = photo
                    ? `<img src="${photo}" alt="Foto ${label}" onclick="viewSessionPhoto('${s.id}', '${which}', ${n})" class="w-full h-40 object-cover rounded-lg border-2 border-[#111827] cursor-pointer">`
                    : `<div class="w-full h-40 rounded-lg border-2 border-dashed border-[#111827] flex items-center justify-center text-xs font-bold text-neutral-500">Tanpa foto (angka diketik)</div>`;
                const zoom = photo ? `<button onclick="viewSessionPhoto('${s.id}', '${which}', ${n})" class="underline text-blue-700 text-[11px]">Zoom</button>` : '';
                return `
                    <div class="nb-card-sm p-2.5 ${bg}">
                        <div class="flex items-center justify-between text-xs font-extrabold mb-1.5">
                            <span>📷 ${label}: <span class="font-mono-code">${fmtKwh(meter)}</span></span>
                            ${zoom}
                        </div>
                        ${media}
                    </div>`;
            };

            const reversed = [...completedSessions].reverse();
            container.innerHTML = reversed.map((s, idx) => {
                const sessionNumber = completedSessions.length - idx;
                return `
                    <article class="nb-card p-4 sm:p-5 bg-white space-y-4">
                        <div class="flex flex-wrap items-center justify-between gap-2 pb-3 border-b-2 border-[#111827]">
                            <div class="flex flex-wrap items-center gap-2">
                                <span class="nb-badge bg-[#111827] text-[#BEF264] px-2.5 py-1 font-mono-code">SESI #${sessionNumber}</span>
                                <span class="nb-badge ${s.endSOC === 100 ? 'bg-[#FDE047]' : 'bg-[#7DD3FC]'} px-2.5 py-1">
                                    ${s.startSOC}% ➔ ${s.endSOC}% (+${s.deltaSOC}%)
                                </span>
                                <span class="font-mono-code text-xs font-extrabold text-emerald-800 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-700">
                                    ${s.deltaKwh !== null ? fmtKwh(s.deltaKwh) + ' PLN' : 'kWh —'} • ${fmtRp(s.costRp)}
                                </span>
                            </div>
                            <button onclick="deleteSessionRecord('${s.id}', this)" class="text-xs font-bold text-red-600 underline">
                                Hapus Log
                            </button>
                        </div>

                        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                            <div class="nb-card-sm p-2.5 bg-[#FAF9F6]">
                                <div class="text-[10px] font-extrabold uppercase text-neutral-500">Mulai Cas</div>
                                <div class="font-mono-code font-bold mt-0.5">${s.startTimestamp}</div>
                            </div>
                            <div class="nb-card-sm p-2.5 bg-[#FAF9F6]">
                                <div class="text-[10px] font-extrabold uppercase text-neutral-500">Selesai Cas</div>
                                <div class="font-mono-code font-bold mt-0.5">${s.endTimestamp}</div>
                            </div>
                            <div class="nb-card-sm p-2.5 bg-[#FAF9F6]">
                                <div class="text-[10px] font-extrabold uppercase text-neutral-500">Durasi Total</div>
                                <div class="font-mono-code font-extrabold mt-0.5">${s.durationFormatted}</div>
                            </div>
                            <div class="nb-card-sm p-2.5 bg-[#FAF9F6]">
                                <div class="text-[10px] font-extrabold uppercase text-neutral-500">Efisiensi Charger</div>
                                <div class="font-mono-code font-extrabold mt-0.5">${s.efficiencyPct !== null ? s.efficiencyPct + '%' : '—'}</div>
                            </div>
                        </div>

                        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            ${photoBlock(s, 'start', sessionNumber)}
                            ${photoBlock(s, 'end', sessionNumber)}
                        </div>
                    </article>
                `;
            }).join('');
        }

        let pendingDeleteId = null, pendingDeleteTimer = null;
        async function deleteSessionRecord(sessionId, btn) {
            if (pendingDeleteId !== sessionId) {
                pendingDeleteId = sessionId;
                if (btn) btn.textContent = 'Ketuk lagi untuk hapus';
                clearTimeout(pendingDeleteTimer);
                pendingDeleteTimer = setTimeout(() => { pendingDeleteId = null; if (btn) btn.textContent = 'Hapus Log'; }, 4000);
                return;
            }
            pendingDeleteId = null; clearTimeout(pendingDeleteTimer);
            completedSessions = completedSessions.filter(s => s.id !== sessionId);
            await savePersistedState();
            updateUIState();
            showToast('Log Dihapus', 'Catatan sesi pengecasan telah dihapus dari penyimpanan lokal.');
        }

        // =====================================================================
        // 9. UI STATE SYNCHRONIZATION & LIVE TIMER
        // =====================================================================
        function updateUIState() {
            const idleCard = document.getElementById('idle-charge-card');
            const activeCard = document.getElementById('active-charge-card');

            if (activeSession) {
                idleCard.classList.add('hidden');
                activeCard.classList.remove('hidden');

                document.getElementById('active-target-badge').textContent = `Target: ${activeSession.targetSOC}%`;
                document.getElementById('active-start-ts').textContent = activeSession.startTimestamp;
                document.getElementById('active-start-values').textContent =
                    `SOC ${activeSession.startSOC}% • ${fmtKwh(activeSession.startMeter)}`;
                document.getElementById('active-photo-box').classList.toggle('hidden', !activeSession.startPhotoData);
                if (activeSession.startPhotoData) document.getElementById('active-start-thumb').src = activeSession.startPhotoData;

                const pctNeeded = Math.max(0, activeSession.targetSOC - activeSession.startSOC);
                const hoursNeeded = pctNeeded / PCT_PER_HOUR;
                const estFinishDate = new Date(activeSession.startEpoch + hoursNeeded * 3600 * 1000);
                document.getElementById('active-est-finish').textContent =
                    `${formatTimestampWIB(estFinishDate).slice(11, 16)} WIB (±${formatDurationHuman(hoursNeeded)})`;

                startActiveLiveTimer();
            } else {
                activeCard.classList.add('hidden');
                idleCard.classList.remove('hidden');
                stopActiveLiveTimer();

                const estSoc = getEstimatedCurrentSOC();
                document.getElementById('hero-current-soc').textContent = `${estSoc}%`;
                const now = new Date();
                document.getElementById('today-schedule-pill').textContent = `Hari Ini: ${formatIndoDate(now)}`;
            }

            // Update 4 KPI summary cards
            const totalSessions = completedSessions.length;
            const totalKwh = completedSessions.reduce((acc, s) => acc + (s.deltaKwh || 0), 0);
            const totalCost = completedSessions.reduce((acc, s) => acc + (s.costRp || 0), 0);
            const effList = completedSessions.map(s => s.efficiencyPct).filter(v => v !== null && v !== undefined && Number.isFinite(Number(v)));
            const avgEff = effList.length ? effList.reduce((a, b) => a + Number(b), 0) / effList.length : 92.0;

            document.getElementById('kpi-total-sessions').textContent = `${totalSessions} Sesi`;
            document.getElementById('kpi-total-kwh').textContent = `Total PLN: ${totalKwh.toFixed(2)} kWh`;
            document.getElementById('kpi-total-cost').textContent = formatRupiah(totalCost);
            document.getElementById('kpi-avg-eff').textContent = `${avgEff.toFixed(1)}%`;

            rebuildDynamicSchedule();
            renderScheduleTable();
            renderHistoryList();
        }

        function startActiveLiveTimer() {
            stopActiveLiveTimer();
            const tick = () => {
                if (!activeSession) return;
                const elapsedSec = Math.max(0, Math.floor((Date.now() - activeSession.startEpoch) / 1000));
                document.getElementById('active-live-timer').textContent = formatDurationFromSeconds(elapsedSec);

                const estSoc = Math.min(100, activeSession.startSOC + (elapsedSec / 3600) * PCT_PER_HOUR);
                document.getElementById('active-est-soc').textContent = `${estSoc.toFixed(1)}%`;
            };
            tick();
            liveTimerInterval = setInterval(tick, 1000);
        }

        function stopActiveLiveTimer() {
            if (liveTimerInterval) {
                clearInterval(liveTimerInterval);
                liveTimerInterval = null;
            }
        }

        function startHeaderClock() {
            const updateClock = () => {
                const nowStr = formatTimestampWIB(new Date());
                document.getElementById('header-clock').textContent = nowStr;

                if (!document.getElementById('modal-start-charge').classList.contains('hidden')) {
                    document.getElementById('start-modal-live-ts').textContent = nowStr;
                }
                if (!document.getElementById('modal-stop-charge').classList.contains('hidden')) {
                    document.getElementById('stop-modal-live-ts').textContent = nowStr;
                }
            };
            updateClock();
            setInterval(updateClock, 1000);
        }

        // =====================================================================
        // 10. TABS, PHOTO VIEWER, BACKUP JSON & .ICS CALENDAR EXPORT
        // =====================================================================
        function switchTab(tabName) {
            ['schedule', 'history', 'backup'].forEach(t => {
                const btn = document.getElementById(`tab-btn-${t}`);
                const panel = document.getElementById(`tab-panel-${t}`);
                if (t === tabName) {
                    btn.classList.remove('bg-[#FFFFFF]', 'text-[#111827]');
                    btn.classList.add('bg-[#111827]', 'text-[#BEF264]');
                    panel.classList.remove('hidden');
                } else {
                    btn.classList.remove('bg-[#111827]', 'text-[#BEF264]');
                    btn.classList.add('bg-[#FFFFFF]', 'text-[#111827]');
                    panel.classList.add('hidden');
                }
            });
        }

        function viewPhotoFullscreen(dataUrl, caption) {
            if (!dataUrl) return;
            document.getElementById('photo-viewer-img').src = dataUrl;
            document.getElementById('photo-viewer-caption').textContent = caption || 'Bukti Foto Meteran';
            document.getElementById('modal-photo-viewer').classList.remove('hidden');
        }

        function closePhotoViewer() {
            document.getElementById('modal-photo-viewer').classList.add('hidden');
        }

        function openInstallModal() {
            document.getElementById('modal-install-pwa').classList.remove('hidden');
        }

        function closeInstallModal() {
            document.getElementById('modal-install-pwa').classList.add('hidden');
        }

        function exportBackupJSON() {
            const backupObj = {
                app: 'BYD Atto 1 Charge Tracker & SoH Logbook',
                version: 1,
                exportedAt: formatTimestampWIB(new Date()),
                activeSession,
                completedSessions
            };
            const blob = new Blob([JSON.stringify(backupObj, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.setAttribute('download', `Backup_Atto1_ChargeLog_${getDateKey(new Date())}.json`);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showToast('Backup JSON Diunduh!', `Berhasil mengekspor ${completedSessions.length} sesi lengkap beserta foto bukti meteran.`);
        }

        async function importBackupJSON(event) {
            const file = event.target.files[0];
            if (!file) return;
            if (file.size > 200 * 1024 * 1024) { showToast('File Terlalu Besar', 'Maksimal 200 MB.'); event.target.value = ''; return; }
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                if (!parsed || !Array.isArray(parsed.completedSessions)) {
                    throw new Error('Format file JSON tidak valid.');
                }
                const c = cleanState(parsed);
                activeSession = c.activeSession;
                completedSessions = c.completedSessions;
                await savePersistedState();
                updateUIState();
                showToast('Restore Berhasil! ✅', `Memulihkan ${completedSessions.length} sesi pengecasan beserta foto bukti meteran.`);
            } catch (err) {
                showToast('Gagal Impor JSON', 'Pastikan file yang dipilih adalah file backup JSON dari aplikasi ini.');
            }
            event.target.value = '';
        }

        function downloadICS() {
            const icsContent = [
                'BEGIN:VCALENDAR',
                'VERSION:2.0',
                'PRODID:-//BYD Atto 1 Charge Logbook//PWA Android//ID',
                'CALSCALE:GREGORIAN',
                'METHOD:PUBLISH',
                'BEGIN:VEVENT',
                'UID:atto1-pwa-reg80-2day-20261122@atto1logbook.id',
                'DTSTAMP:20261122T130000Z',
                'DTSTART;TZID=Asia/Jakarta:20261122T210000',
                'DTEND;TZID=Asia/Jakarta:20261122T211500',
                'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=183',
                'SUMMARY:🔵 Cas BYD Atto 1 — STOP di 80% (Buka App & Foto Meteran)',
                'DESCRIPTION:Buka aplikasi Atto 1 Charge Logbook -> Input sisa baterai & foto meteran kWh awal -> Klik START CHARGE (1.3 kW, durasi ±9 jam sampai 80%).',
                'BEGIN:VALARM',
                'TRIGGER:-PT0M',
                'ACTION:DISPLAY',
                'DESCRIPTION:Waktunya Cas BYD Atto 1 & Foto Meteran Listrik!',
                'END:VALARM',
                'END:VEVENT',
                'BEGIN:VEVENT',
                'UID:atto1-pwa-cal100-sat-20261128@atto1logbook.id',
                'DTSTAMP:20261122T130000Z',
                'DTSTART;TZID=Asia/Jakarta:20261128T210000',
                'DTEND;TZID=Asia/Jakarta:20261128T211500',
                'RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=52',
                'SUMMARY:🟡 Kalibrasi LFP BYD Atto 1 — CAS PENUH 100% (Sabtu Malam)',
                'DESCRIPTION:Jadwal Kalibrasi Mingguan Sabtu Malam (1.3 kW, ±14 jam hingga 100%). Jangan lupa foto meteran awal & akhir di Atto 1 Charge Logbook!',
                'BEGIN:VALARM',
                'TRIGGER:-PT0M',
                'ACTION:DISPLAY',
                'DESCRIPTION:Sabtu Malam: Kalibrasi LFP BYD Atto 1 sampai 100%!',
                'END:VALARM',
                'END:VEVENT',
                'END:VCALENDAR'
            ].join('\r\n');

            const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.setAttribute('download', 'Alarm_Cas_BYD_Atto1_Otomatis_1Tahun.ics');
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            showToast('File Alarm .ICS Diunduh!', 'Buka file .ics tersebut di HP Android Anda untuk memasang pengingat berulang 1 tahun.');
        }

        let toastTimer;
        function showToast(title, body) {
            const box = document.getElementById('toast');
            document.getElementById('toast-title').textContent = title;
            document.getElementById('toast-body').textContent = body;
            box.classList.remove('hidden');
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => box.classList.add('hidden'), 6000);
        }

        function hideToast() {
            document.getElementById('toast').classList.add('hidden');
        }

        // =====================================================================
        // 11. BOOTSTRAP APPLICATION
        // =====================================================================
        window.addEventListener('DOMContentLoaded', async () => {
            if ('serviceWorker' in navigator) { navigator.serviceWorker.register('./sw.js').catch(() => {}); }
            if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(() => {}); }
            populateScheduleMonthFilter();
            startHeaderClock();
            await openDatabase();
            await loadPersistedState();
            updateUIState();
        });
