'use strict';

// Files kept in an S3-compatible bucket (Garage, MinIO, RustFS, SeaweedFS,
// AWS) under the same keys uploads/ uses on disk. Haven still serves them
// itself (serve.js); the bucket is never exposed to browsers.
//
// With localFallback on, a key the bucket does not have is looked for in
// uploads/ on this machine, so a server can move its files over while it
// stays up (scripts/migrate-uploads-to-s3.js). Deleting then removes the
// local copy too, or the fallback would bring the file back.

const fs = require('fs');
const {
  S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, CopyObjectCommand,
  ListObjectsV2Command, HeadBucketCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { DELETED_PREFIX } = require('./paths');

const notFound = (err) => err && (err.name === 'NotFound' || err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404);

class S3Storage {
  constructor({ endpoint, bucket, region = 'us-east-1', accessKeyId, secretAccessKey, prefix = '', forcePathStyle = true, local = null }) {
    this.kind = 's3';
    this.endpoint = endpoint;
    this.bucket = bucket;
    this.prefix = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;
    this.local = local;   // a LocalStorage to fall back on, or null
    this.client = new S3Client({
      endpoint, region, forcePathStyle,
      credentials: { accessKeyId, secretAccessKey },
      // The SDK checks a CRC32 on every object by default, and stores other
      // than AWS answer with one it rejects for files sent in parts (Garage
      // does). Only where the API needs one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  describe() { return `S3 bucket "${this.bucket}" at ${this.endpoint}`; }

  _key(rel) { return this.prefix + rel; }

  // CopySource is "bucket/key" with the key URL-encoded, slashes kept.
  _source(rel) { return `${this.bucket}/${this._key(rel).split('/').map(encodeURIComponent).join('/')}`; }

  async put(rel, localPath, { contentType } = {}) {
    const { size } = fs.statSync(localPath);
    const body = fs.createReadStream(localPath);
    try {
      await new Upload({
        client: this.client,
        params: { Bucket: this.bucket, Key: this._key(rel), Body: body, ContentType: contentType || undefined },
      }).done();
    } finally {
      body.destroy();
    }
    fs.unlinkSync(localPath);
    return { size };
  }

  /** What the bucket itself holds under ``rel``, never the local fallback. */
  async headObject(rel) {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this._key(rel) }));
      return { size: r.ContentLength, lastModified: r.LastModified, etag: r.ETag };
    } catch (err) {
      if (!notFound(err)) throw err;
      return null;
    }
  }

  async head(rel) {
    const there = await this.headObject(rel);
    if (there || !this.local) return there;
    return this.local.head(rel);
  }

  async getStream(rel, { range } = {}) {
    try {
      const r = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: this._key(rel),
        Range: range ? `bytes=${range.start}-${range.end}` : undefined,
      }));
      const total = r.ContentRange ? Number(r.ContentRange.split('/')[1]) : r.ContentLength;
      return { stream: r.Body, size: total, lastModified: r.LastModified, etag: r.ETag };
    } catch (err) {
      if (!notFound(err)) throw err;
      return this.local ? this.local.getStream(rel, { range }) : null;
    }
  }

  async readBuffer(rel) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this._key(rel) }));
      return Buffer.from(await r.Body.transformToByteArray());
    } catch (err) {
      if (!notFound(err)) throw err;
      return this.local ? this.local.readBuffer(rel) : null;
    }
  }

  async remove(rel) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this._key(rel) }));
    if (this.local) await this.local.remove(rel);
  }

  async _exists(rel) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this._key(rel) }));
      return true;
    } catch (err) {
      if (notFound(err)) return false;
      throw err;
    }
  }

  // Copy then delete: the copy gets a fresh LastModified, which is when the
  // retention window starts. A crash between the two leaves both, and the
  // next delete or reconcile settles it.
  async _move(fromRel, toRel) {
    await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: this._key(toRel), CopySource: this._source(fromRel) }));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this._key(fromRel) }));
  }

  async softDelete(rel) {
    if (rel.startsWith(DELETED_PREFIX)) return false;
    if (await this._exists(rel)) {
      await this._move(rel, DELETED_PREFIX + rel);
      if (this.local) await this.local.remove(rel);
      return true;
    }
    return this.local ? this.local.softDelete(rel) : false;
  }

  async restore(rel) {
    if (await this._exists(DELETED_PREFIX + rel)) {
      await this._move(DELETED_PREFIX + rel, rel);
      return true;
    }
    return this.local ? this.local.restore(rel) : false;
  }

  async *list(prefix = '') {
    let token;
    do {
      const r = await this.client.send(new ListObjectsV2Command({
        Bucket: this.bucket, Prefix: this._key(prefix), ContinuationToken: token,
      }));
      for (const o of r.Contents || []) {
        if (o.Key.endsWith('/')) continue;   // a folder marker some tools leave behind
        yield { rel: o.Key.slice(this.prefix.length), size: o.Size, lastModified: o.LastModified };
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }

  async ping() {
    try {
      try {
        await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      } catch (err) {
        // Garage answers 403 to HeadBucket for a key scoped to the bucket; a
        // one-item listing tells whether the key can really use it.
        if (err.$metadata?.httpStatusCode !== 403) throw err;
        await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
      }
    } catch (err) {
      // A failed HeadBucket often has no message of its own; say what came back.
      const status = err.$metadata?.httpStatusCode;
      const what = [err.name, status && `HTTP ${status}`, err.code].filter(Boolean).join(', ');
      throw new Error(`${what}${err.message && err.message !== err.name ? `: ${err.message}` : ''}`);
    }
  }
}

module.exports = { S3Storage };
