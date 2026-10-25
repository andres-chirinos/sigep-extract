(async function() {
    'use strict';

    // ==========================================
    // CONFIGURACIÓN Y CONSTANTES
    // ==========================================
    const DB_NAME = 'sigep_extractor_db';
    const STORE_NAME = 'records';
    const MIN_PAGE_DELAY = 1500; // ms mínimo entre páginas
    const MAX_PAGE_DELAY = 2600; // ms máximo (jitter humano)
    const SPINNER_TIMEOUT = 45000; // ms de espera máxima para spinner de SIGEP
    const MAX_PAGE_RETRIES = 5; // reintentos antes de pausar
    const AUTO_DOWNLOAD_INTERVAL = 3000; // descarga snapshot cada N registros

    // ==========================================
    // UTILIDADES: TIEMPO Y DELAYS
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

    // Hash exhaustivo para identificar cada contrato de forma unívoca
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
    // Activo: contiene .ball-pulse
    // Inactivo: queda vacío <spinner-http><!----></spinner-http>
    // ==========================================
    const isSpinnerActive = () => {
        const spinner = document.querySelector('spinner-http');
        if (!spinner) return false;
        if (spinner.querySelector('.ball-pulse, .posicion-spinner')) return true;
        return spinner.children.length > 0;
    };

    const waitForSpinnerToFinish = async (timeoutMs = SPINNER_TIMEOUT) => {
        const start = Date.now();
        let wasActive = false;
        while (isSpinnerActive()) {
            wasActive = true;
            if (Date.now() - start > timeoutMs) {
                console.warn(`⚠️ Spinner de SIGEP activo tras ${timeoutMs / 1000}s. Continuando...`);
                break;
            }
            await sleep(250);
        }
        if (wasActive) {
            // Margen para que Angular renderice los cambios en el DOM
            await sleep(500);
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

        console.log(`💾 Archivo JSONL descargado con ${dataArray.length} registros.`);
    };

    // ==========================================
    // MUESTREO ALEATORIO SIMPLE (MAS)
    // ==========================================
    window.muestrearRegistros = function(sampleSize = 100, download = true) {
        const allItems = Array.from(window.sigepDataMap ? window.sigepDataMap.values() : []);
        if (allItems.length === 0) {
            console.warn("⚠️ No hay registros en memoria para muestrear.");
            alert("No hay registros para muestrear.");
            return [];
        }
        const k = Math.min(sampleSize, allItems.length);
        const pool = [...allItems];
        const sample = [];
        for (let i = 0; i < k; i++) {
            const j = i + Math.floor(Math.random() * (pool.length - i));
            const temp = pool[i];
            pool[i] = pool[j];
            pool[j] = temp;
            sample.push(pool[i]);
        }
        console.log(`🎲 [Muestreo MAS] ${sample.length} registros seleccionados de una población de ${allItems.length} (${((sample.length / allItems.length) * 100).toFixed(2)}%).`);
        if (download) {
            const content = sample.map(r => {
                const c = { ...r };
                delete c.id;
                return JSON.stringify(c);
            }).join('\n');
            const blob = new Blob([content], { type: 'application/jsonlines+json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `sigep_muestra_${sample.length}_${Date.now()}.jsonl`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
        return sample;
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
                width: 330px;
                border: 1px solid #334155;
            `;
            hud.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                    <strong style="color:#38bdf8; font-size:14px;">🏛️ SIGEP Extractor Pro</strong>
                    <span id="hud-status-badge" style="background:#0284c7; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:bold;">Iniciando</span>
                </div>
                <div style="margin-bottom:4px; display:flex; justify-content:space-between;">
                    <span>Registros acumulados:</span>
                    <strong id="hud-records" style="color:#4ade80;">0</strong>
                </div>
                <div style="margin-bottom:4px; display:flex; justify-content:space-between;">
                    <span>Página / Total:</span>
                    <strong id="hud-page">1 / --</strong>
                </div>
                <div style="margin-bottom:4px; display:flex; justify-content:space-between;">
                    <span>Tiempo estimado (ETA):</span>
                    <strong id="hud-eta">Calculando...</strong>
                </div>
                <div style="margin-bottom:10px; font-size:11px; color:#94a3b8; word-break:break-word;" id="hud-detail">
                    Iniciando extractor...
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
    // EXTRACCIÓN Y LECTURA DEL DOM
    // ==========================================
    const extractRowsFromDOM = () => {
        const rows = document.querySelectorAll('#tablaValues tbody tr');
        const extracted = [];
        rows.forEach(row => {
            const cols = row.querySelectorAll('td');
            if (cols.length >= 10 && !row.innerText.includes('No hay datos')) {
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

    const getFirstRowSignature = () => {
        const firstRow = document.querySelector('#tablaValues tbody tr');
        return firstRow ? firstRow.innerText.trim() : '';
    };

    const getActivePageNumber = () => {
        const activeLi = document.querySelector('li.pagination-page.active a, .pagination .active a');
        if (activeLi) {
            const num = parseInt(activeLi.innerText.trim(), 10);
            if (!isNaN(num) && num > 0) return num;
        }
        return null;
    };

    const getTotalPagesEstimated = () => {
        // Intentar leer la última página de la paginación de ngx-bootstrap
        const lastLi = document.querySelector('li.pagination-last a');
        if (lastLi) {
            // ngx-bootstrap a veces no muestra el número en 'Último', buscar los números de páginas visibles
            const pageLinks = Array.from(document.querySelectorAll('li.pagination-page a'))
                .map(a => parseInt(a.innerText.trim(), 10))
                .filter(n => !isNaN(n));
            if (pageLinks.length > 0) {
                return Math.max(...pageLinks);
            }
        }
        return 10000;
    };

    // ==========================================
    // BOTÓN SIGUIENTE Y CLIC HUMANO
    // ==========================================
    const getNextButton = () => {
        const nextLi = document.querySelector('li.pagination-next');
        if (nextLi) {
            if (!nextLi.classList.contains('disabled')) {
                return nextLi.querySelector('a');
            }
            return null;
        }
        const allLinks = Array.from(document.querySelectorAll('a.page-link, .pagination-next a, .page-item a'));
        const link = allLinks.find(a => a.innerText.trim().toLowerCase().includes('siguiente') || a.innerText.trim() === '»');
        if (link) {
            const parentLi = link.closest('li');
            if (!parentLi || !parentLi.classList.contains('disabled')) {
                return link;
            }
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
    // ESPERA INTELIGENTE DE CAMBIO DE PÁGINA
    // ==========================================
    const waitForPageToChange = async (oldPageNum, oldSignature, timeoutMs = 40000) => {
        const start = Date.now();

        // 1. Esperar a que el spinner aparezca (si va a aparecer)
        for (let i = 0; i < 8; i++) {
            if (isSpinnerActive()) break;
            await sleep(150);
        }

        // 2. Esperar a que el spinner termine por completo
        await waitForSpinnerToFinish(timeoutMs);

        // 3. Evaluar si la página o la tabla cambió
        while (Date.now() - start < timeoutMs) {
            if (isSpinnerActive()) {
                await waitForSpinnerToFinish(timeoutMs);
            }

            const curPage = getActivePageNumber();
            const curSignature = getFirstRowSignature();

            // Si cambió el número de página activa
            if (curPage !== null && oldPageNum !== null && curPage !== oldPageNum) {
                await sleep(300); // margen de renderizado
                return true;
            }

            // O si cambió el contenido de la primera fila
            if (curSignature && curSignature !== oldSignature && !curSignature.includes('No hay datos')) {
                await sleep(300);
                return true;
            }

            await sleep(300);
        }

        return false;
    };

    // ==========================================
    // EJECUCIÓN PRINCIPAL
    // ==========================================
    console.log("🚀 Iniciando SIGEP Extractor Pro (Modo DOM Robusto)...");
    createOrUpdateHUD();

    // 1. Inicializar IndexedDB y cargar progreso previo
    const db = await initDB();
    const storedList = await loadAllRecordsFromDB(db);

    window.sigepDataMap = new Map();
    storedList.forEach(item => {
        const id = generateUniqueId(item);
        item.id = id;
        window.sigepDataMap.set(id, item);
    });

    console.log(`📂 Base de datos cargada con ${window.sigepDataMap.size} registros previos.`);
    
    // Preguntar al usuario configuración (Inicio, Fin, Salto)
    const suggestedStartPage = Math.floor(window.sigepDataMap.size / 10) + 1;
    let userStartingPage = suggestedStartPage;
    let userEndPage = 100820;
    let userStep = 1;

    try {
        const inputVal = prompt(
            `🏛️ SIGEP Extractor Pro - Configuración\n\n` +
            `Registros en BD local: ${window.sigepDataMap.size.toLocaleString()}\n` +
            `Introduce: inicio, fin, salto\n` +
            `Ejemplos:\n` +
            `  - "189, 500, 1" (avanza de 1 en 1 hasta la 500)\n` +
            `  - "1, 1000, 5" (avanza de 5 en 5)\n` +
            `  - O solo el número de página inicial`,
            `${suggestedStartPage}, 100820, 1`
        );
        if (inputVal !== null && inputVal.trim() !== '') {
            const parts = inputVal.split(',').map(s => parseInt(s.trim(), 10));
            if (!isNaN(parts[0]) && parts[0] > 0) userStartingPage = parts[0];
            if (!isNaN(parts[1]) && parts[1] >= userStartingPage) userEndPage = parts[1];
            if (!isNaN(parts[2]) && parts[2] > 0) userStep = parts[2];
        }
    } catch(e) {}
    console.log(`🎯 Configuración seleccionada: Inicio=${userStartingPage}, Fin=${userEndPage}, Salto=${userStep}`);

    updateHUD({
        records: window.sigepDataMap.size,
        page: userStartingPage,
        status: "Listo",
        detail: `Inicio: pág ${userStartingPage} | Fin: ${userEndPage} | Salto: ${userStep}`
    });

    // 2. Esperar a que la página se encuentre en reposo
    await waitForSpinnerToFinish(20000);

    // 3. Ajustar filtro Estado: Todos
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
                await sleep(500);
                await waitForSpinnerToFinish(25000);
            }
        }
    } catch (e) {
        console.warn("⚠️ No se pudo ajustar dropdown de Estado:", e);
    }

    // 4. ASEGURAR CARGA DE PÁGINA 1
    let currentRows = extractRowsFromDOM();
    if (currentRows.length === 0) {
        console.log("⏳ Tabla vacía. Esperando carga inicial de Página 1...");
        updateHUD({ status: "Cargando", detail: "Esperando registros de la página 1..." });

        const searchSubmitBtn = document.querySelector('button[type="submit"]');
        if (searchSubmitBtn) {
            console.log("🔍 Presionando botón de búsqueda...");
            searchSubmitBtn.click();
        }

        await waitForSpinnerToFinish(30000);

        // Espera activa a que el DOM pinte filas válidas
        const startWait = Date.now();
        while (currentRows.length === 0 && Date.now() - startWait < 20000) {
            await sleep(500);
            currentRows = extractRowsFromDOM();
        }
    }

    // Guardar los datos de la Página 1
    if (currentRows.length > 0) {
        const toSave = [];
        currentRows.forEach(rec => {
            const id = generateUniqueId(rec);
            if (!window.sigepDataMap.has(id)) {
                rec.id = id;
                window.sigepDataMap.set(id, rec);
                toSave.push(rec);
            }
        });
        if (toSave.length > 0) {
            await saveRecordsToDB(db, toSave);
            console.log(`📥 Registrados ${toSave.length} items de la Página 1.`);
        }
    } else {
        console.warn("⚠️ Atención: La página 1 aún no muestra registros. Inicia la búsqueda manualmente si no inició.");
    }

    // 5. Bucle de paginación
    window.__sigepScrapingActive = true;
    window.__sigepScrapingPaused = false;

    let currentPage = getActivePageNumber() || userStartingPage || 1;
    let estimatedTotalPages = getTotalPagesEstimated();
    let sessionStartTime = Date.now();
    let initialCount = window.sigepDataMap.size;
    let lastAutoDownloadCount = initialCount;

    console.log(`🏁 Iniciando paginación a partir de página ${currentPage}...`);
    updateHUD({
        records: window.sigepDataMap.size,
        page: currentPage,
        totalPages: estimatedTotalPages > currentPage ? estimatedTotalPages : '--',
        status: "Extrayendo",
        detail: `Página actual: ${currentPage}. Buscando siguiente...`
    });

    while (window.__sigepScrapingActive) {
        // Pausa interactiva desde el HUD
        while (window.__sigepScrapingPaused && window.__sigepScrapingActive) {
            updateHUD({ status: "Pausado", detail: "Haga clic en 'Reanudar' para continuar." });
            await sleep(1000);
        }
        if (!window.__sigepScrapingActive) break;

        // Asegurarse de que el spinner terminó antes de interactuar
        await waitForSpinnerToFinish(SPINNER_TIMEOUT);

        // Buscar botón siguiente habilitado
        let nextBtn = getNextButton();
        let retryAttempt = 0;

        // Si no está disponible de inmediato, esperar hasta 15s con polling
        if (!nextBtn) {
            const btnWaitStart = Date.now();
            while (!nextBtn && Date.now() - btnWaitStart < 15000) {
                await sleep(500);
                await waitForSpinnerToFinish(5000);
                nextBtn = getNextButton();
            }
        }

        // Si después de esperar sigue sin botón: comprobar si es el fin real
        if (!nextBtn) {
            const nextLi = document.querySelector('li.pagination-next');
            if (nextLi && nextLi.classList.contains('disabled')) {
                console.log(`🎉 Fin alcanzado: botón 'Siguiente' permanentemente deshabilitado en página ${currentPage}.`);
                updateHUD({ status: "Finalizado", detail: `Recorrido completado en página ${currentPage}.` });
                break;
            }
            console.warn(`⚠️ Botón 'Siguiente' no encontrado en página ${currentPage}. Reintentando ciclo...`);
            await sleep(2000);
            continue;
        }

        // Datos antes del clic para detectar cambio real en la UI
        const oldPage = getActivePageNumber() || currentPage;
        const oldSignature = getFirstRowSignature();
        let pageChangedSuccessfully = false;

        while (!pageChangedSuccessfully && retryAttempt < MAX_PAGE_RETRIES && window.__sigepScrapingActive) {
            try {
                retryAttempt++;
                updateHUD({
                    status: retryAttempt > 1 ? `Reintento ${retryAttempt}` : "Cargando",
                    detail: `Saltando a página ${oldPage + 1}...`
                });

                // Disparamos clic humano en el botón
                simulateHumanClick(nextBtn);

                // Esperamos que el spinner se active, termine y la tabla cambie de contenido
                pageChangedSuccessfully = await waitForPageToChange(oldPage, oldSignature, SPINNER_TIMEOUT);

                if (pageChangedSuccessfully) {
                    // Extraer los registros nuevos que acaban de cargarse en el DOM
                    const newRows = extractRowsFromDOM();
                    const newlyAdded = [];

                    newRows.forEach(rec => {
                        const id = generateUniqueId(rec);
                        if (!window.sigepDataMap.has(id)) {
                            rec.id = id;
                            window.sigepDataMap.set(id, rec);
                            newlyAdded.push(rec);
                        }
                    });

                    if (newlyAdded.length > 0) {
                        await saveRecordsToDB(db, newlyAdded);
                    }

                    // Actualizar número de página actual
                    currentPage = getActivePageNumber() || (oldPage + 1);

                    // Métricas y ETA
                    const currentTotal = window.sigepDataMap.size;
                    const sessionRecords = currentTotal - initialCount;
                    let etaStr = "--";
                    if (sessionRecords > 0) {
                        const elapsed = Date.now() - sessionStartTime;
                        const msPerRecord = elapsed / sessionRecords;
                        const remainingRecords = Math.max(0, 100000 - currentTotal);
                        etaStr = formatTime(remainingRecords * msPerRecord);
                    }

                    updateHUD({
                        records: currentTotal,
                        page: currentPage,
                        totalPages: estimatedTotalPages > currentPage ? estimatedTotalPages : '--',
                        eta: etaStr,
                        status: "Extrayendo",
                        detail: `+${newlyAdded.length} nuevos (Pág ${currentPage}). Total: ${currentTotal}`
                    });

                    console.log(`✅ Pág ${currentPage} | +${newlyAdded.length} nuevos | Total: ${currentTotal} | ETA: ${etaStr}`);

                    // Auto-descarga periódica de seguridad
                    if (currentTotal - lastAutoDownloadCount >= AUTO_DOWNLOAD_INTERVAL) {
                        console.log(`💾 Guardado automático de seguridad (${currentTotal} registros)...`);
                        window.descargarAvanceJSONL('sigep_seguridad');
                        lastAutoDownloadCount = currentTotal;
                    }

                } else {
                    console.warn(`⚠️ La página no cambió tras clic (intento ${retryAttempt}/${MAX_PAGE_RETRIES}). Reintentando...`);
                    await waitForSpinnerToFinish(15000);
                    await sleep(2000 * retryAttempt);
                    nextBtn = getNextButton() || nextBtn;
                }

            } catch (err) {
                console.warn(`⚠️ Excepción en avance de página:`, err);
                await sleep(3000);
            }
        }

        if (!pageChangedSuccessfully) {
            console.error(`❌ No se pudo avanzar desde la página ${currentPage} tras ${MAX_PAGE_RETRIES} intentos. Pausando.`);
            updateHUD({
                status: "Detenido",
                detail: `Detenido en página ${currentPage}. Puede hacer clic en 'Descargar'.`
            });
            break;
        }

        // Delay humano con jitter aleatorio para no sobrecargar el servidor
        await randomDelay(MIN_PAGE_DELAY, MAX_PAGE_DELAY);
    }

    console.log("🎉 Extracción finalizada. Generando descarga final de datos...");
    updateHUD({ status: "Completado", detail: "Descargando archivo final completo..." });
    window.descargarAvanceJSONL('sigep_completo');

})();