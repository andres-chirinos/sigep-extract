const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const OUTPUT_FILE = process.env.OUTPUT_FILE || '/app/data/sigep_export.jsonl';
const USER_DATA_DIR = process.env.USER_DATA_DIR || '/app/data/browser_profile';
const TARGET_URL = 'https://sigep.gob.bo/rsportaltransparencia/#/portalHome/personal';
const BATCH_SIZE = 10;
const DELAY_BETWEEN_PAGES = 1800; // ms para no saturar Cloudflare

// Asegurar directorios
const dataDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Cargar IDs ya existentes para reanudar sin duplicados
const existingIds = new Set();
let totalSaved = 0;

if (fs.existsSync(OUTPUT_FILE)) {
    try {
        const lines = fs.readFileSync(OUTPUT_FILE, 'utf8').split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const rec = JSON.parse(line);
                const id = [
                    rec.entidad || '',
                    rec.unidadOrganizacional || '',
                    rec.nombre || '',
                    rec.cargo || '',
                    rec.puestoFuncion || '',
                    rec.tipo || '',
                    rec.nivelSalarialMonto || '',
                    rec.fechaInicio || '',
                    rec.fechaFin || '',
                    rec.estado || ''
                ].join('|').toLowerCase().replace(/\s+/g, ' ').trim();
                existingIds.add(id);
                totalSaved++;
            } catch (e) {}
        }
        console.log(`[Servidor] Archivo existente detectado. ${totalSaved} registros previos cargados.`);
    } catch (e) {
        console.warn('[Servidor] Error leyendo archivo previo:', e.message);
    }
}

async function run() {
    console.log('[Servidor] Lanzando Chromium con soporte anti-bot y display virtual :99...');

    const browser = await puppeteer.launch({
        headless: false, // GUI interactiva visible en http://localhost:6080/vnc.html
        executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome-stable',
        ignoreDefaultArgs: ['--enable-automation'],
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1600,1000',
            '--no-first-run',
            '--no-default-browser-check'
        ],
        userDataDir: USER_DATA_DIR,
        defaultViewport: { width: 1600, height: 1000 }
    });

    const page = (await browser.pages())[0] || await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    page.on('console', msg => console.log(`[Browser Console ${msg.type()}]`, msg.text()));
    page.on('pageerror', err => console.error('[Browser Error]', err.message));

    // Exponer función para que el navegador guarde por lotes directo al archivo
    await page.exposeFunction('saveBatchToDisk', (records, pageNum, totalRegs) => {
        if (!records || records.length === 0) return 0;
        let newCount = 0;
        let linesToWrite = '';

        for (const rec of records) {
            const id = [
                rec.entidad || '',
                rec.unidadOrganizacional || '',
                rec.nombre || '',
                rec.cargo || '',
                rec.puestoFuncion || '',
                rec.tipo || '',
                rec.nivelSalarialMonto || '',
                rec.fechaInicio || '',
                rec.fechaFin || '',
                rec.estado || ''
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

        console.log(`[Servidor] Pág ${pageNum} | +${newCount} nuevos | Total acumulado: ${totalSaved} / ${totalRegs || '100000'}`);
        return newCount;
    });

    console.log(`[Servidor] Navegando al portal: ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    console.log('[Servidor] Esperando sesión y autenticación anónima SIGEP...');
    await page.waitForFunction(() => sessionStorage.getItem('ps_accessToken') !== null, { timeout: 30000 });

    console.log('[Servidor] Sesión iniciada con éxito. Comenzando extracción masiva...');

    // Ejecutar extractor continuo dentro de la sesión de Chrome
    await page.evaluate(async (startPageNumber) => {
        const sleep = ms => new Promise(r => setTimeout(r, ms));

        const getTurnstileToken = () => {
            return new Promise((resolve, reject) => {
                const container = document.createElement('div');
                document.body.appendChild(container);
                try {
                    window.turnstile.render(container, {
                        sitekey: '0x4AAAAAACHbHIeBTaDEpzYc',
                        callback: (token) => {
                            container.remove();
                            resolve(token);
                        },
                        'error-callback': (err) => {
                            container.remove();
                            reject(err);
                        }
                    });
                } catch (e) {
                    container.remove();
                    reject(e);
                }
            });
        };

        // Crear HUD flotante de estado en la pantalla de noVNC
        const hud = document.createElement('div');
        hud.id = 'server-hud';
        hud.style.cssText = 'position:fixed;top:15px;right:15px;z-index:999999;background:#0f172a;color:#f8fafc;padding:12px 18px;border-radius:10px;font-family:sans-serif;font-size:13px;border:1px solid #38bdf8;box-shadow:0 8px 20px rgba(0,0,0,0.5);width:320px;';
        hud.innerHTML = `
            <div style="font-weight:bold;color:#38bdf8;margin-bottom:6px;">🚀 Extractor Autónomo Activo</div>
            <div id="hud-status" style="color:#4ade80;">Iniciando extracción...</div>
            <div id="hud-stats" style="margin-top:4px;color:#94a3b8;font-size:12px;">Página 1</div>
        `;
        document.body.appendChild(hud);

        const updateHUD = (status, stats) => {
            document.getElementById('hud-status').innerText = status;
            document.getElementById('hud-stats').innerText = stats;
        };

        let pageNum = startPageNumber || 1;
        let totalRegistros = 100000;
        let consecutiveErrors = 0;

        while (true) {
            // Verificar fin de páginas
            if (pageNum > Math.ceil(totalRegistros / 10) && totalRegistros > 0) {
                console.log(`[Browser] Extracción finalizada en página ${pageNum - 1}.`);
                updateHUD('Finalizado con éxito', `Total: ${totalRegistros} registros extraídos.`);
                break;
            }

            try {
                updateHUD(`Extrayendo página ${pageNum}...`, `Turnstile challenge en progreso...`);

                // 1. Obtener token de Turnstile generado por Cloudflare en el navegador real
                const captcha = await getTurnstileToken();
                const bearer = sessionStorage.getItem('ps_accessToken');

                // 2. Fetch autenticado a la API de personal (SP = Sin filtro, Todos)
                const url = `/rsportaltransparencia/api/v1/persona/lista?tipoBusqueda=SP&draw=${pageNum}&estadoBusqueda=&tipoPersonalBusqueda=`;
                const response = await fetch(url, {
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Authorization': 'bearer ' + bearer,
                        'Captcha': captcha
                    }
                });

                if (response.status === 200) {
                    const data = await response.json();
                    if (data.numRegistros) {
                        totalRegistros = data.numRegistros;
                    }

                    if (data.lista && data.lista.length > 0) {
                        await window.saveBatchToDisk(data.lista, pageNum, totalRegistros);
                        consecutiveErrors = 0;
                        updateHUD(`Página ${pageNum} procesada`, `+${data.lista.length} registros. Total: ${totalRegistros}`);
                        pageNum++;
                    } else {
                        console.log(`[Browser] No se encontraron más registros en página ${pageNum}.`);
                        break;
                    }
                } else if (response.status === 401) {
                    console.warn(`[Browser] Error 401 en página ${pageNum}. Esperando renovación de sesión...`);
                    updateHUD(`Error 401 en pág ${pageNum}`, 'Esperando renovación...');
                    await sleep(4000);
                    consecutiveErrors++;
                } else {
                    console.warn(`[Browser] Error HTTP ${response.status} en página ${pageNum}. Reintentando...`);
                    updateHUD(`Error HTTP ${response.status}`, `Reintentando intento ${consecutiveErrors + 1}...`);
                    await sleep(3000);
                    consecutiveErrors++;
                }

                if (consecutiveErrors >= 5) {
                    console.error(`[Browser] 5 errores seguidos en página ${pageNum}. Pausando 15s...`);
                    updateHUD('Pausa por errores', 'Esperando 15 segundos antes de reintentar...');
                    await sleep(15000);
                    consecutiveErrors = 0;
                }

                // Pausa prudente entre llamadas
                await sleep(1800 + Math.random() * 800);

            } catch (err) {
                console.error(`[Browser] Excepción en página ${pageNum}:`, err.message || err);
                updateHUD('Error en llamada', `Excepción: ${err.message || err}`);
                await sleep(4000);
                consecutiveErrors++;
            }
        }
    }, Math.floor(totalSaved / BATCH_SIZE) + 1);

    console.log('[Servidor] Proceso de extracción completado exitosamente.');
}

run().catch(err => {
    console.error('[Servidor] Error crítico en ejecutor:', err);
});
