const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

class S3SyncManager {
    constructor() {
        this.bucket = process.env.S3_BUCKET;
        this.region = process.env.S3_REGION || 'auto';
        this.endpoint = process.env.S3_ENDPOINT || undefined;
        this.prefix = process.env.S3_KEY_PREFIX || 'sigep/';
        this.syncInterval = parseInt(process.env.S3_SYNC_INTERVAL || '500', 10);
        this.forcePathStyle = process.env.S3_FORCE_PATH_STYLE === 'true';

        this.enabled = !!(this.bucket && (process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID));

        if (this.enabled) {
            const credentials = {
                accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
                secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY
            };

            const clientConfig = {
                region: this.region,
                credentials
            };

            if (this.endpoint) {
                clientConfig.endpoint = this.endpoint;
            }

            if (this.forcePathStyle) {
                clientConfig.forcePathStyle = true;
            }

            this.client = new S3Client(clientConfig);
            console.log(`[S3] Activado -> Bucket: ${this.bucket}, Endpoint: ${this.endpoint || 'AWS S3'}, Prefijo: ${this.prefix}`);
        } else {
            console.log('[S3] No configurado o deshabilitado (S3_BUCKET / S3_ACCESS_KEY_ID no definidos).');
        }
    }

    getKey(filename) {
        const cleanPrefix = this.prefix.endsWith('/') ? this.prefix : `${this.prefix}/`;
        return `${cleanPrefix}${filename}`;
    }

    async pullInitialFile(localFilePath) {
        if (!this.enabled) return false;

        const s3Key = this.getKey(path.basename(localFilePath));
        console.log(`[S3] Verificando respaldo previo en s3://${this.bucket}/${s3Key}...`);

        try {
            // Comprobar existencia en S3
            await this.client.send(new HeadObjectCommand({
                Bucket: this.bucket,
                Key: s3Key
            }));

            // Si existe localmente y es más pesado o igual, verificar
            let localSize = 0;
            if (fs.existsSync(localFilePath)) {
                localSize = fs.statSync(localFilePath).size;
            }

            const getCmd = new GetObjectCommand({
                Bucket: this.bucket,
                Key: s3Key
            });
            const response = await this.client.send(getCmd);

            if (response.ContentLength && response.ContentLength < localSize) {
                console.log(`[S3] Archivo local (${localSize} bytes) es más reciente que S3 (${response.ContentLength} bytes). Conservando local.`);
                return true;
            }

            const writeStream = fs.createWriteStream(localFilePath);
            await new Promise((resolve, reject) => {
                response.Body.pipe(writeStream);
                response.Body.on('error', reject);
                writeStream.on('finish', resolve);
                writeStream.on('error', reject);
            });

            const newSize = fs.statSync(localFilePath).size;
            console.log(`[S3] Descarga exitosa desde S3 -> ${localFilePath} (${newSize} bytes).`);
            return true;
        } catch (err) {
            if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
                console.log('[S3] No existe archivo previo en S3. Se iniciará extracción desde cero.');
                return false;
            }
            console.warn('[S3] Advertencia consultando S3 en inicio:', err.message);
            return false;
        }
    }

    async uploadFile(localFilePath) {
        if (!this.enabled) return false;
        if (!fs.existsSync(localFilePath)) return false;

        const fileName = path.basename(localFilePath);
        const s3Key = this.getKey(fileName);

        try {
            const fileStream = fs.createReadStream(localFilePath);
            const fileSize = fs.statSync(localFilePath).size;

            await this.client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: s3Key,
                Body: fileStream,
                ContentType: 'application/jsonlines+json'
            }));

            console.log(`[S3] Archivo sincronizado: s3://${this.bucket}/${s3Key} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
            return true;
        } catch (err) {
            console.error('[S3] Error subiendo archivo a S3:', err.message);
            return false;
        }
    }

    async uploadStatus(statusData) {
        if (!this.enabled) return false;

        const s3Key = this.getKey('status.json');
        try {
            const manifest = {
                updatedAt: new Date().toISOString(),
                ...statusData
            };

            await this.client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: s3Key,
                Body: JSON.stringify(manifest, null, 2),
                ContentType: 'application/json'
            }));

            return true;
        } catch (err) {
            console.warn('[S3] No se pudo actualizar status.json:', err.message);
            return false;
        }
    }
}

module.exports = new S3SyncManager();
