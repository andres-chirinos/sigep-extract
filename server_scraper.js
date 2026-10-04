const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

puppeteer.use(StealthPlugin());

const OUTPUT_FILE = process.env.OUTPUT_FILE || '/app/data/sigep_export.jsonl';
const USER_DATA_DIR = process.env.USER_DATA_DIR || '/app/data/browser_profile';
const TARGET_URL = 'https://sigep.gob.bo/rsportaltransparencia/#/portalHome/personal';

// Asegurar directorios
const dataDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Cargar IDs ya extraídos para evitar duplicados al reanudar
const existingIds = new Set();
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
            } catch (e) {}
        }
        console.log(`[Servidor] Archivo previo detectado. Cargados ${existingIds.size} registros únicos existentes.`);
    } catch (e) {
        console.warn('[Servidor] Error al leer archivo existente:', e.message);
    }
}

async function run() {
    console.log('[Servidor] Iniciando Chromium con stealth en display virtual...');

    const browser = await puppeteer.launch({
        headless: false, // GUI visible a través de noVNC en el puerto 6080
        executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome-stable',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--window-size=1600,1000',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--no-default-browser-check',
            '--no-first-run',
            '--lang=es-ES,es'
        ],
        userDataDir: USER_DATA_DIR,
        defaultViewport: { width: 1600, height: 1000 }
    });

    const page = (await browser.pages())[0] || await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });

    // Exponer función de guardado directo a disco
    await page.exposeFunction('saveBatchToDisk', (records) => {
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
            }
        }

        if (linesToWrite.length > 0) {
            fs.appendFileSync(OUTPUT_FILE, linesToWrite, 'utf8');
        }

        console.log(`[Servidor] Guardados ${newCount} registros nuevos. Total archivo: ${existingIds.size}`);
        return newCount;
    });

    console.log(`[Servidor] Navegando a ${TARGET_URL}...`);
    try {
        await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    } catch (e) {
        console.warn('[Servidor] Timeout en carga inicial de página, verificando DOM...');
    }

    console.log('[Servidor] Esperando 8 segundos para estabilización de Cloudflare y Angular...');
    await new Promise(r => setTimeout(r, 8000));

    console.log('[Servidor] Inyectando script de extracción y paginación continua...');

    // Inyección de la lógica dentro del contexto del navegador
    await page.evaluate(async () => {
        const sleep = (ms) => new Promise(r => setTimeout(r, ms));
        const randomDelay = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min);

        const isSpinnerActive = () => {
            const spinner = document.querySelector('spinner-http');
            if (!spinner) return false;
            if (spinner.querySelector('.ball-pulse, .posicion-spinner')) return true;
            return spinner.children.length > 0;
        };

        const waitForSpinner = async (timeoutMs = 45000) => {
            const start = Date.now();
            let wasActive = false;
            while (isSpinnerActive()) {
                wasActive = true;
                if (Date.now() - start > timeoutMs) break;
                await sleep(250);
            }
            if (wasActive) await sleep(500);
        };

        const extractDOM = () => {
            const rows = document.querySelectorAll('#tablaValues tbody tr');
            const data = [];
            rows.forEach(r => {
                const c = r.querySelectorAll('td');
                if (c.length >= 10 && !r.innerText.includes('No hay datos')) {
                    data.push({
                        entidad: c[0].innerText.trim(),
                        unidadOrganizacional: c[1].innerText.trim(),
                        nombre: c[2].innerText.trim(),
                        cargo: c[3].innerText.trim(),
                        puestoFuncion: c[4].innerText.trim(),
                        tipo: c[5].innerText.trim(),
                        nivelSalarialMonto: c[6].innerText.trim(),
                        fechaInicio: c[7].innerText.trim(),
                        fechaFin: c[8].innerText.trim(),
                        estado: c[9].innerText.trim()
                    });
                }
            });
            return data;
        };

        const getActivePageNumber = () => {
            const el = document.querySelector('li.pagination-page.active a, .pagination .active a');
            return el ? parseInt(el.innerText.trim(), 10) : null;
        };

        const getFirstRowSignature = () => {
            const r = document.querySelector('#tablaValues tbody tr');
            return r ? r.innerText.trim() : '';
        };

        const getNextButton = () => {
            const nextLi = document.querySelector('li.pagination-next');
            if (nextLi && !nextLi.classList.contains('disabled')) {
                return nextLi.querySelector('a');
            }
            return null;
        };

        const simulateClick = (el) => {
            if (!el) return;
            el.focus();
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        };

        // 1. Ajustar filtro Estado: Todos si no está aplicado
        await waitForSpinner();
        try {
            const estadoBtn = Array.from(document.querySelectorAll('.btn-group button'))
                .find(b => b.innerText.includes('Estado:'));
            if (estadoBtn && !estadoBtn.innerText.includes('Todos')) {
                estadoBtn.click();
                await sleep(400);
                const parentGroup = estadoBtn.closest('.btn-group') || document;
                const todosOption = Array.from(parentGroup.querySelectorAll('.dropdown-item'))
                    .find(el => el.innerText.trim() === 'Todos');
                if (todosOption) {
                    todosOption.click();
                    await sleep(500);
                    await waitForSpinner();
                }
            }
        } catch (e) {
            console.warn('Error ajustando filtro Estado:', e);
        }

        // 2. Asegurar datos en Página 1
        let rows = extractDOM();
        if (rows.length === 0) {
            const submitBtn = document.querySelector('button[type="submit"]');
            if (submitBtn) submitBtn.click();
            await waitForSpinner();

            const startW = Date.now();
            while (rows.length === 0 && Date.now() - startW < 20000) {
                await sleep(500);
                rows = extractDOM();
            }
        }

        if (rows.length > 0) {
            await window.saveBatchToDisk(rows);
        }

        // 3. Bucle de paginación
        let currentPage = getActivePageNumber() || 1;
        console.log(`[Browser] Extracción iniciada en página ${currentPage}...`);

        while (true) {
            await waitForSpinner();

            let nextBtn = getNextButton();
            if (!nextBtn) {
                const startBtnWait = Date.now();
                while (!nextBtn && Date.now() - startBtnWait < 15000) {
                    await sleep(500);
                    await waitForSpinner(5000);
                    nextBtn = getNextButton();
                }
            }

            if (!nextBtn) {
                const nextLi = document.querySelector('li.pagination-next');
                if (nextLi && nextLi.classList.contains('disabled')) {
                    console.log('[Browser] Última página alcanzada o botón deshabilitado.');
                    break;
                }
                await sleep(2000);
                continue;
            }

            const oldPage = getActivePageNumber() || currentPage;
            const oldSig = getFirstRowSignature();
            let pageChanged = false;

            for (let attempt = 1; attempt <= 5; attempt++) {
                simulateClick(nextBtn);

                // Esperar spinner y cambio
                for (let i = 0; i < 8; i++) {
                    if (isSpinnerActive()) break;
                    await sleep(150);
                }
                await waitForSpinner();

                const curPage = getActivePageNumber();
                const curSig = getFirstRowSignature();

                if ((curPage && curPage !== oldPage) || (curSig && curSig !== oldSig && !curSig.includes('No hay datos'))) {
                    pageChanged = true;
                    break;
                }
                await sleep(1500 * attempt);
                nextBtn = getNextButton() || nextBtn;
            }

            if (!pageChanged) {
                console.warn(`[Browser] No se pudo avanzar desde página ${currentPage}. Pausando ciclo.`);
                break;
            }

            const newBatch = extractDOM();
            if (newBatch.length > 0) {
                await window.saveBatchToDisk(newBatch);
            }

            currentPage = getActivePageNumber() || (currentPage + 1);
            await randomDelay(1600, 2600);
        }

        console.log('[Browser] Extracción completada en navegador.');
    });

    console.log('[Servidor] Proceso de extracción finalizado.');
}

run().catch(err => {
    console.error('[Servidor] Error crítico:', err);
});
