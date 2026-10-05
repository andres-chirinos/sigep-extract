const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const warcRecorder = require('./warc_recorder');
const WarcToMarkdownProcessor = require('./warc_to_markdown');
const s3Sync = require('./s3_sync');

const START_URL = process.env.START_URL || process.env.TARGET_URL || 'https://sigep.gob.bo/rsportaltransparencia/#/portalHome/personal';
const SCRIPTS_DIR = process.env.SCRIPTS_DIR || '/app/scripts';
const AUTO_EXECUTE_SCRIPT = process.env.AUTO_EXECUTE_SCRIPT || '';
const WARC_ENABLED = process.env.WARC_ENABLED !== 'false';
const WARC_SYNC_INTERVAL_MINUTES = parseInt(process.env.WARC_SYNC_INTERVAL_MINUTES || '10', 10);
const AUTO_WARC_TO_MD = process.env.AUTO_WARC_TO_MD === 'true';

// Asegurar directorios
if (!fs.existsSync(SCRIPTS_DIR)) {
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
}

function getAvailableScripts() {
    try {
        if (!fs.existsSync(SCRIPTS_DIR)) return [];
        return fs.readdirSync(SCRIPTS_DIR).filter(f => f.endsWith('.js'));
    } catch (e) {
        return [];
    }
}

// Manejo de señales de terminación
async function handleShutdown(signal) {
    console.log(`\n[Cliente] Señal ${signal} recibida. Cerrando sesión y procesando archivos...`);
    try {
        const warcFile = warcRecorder.close();
        if (warcFile && (AUTO_WARC_TO_MD || process.env.AUTO_PROCESS_WARC_TO_MD === 'true')) {
            console.log('[Cliente] Procesando WARC final a Markdown...');
            const processor = new WarcToMarkdownProcessor();
            await processor.processWarcFile(warcFile);
        }
        if (s3Sync.enabled && warcFile) {
            console.log('[Cliente] Sincronizando archivos WARC a S3...');
            await s3Sync.uploadArchives();
        }
    } catch (e) {
        console.error('[Cliente] Error en cierre limpio:', e.message);
    }
    process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

async function startClient() {
    console.log('====================================================');
    console.log('🌐 FRAMEWORK ANTI-BOT: CLIENTE WEB + WARC + MARKDOWN');
    console.log(`URL Inicial: ${START_URL}`);
    console.log(`WARC Archiving: ${WARC_ENABLED ? 'ACTIVADO' : 'DESACTIVADO'}`);
    console.log(`Auto WARC -> Markdown: ${AUTO_WARC_TO_MD ? 'ACTIVADO' : 'MANUAL'}`);
    console.log(`S3 Storage: ${s3Sync.enabled ? 'CONECTADO (' + s3Sync.bucket + ')' : 'LOCAL'}`);
    console.log('====================================================');

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
            '--start-maximized',
            '--no-first-run',
            '--no-default-browser-check'
        ],
        defaultViewport: null
    });

    // Iniciar archivo WARC
    if (WARC_ENABLED) {
        warcRecorder.startNewSession('client_session');
    }

    const setupPage = async (page) => {
        if (WARC_ENABLED) {
            await warcRecorder.attachToPage(page);
        }

        // Receptor de eventos de consola (completamente invisible para Cloudflare)
        page.on('console', async (msg) => {
            const text = msg.text();

            if (text.startsWith('__ANTIBOT_EXEC__:')) {
                const scriptName = text.replace('__ANTIBOT_EXEC__:', '').trim();
                const scriptPath = path.join(SCRIPTS_DIR, scriptName);
                if (fs.existsSync(scriptPath)) {
                    console.log(`[Cliente] Inyectando script seleccionado: ${scriptName}`);
                    try {
                        const code = fs.readFileSync(scriptPath, 'utf8');
                        await page.evaluate(code);
                    } catch (err) {
                        console.error(`[Cliente] Error ejecutando ${scriptName}:`, err.message);
                    }
                } else {
                    console.warn(`[Cliente] Script no encontrado en ${scriptPath}`);
                }
            } else if (text === '__ANTIBOT_WARC2MD__') {
                console.log('[Cliente] Solicitud recibida: procesando archivos WARC a Markdown...');
                try {
                    const processor = new WarcToMarkdownProcessor();
                    const files = await processor.processAll();
                    console.log(`[Cliente] Finalizado. ${files.length} documentos Markdown creados.`);
                    await page.evaluate((count) => {
                        alert(`Conversión completada.\nSe generaron ${count} archivos Markdown estructurados en /app/data/markdown.`);
                    }, files.length);
                } catch (err) {
                    console.error('[Cliente] Error procesando WARC a MD:', err.message);
                }
            } else {
                console.log(`[Browser ${msg.type()}]`, text);
            }
        });

        // Inyectar UI Dock interactivo en el DOM del navegador
        await page.evaluateOnNewDocument((scriptsList) => {
            window.addEventListener('DOMContentLoaded', () => {
                if (document.getElementById('antibot-control-dock')) return;

                const dock = document.createElement('div');
                dock.id = 'antibot-control-dock';
                dock.style.cssText = `
                    position: fixed;
                    top: 10px;
                    left: 10px;
                    z-index: 2147483647;
                    background: rgba(15, 23, 42, 0.92);
                    backdrop-filter: blur(8px);
                    color: #f8fafc;
                    padding: 8px 14px;
                    border-radius: 10px;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    font-size: 12px;
                    border: 1px solid #38bdf8;
                    box-shadow: 0 8px 24px rgba(0,0,0,0.6);
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    user-select: none;
                `;

                dock.innerHTML = `
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#4ade80;box-shadow:0 0 8px #4ade80;"></span>
                        <strong style="color:#38bdf8;">AntiBot WARC</strong>
                    </div>
                    <span style="color:#64748b;">|</span>
                    <div style="display:flex;align-items:center;gap:4px;">
                        <select id="dock-script-select" style="background:#1e293b;color:#f8fafc;border:1px solid #475569;border-radius:4px;padding:3px 6px;font-size:11px;">
                            ${scriptsList.length > 0 ? scriptsList.map(s => `<option value="${s}">${s}</option>`).join('') : '<option value="">Sin scripts en /scripts</option>'}
                        </select>
                        <button id="dock-btn-run" style="background:#0284c7;color:white;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;font-weight:bold;font-size:11px;">▶ Correr Script</button>
                    </div>
                    <span style="color:#64748b;">|</span>
                    <button id="dock-btn-warc2md" style="background:#059669;color:white;border:none;padding:4px 9px;border-radius:4px;cursor:pointer;font-weight:bold;font-size:11px;" title="Convierte todo el tráfico WARC a Markdown estructurado">📄 WARC → MD</button>
                    <button id="dock-btn-min" style="background:transparent;border:none;color:#94a3b8;cursor:pointer;font-size:14px;padding:0 4px;">−</button>
                `;

                document.body.appendChild(dock);

                // Minimizar / Restaurar
                let isMin = false;
                document.getElementById('dock-btn-min').onclick = () => {
                    isMin = !isMin;
                    dock.style.height = isMin ? '12px' : 'auto';
                    dock.style.overflow = isMin ? 'hidden' : 'visible';
                    document.getElementById('dock-btn-min').innerText = isMin ? '+' : '−';
                };

                // Disparo sigiloso vía console
                document.getElementById('dock-btn-run').onclick = () => {
                    const sel = document.getElementById('dock-script-select');
                    const scriptName = sel.value;
                    if (!scriptName) return alert('No hay scripts disponibles en la carpeta /app/scripts.');
                    console.log('__ANTIBOT_EXEC__:' + scriptName);
                };

                document.getElementById('dock-btn-warc2md').onclick = () => {
                    document.getElementById('dock-btn-warc2md').innerText = '⏳ Procesando...';
                    console.log('__ANTIBOT_WARC2MD__');
                    setTimeout(() => {
                        document.getElementById('dock-btn-warc2md').innerText = '📄 WARC → MD';
                    }, 4000);
                };
            });
        }, getAvailableScripts());
    };

    const pages = await browser.pages();
    const mainPage = pages[0] || await browser.newPage();
    await setupPage(mainPage);

    // Conectar nuevas pestañas emergentes
    browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            const newPage = await target.page();
            if (newPage) {
                await setupPage(newPage);
            }
        }
    });

    console.log(`[Cliente] Navegando a ${START_URL}...`);
    try {
        await mainPage.goto(START_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
        console.warn('[Cliente] Advertencia en navegación inicial:', e.message);
    }

    // Auto-ejecución opcional
    if (AUTO_EXECUTE_SCRIPT) {
        const autoPath = path.isAbsolute(AUTO_EXECUTE_SCRIPT) ? AUTO_EXECUTE_SCRIPT : path.join(SCRIPTS_DIR, AUTO_EXECUTE_SCRIPT);
        if (fs.existsSync(autoPath)) {
            console.log(`[Cliente] Auto-ejecutando script: ${autoPath}...`);
            const code = fs.readFileSync(autoPath, 'utf8');
            await mainPage.evaluate(code);
        }
    }

    // Sincronización periódica de WARC a S3
    if (s3Sync.enabled && WARC_ENABLED) {
        setInterval(async () => {
            console.log('[WARC-S3] Sincronización de archivos WARC hacia S3...');
            await s3Sync.uploadArchives();
        }, WARC_SYNC_INTERVAL_MINUTES * 60 * 1000);
    }

    console.log('[Cliente] Sistema listo.');
    console.log('[Cliente] Acceso interactivo en: http://localhost:6080/vnc.html');
    console.log('[Cliente] Abre DevTools con F12 / clic derecho o usa el dock superior.');
}

startClient().catch(err => {
    console.error('[Cliente] Error crítico:', err);
});
