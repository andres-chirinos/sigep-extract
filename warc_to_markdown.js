const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const MarkdownIt = require('markdown-it');
const TurndownService = require('turndown');
const cheerio = require('cheerio');
const s3Sync = require('./s3_sync');

const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: true
});

const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-'
});

// Reglas personalizadas para Turndown
turndown.remove(['script', 'style', 'noscript', 'canvas', 'svg']);

class WarcToMarkdownProcessor {
    constructor(options = {}) {
        this.warcDir = options.warcDir || process.env.WARC_OUTPUT_DIR || '/app/data/archives';
        this.outputDir = options.outputDir || process.env.MARKDOWN_OUTPUT_DIR || '/app/data/markdown';
        this.syncS3 = options.syncS3 !== undefined ? options.syncS3 : (s3Sync.enabled);

        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    sanitizeFilename(name) {
        return name.replace(/[^a-zA-Z0-9_\-\.]/g, '_').substring(0, 100);
    }

    extractHtmlRecordsFromBuffer(buffer) {
        const records = [];
        let offset = 0;

        while (offset < buffer.length) {
            // Buscar inicio de WARC/1.
            const warcIdx = buffer.indexOf('WARC/1.', offset);
            if (warcIdx === -1) break;

            const headerEnd = buffer.indexOf('\r\n\r\n', warcIdx);
            if (headerEnd === -1) break;

            const headerStr = buffer.toString('utf8', warcIdx, headerEnd);
            const headers = {};
            headerStr.split('\r\n').forEach(line => {
                const colon = line.indexOf(':');
                if (colon !== -1) {
                    headers[line.substring(0, colon).trim().toLowerCase()] = line.substring(colon + 1).trim();
                }
            });

            const contentLength = parseInt(headers['content-length'] || '0', 10);
            const payloadStart = headerEnd + 4;
            const payloadEnd = payloadStart + contentLength;

            if (payloadEnd <= buffer.length) {
                const payloadBuf = buffer.slice(payloadStart, payloadEnd);
                if (headers['warc-type'] === 'response') {
                    // Extraer encabezados HTTP del payload
                    const httpHeaderEnd = payloadBuf.indexOf('\r\n\r\n');
                    if (httpHeaderEnd !== -1) {
                        const httpHeaderStr = payloadBuf.toString('utf8', 0, httpHeaderEnd);
                        const bodyBuf = payloadBuf.slice(httpHeaderEnd + 4);

                        const isHtml = httpHeaderStr.toLowerCase().includes('text/html') ||
                                       httpHeaderStr.toLowerCase().includes('application/xhtml+xml');

                        if (isHtml) {
                            records.push({
                                uri: headers['warc-target-uri'],
                                date: headers['warc-date'],
                                recordId: headers['warc-record-id'],
                                httpHeaders: httpHeaderStr,
                                html: bodyBuf.toString('utf8')
                            });
                        }
                    }
                }
            }
            offset = payloadEnd + 2; // Saltear trailing CRLF
        }

        return records;
    }

    readWarcFile(filePath) {
        let buf = fs.readFileSync(filePath);
        if (filePath.endsWith('.gz')) {
            try {
                // WARC.gz a menudo es multi-stream gzip (un gzip por registro)
                // Intentar descompresión estándar o por bloques
                try {
                    buf = zlib.gunzipSync(buf);
                } catch (gzErr) {
                    // Si falla multi-member, dividir por encabezados gzip magic bytes (1f 8b)
                    const chunks = [];
                    let pos = 0;
                    while (pos < buf.length) {
                        const nextGz = buf.indexOf(Buffer.from([0x1f, 0x8b, 0x08]), pos + 2);
                        const end = nextGz === -1 ? buf.length : nextGz;
                        try {
                            const decompressed = zlib.gunzipSync(buf.slice(pos, end));
                            chunks.push(decompressed);
                        } catch (e) {}
                        if (nextGz === -1) break;
                        pos = nextGz;
                    }
                    buf = Buffer.concat(chunks);
                }
            } catch (e) {
                console.error(`[WARC2MD] Error descomprimiendo ${filePath}:`, e.message);
                return [];
            }
        }

        return this.extractHtmlRecordsFromBuffer(buf);
    }

    convertHtmlToMarkdown(html, url) {
        const $ = cheerio.load(html);

        // Extraer metadatos
        const title = $('title').text().trim() ||
                      $('h1').first().text().trim() ||
                      $('meta[property="og:title"]').attr('content') ||
                      'Página sin título';

        const description = $('meta[name="description"]').attr('content') ||
                            $('meta[property="og:description"]').attr('content') ||
                            '';

        // Remover elementos ruidosos
        $('script, style, noscript, nav, footer, header, svg, iframe, .advertisement, #cookie-banner').remove();

        // Convertir enlaces relativos a absolutos
        try {
            const base = new URL(url);
            $('a[href]').each((_, el) => {
                const href = $(el).attr('href');
                if (href && !href.startsWith('http') && !href.startsWith('mailto:') && !href.startsWith('javascript:')) {
                    try {
                        $(el).attr('href', new URL(href, base).href);
                    } catch (e) {}
                }
            });
        } catch (e) {}

        const cleanHtml = $('body').html() || html;
        const markdownBody = turndown.turndown(cleanHtml);

        return {
            title,
            description,
            markdown: markdownBody
        };
    }

    async processWarcFile(filePath) {
        console.log(`[WARC2MD] Procesando archivo: ${filePath}...`);
        const records = this.readWarcFile(filePath);
        console.log(`[WARC2MD] ${records.length} páginas HTML encontradas en ${path.basename(filePath)}.`);

        const generatedFiles = [];

        for (let i = 0; i < records.length; i++) {
            const rec = records[i];
            const { title, description, markdown } = this.convertHtmlToMarkdown(rec.html, rec.uri);

            let host = 'sitio';
            try { host = new URL(rec.uri).hostname; } catch (e) {}

            const safeTitle = this.sanitizeFilename(title || 'doc');
            const fileName = `${host}_${safeTitle}_${Date.now()}_${i + 1}.md`;
            const outPath = path.join(this.outputDir, fileName);

            // Generar Markdown con Frontmatter estándar
            const frontmatter = [
                '---',
                `url: "${rec.uri}"`,
                `title: "${title.replace(/"/g, '\\"')}"`,
                `description: "${description.replace(/"/g, '\\"')}"`,
                `archived_at: "${rec.date || new Date().toISOString()}"`,
                `warc_record_id: "${rec.recordId || ''}"`,
                `source_warc: "${path.basename(filePath)}"`,
                'generator: "AntiBot-WARC-Framework"',
                '---',
                '',
                `# ${title}`,
                '',
                markdown
            ].join('\n');

            fs.writeFileSync(outPath, frontmatter, 'utf8');
            generatedFiles.push(outPath);
        }

        console.log(`[WARC2MD] Generados ${generatedFiles.length} documentos Markdown.`);

        // Sincronizar Markdown a S3 si está habilitado
        if (this.syncS3 && s3Sync.enabled && generatedFiles.length > 0) {
            console.log(`[WARC2MD] Sincronizando ${generatedFiles.length} archivos Markdown a S3...`);
            for (const mdFile of generatedFiles) {
                const s3Key = s3Sync.getKey(`markdown/${path.basename(mdFile)}`);
                try {
                    const stream = fs.createReadStream(mdFile);
                    await s3Sync.client.send(new (require('@aws-sdk/client-s3').PutObjectCommand)({
                        Bucket: s3Sync.bucket,
                        Key: s3Key,
                        Body: stream,
                        ContentType: 'text/markdown; charset=utf-8'
                    }));
                } catch (e) {
                    console.error('[WARC2MD] Error subiendo MD a S3:', e.message);
                }
            }
            console.log(`[WARC2MD] Markdown sincronizado a s3://${s3Sync.bucket}/${s3Sync.getKey('markdown/')}`);
        }

        return generatedFiles;
    }

    async processAll() {
        if (!fs.existsSync(this.warcDir)) {
            console.warn(`[WARC2MD] Directorio WARC no existe: ${this.warcDir}`);
            return [];
        }

        const files = fs.readdirSync(this.warcDir)
            .filter(f => f.endsWith('.warc') || f.endsWith('.warc.gz'))
            .map(f => path.join(this.warcDir, f));

        console.log(`[WARC2MD] Encontrados ${files.length} archivos WARC para procesar.`);
        const allMd = [];
        for (const f of files) {
            const res = await this.processWarcFile(f);
            allMd.push(...res);
        }
        return allMd;
    }
}

// Ejecución vía CLI si se llama directamente
if (require.main === module) {
    const target = process.argv[2];
    const processor = new WarcToMarkdownProcessor();

    (async () => {
        if (target && fs.existsSync(target)) {
            const stat = fs.statSync(target);
            if (stat.isDirectory()) {
                processor.warcDir = target;
                await processor.processAll();
            } else {
                await processor.processWarcFile(target);
            }
        } else {
            await processor.processAll();
        }
    })().catch(err => {
        console.error('[WARC2MD] Error fatal:', err);
        process.exit(1);
    });
}

module.exports = WarcToMarkdownProcessor;
