const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

class WarcRecorder {
    constructor(options = {}) {
        this.outputDir = options.outputDir || process.env.WARC_OUTPUT_DIR || '/app/data/archives';
        this.enabled = options.enabled !== undefined ? options.enabled : (process.env.WARC_ENABLED !== 'false');
        this.compress = options.compress !== undefined ? options.compress : true;
        this.currentWarcFile = null;
        this.writeStream = null;
        this.requests = new Map(); // requestId -> request data

        if (this.enabled) {
            if (!fs.existsSync(this.outputDir)) {
                fs.mkdirSync(this.outputDir, { recursive: true });
            }
        }
    }

    generateUUID() {
        return `<urn:uuid:${crypto.randomUUID()}>`;
    }

    getISODate(date = new Date()) {
        return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
    }

    startNewSession(prefix = 'web_archive') {
        if (!this.enabled) return null;

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = this.compress ? '.warc.gz' : '.warc';
        const filename = `${prefix}_${timestamp}${ext}`;
        this.currentWarcFile = path.join(this.outputDir, filename);

        this.writeStream = fs.createWriteStream(this.currentWarcFile, { flags: 'a' });
        console.log(`[WARC] Iniciando captura de archivo: ${this.currentWarcFile}`);

        // Escribir registro warcinfo inicial
        this.writeWarcInfo();
        return this.currentWarcFile;
    }

    writeRecord(warcHeaders, httpHeaderString = '', payloadBuffer = Buffer.alloc(0)) {
        if (!this.writeStream) return;

        const headerBuffer = Buffer.from(httpHeaderString, 'utf8');
        const fullPayload = Buffer.concat([headerBuffer, payloadBuffer]);

        warcHeaders['Content-Length'] = fullPayload.length.toString();

        let headerBlock = 'WARC/1.1\r\n';
        for (const [k, v] of Object.entries(warcHeaders)) {
            headerBlock += `${k}: ${v}\r\n`;
        }
        headerBlock += '\r\n';

        const recordBuffer = Buffer.concat([
            Buffer.from(headerBlock, 'utf8'),
            fullPayload,
            Buffer.from('\r\n\r\n', 'utf8')
        ]);

        if (this.compress) {
            const gz = zlib.gzipSync(recordBuffer);
            this.writeStream.write(gz);
        } else {
            this.writeStream.write(recordBuffer);
        }
    }

    writeWarcInfo() {
        const payload = `software: AntiBot-WARC-Client/1.0\r\nformat: WARC File Format 1.1\r\nconformsTo: http://bibnum.bnf.fr/WARC/WARC_ISO_28500_version1_latestdraft.pdf\r\n`;
        const warcHeaders = {
            'WARC-Type': 'warcinfo',
            'WARC-Date': this.getISODate(),
            'WARC-Filename': path.basename(this.currentWarcFile),
            'WARC-Record-ID': this.generateUUID(),
            'Content-Type': 'application/warc-fields'
        };
        this.writeRecord(warcHeaders, '', Buffer.from(payload, 'utf8'));
    }

    async attachToPage(page) {
        if (!this.enabled) return;
        if (!this.currentWarcFile) {
            this.startNewSession('client_session');
        }

        const client = await page.target().createCDPSession();
        await client.send('Network.enable', {
            maxResourceBufferSize: 50 * 1024 * 1024,
            maxTotalBufferSize: 150 * 1024 * 1024
        });

        // 1. Capturar petición saliente
        client.on('Network.requestWillBeSent', (params) => {
            const { requestId, request, timestamp, wallTime } = params;
            const reqDate = wallTime ? new Date(wallTime * 1000) : new Date();

            this.requests.set(requestId, {
                url: request.url,
                method: request.method,
                headers: request.headers,
                postData: request.postData,
                date: reqDate,
                requestId
            });

            // Construir bloque HTTP request
            try {
                let httpReq = `${request.method} ${new URL(request.url).pathname}${new URL(request.url).search} HTTP/1.1\r\n`;
                for (const [k, v] of Object.entries(request.headers)) {
                    httpReq += `${k}: ${v}\r\n`;
                }
                httpReq += '\r\n';

                const postBuf = request.postData ? Buffer.from(request.postData, 'utf8') : Buffer.alloc(0);

                const warcHeaders = {
                    'WARC-Type': 'request',
                    'WARC-Date': this.getISODate(reqDate),
                    'WARC-Target-URI': request.url,
                    'WARC-Record-ID': this.generateUUID(),
                    'Content-Type': 'application/http; msgtype=request'
                };

                this.writeRecord(warcHeaders, httpReq, postBuf);
            } catch (e) {
                // URLs especiales como data: o chrome-extension:
            }
        });

        // 2. Capturar respuesta entrante
        client.on('Network.responseReceived', (params) => {
            const { requestId, response, wallTime } = params;
            const reqInfo = this.requests.get(requestId);
            if (!reqInfo) return;

            reqInfo.response = response;
            reqInfo.responseDate = wallTime ? new Date(wallTime * 1000) : new Date();
        });

        // 3. Obtener cuerpo y guardar registro WARC response
        client.on('Network.loadingFinished', async (params) => {
            const { requestId } = params;
            const reqInfo = this.requests.get(requestId);
            if (!reqInfo || !reqInfo.response) return;

            const response = reqInfo.response;
            let bodyBuffer = Buffer.alloc(0);

            try {
                const bodyRes = await client.send('Network.getResponseBody', { requestId });
                if (bodyRes.body) {
                    bodyBuffer = bodyRes.base64Encoded ? Buffer.from(bodyRes.body, 'base64') : Buffer.from(bodyRes.body, 'utf8');
                }
            } catch (e) {
                // Recursos cacheados, redirecciones o sin body disponible
            }

            try {
                let httpRes = `HTTP/1.1 ${response.status} ${response.statusText || 'OK'}\r\n`;
                if (response.headers) {
                    for (const [k, v] of Object.entries(response.headers)) {
                        httpRes += `${k}: ${v}\r\n`;
                    }
                }
                httpRes += '\r\n';

                const warcHeaders = {
                    'WARC-Type': 'response',
                    'WARC-Date': this.getISODate(reqInfo.responseDate || new Date()),
                    'WARC-Target-URI': reqInfo.url,
                    'WARC-Record-ID': this.generateUUID(),
                    'Content-Type': 'application/http; msgtype=response'
                };

                this.writeRecord(warcHeaders, httpRes, bodyBuffer);
            } catch (e) {}

            this.requests.delete(requestId);
        });

        console.log('[WARC] Interceptor CDP activo para generación automática de archivo web.');
    }

    close() {
        if (this.writeStream) {
            this.writeStream.end();
            console.log(`[WARC] Sesión finalizada: ${this.currentWarcFile}`);
            return this.currentWarcFile;
        }
        return null;
    }
}

module.exports = new WarcRecorder();
