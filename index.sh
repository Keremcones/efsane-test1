#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$PROJECT_DIR"

PROJECT_REF="${SUPABASE_PROJECT_REF:-jcrbhekrphxodxhkuzju}"
FUNCTION_NAME="check-alarm-signals"

usage() {
   cat <<'EOF'
Kullanım: ./index.sh <komut>

Komutlar:
   status   Git ve temel dosya durumu
   deploy   Edge function deploy
   logs     Edge function son logları
   help     Bu yardımı göster
EOF
}

require_cmd() {
   command -v "$1" >/dev/null 2>&1 || {
      echo "❌ Eksik komut: $1" >&2
      exit 1
   }
}

cmd_status() {
   echo "📍 Proje: $PROJECT_DIR"
   git status --short || true
   echo "\n📄 Kritik dosyalar:"
   ls -1 supabase/functions/check-alarm-signals/index.ts index.sh 2>/dev/null || true
}

cmd_deploy() {
   require_cmd supabase
   supabase functions deploy "$FUNCTION_NAME" --project-ref "$PROJECT_REF"
}

cmd_logs() {
   require_cmd supabase
   supabase functions logs "$FUNCTION_NAME" --project-ref "$PROJECT_REF"
}

case "${1:-help}" in
   status) cmd_status ;;
   deploy) cmd_deploy ;;
   logs) cmd_logs ;;
   help|-h|--help) usage ;;
   *)
      echo "❌ Bilinmeyen komut: $1" >&2
      usage
      exit 1
      ;;
esac
