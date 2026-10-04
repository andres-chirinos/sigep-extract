(async function() {
    const STORAGE_KEY = 'sigep_scraping_data';
    const PAGE_DELAY = 2000; // Tiempo de espera ajustable para asegurar que cargue la tabla (en milisegundos)

    // Función auxiliar para esperar elementos en el DOM
    const waitForElement = (selector, timeout = 10000) => {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const interval = setInterval(() => {
                const el = document.querySelector(selector);
                if (el) {
                    clearInterval(interval);
                    resolve(el);
                } else if (Date.now() - start > timeout) {
                    clearInterval(interval);
                    reject(new Error(`Timeout esperando por el selector: ${selector}`));
                }
            }, 200);
        });
    };

    // Función para pausar la ejecución
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    console.log("🚀 Iniciando script de extracción SIGEP...");

    // 1. Intentar seleccionar "Todos" en el desplegable de Estado si no está seleccionado
    try {
        const dropdownToggle = document.querySelector('.btn-group[dropdown] button, button.dropdown-toggle');
        if (dropdownToggle && !dropdownToggle.innerText.includes('Todos')) {
            dropdownToggle.click();
            await sleep(500);
            const items = Array.from(document.querySelectorAll('.dropdown-menu .dropdown-item'));
            const todosItem = items.find(el => el.innerText.trim() === 'Todos');
            if (todosItem) {
                todosItem.click();
                console.log("✅ Filtro 'Estado: Todos' seleccionado correctamente.");
                await sleep(PAGE_DELAY);
            }
        }
    } catch (e) {
        console.warn("⚠️ No se pudo automatizar la selección del desplegable de estado (continúa con el estado actual):", e);
    }

    // Recuperar datos previos de localStorage si existen
    let extractedData = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    let pageCount = parseInt(localStorage.getItem(STORAGE_KEY + '_page') || '1', 10);
    console.log(`📂 Datos recuperados de sesión anterior: ${extractedData.length} registros. Página actual aprox: ${pageCount}`);

    let scrapingActive = true;

    while (scrapingActive) {
        try {
            console.log(`⏳ Esperando a que cargue la tabla en la página...`);
            await waitForElement('#tablaValues tbody', 15000);
            await sleep(PAGE_DELAY); // Estabilizar renderizado de filas

            const rows = document.querySelectorAll('#tablaValues tbody tr');
            console.log(`📊 Encontradas ${rows.length} filas en la página actual.`);

            if (rows.length === 0) {
                console.warn("⚠️ No se encontraron filas. Puede que la tabla esté vacía o cargando.");
            }

            let newRecordsOnPage = 0;
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
                    extractedData.push(record);
                    newRecordsOnPage++;
                }
            });

            // Guardar estado actual en localStorage de forma persistente
            localStorage.setItem(STORAGE_KEY, JSON.stringify(extractedData));
            localStorage.setItem(STORAGE_KEY + '_page', pageCount);
            console.log(`💾 Progreso guardado. Total acumulado: ${extractedData.length} registros.`);

            // Buscar el botón de "Siguiente"
            // Comprobamos si el elemento li padre o el botón tienen clase disabled o similar
            const nextLi = document.querySelector('li.pagination-next');
            const nextButton = document.querySelector('li.pagination-next a.page-link, a.page-link'); // Ajustar según selector exacto
            
            // Buscar específicamente el botón que contenga "Siguiente"
            const allLinks = Array.from(document.querySelectorAll('a.page-link, ul.pagination li a'));
            const nextLink = allLinks.find(a => a.innerText.trim().toLowerCase().includes('siguiente') || a.innerText.trim() === '»');

            if (!nextLink) {
                console.log("🏁 No se encontró el botón 'Siguiente'. Fin del proceso.");
                scrapingActive = false;
                break;
            }

            const parentLi = nextLink.closest('li');
            if (parentLi && (parentLi.classList.contains('disabled') || parentLi.classList.contains('active'))) {
                console.log("🏁 El botón de siguiente está deshabilitado o inactivo. Fin de la paginación.");
                scrapingActive = false;
                break;
            }

            // Hacer clic en siguiente
            console.pas ? console.pas("➡️ Avanzando a la siguiente página...") : console.log("➡️ Avanzando a la siguiente página...");
            nextLink.click();
            pageCount++;
            await sleep(PAGE_DELAY);

        } catch (error) {
            console.error("❌ Ocurrió un error durante la extracción en esta iteración:", error);
            scrapingActive = false;
        }
    }

    console.log("🎉 ¡Extracción completada con éxito!");
    console.log(`📦 Total de registros extraídos: ${extractedData.length}`);

    // Descargar automáticamente el archivo JSON al terminar
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(extractedData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `sigep_personal_${Date.now()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();

    // Limpiar localStorage opcionalmente al finalizar por completo:
    // localStorage.removeItem(STORAGE_KEY);
    // localStorage.removeItem(STORAGE_KEY + '_page');

})();