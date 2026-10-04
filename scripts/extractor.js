(async function() {
    const STORAGE_KEY = 'sigep_scraping_data';
    const PAGE_DELAY = 2500; // Aumentado ligeramente para dar margen a la carga de datos

    // Función auxiliar para generar un "hash" único simple basado en el contenido del registro
    const generateUniqueId = (record) => {
        // Concatenamos campos clave para formar un string único que identifique la fila
        return `${record.entidad}-${record.nombre}-${record.cargo}-${record.fechaInicio}`.replace(/\s+/g, '').toLowerCase();
    };

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

    console.log("🚀 Iniciando script de extracción SIGEP (Versión Anti-Duplicados)...");

    // 1. Configurar filtro de Estado
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

    // 2. Cargar datos previos. 
    // Usaremos un Map para evitar duplicados fácilmente (Clave: Hash Único, Valor: Objeto del registro)
    let rawStoredData = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    let dataMap = new Map();
    
    // Rellenar el Map con los datos previos para filtrar
    rawStoredData.forEach(item => {
        const id = generateUniqueId(item);
        dataMap.set(id, item);
    });

    console.log(`📂 Iniciando con ${dataMap.size} registros únicos guardados de sesiones anteriores.`);

    let scrapingActive = true;
    let pageStagnationCounter = 0; // Para detectar si nos quedamos atrapados en la misma página

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
                    
                    // Comprobación clave: ¿Este registro ya existe en nuestro almacenamiento?
                    if (!dataMap.has(recordId)) {
                        dataMap.set(recordId, record);
                        newRecordsAddedThisPage++;
                    }
                }
            });

            console.log(`📊 Leídas ${rows.length} filas. Nuevos registros únicos añadidos: ${newRecordsAddedThisPage}`);

            // Mecanismo de seguridad: Si no añadimos ningún registro nuevo y estamos iterando, 
            // podríamos estar en la última página o la tabla no refrescó correctamente.
            if (newRecordsAddedThisPage === 0) {
                pageStagnationCounter++;
                if(pageStagnationCounter > 2) {
                    console.log("⚠️ 3 páginas consecutivas sin datos nuevos. Abortando para evitar bucle infinito.");
                    scrapingActive = false;
                    break;
                }
            } else {
                pageStagnationCounter = 0; // Reiniciar contador si encontramos datos frescos
            }

            // Convertir el Map de vuelta a un Array y guardar en LocalStorage
            const updatedDataArray = Array.from(dataMap.values());
            localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedDataArray));
            console.log(`💾 Guardado en LocalStorage. Total general: ${updatedDataArray.length} registros.`);

            // 3. Lógica de Paginación Avanzada
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
            await sleep(PAGE_DELAY); // Espera crucial para que Angular destruya e inicialice la nueva tabla

        } catch (error) {
            console.error("❌ Error en el bucle principal:", error);
            console.log("Intentando recuperar la tabla en 5 segundos...");
            await sleep(5000); // Intento de recuperación ante caídas de red breves
        }
    }

    // 4. Descarga Final
    const finalData = Array.from(dataMap.values());
    console.log(`🎉 Proceso terminado. Generando archivo de descarga con ${finalData.length} registros.`);

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(finalData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `sigep_personal_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();

})();