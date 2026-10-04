(async function() {
    'use strict';

    // ==========================================
    // CONFIGURACIÓN Y CONSTANTES
    // ==========================================
    const DB_NAME = 'sigep_extractor_db';
    const STORE_NAME = 'records';
    const MIN_PAGE_DELAY = 1800; // ms mínimo entre páginas
    const MAX_PAGE_DELAY = 2800; // ms máximo (jitter humano)
    const REQUEST_TIMEOUT = 30000; // ms para considerar que una petición falló
    const SPINNER_TIMEOUT = 30000; // ms máximo de espera a que desaparezca el spinner
    const MAX_PAGE_RETRIES = 5; // reintentos si el servidor SIGEP o Turnstile se atora
    const AUTO_DOWNLOAD_INTERVAL = 5000; // auto-descarga cada N registros

    // ==========================================
    // UTILIDADES: ESPERA Y TIEMPO
    // ==========================================
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const randomDelay = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

    const formatTime = (ms) => {
        if (!ms || ms < 0 || !isFinite(ms)) return "--";
        const totalSecs = Math.floor(ms / 1000);
        const h = Math.floor(totalSecs / 3600);
        const m = Math.floor((totalSecs % 3600) / 60);
        const s = totalSecs % 60;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    };

    // Hash exhaustivo para no descartar contratos legítimos de la misma persona
    const generateUniqueId = (r) => {
        return [
            r.entidad || '',
            r.unidadOrganizacional || '',
            r.nombre || '',
            r.cargo || '',
            r.puestoFuncion || '',
            r.tipo || '',
            r.nivelSalarialMonto || '',
            r.fechaInicio || '',
            r.fechaFin || '',
            r.estado || ''
        ].join('|').toLowerCase().replace(/\s+/g, ' ').trim();
    };

    // ==========================================
    // DETECCIÓN INTELIGENTE DE SPINNER
    // ==========================================
    const isSpinnerActive = () => {
        const spinner = document.querySelector('spinner-http .ball-pulse, spinner-http .posicion-spinner');
        return !!spinner;
    };

    const waitForSpinnerToFinish = async (timeoutMs = SPINNER_TIMEOUT) => {
        const start = Date.now();
        let wasActive = false;
        while (isSpinnerActive()) {
            wasActive = true;
            if (Date.now() - start > timeoutMs) {
                console.warn("⚠️ Spinner de SIGEP tardó demasiado. Continuando...");
                break;
            }
            await sleep(250);
        }
        // Margen para que Angular complete el ciclo de detección de cambios (ChangeDetection)
        if (wasActive) {
            await sleep(400);
        }
    };

    // ==========================================
    // PERSISTENCIA ROBUSTA (IndexedDB)
    // Sin límite de 5MB de localStorage
    // ==========================================
    const initDB = () => {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = (e) => reject(e.target.error);
        });
    };

    const loadAllRecordsFromDB = (db) => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    };

    const saveRecordsToDB = (db, records) => {
        return new Promise((resolve, reject) => {
            if (!records || records.length === 0) return resolve();
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            records.forEach(rec => {
                store.put(rec);
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    };

    // ==========================================
    // INTERCEPTOR XHR (Captura datos puros JSON)
    // ==========================================
    let pendingPageResolvers = [];
    let isXhrIntercepted = window.__sigepXhrIntercepted || false;

    if (!isXhrIntercepted) {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url) {
            this._sigepUrl = url;
            this._sigepMethod = method;
            return origOpen.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function(body) {
            if (this._sigepUrl && this._sigepUrl.includes('/api/v1/persona/lista')) {
                this.addEventListener('load', function() {
                    if (this.status === 200) {
                        try {
                            const json = JSON.parse(this.responseText);
                            const callbacks = pendingPageResolvers.splice(0);
                            callbacks.forEach(cb => cb.resolve({ json, url: this._sigepUrl }));
                        } catch (err) {
                            const callbacks = pendingPageResolvers.splice(0);
                            callbacks.forEach(cb => cb.reject(err));
                        }
                    } else {
                        const callbacks = pendingPageResolvers.splice(0);
                        callbacks.forEach(cb => cb.reject(new Error(`HTTP ${this.status}: ${this.statusText}`)));
                    }
                });

                this.addEventListener('error', function() {
                    const callbacks = pendingPageResolvers.splice(0);
                    callbacks.forEach(cb => cb.reject(new Error('Network error on persona request')));
                });

                this.addEventListener('timeout', function() {
                    const callbacks = pendingPageResolvers.splice(0);
                    callbacks.forEach(cb => cb.reject(new Error('Request timeout on persona request')));
                });
            }
            return origSend.apply(this, arguments);
        };

        window.__sigepXhrIntercepted = true;
        console.log("🛰️ Interceptor de red XHR activo para /api/v1/persona/lista.");
    }

    const waitForNextApiResponse = (timeoutMs = REQUEST_TIMEOUT) => {
        return new Promise((resolve, reject) => {
            let timer;
            const resolver = {
                resolve: (data) => {
                    clearTimeout(timer);
                    resolve(data);
                },
                reject: (err) => {
                    clearTimeout(timer);
                    reject(err);
                }
            };
            pendingPageResolvers.push(resolver);

            timer = setTimeout(() => {
                const idx = pendingPageResolvers.indexOf(resolver);
                if (idx !== -1) {
                    pendingPageResolvers.splice(idx, 1);
                }
                reject(new Error(`Timeout esperando respuesta XHR (${timeoutMs}ms)`));
            }, timeoutMs);
        });
    };

    // ==========================================
    // DESCARGA DE ARCHIVOS (JSONL)
    // ==========================================
    window.descargarAvanceJSONL = function(fileNamePrefix = 'sigep_avance') {
        const dataArray = Array.from(window.sigepDataMap ? window.sigepDataMap.values() : []);
        if (dataArray.length === 0) {
            console.warn("⚠️ No hay registros para descargar.");
            alert("No hay registros recopilados todavía.");
            return;
        }

        const jsonlContent = dataArray.map(obj => {
            const cleanObj = { ...obj };
            delete cleanObj.id;
            return JSON.stringify(cleanObj);
        }).join('\n');

        const blob = new Blob([jsonlContent], { type: 'application/jsonlines+json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${fileNamePrefix}_${dataArray.length}_${Date.now()}.jsonl`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        console.log(`💾 Descargado archivo JSONL con ${dataArray.length} registros.`);
    };

    // ==========================================
    // INTERFAZ FLOTANTE (HUD)
    // ==========================================
    const createOrUpdateHUD = () => {
        let hud = document.getElementById('sigep-hud');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'sigep-hud';
            hud.style.cssText = `
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 999999;
                background: #1e293b;
                color: #f8fafc;
                padding: 14px 18px;
                border-radius: 12px;
                box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4), 0 8px 10px -6px rgba(0, 0, 0, 0.3);
                font-family: system-ui, -apple-system, sans-serif;
                font-size: 13px;
                width: 320px;
                border: 1px solid #334155;
            `;
            hud.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <strong style="color:#38bdf8; font-size:14px;">🏛️ SIGEP Extractor Pro</strong>
                    <span id="hud-status-badge" style="background:#0284c7; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:bold;">Iniciando</span>
                </div>
                <div style="margin-bottom:4px; display:flex; justify-content:space-between;">
                    <span>Registros:</span>
                    <strong id="hud-records" style="color:#4ade80;">0</strong>
                </div>
                <div style="margin-bottom:4px; display:flex; justify-content:space-between;">
                    <span>Página / Total:</span>
                    <strong id="hud-page">0 / --</strong>
                </div>
                <div style="margin-bottom:4px; display:flex; justify-content:space-between;">
                    <span>Tiempo estimado (ETA):</span>
                    <strong id="hud-eta">Calculando...</strong>
                </div>
                <div style="margin-bottom:10px; font-size:11px; color:#94a3b8;" id="hud-detail">
                    Esperando datos...
                </div>
                <div style="display:flex; gap:6px;">
                    <button id="hud-btn-pause" style="flex:1; background:#475569; border:none; color:white; padding:6px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:bold;">⏸️ Pausar</button>
                    <button id="hud-btn-download" style="flex:1; background:#0284c7; border:none; color:white; padding:6px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:bold;">💾 Descargar</button>
                    <button id="hud-btn-stop" style="background:#dc2626; border:none; color:white; padding:6px 10px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:bold;">⏹️</button>
                </div>
            `;
            document.body.appendChild(hud);

            document.getElementById('hud-btn-pause').onclick = () => {
                window.__sigepScrapingPaused = !window.__sigepScrapingPaused;
                const btn = document.getElementById('hud-btn-pause');
                btn.innerText = window.__sigepScrapingPaused ? "▶️ Reanudar" : "⏸️ Pausar";
                btn.style.background = window.__sigepScrapingPaused ? "#16a34a" : "#475569";
                console.log(window.__sigepScrapingPaused ? "⏸️ Extracción pausada por usuario." : "▶️ Extracción reanudada.");
            };

            document.getElementById('hud-btn-download').onclick = () => {
                window.descargarAvanceJSONL();
            };

            document.getElementById('hud-btn-stop').onclick = () => {
                if (confirm("¿Deseas detener la extracción y descargar los datos actuales?")) {
                    window.__sigepScrapingActive = false;
                    window.descargarAvanceJSONL();
                }
            };
        }
        return hud;
    };

    const updateHUD = (data) => {
        createOrUpdateHUD();
        if (data.records !== undefined) document.getElementById('hud-records').innerText = data.records.toLocaleString();
        if (data.page !== undefined) document.getElementById('hud-page').innerText = `${data.page} / ${data.totalPages || '--'}`;
        if (data.eta !== undefined) document.getElementById('hud-eta').innerText = data.eta;
        if (data.status !== undefined) document.getElementById('hud-status-badge').innerText = data.status;
        if (data.detail !== undefined) document.getElementById('hud-detail').innerText = data.detail;
    };

    // ==========================================
    // DOM FALLBACK (Por si la primera página ya cargó)
    // ==========================================
    const extractFromDOM = () => {
        const rows = document.querySelectorAll('#tablaValues tbody tr');
        const extracted = [];
        rows.forEach(row => {
            const cols = row.querySelectorAll('td');
            if (cols.length >= 10) {
                const rec = {
                    entidad: cols[0].innerText.trim(),
                    unidadOrganizacional: cols[1].innerText.trim(),
                    nombre: cols[2].innerText.trim(),
                    cargo: cols[3].innerText.trim(),
                    puestoFuncion: cols[4].innerText.trim(),
                    tipo: cols[5].innerText.trim(),
                    nivelSalarialMonto: cols[6].innerText.trim(),
                    fechaInicio: cols[7].innerText.trim(),
                    fechaFin: cols[8].innerText.trim(),
                    estado: cols[9].innerText.trim()
                };
                extracted.push(rec);
            }
        });
        return extracted;
    };

    // ==========================================
    // ESPERA Y GESTIÓN DE BOTÓN SIGUIENTE
    // ==========================================
    const waitForNextButtonClickable = async (timeoutMs = 15000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            // 1. Primero esperar a que cualquier spinner HTTP termine por completo
            await waitForSpinnerToFinish(timeoutMs);

            // 2. Verificar estado del botón siguiente
            const nextLi = document.querySelector('li.pagination-next');
            if (nextLi) {
                if (!nextLi.classList.contains('disabled')) {
                    const link = nextLi.querySelector('a');
                    if (link) return link;
                }
            } else {
                const allLinks = Array.from(document.querySelectorAll('a.page-link, .pagination-next a, .page-item a'));
                const link = allLinks.find(a => a.innerText.trim().toLowerCase().includes('siguiente') || a.innerText.trim() === '»');
                if (link) {
                    const parentLi = link.closest('li');
                    if (!parentLi || !parentLi.classList.contains('disabled')) {
                        return link;
                    }
                }
            }
            await sleep(300);
        }
        return null;
    };

    const simulateHumanClick = (element) => {
        if (!element) return;
        element.focus();
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    };

    // ==========================================
    // EJECUCIÓN PRINCIPAL
    // ==========================================
    console.log("🚀 Iniciando SIGEP Extractor Pro...");
    createOrUpdateHUD();

    // 1. Inicializar base de datos IndexedDB
    const db = await initDB();
    const storedList = await loadAllRecordsFromDB(db);

    window.sigepDataMap = new Map();
    storedList.forEach(item => {
        const id = generateUniqueId(item);
        item.id = id;
        window.sigepDataMap.set(id, item);
    });

    console.log(`📂 Base de datos cargada con ${window.sigepDataMap.size} registros previos.`);
    updateHUD({
        records: window.sigepDataMap.size,
        status: "Listo",
        detail: `Cargados ${window.sigepDataMap.size} registros previos.`
    });

    // 2. Esperar si la página está cargando inicialmente
    await waitForSpinnerToFinish(15000);

    // 3. Comprobar / automatizar filtro de estado 'Todos'
    try {
        const estadoBtn = Array.from(document.querySelectorAll('.btn-group button'))
            .find(b => b.innerText.includes('Estado:'));
        if (estadoBtn && !estadoBtn.innerText.includes('Todos')) {
            console.log("⚙️ Aplicando filtro Estado: Todos...");
            estadoBtn.click();
            await sleep(400);
            const parentGroup = estadoBtn.closest('.btn-group') || document;
            const todosOption = Array.from(parentGroup.querySelectorAll('.dropdown-item'))
                .find(el => el.innerText.trim() === 'Todos');
            if (todosOption) {
                todosOption.click();
                console.log("✅ Filtro 'Estado: Todos' seleccionado.");
                await waitForSpinnerToFinish(15000);
                await sleep(MIN_PAGE_DELAY);
            }
        }
    } catch (e) {
        console.warn("⚠️ No se pudo ajustar automáticamente el dropdown de Estado:", e);
    }

    // 4. Capturar primera página si ya está renderizada en el DOM
    const initialDomRows = extractFromDOM();
    if (initialDomRows.length > 0) {
        const toSave = [];
        initialDomRows.forEach(rec => {
            const id = generateUniqueId(rec);
            if (!window.sigepDataMap.has(id)) {
                rec.id = id;
                window.sigepDataMap.set(id, rec);
                toSave.push(rec);
            }
        });
        if (toSave.length > 0) {
            await saveRecordsToDB(db, toSave);
            console.log(`📥 Capturados ${toSave.length} registros iniciales del DOM.`);
        }
    }

    // 5. Bucle principal de paginación
    window.__sigepScrapingActive = true;
    window.__sigepScrapingPaused = false;

    // Detectar página inicial desde el DOM si es posible
    const activePageEl = document.querySelector('li.pagination-page.active a');
    let currentPage = activePageEl ? (parseInt(activePageEl.innerText.trim(), 10) || 1) : 1;
    let totalItems = 100000;
    let totalPages = Math.ceil(totalItems / 10);
    let sessionStartTime = Date.now();
    let initialCount = window.sigepDataMap.size;
    let lastAutoDownloadCount = initialCount;

    while (window.__sigepScrapingActive) {
        // Soporte de pausa interactiva
        while (window.__sigepScrapingPaused && window.__sigepScrapingActive) {
            updateHUD({ status: "Pausado", detail: "Haga clic en 'Reanudar' para continuar." });
            await sleep(1000);
        }
        if (!window.__sigepScrapingActive) break;

        // Esperar a que el spinner desaparezca y el botón 'Siguiente' esté habilitado
        updateHUD({
            status: isSpinnerActive() ? "Cargando..." : "Esperando botón",
            detail: isSpinnerActive() ? "Esperando a que finalice la carga de datos..." : `Buscando página ${currentPage + 1}...`
        });

        const nextBtn = await waitForNextButtonClickable(15000);
        if (!nextBtn) {
            // Si el botón no está disponible, comprobar si realmente estamos al final
            await waitForSpinnerToFinish(10000);
            const checkLi = document.querySelector('li.pagination-next');
            if (!checkLi || checkLi.classList.contains('disabled') || currentPage >= totalPages) {
                console.log("🏁 Fin de los datos alcanzado.");
                updateHUD({ status: "Finalizado", detail: "Todas las páginas fueron procesadas." });
                break;
            } else {
                console.warn("⚠️ Botón 'Siguiente' no respondió a tiempo. Reintentando ciclo...");
                await sleep(2000);
                continue;
            }
        }

        let pageSuccess = false;
        let retryAttempt = 0;

        while (!pageSuccess && retryAttempt < MAX_PAGE_RETRIES && window.__sigepScrapingActive) {
            try {
                retryAttempt++;
                updateHUD({
                    status: retryAttempt > 1 ? `Reintento ${retryAttempt}` : "Cargando",
                    detail: `Pidiendo página ${currentPage + 1}...`
                });

                // 1. Armamos la promesa para la respuesta XHR
                const responsePromise = waitForNextApiResponse(REQUEST_TIMEOUT);

                // 2. Disparamos clic humano en el botón habilitado
                simulateHumanClick(nextBtn);

                // 3. Esperamos respuesta de la API en la red
                const apiResult = await responsePromise;
                const json = apiResult.json;

                if (json && json.lista) {
                    currentPage++;
                    if (json.numRegistros) {
                        totalItems = json.numRegistros;
                        totalPages = Math.ceil(totalItems / 10);
                    }

                    const newlyAdded = [];
                    json.lista.forEach(rec => {
                        const id = generateUniqueId(rec);
                        if (!window.sigepDataMap.has(id)) {
                            rec.id = id;
                            window.sigepDataMap.set(id, rec);
                            newlyAdded.push(rec);
                        }
                    });

                    // Guardar asíncronamente en IndexedDB
                    if (newlyAdded.length > 0) {
                        await saveRecordsToDB(db, newlyAdded);
                    }

                    // Métricas y ETA
                    const currentTotal = window.sigepDataMap.size;
                    const sessionRecords = currentTotal - initialCount;
                    let etaStr = "--";
                    if (sessionRecords > 0) {
                        const elapsed = Date.now() - sessionStartTime;
                        const msPerRecord = elapsed / sessionRecords;
                        const remaining = Math.max(0, totalItems - currentTotal);
                        etaStr = formatTime(remaining * msPerRecord);
                    }

                    updateHUD({
                        records: currentTotal,
                        page: currentPage,
                        totalPages: totalPages,
                        eta: etaStr,
                        status: "Extrayendo",
                        detail: `+${newlyAdded.length} nuevos (Pág ${currentPage}). Total: ${currentTotal}/${totalItems}`
                    });

                    console.log(`✅ Pág ${currentPage}/${totalPages} | +${newlyAdded.length} nuevos | Total: ${currentTotal} | ETA: ${etaStr}`);

                    // Auto-descarga periódica de seguridad
                    if (currentTotal - lastAutoDownloadCount >= AUTO_DOWNLOAD_INTERVAL) {
                        console.log(`💾 Guardado automático de seguridad (${currentTotal} registros)...`);
                        window.descargarAvanceJSONL('sigep_seguridad');
                        lastAutoDownloadCount = currentTotal;
                    }

                    // 4. CRUCIAL: Esperar a que Angular procese los datos y apague el spinner
                    await waitForSpinnerToFinish(SPINNER_TIMEOUT);

                    pageSuccess = true;
                } else {
                    throw new Error("Respuesta recibida pero sin lista de registros válida.");
                }

            } catch (err) {
                console.warn(`⚠️ Error en página ${currentPage + 1} (intento ${retryAttempt}/${MAX_PAGE_RETRIES}):`, err.message);
                updateHUD({
                    status: "Reintentando",
                    detail: `Fallo temporal: ${err.message}. Esperando ${3 * retryAttempt}s...`
                });
                await waitForSpinnerToFinish(10000);
                await sleep(3000 * retryAttempt);
            }
        }

        if (!pageSuccess) {
            console.error(`❌ Falló la página ${currentPage + 1} tras ${MAX_PAGE_RETRIES} intentos. Pausando para no perder progreso.`);
            updateHUD({
                status: "Detenido por error",
                detail: `Error recurrente en página ${currentPage + 1}. Puede hacer clic en Descargar.`
            });
            break;
        }

        // Delay humano con variación aleatoria antes de solicitar la siguiente página
        await randomDelay(MIN_PAGE_DELAY, MAX_PAGE_DELAY);
    }

    console.log("🎉 Extracción finalizada. Generando descarga completa de los datos...");
    updateHUD({ status: "Completado", detail: "Descargando archivo final..." });
    window.descargarAvanceJSONL('sigep_completo');

})();