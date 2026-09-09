#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  إنشاء رابط عام (HTTPS) للخادم المحلي حتى يقدر Meta يوصله.
#
#  الاستخدام:   npm run tunnel
#  أو:          bash scripts/tunnel.sh 3000
#
#  بعد التشغيل انسخ الرابط (مثل https://xyz.trycloudflare.com)
#  وضعه في Meta كـ Callback URL:   https://xyz.trycloudflare.com/webhook
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

PORT="${1:-${PORT:-3000}}"
BIN="$(command -v cloudflared || true)"
TMPDIR_CF="${HOME}/.cloudflared"

echo "🔎 نفق عام للمنفذ ${PORT}"

# ── 1) cloudflared (مفضل: مجاني وبدون تسجيل) ──
if [[ -z "$BIN" ]]; then
  echo "📦 cloudflared غير مثبت — محاولة التثبيت التلقائي..."
  mkdir -p "$TMPDIR_CF"
  OS="$(uname -s)"
  ARCH="$(uname -m)"
  URL=""
  case "${OS}-${ARCH}" in
    Linux-x86_64)  URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
    Linux-aarch64) URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
    Darwin-x86_64) URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz" ;;
    Darwin-arm64)  URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz" ;;
  esac

  if [[ -n "$URL" ]]; then
    if [[ "$URL" == *.tgz ]]; then
      curl -fsSL "$URL" -o "$TMPDIR_CF/cf.tgz"
      tar -xzf "$TMPDIR_CF/cf.tgz" -C "$TMPDIR_CF"
      BIN="$TMPDIR_CF/cloudflared"
    else
      curl -fsSL "$URL" -o "$TMPDIR_CF/cloudflared"
      chmod +x "$TMPDIR_CF/cloudflared"
      BIN="$TMPDIR_CF/cloudflared"
    fi
    echo "✅ تم التثبيت في $BIN"
  fi
fi

# ── 2) لو ما نجح، جرّب ngrok ──
if [[ -z "$BIN" || ! -x "$BIN" ]]; then
  if command -v ngrok >/dev/null 2>&1; then
    echo "🚇 استخدام ngrok بدلًا من cloudflared"
    echo "   الرابط سيظهر في: http://localhost:4040"
    exec ngrok http "$PORT"
  fi

  cat <<'MSG'

❌ تعذّر تثبيت cloudflared تلقائيًا.

البدائل (اختر واحدًا):

  أ) تثبيت يدوي:
     macOS   : brew install cloudflared
     Debian  : sudo dpkg -i <(curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64)
     أو نزّل من: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
     ثم شغّل : cloudflared tunnel --url http://localhost:3000

  ب) ngrok:
     ngrok http 3000

  ج) للإنتاج (بدون نفق): انشر على Railway / Render / Fly.io / VPS
     واستخدم رابط HTTPS الدائم.

⚠️  ملاحظات مهمة:
  • Meta تتطلب HTTPS صالحًا — النفق يعطيك ذلك مجانًا.
  • رابط cloudflared السريع يتغيّر كل مرة تشغّله → حدّث Callback URL في Meta.
  • للإنتاج استخدم نطاقًا ثابتًا (cloudflared tunnel مع DNS، أو استضافة).
MSG
  exit 1
fi

cat <<MSG

🚇 جارٍ فتح النفق…
   انتظر حتى يظهر سطر:  https://xxxxxxxx.trycloudflare.com
   ثم في Meta for Developers → WhatsApp → Configuration:
     Callback URL : https://xxxxxxxx.trycloudflare.com/webhook
     Verify Token : نفس قيمة WHATSAPP_VERIFY_TOKEN في ملف .env
   واشترك في حقل "messages".

   (Ctrl+C للإيقاف)

MSG

exec "$BIN" tunnel --url "http://localhost:${PORT}" --no-autoupdate
