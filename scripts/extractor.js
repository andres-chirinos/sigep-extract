(async function() {
    const STORAGE_KEY = 'sigep_scraping_data';
    const PAGE_DELAY = 2500; 

    // Hash único para evitar duplicados
    const generateUniqueId = (record) => {
        return `${record.entidad}-${record.nombre}-${record.cargo}-${record.fechaInicio}`.replace(/\s+/g, '').toLowerCase();
    };

    // Función para esperar elementos en el DOM
    const waitForElement = (selector, timeout = 15000) => {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const interval = setInterval(() => {
                const el = document.querySelector(selector);
                if (el) {
                    clearInterval(interval);
                    resolve(el);
                } else if (Date.now() - start > timeout) {
                    clearInterval(interval);
                    reject(new Error(`Timeout esperando por: ${selector}`));
                }
            }, 500);
        });
    };

    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Exponemos la función globalmente para que puedas escribir descargarAvanceJSONL() en la consola
    window.descargarAvanceJSONL = function() {
        const dataArray = Array.from(window.sigepDataMap ? window.sigepDataMap.values() : []);
        if (dataArray.length === 0) {
            console.warn("⚠️ No hay datos para descargar todavía.");
            return;
        }

        // Convertir a formato JSON Lines (un objeto JSON por línea)
        const jsonlContent = dataArray.map(obj => JSON.stringify(obj)).join('\n');
        
        // Usar Blob para soportar archivos muy grandes
        const blob = new Blob([jsonlContent], { type: 'application/jsonlines+json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `sigep_avance_${Date.now()}.jsonl`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log(`✅ Descargado archivo JSONL con ${dataArray.length} registros hasta el momento.`);
    };

    console.log("🚀 Iniciando script de extracción SIGEP...");
    console.log("💡 TIP: Puedes escribir 'descargarAvanceJSONL()' en esta consola en cualquier momento para descargar lo que se ha extraído hasta ahora.");

    try {
        const dropdownToggle = document.querySelector('.btn-group[dropdown] button');
        if (dropdownToggle && !dropdownToggle.innerText.includes('Todos')) {
            dropdownToggle.click();
            await sleep(500);
            const todosItem = Array.from(document.querySelectorAll('.dropdown-menu .dropdown-item'))
                                   .find(el => el.innerText.trim() === 'Todos');
            if (todosItem) {
                todosItem.click();
                console.log("✅ Filtro 'Estado: Todos' aplicado.");
                await sleep(PAGE_DELAY);
            }
        }
    } catch (e) {
        console.warn("⚠️ No se pudo automatizar el filtro de estado:", e);
    }

    let rawStoredData = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    // Guardamos el Map globalmente para que descargarAvanceJSONL pueda acceder a él
    window.sigepDataMap = new Map();
    
    rawStoredData.forEach(item => {
        const id = generateUniqueId(item);
        window.sigepDataMap.set(id, item);
    });

    console.log(`📂 Iniciando con ${window.sigepDataMap.size} registros guardados previamente.`);

    let scrapingActive = true;
    let pageStagnationCounter = 0;

    while (scrapingActive) {
        try {
            console.log(`⏳ Esperando carga de la tabla...`);
            await waitForElement('#tablaValues tbody tr', 15000);
            await sleep(PAGE_DELAY);

            const rows = document.querySelectorAll('#tablaValues tbody tr');
            let newRecordsAddedThisPage = 0;

            rows.forEach((row) => {
                const cols = row.querySelectorAll('td');
                if (cols.length >= 10) {
                    const record = {
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

                    const recordId = generateUniqueId(record);
                    
                    if (!window.sigepDataMap.has(recordId)) {
                        window.sigepDataMap.set(recordId, record);
                        newRecordsAddedThisPage++;
                    }
                }
            });

            console.log(`📊 Leídas ${rows.length} filas. Nuevos registros únicos añadidos: ${newRecordsAddedThisPage}`);

            if (newRecordsAddedThisPage === 0) {
                pageStagnationCounter++;
                if(pageStagnationCounter > 2) {
                    console.log("⚠️ 3 páginas consecutivas sin datos nuevos. Abortando bucle.");
                    scrapingActive = false;
                    break;
                }
            } else {
                pageStagnationCounter = 0;
            }

            const updatedDataArray = Array.from(window.sigepDataMap.values());
            localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedDataArray));

            const allLinks = Array.from(document.querySelectorAll('a.page-link, .pagination-next a, .page-item a'));
            const nextLink = allLinks.find(a => a.innerText.trim().toLowerCase().includes('siguiente') || a.innerText.trim() === '»');

            if (!nextLink) {
                console.log("🏁 No se encontró enlace 'Siguiente'. Fin del recorrido.");
                scrapingActive = false;
                break;
            }

            const parentLi = nextLink.closest('li');
            if (parentLi && (parentLi.classList.contains('disabled') || parentLi.classList.contains('active'))) {
                console.log("🏁 El botón 'Siguiente' está deshabilitado. Última página alcanzada.");
                scrapingActive = false;
                break;
            }

            console.log("➡️ Haciendo clic en siguiente...");
            nextLink.click();
            await sleep(PAGE_DELAY);

        } catch (error) {
            console.error("❌ Error en el bucle principal:", error);
            await sleep(5000);
        }
    }

    console.log("🎉 Proceso terminado automáticamente. Generando descarga final...");
    window.descargarAvanceJSONL(); // Reutilizamos la función para la descarga final

})();