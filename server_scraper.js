const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const s3Sync = require('./s3_sync');

const OUTPUT_FILE = process.env.OUTPUT_FILE || '/app/data/sigep_export.jsonl';
const TARGET_URL = 'https://sigep.gob.bo/rsportaltransparencia/#/portalHome/personal';
const BATCH_SIZE = 10;
const DELAY_BETWEEN_PAGES = parseInt(process.env.DELAY_BETWEEN_PAGES || '1800', 10);

// Asegurar directorios locales
const dataDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

let existingIds = new Set();
let totalSaved = 0;
let pageNum = 1;
let totalRegistros = 1000636;
let recordsSinceLastSync = 0;

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
            console.log(`[Servidor] Archivo local listo: ${totalSaved} registros deduplicados cargados.`);
        } catch (e) {
            console.warn('[Servidor] Error leyendo archivo local:', e.message);
        }
    }
}

// Manejo de apagado limpio (Dokploy o Docker stop)
let isShuttingDown = false;
async function handleShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n[Servidor] Señal ${signal} recibida. Realizando sincronización final a S3...`);
    try {
        if (s3Sync.enabled) {
            await s3Sync.uploadFile(OUTPUT_FILE);
            await s3Sync.uploadStatus({
                currentPage: pageNum,
                totalPages: Math.ceil(totalRegistros / BATCH_SIZE),
                totalSaved,
                totalRecords: totalRegistros,
                progressPercent: `${((totalSaved / totalRegistros) * 100).toFixed(2)}%`,
                status: 'INTERRUPTED'
            });
        }
    } catch (e) {
        console.error('[Servidor] Error durante sincronización final:', e.message);
    }
    process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
    // 1. Si S3 está activo, intentar descargar último estado previo antes de arrancar
    if (s3Sync.enabled) {
        await s3Sync.pullInitialFile(OUTPUT_FILE);
    }

    // 2. Cargar registros y calcular página de inicio
    loadExistingRecords();
    pageNum = Math.floor(totalSaved / BATCH_SIZE) + 1;

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

    // Configurar HUD flotante para visualización en noVNC
    await page.evaluate(() => {
        const hud = document.createElement('div');
        hud.id = 'server-hud';
        hud.style.cssText = 'position:fixed;top:15px;right:15px;z-index:999999;background:#0f172a;color:#f8fafc;padding:14px 20px;border-radius:10px;font-family:sans-serif;font-size:13px;border:1px solid #38bdf8;box-shadow:0 8px 20px rgba(0,0,0,0.5);width:340px;';
        hud.innerHTML = `
            <div style="font-weight:bold;color:#38bdf8;margin-bottom:6px;">🚀 Extractor SIGEP Pro + S3</div>
            <div id="hud-status" style="color:#4ade80;">Iniciando extracción...</div>
            <div id="hud-stats" style="margin-top:4px;color:#94a3b8;font-size:12px;">Página 1</div>
        `;
        document.body.appendChild(hud);
    });

    let consecutiveErrors = 0;
    console.log(`[Servidor] Comenzando escaneo continuo desde página ${pageNum}...`);

    while (true) {
        if (isShuttingDown) break;

        const totalPages = Math.ceil(totalRegistros / BATCH_SIZE);
        if (pageNum > totalPages && totalRegistros > 0) {
            console.log(`[Servidor] ¡Extracción completa! Total páginas procesadas: ${pageNum - 1}`);
            if (s3Sync.enabled) {
                await s3Sync.uploadFile(OUTPUT_FILE);
                await s3Sync.uploadStatus({
                    currentPage: pageNum,
                    totalPages,
                    totalSaved,
                    totalRecords: totalRegistros,
                    progressPercent: '100%',
                    status: 'COMPLETED'
                });
            }
            break;
        }

        try {
            // Actualizar HUD
            await page.evaluate((p, totP, totRecs, s3Ok) => {
                const s = document.getElementById('hud-status');
                const st = document.getElementById('hud-stats');
                if (s) s.innerText = `Extrayendo pág ${p} / ${totP}...`;
                if (st) st.innerText = `Guardados: ${totRecs} ${s3Ok ? '☁️ S3 activo' : ''}`;
            }, pageNum, totalPages, totalSaved, s3Sync.enabled);

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
                            recordsSinceLastSync++;
                        }
                    }

                    if (linesToWrite.length > 0) {
                        fs.appendFileSync(OUTPUT_FILE, linesToWrite, 'utf8');
                    }

                    console.log(`[Servidor] Pág ${pageNum} | +${newCount} nuevos | Acumulado: ${totalSaved} / ${totalRegistros}`);
                    consecutiveErrors = 0;
                    pageNum++;

                    // Sincronización periódica a S3
                    if (s3Sync.enabled && recordsSinceLastSync >= s3Sync.syncInterval) {
                        await s3Sync.uploadFile(OUTPUT_FILE);
                        await s3Sync.uploadStatus({
                            currentPage: pageNum,
                            totalPages,
                            totalSaved,
                            totalRecords: totalRegistros,
                            progressPercent: `${((totalSaved / totalRegistros) * 100).toFixed(2)}%`,
                            status: 'RUNNING'
                        });
                        recordsSinceLastSync = 0;
                    }

                } else {
                    console.log(`[Servidor] No hay más registros en pág ${pageNum}. Fin de lista.`);
                    break;
                }
            } else if (result.status === 401) {
                console.warn(`[Servidor] HTTP 401 en pág ${pageNum}. Renovando sesión...`);
                await sleep(5000);
                consecutiveErrors++;
            } else {
                console.warn(`[Servidor] HTTP ${result.status} en pág ${pageNum}. Reintentando...`);
                await sleep(3000);
                consecutiveErrors++;
            }

            if (consecutiveErrors >= 5) {
                console.error(`[Servidor] 5 fallos consecutivos en pág ${pageNum}. Pausa preventiva de 20s...`);
                await sleep(20000);
                consecutiveErrors = 0;
            }

            await sleep(DELAY_BETWEEN_PAGES + Math.floor(Math.random() * 600));

        } catch (err) {
            console.error(`[Servidor] Error en pág ${pageNum}:`, err.message || err);
            consecutiveErrors++;
            await sleep(4000);
        }
    }

    console.log('[Servidor] Proceso terminado.');
}

run().catch(err => {
    console.error('[Servidor] Error crítico:', err);
});
