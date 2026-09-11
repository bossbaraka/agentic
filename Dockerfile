# ═══════════════════════════════════════════════════════════════
#  MUREEH | مُريح — صورة إنتاج
#  البناء:   docker build -t mureeh-agent .
#  التشغيل:  docker run -p 3000:3000 --env-file .env -v mureeh-data:/app/data mureeh-agent
#
#  ملاحظة: Node 22 مطلوب لقاعدة البيانات (node:sqlite المدمجة).
# ═══════════════════════════════════════════════════════════════

FROM node:22-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# ── الاعتماديات فقط (طبقة تُخزَّن مؤقتًا) ──
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ── الكود ──
COPY tsconfig.json ./
COPY src ./src
COPY knowledge ./knowledge
COPY scripts ./scripts

# مجلد البيانات — اربطه بـ volume دائم (قاعدة SQLite + الجلسات + الوسائط)
RUN mkdir -p /app/data /app/data/media
VOLUME ["/app/data"]

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    MEDIA_DIR=/app/data/media \
    KNOWLEDGE_DIR=/app/knowledge

EXPOSE 3000

# فحص صحّة بسيط بدون أدوات إضافية
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# نشغّل عبر tsx (نفس نمط التشغيل المعتمد في المشروع).
# لبديل أسرع بعد التأكد من البناء: npm run build && node dist/server.js
CMD ["npx", "tsx", "src/server.ts"]
