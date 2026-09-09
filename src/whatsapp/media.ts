import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log, uid } from '../lib/utils.js';
import type { MediaPart } from '../types.js';

/**
 * تنزيل الوسائط الواردة من واتساب.
 *
 * الآلية الرسمية (خطوتان):
 *  1) GET  /{media_id}          → يرجع رابط تنزيل مؤقت (lookup_url)
 *  2) GET  {lookup_url}         → يحمل البايتات (مطلوب نفس الـ Bearer token)
 *
 * بعدها نحوّل الوسائط إلى base64 لتمريرها لـ Gemini كـ inlineData
 * (النموذج يفهم الصور والصوت والفيديو وملفات PDF مباشرة).
 */

const GRAPH = () => `https://graph.facebook.com/${config.whatsapp.GRAPH_VERSION}`;

export interface DownloadedMedia extends MediaPart {
  localPath?: string;
}

/** جلب رابط التنزيل المؤقت */
export async function getMediaUrl(mediaId: string): Promise<string> {
  const res = await fetch(`${GRAPH()}/${mediaId}`, {
    headers: { Authorization: `Bearer ${config.whatsapp.ACCESS_TOKEN}` },
  });

  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Media lookup ${res.status}: ${json?.error?.message ?? 'فشل'}`);
  }
  if (!json?.url) throw new Error('Media lookup لم يرجع رابط تنزيل');
  return json.url as string;
}

/** تنزيل بايتات الوسائط */
export async function downloadMediaBytes(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.whatsapp.ACCESS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Media download ${res.status}`);

  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.byteLength > config.paths.MAX_MEDIA_BYTES) {
    throw new Error(
      `حجم الوسائط ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB يتجاوز الحد ` +
      `${(config.paths.MAX_MEDIA_BYTES / 1024 / 1024).toFixed(1)}MB`,
    );
  }

  const mimeType = res.headers.get('content-type') ?? 'application/octet-stream';
  return { buffer, mimeType };
}

/**
 * تنزيل وسائط رسالة واردة وتجهيزها للنموذج.
 * يرجع null في وضع التجربة أو عند الفشل (مع سبب في note).
 */
export async function fetchInboundMedia(
  media: { id: string; mimeType: string; kind: MediaPart['kind'] },
): Promise<DownloadedMedia | null> {
  if (config.env.DEMO_MODE) {
    return {
      kind: media.kind,
      mimeType: media.mimeType,
      data: '',
      bytes: 0,
      note: '[وضع التجربة: الوسائط غير متاحة — سيتم وصفها نصيًا فقط]',
    };
  }

  if (!config.whatsapp.ACCESS_TOKEN) {
    return { kind: media.kind, mimeType: media.mimeType, data: '', bytes: 0, note: '[لا يوجد توكن — تعذّر تنزيل الوسائط]' };
  }

  try {
    const url = await getMediaUrl(media.id);
    const { buffer, mimeType } = await downloadMediaBytes(url);
    const effectiveMime = mimeType === 'application/octet-stream' ? media.mimeType : mimeType;

    let localPath: string | undefined;
    if (config.paths.SAVE_MEDIA) {
      const ext = extFor(effectiveMime, media.kind);
      localPath = path.join(config.paths.MEDIA_DIR, `${Date.now()}_${uid('f')}${ext}`);
      fs.mkdirSync(config.paths.MEDIA_DIR, { recursive: true });
      fs.writeFileSync(localPath, buffer);
    }

    log.info(`📎 وسائط ${media.kind} (${(buffer.byteLength / 1024).toFixed(0)} KB, ${effectiveMime})`);

    return {
      kind: media.kind,
      mimeType: effectiveMime,
      data: buffer.toString('base64'),
      bytes: buffer.byteLength,
      localPath,
    };
  } catch (err) {
    log.warn(`تعذّر تنزيل الوسائط: ${(err as Error).message}`);
    return {
      kind: media.kind,
      mimeType: media.mimeType,
      data: '',
      bytes: 0,
      note: `[تعذّر تنزيل الوسائط: ${(err as Error).message}]`,
    };
  }
}

/** رفع وسائط إلى Meta والحصول على media id (لإرسال صور/ملفات للعميل) */
export async function uploadMedia(buffer: Buffer, mimeType: string): Promise<string | null> {
  if (config.env.DEMO_MODE) return 'demo_media_id';

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([new Uint8Array(buffer)], { type: mimeType }), `file${extFor(mimeType, 'document')}`);

  const res = await fetch(`${GRAPH()}/${config.whatsapp.PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.ACCESS_TOKEN}` },
    body: form,
  });

  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    log.error(`فشل رفع الوسائط: ${json?.error?.message ?? res.status}`);
    return null;
  }
  return json?.id ?? null;
}

/** بصمة SHA-256 للتحقق من سلامة الوسائط (كما يوصي Meta) */
export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('base64');
}

function extFor(mime: string, kind: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('png')) return '.png';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('mp4')) return '.mp4';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('aac')) return '.aac';
  if (m.includes('wav')) return '.wav';
  if (m.includes('pdf')) return '.pdf';
  if (kind === 'audio') return '.ogg';
  if (kind === 'video') return '.mp4';
  if (kind === 'image') return '.jpg';
  return '.bin';
}

/** هل هذا النوع قابل للفهم من قبل Gemini؟ */
export function isGeminiUnderstandable(mime: string): boolean {
  const m = (mime || '').toLowerCase();
  return (
    m.startsWith('image/') ||
    m.startsWith('audio/') ||
    m.startsWith('video/') ||
    m === 'application/pdf' ||
    m === 'text/plain'
  );
}
