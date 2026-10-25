const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { samplePages, sampleRecordsFromFile } = require('./sampling');

const OUTPUT_FILE = process.env.OUTPUT_FILE || path.join(__dirname, 'data', 'sigep_export.jsonl');
const STATUS_FILE = process.env.STATUS_FILE || path.join(path.dirname(OUTPUT_FILE), 'status.json');
const TARGET_URL = 'https://sigep.gob.bo/rsportaltransparencia/#/portalHome/personal';
const BATCH_SIZE = 10;
const DELAY_BETWEEN_PAGES = parseInt(process.env.DELAY_BETWEEN_PAGES || '1800', 10);

// CLI: Modo independiente para muestreo rápido de registros ya descargados
// Uso: node server_scraper.js --sample 500 [--seed 42]
const sampleArgIdx = process.argv.indexOf('--sample');
if (sampleArgIdx !== -1) {
    const size = parseInt(process.argv[sampleArgIdx + 1], 10) || 100;
    const seedIdx = process.argv.indexOf('--seed');
    const seed = seedIdx !== -1 ? parseInt(process.argv[seedIdx + 1], 10) : null;
    const outName = path.join(path.dirname(OUTPUT_FILE), `sigep_sample_${size}_${Date.now()}.jsonl`);

    console.log(`\n🎲 [Muestreo] Extrayendo Muestra Aleatoria Simple (MAS) de ${size} registros...`);
    sampleRecordsFromFile(OUTPUT_FILE, outName, size, seed).then(res => {
        console.log(`✅ [Muestreo] Muestra generada con éxito:`);
        console.log(`   - Población total (N): ${res.populationSize.toLocaleString()} registros`);
        console.log(`   - Muestra seleccionada (n): ${res.sampleSize.toLocaleString()} registros`);
        console.log(`   - Fracción de muestreo: ${res.samplingRatio}`);
        console.log(`   - Archivo generado: ${res.sampleFile}\n`);
        process.exit(0);
    }).catch(err => {
        console.error('❌ [Muestreo] Error:', err.message);
        process.exit(1);
    });
    return;
}

const puppeteer = require('puppeteer');

// Asegurar directorios locales
const dataDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let existingIds = new Set();
let totalSaved = 0;
let totalRegistros = 1008195;
let isShuttingDown = false;
let currentActiveConfig = null;
let currentActivePage = 1;

function loadExistingRecords() {
    existingIds.clear();
    totalSaved = 0;
    if (fs.existsSync(OUTPUT_FILE)) {
        try {
            const lines = fs.readFileSync(OUTPUT_FILE, 'utf8').split('\n');
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const rec = JSON.parse(line);
                    const id = [
                        rec.entidad || '',
                        rec.siglaEntidad || '',
                        rec.descUnidad || '',
                        rec.razonSocial || (rec.nombres + ' ' + rec.primerApellido) || '',
                        rec.descCargo || '',
                        rec.monto || '',
                        rec.fechaIni || '',
                        rec.fechaFin || '',
                        rec.apiEstado || ''
                    ].join('|').toLowerCase().replace(/\s+/g, ' ').trim();
                    existingIds.add(id);
                    totalSaved++;
                } catch (e) {}
            }
            console.log(`[Servidor] Archivo previo cargado: ${totalSaved} registros deduplicados.`);
        } catch (e) {
            console.warn('[Servidor] Error leyendo archivo previo:', e.message);
        }
    }
}

function loadStatus() {
    if (fs.existsSync(STATUS_FILE)) {
        try {
            const content = fs.readFileSync(STATUS_FILE, 'utf8');
            const data = JSON.parse(content);
            console.log(`[Servidor] 📄 status.json detectado -> Última pág: ${data.currentPage || data.startPage}, Fin: ${data.endPage}, Salto: ${data.step}, Muestra: ${data.sampleSize}`);
            return data;
        } catch (e) {
            console.warn('[Servidor] Error leyendo status.json:', e.message);
        }
    }
    return null;
}

function saveStatus(data) {
    try {
        const payload = {
            updatedAt: new Date().toISOString(),
            currentPage: data.currentPage !== undefined ? data.currentPage : currentActivePage,
            startPage: data.startPage !== undefined ? data.startPage : (currentActiveConfig ? currentActiveConfig.startPage : 1),
            endPage: data.endPage !== undefined ? data.endPage : (currentActiveConfig ? currentActiveConfig.endPage : 100820),
            step: data.step !== undefined ? data.step : (currentActiveConfig ? currentActiveConfig.step : 1),
            sampleSize: data.sampleSize !== undefined ? data.sampleSize : (currentActiveConfig ? currentActiveConfig.sampleSize : 0),
            totalSaved: totalSaved,
            totalRecords: totalRegistros,
            progressPercent: totalRegistros > 0 ? `${((totalSaved / totalRegistros) * 100).toFixed(2)}%` : '0%',
            status: data.status || 'RUNNING'
        };
        fs.writeFileSync(STATUS_FILE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
        console.warn('[Servidor] Error actualizando status.json:', e.message);
    }
}

function handleShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Servidor] Señal ${signal} recibida. Guardando status.json y saliendo...`);
    saveStatus({
        currentPage: currentActivePage,
        status: 'PAUSED'
    });
    process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Diálogo interactivo para configurar inicio, fin, salto (step) y tamaño de muestra simple
 */
async function askScrapingConfig(page, defaults) {
    const defStart = defaults.startPage;
    const defEnd = defaults.endPage;
    const defStep = defaults.step;
    const defSample = defaults.sampleSize;

    // 1. Si está definido explícitamente por variable de entorno (START_PAGE o SAMPLE_SIZE)
    if (process.env.START_PAGE || process.env.END_PAGE || (process.env.SAMPLE_SIZE && parseInt(process.env.SAMPLE_SIZE, 10) > 0)) {
        const start = parseInt(process.env.START_PAGE, 10) || defStart;
        const end = parseInt(process.env.END_PAGE, 10) || defEnd;
        const step = parseInt(process.env.PAGE_STEP, 10) || defStep;
        const sampleSize = parseInt(process.env.SAMPLE_SIZE, 10) || defSample;
        console.log(`[Servidor] Configuración detectada en variables de entorno: Inicio=${start}, Fin=${end}, Salto=${step}, Muestra=${sampleSize}`);
        return { startPage: start, endPage: end, step, sampleSize };
    }

    console.log('\n================================================================');
    console.log(`[Servidor] Registros en disco: ${totalSaved.toLocaleString()} | Total páginas: ${defEnd.toLocaleString()}`);
    console.log(`[Servidor] Valores actuales/sugeridos: Inicio=${defStart}, Fin=${defEnd}, Salto=${defStep}, Muestra=${defSample}`);
    console.log(`[Servidor] Puedes modificar estos valores en status.json, en noVNC (:6080) o pulsar Enter aquí.`);
    console.log(`[Servidor] Auto-iniciando con estos valores en 25 segundos...`);
    console.log('================================================================\n');

    return new Promise(async (resolve) => {
        let isResolved = false;

        const applyConfig = (cfg) => {
            if (isResolved) return;
            isResolved = true;
            const start = Math.max(1, parseInt(cfg.startPage, 10) || defStart);
            const end = Math.max(start, parseInt(cfg.endPage, 10) || defEnd);
            const step = Math.max(1, parseInt(cfg.step, 10) || 1);
            const sampleSize = Math.max(0, parseInt(cfg.sampleSize, 10) || 0);

            console.log(`[Servidor] ✅ Configuración aceptada:`);
            console.log(`   - Página inicio: ${start}`);
            console.log(`   - Página fin: ${end}`);
            console.log(`   - Salto / Paso: ${step}`);
            console.log(`   - Muestra aleatoria (páginas): ${sampleSize > 0 ? sampleSize : 'Desactivada (Rango completo)'}`);
            resolve({ startPage: start, endPage: end, step, sampleSize });
        };

        // Opción CLI en terminal si hay TTY
        if (process.stdin.isTTY) {
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            rl.question(`Presiona Enter para continuar con [Inicio: ${defStart}, Fin: ${defEnd}, Salto: ${defStep}, Muestra: ${defSample}]: `, () => {
                rl.close();
                applyConfig({ startPage: defStart, endPage: defEnd, step: defStep, sampleSize: defSample });
            });
        }

        // Renderizar modal interactivo completo en la pantalla del navegador (noVNC :6080)
        try {
            await page.evaluate((defS, defE, defSt, defSa, prevSaved, hasPrevStatus) => {
                const modal = document.createElement('div');
                modal.id = 'sigep-config-modal';
                modal.style.cssText = `
                    position: fixed;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    z-index: 9999999;
                    background: #0f172a;
                    color: #f8fafc;
                    padding: 24px 30px;
                    border-radius: 16px;
                    font-family: system-ui, -apple-system, sans-serif;
                    border: 2px solid #38bdf8;
                    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.85);
                    width: 490px;
                    box-sizing: border-box;
                `;
                modal.innerHTML = `
                    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
                        <span style="font-size:26px;">⚙️</span>
                        <div>
                            <h2 style="margin:0; color:#38bdf8; font-size:18px; font-weight:700;">Configuración de Extracción SIGEP</h2>
                            <span style="color:#94a3b8; font-size:12px;">${prevSaved.toLocaleString()} registros previos guardados ${hasPrevStatus ? '• (cargado de status.json)' : ''}</span>
                        </div>
                    </div>

                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;">
                        <div>
                            <label style="display:block; font-size:12px; color:#cbd5e1; margin-bottom:4px; font-weight:600;">Página Inicio:</label>
                            <input id="cfg-start" type="number" min="1" value="${defS}" style="width:100%; padding:9px; border-radius:8px; border:1px solid #475569; background:#1e293b; color:#f8fafc; font-size:14px; font-weight:bold; box-sizing:border-box;" />
                        </div>
                        <div>
                            <label style="display:block; font-size:12px; color:#cbd5e1; margin-bottom:4px; font-weight:600;">Página Fin:</label>
                            <input id="cfg-end" type="number" min="1" value="${defE}" style="width:100%; padding:9px; border-radius:8px; border:1px solid #475569; background:#1e293b; color:#f8fafc; font-size:14px; font-weight:bold; box-sizing:border-box;" />
                        </div>
                    </div>

                    <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
                        <div>
                            <label style="display:block; font-size:12px; color:#cbd5e1; margin-bottom:4px; font-weight:600;">Salto (Paso):</label>
                            <input id="cfg-step" type="number" min="1" value="${defSt}" style="width:100%; padding:9px; border-radius:8px; border:1px solid #475569; background:#1e293b; color:#f8fafc; font-size:14px; font-weight:bold; box-sizing:border-box;" />
                            <small style="color:#64748b; font-size:11px;">1 = consecutivas</small>
                        </div>
                        <div>
                            <label style="display:block; font-size:12px; color:#cbd5e1; margin-bottom:4px; font-weight:600;">Muestreo Simple (págs):</label>
                            <input id="cfg-sample" type="number" min="0" value="${defSa}" placeholder="0 = todo" style="width:100%; padding:9px; border-radius:8px; border:1px solid #475569; background:#1e293b; color:#f8fafc; font-size:14px; font-weight:bold; box-sizing:border-box;" />
                            <small style="color:#64748b; font-size:11px;">0 = todo el rango</small>
                        </div>
                    </div>

                    <button id="cfg-btn-start" style="width:100%; padding:12px; background:#0284c7; color:white; font-weight:bold; font-size:15px; border:none; border-radius:10px; cursor:pointer;">
                        ▶️ Iniciar Extracción
                    </button>
                    <div id="cfg-countdown" style="margin-top:10px; font-size:11px; text-align:center; color:#64748b;">
                        Auto-inicio en <strong id="cfg-timer" style="color:#f59e0b;">25</strong>s con valores sugeridos...
                    </div>
                `;
                document.body.appendChild(modal);

                let timeLeft = 25;
                let isPaused = false;
                const timerSpan = document.getElementById('cfg-timer');
                const btn = document.getElementById('cfg-btn-start');
                const inputs = modal.querySelectorAll('input');

                inputs.forEach(inp => {
                    inp.addEventListener('focus', () => {
                        isPaused = true;
                        document.getElementById('cfg-countdown').innerText = 'Temporizador pausado. Edita los campos y pulsa Iniciar.';
                    });
                });

                window.__sigepConfigResult = null;

                const finish = () => {
                    window.__sigepConfigResult = {
                        startPage: parseInt(document.getElementById('cfg-start').value, 10) || defS,
                        endPage: parseInt(document.getElementById('cfg-end').value, 10) || defE,
                        step: parseInt(document.getElementById('cfg-step').value, 10) || 1,
                        sampleSize: parseInt(document.getElementById('cfg-sample').value, 10) || 0
                    };
                    modal.remove();
                };

                btn.addEventListener('click', finish);

                const interval = setInterval(() => {
                    if (!isPaused) {
                        timeLeft--;
                        if (timerSpan) timerSpan.innerText = timeLeft;
                        if (timeLeft <= 0) {
                            clearInterval(interval);
                            finish();
                        }
                    }
                }, 1000);
            }, defStart, defEnd, defStep, defSample, totalSaved, !!defaults.fromStatus);
        } catch (e) {
            console.warn('[Servidor] No se pudo renderizar modal web:', e.message);
        }

        const pollWebResult = setInterval(async () => {
            if (isResolved) {
                clearInterval(pollWebResult);
                return;
            }
            try {
                const res = await page.evaluate(() => window.__sigepConfigResult);
                if (res) {
                    clearInterval(pollWebResult);
                    applyConfig(res);
                }
            } catch (e) {}
        }, 500);

        setTimeout(() => {
            if (!isResolved) {
                applyConfig({ startPage: defStart, endPage: defEnd, step: defStep, sampleSize: defSample });
            }
        }, 27000);
    });
}

async function run() {
    loadExistingRecords();
    const prevStatus = loadStatus();

    const defaultTotalPages = Math.ceil(totalRegistros / BATCH_SIZE);

    // Calcular valores por defecto: Prioridad 1 = status.json, Prioridad 2 = cálculo automático
    const suggestedStart = (prevStatus && (prevStatus.currentPage || prevStatus.startPage))
        || (Math.floor(totalSaved / BATCH_SIZE) + 1);
    const suggestedEnd = (prevStatus && prevStatus.endPage) || defaultTotalPages;
    const suggestedStep = (prevStatus && prevStatus.step) || 1;
    const suggestedSample = (prevStatus && prevStatus.sampleSize) || 0;

    console.log('[Servidor] Iniciando Google Chrome con aceleración WebGL y display virtual :99...');

    const browser = await puppeteer.launch({
        headless: false,
        executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome-stable',
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--ignore-gpu-blocklist',
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-webgl',
            '--remote-debugging-port=9222',
            '--window-size=1600,1000',
            '--no-first-run',
            '--no-default-browser-check'
        ],
        defaultViewport: { width: 1600, height: 1000 }
    });

    const page = (await browser.pages())[0] || await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    page.on('console', msg => console.log(`[Browser Console ${msg.type()}]`, msg.text()));
    page.on('pageerror', err => console.error('[Browser Error]', err.message));

    console.log(`[Servidor] Navegando a ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    console.log('[Servidor] Esperando sesión anónima SIGEP y Turnstile...');
    await page.waitForFunction(() => sessionStorage.getItem('ps_accessToken') !== null, { timeout: 30000 });
    await page.waitForFunction(() => typeof window.turnstile !== 'undefined' && typeof window.turnstile.render === 'function', { timeout: 30000 });
    console.log('[Servidor] Sesión establecida y Turnstile listo.');

    // PREGUNTAR CONFIGURACIÓN AL USUARIO (Inicio, Fin, Salto, Muestra Simple)
    const config = await askScrapingConfig(page, {
        startPage: suggestedStart,
        endPage: suggestedEnd,
        step: suggestedStep,
        sampleSize: suggestedSample,
        fromStatus: !!prevStatus
    });

    currentActiveConfig = config;
    currentActivePage = config.startPage;

    // Guardar estado inicial confirmado en status.json
    saveStatus({
        currentPage: config.startPage,
        status: 'RUNNING'
    });

    // Generar cola de páginas a procesar usando el módulo sampling
    const pageQueue = samplePages(config.startPage, config.endPage, config.step, config.sampleSize);
    console.log(`[Servidor] Plan de trabajo generado: ${pageQueue.length.toLocaleString()} páginas a consultar.`);

    // Configurar HUD flotante en pantalla (noVNC)
    await page.evaluate((totalPlan, isSample) => {
        const hud = document.createElement('div');
        hud.id = 'server-hud';
        hud.style.cssText = 'position:fixed;top:15px;right:15px;z-index:999999;background:#0f172a;color:#f8fafc;padding:14px 20px;border-radius:10px;font-family:sans-serif;font-size:13px;border:1px solid #38bdf8;box-shadow:0 8px 20px rgba(0,0,0,0.5);width:340px;';
        hud.innerHTML = `
            <div style="font-weight:bold;color:#38bdf8;margin-bottom:6px;">🚀 Extractor Autónomo SIGEP</div>
            <div id="hud-status" style="color:#4ade80;">Iniciando plan de extracción...</div>
            <div id="hud-stats" style="margin-top:4px;color:#94a3b8;font-size:12px;">Total planificadas: ${totalPlan.toLocaleString()} páginas ${isSample ? '(Muestra MAS)' : ''}</div>
        `;
        document.body.appendChild(hud);
    }, pageQueue.length, config.sampleSize > 0);

    let consecutiveErrors = 0;

    // Iterar por la cola de páginas planificada
    for (let index = 0; index < pageQueue.length; index++) {
        if (isShuttingDown) break;

        const pageNum = pageQueue[index];
        currentActivePage = pageNum;
        const progressStr = `[${index + 1} / ${pageQueue.length}]`;

        try {
            // Actualizar HUD
            await page.evaluate((p, idx, totalP, totRecs) => {
                const s = document.getElementById('hud-status');
                const st = document.getElementById('hud-stats');
                if (s) s.innerText = `Pág actual: ${p} (${idx} de ${totalP})`;
                if (st) st.innerText = `Guardados: ${totRecs.toLocaleString()} registros`;
            }, pageNum, index + 1, pageQueue.length, totalSaved);

            // Obtener lote mediante Turnstile + API directa en Chrome
            const result = await page.evaluate(async (p) => {
                const getCaptcha = () => new Promise((resolve, reject) => {
                    const c = document.createElement('div');
                    document.body.appendChild(c);
                    const timer = setTimeout(() => {
                        if (c.parentNode) c.remove();
                        reject(new Error('Turnstile token timeout (15s)'));
                    }, 15000);

                    try {
                        const wId = window.turnstile.render(c, {
                            sitekey: '0x4AAAAAACHbHIeBTaDEpzYc',
                            callback: (token) => {
                                clearTimeout(timer);
                                window.turnstile.remove(wId);
                                if (c.parentNode) c.remove();
                                resolve(token);
                            },
                            'error-callback': (err) => {
                                clearTimeout(timer);
                                window.turnstile.remove(wId);
                                if (c.parentNode) c.remove();
                                reject(new Error('Turnstile error: ' + err));
                            }
                        });
                    } catch (e) {
                        clearTimeout(timer);
                        if (c.parentNode) c.remove();
                        reject(e);
                    }
                });

                const token = await getCaptcha();
                const bearer = sessionStorage.getItem('ps_accessToken');

                const url = `/rsportaltransparencia/api/v1/persona/lista?tipoBusqueda=SP&draw=${p}&estadoBusqueda=&tipoPersonalBusqueda=`;
                const res = await fetch(url, {
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Authorization': 'bearer ' + bearer,
                        'Captcha': token
                    }
                });

                if (res.status === 200) {
                    const json = await res.json();
                    const payload = json.data || json;
                    return {
                        ok: true,
                        lista: payload.lista || [],
                        numRegistros: payload.numRegistros
                    };
                } else {
                    return {
                        ok: false,
                        status: res.status
                    };
                }
            }, pageNum);

            if (result.ok) {
                if (result.numRegistros) {
                    totalRegistros = result.numRegistros;
                }

                if (result.lista && result.lista.length > 0) {
                    let newCount = 0;
                    let linesToWrite = '';

                    for (const rec of result.lista) {
                        const id = [
                            rec.entidad || '',
                            rec.siglaEntidad || '',
                            rec.descUnidad || '',
                            rec.razonSocial || (rec.nombres + ' ' + rec.primerApellido) || '',
                            rec.descCargo || '',
                            rec.monto || '',
                            rec.fechaIni || '',
                            rec.fechaFin || '',
                            rec.apiEstado || ''
                        ].join('|').toLowerCase().replace(/\s+/g, ' ').trim();

                        if (!existingIds.has(id)) {
                            existingIds.add(id);
                            linesToWrite += JSON.stringify(rec) + '\n';
                            newCount++;
                            totalSaved++;
                        }
                    }

                    if (linesToWrite.length > 0) {
                        fs.appendFileSync(OUTPUT_FILE, linesToWrite, 'utf8');
                    }

                    console.log(`[Servidor] ${progressStr} Pág ${pageNum} | +${newCount} nuevos | Acumulado: ${totalSaved.toLocaleString()}`);
                    consecutiveErrors = 0;

                    // Actualizar status.json tras cada página procesada
                    const nextPageNumber = (index + 1 < pageQueue.length) ? pageQueue[index + 1] : pageNum;
                    saveStatus({
                        currentPage: nextPageNumber,
                        status: 'RUNNING'
                    });

                } else {
                    console.log(`[Servidor] ${progressStr} Pág ${pageNum} sin registros.`);
                }
            } else if (result.status === 401) {
                console.warn(`[Servidor] HTTP 401 en pág ${pageNum}. Esperando sesión...`);
                await sleep(5000);
                consecutiveErrors++;
                index--; // Reintentar esta página
            } else {
                console.warn(`[Servidor] HTTP ${result.status} en pág ${pageNum}. Reintentando...`);
                await sleep(3000);
                consecutiveErrors++;
                index--; // Reintentar esta página
            }

            if (consecutiveErrors >= 5) {
                console.error(`[Servidor] 5 fallos consecutivos. Pausa preventiva de 20s...`);
                await sleep(20000);
                consecutiveErrors = 0;
            }

            await sleep(DELAY_BETWEEN_PAGES + Math.floor(Math.random() * 600));

        } catch (err) {
            console.error(`[Servidor] Error en pág ${pageNum}:`, err.message || err);
            consecutiveErrors++;
            await sleep(4000);
            if (consecutiveErrors < 3) {
                index--; // Reintentar hasta 3 veces
            }
        }
    }

    console.log(`[Servidor] ¡Plan completado! Total registros extraídos: ${totalSaved.toLocaleString()}`);
    saveStatus({
        currentPage: currentActivePage,
        status: 'COMPLETED'
    });
}

run().catch(err => {
    console.error('[Servidor] Error crítico:', err);
});
