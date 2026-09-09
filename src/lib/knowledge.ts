import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from './utils.js';

/**
 * قاعدة المعرفة (Knowledge Base).
 *
 * كل ملفات Markdown داخل KNOWLEDGE_DIR تُحقن في الـ system prompt.
 * هذه هي الطريقة الأبسط والأدق لتعليم البوت عن نشاطك:
 * أسعار، ساعات عمل، سياسات إرجاع، أسئلة متكررة...
 *
 * أعد تحميل الملفات دون إعادة تشغيل الخادم عبر reload().
 */
export class KnowledgeBase {
  private docs: { file: string; title: string; content: string }[] = [];
  private loadedAt = 0;

  reload(): void {
    const dir = config.paths.KNOWLEDGE_DIR;
    this.docs = [];

    if (!fs.existsSync(dir)) {
      log.warn(`مجلد قاعدة المعرفة غير موجود: ${dir}`);
      this.loadedAt = Date.now();
      return;
    }

    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(md|markdown|txt)$/i.test(f))
      .sort();

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(dir, file), 'utf8').trim();
        if (!content) continue;
        const titleMatch = content.match(/^#\s+(.+)$/m);
        this.docs.push({
          file,
          title: titleMatch ? titleMatch[1].trim() : path.basename(file, path.extname(file)),
          content,
        });
      } catch (err) {
        log.warn(`تعذّر قراءة ${file}: ${(err as Error).message}`);
      }
    }

    this.loadedAt = Date.now();
    const chars = this.docs.reduce((n, d) => n + d.content.length, 0);
    log.ok(`قاعدة المعرفة: ${this.docs.length} ملف / ${chars.toLocaleString('ar')} حرف`);
  }

  /** النص المحقون في الـ system prompt */
  render(): string {
    if (this.docs.length === 0) {
      return '(لا توجد قاعدة معرفة مضبوطة حاليًا. إذا سألك العميل عن معلومات تخص النشاط ولا تعرفها، استخدم أمر التحويل لموظف بشري بدل التخمين.)';
    }

    return this.docs
      .map((d) => `### من ملف: ${d.file}\n${d.content}`)
      .join('\n\n---\n\n');
  }

  size(): number {
    return this.docs.length;
  }

  files(): string[] {
    return this.docs.map((d) => d.file);
  }

  get timestamp(): number {
    return this.loadedAt;
  }
}

export const knowledge = new KnowledgeBase();
