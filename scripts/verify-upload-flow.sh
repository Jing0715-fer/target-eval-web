#!/usr/bin/env bash
# 端到端验证分块上传链路：init → chunk → complete → status（轮询至终态）
set -e
BASE=http://localhost:3000/api/evaluate/upload
COOKIE="owner_probe_e2e=1"

echo "== 1. init =="
INIT=$(curl -s -X POST $BASE/init -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d "{\"name\":\"probe.docx\",\"size\":$(stat -c%s /tmp/probe.docx)}")
echo "$INIT"
UPLOAD_ID=$(echo "$INIT" | python3 -c "import sys,json;print(json.load(sys.stdin)['uploadId'])")
test -n "$UPLOAD_ID" || { echo "FAIL: no uploadId"; exit 1; }

echo "== 2. chunk (offset 0) =="
curl -s -X PUT "$BASE/chunk?uploadId=$UPLOAD_ID&offset=0" \
  -H "Cookie: $COOKIE" -H "Content-Type: application/octet-stream" \
  --data-binary @/tmp/probe.docx; echo

echo "== 3. complete =="
curl -s -X POST $BASE/complete -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d "{\"uploadId\":\"$UPLOAD_ID\"}"; echo

echo "== 4. status (poll ≤60s) =="
for i in $(seq 1 40); do
  sleep 1.5
  ST=$(curl -s "$BASE/status?uploadId=$UPLOAD_ID" -H "Cookie: $COOKIE")
  PHASE=$(echo "$ST" | python3 -c "import sys,json;print(json.load(sys.stdin).get('phase','?'))" 2>/dev/null || echo parse-err)
  echo "[$i] phase=$PHASE"
  if [ "$PHASE" = "done" ] || [ "$PHASE" = "error" ]; then
    echo "$ST" | head -c 600; echo
    break
  fi
done

echo "== 5. 无状态直传通道（stateless=1 & noVlm=1） =="
curl -s -X POST "$BASE?stateless=1&noVlm=1" -F "file=@/tmp/probe.docx" | head -c 400; echo
