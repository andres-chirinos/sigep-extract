const fs = require('fs');
const readline = require('readline');
const path = require('path');

/**
 * Generador de números pseudoaleatorios con semilla (Linear Congruential Generator)
 * Permite reproducibilidad estadística si se proporciona una semilla.
 */
function createRng(seed) {
    if (seed === undefined || seed === null) {
        return Math.random;
    }
    let s = Number(seed) % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => {
        s = (s * 16807) % 2147483647;
        return (s - 1) / 2147483646;
    };
}

/**
 * Muestreo Aleatorio Simple (MAS) de páginas dentro de un rango con salto.
 * 
 * @param {number} startPage - Página de inicio (>= 1)
 * @param {number} endPage - Página de fin (>= startPage)
 * @param {number} step - Salto entre páginas (>= 1, defecto: 1)
 * @param {number} sampleSize - Número de páginas a muestrear (0 = todas las páginas del rango)
 * @param {number|null} seed - Semilla opcional para reproducibilidad
 * @returns {number[]} Lista ordenada de páginas seleccionadas
 */
function samplePages(startPage = 1, endPage = 1, step = 1, sampleSize = 0, seed = null) {
    const start = Math.max(1, parseInt(startPage, 10) || 1);
    const end = Math.max(start, parseInt(endPage, 10) || start);
    const s = Math.max(1, parseInt(step, 10) || 1);
    const k = Math.max(0, parseInt(sampleSize, 10) || 0);

    // 1. Construir universo de páginas válidas
    const universe = [];
    for (let p = start; p <= end; p += s) {
        universe.push(p);
    }

    // Si sampleSize es 0 o mayor/igual al universo, retornar todas las páginas en el rango
    if (k === 0 || k >= universe.length) {
        return universe;
    }

    // 2. Muestreo aleatorio simple sin reemplazo (Algoritmo Fisher-Yates parcial)
    const rng = createRng(seed);
    const pool = [...universe];
    const sampled = [];

    for (let i = 0; i < k; i++) {
        const j = i + Math.floor(rng() * (pool.length - i));
        const temp = pool[i];
        pool[i] = pool[j];
        pool[j] = temp;
        sampled.push(pool[i]);
    }

    // Ordenar ascendentemente para navegación predecible en el portal
    return sampled.sort((a, b) => a - b);
}

/**
 * Muestreo Aleatorio Simple de registros desde un archivo JSONL (Algoritmo Reservoir Sampling - Vitter)
 * Eficiente en memoria: realiza un único paso sobre el archivo usando memoria O(sampleSize).
 * 
 * @param {string} inputFilePath - Ruta al archivo .jsonl de origen
 * @param {string} outputFilePath - Ruta al archivo donde se guardará la muestra
 * @param {number} sampleSize - Cantidad de registros a seleccionar
 * @param {number|null} seed - Semilla opcional para reproducibilidad
 * @returns {Promise<{populationSize: number, sampleSize: number, samplingRatio: string, sampleFile: string}>}
 */
async function sampleRecordsFromFile(inputFilePath, outputFilePath, sampleSize, seed = null) {
    if (!fs.existsSync(inputFilePath)) {
        throw new Error(`Archivo no encontrado: ${inputFilePath}`);
    }

    const k = parseInt(sampleSize, 10);
    if (isNaN(k) || k <= 0) {
        throw new Error(`Tamaño de muestra inválido: ${sampleSize}. Debe ser mayor a 0.`);
    }

    const rng = createRng(seed);
    const reservoir = [];
    let count = 0;

    const fileStream = fs.createReadStream(inputFilePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        if (!line.trim()) continue;
        count++;

        if (reservoir.length < k) {
            reservoir.push(line);
        } else {
            // Reemplazo probabilístico uniforme
            const j = Math.floor(rng() * count);
            if (j < k) {
                reservoir[j] = line;
            }
        }
    }

    const actualSampleCount = reservoir.length;
    const samplingRatio = count > 0 ? ((actualSampleCount / count) * 100).toFixed(4) + '%' : '0%';

    // Asegurar directorio destino
    const outDir = path.dirname(outputFilePath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    // Escribir archivo de muestra
    fs.writeFileSync(outputFilePath, reservoir.join('\n') + '\n', 'utf8');

    return {
        populationSize: count,
        sampleSize: actualSampleCount,
        samplingRatio,
        sampleFile: outputFilePath
    };
}

module.exports = {
    samplePages,
    sampleRecordsFromFile
};
