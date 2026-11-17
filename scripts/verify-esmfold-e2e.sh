#!/usr/bin/env bash
# 端到端验证 ESMFold 兜底集成：纯序列输入（无 UniProt）→ 后台作业 → 轮询 →
# 校验摘要 esmfold 字段 + 报告 HTML 含 ESMFold 交互视图区块
# 用一个 NOT 在 AFDB 的短序列（随机点突变泛素 — 保证 AFDB 无收录 → 触发兜底）
set -e
BASE=http://localhost:3000

# 泛素 76aa 带 6 处点突变（AFDB 无该条目；BLAST 仍可找到泛素家族 → 评估流程完整）
SEQ="MQIFVKTLTGKTITLEVEPSDTIENVKAKIQDKEGIPPDQQRLIFAGKQLEDGRTLSDYNIQKESTLHLVLRLRGA"

echo "== 1. 提交 sequence 模式评估作业 =="
SUBMIT=$(curl -s -X POST $BASE/api/evaluate -H "Content-Type: application/json" -H "Cookie: owner_esm_e2e=1" \
  -d "{\"mode\":\"sequence\",\"sequence\":\"$SEQ\",\"goal\":\"验证 ESMFold 兜底预测集成\"}")
echo "$SUBMIT" | head -c 400; echo
JOB_ID=$(echo "$SUBMIT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('jobId') or d.get('id') or '')")
test -n "$JOB_ID" || { echo "FAIL: no jobId"; exit 1; }
echo "jobId=$JOB_ID"

echo "== 2. 轮询作业（≤14 分钟）=="
for i in $(seq 1 280); do
  sleep 3
  J=$(curl -s "$BASE/api/jobs/$JOB_ID" -H "Cookie: owner_esm_e2e=1")
  STATUS=$(echo "$J" | python3 -c "import sys,json; d=json.load(sys.stdin); j=d.get('job') or d; print(j.get('status','?'))" 2>/dev/null || echo "?")
  if [ $((i % 10)) -eq 0 ]; then echo "[$((i*3))s] status=$STATUS"; fi
  if [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ]; then
    echo "FINAL status=$STATUS"
    echo "$J" | python3 -c "
import sys, json
d = json.load(sys.stdin)
j = d.get('job') or d
err = j.get('error')
if err: print('ERROR:', err)
s = j.get('summary')
if s:
    if isinstance(s, str): s = json.loads(s)
    esm = s.get('esmfold')
    af = s.get('alphafold')
    print('alphafold:', json.dumps(af, ensure_ascii=False))
    print('esmfold  :', json.dumps(esm, ensure_ascii=False))
    rp = j.get('reportPath')
    print('reportPath:', rp)
" 2>/dev/null || echo "$J" | head -c 600
    break
  fi
done

echo "== 3. 报告 HTML 校验 =="
RP=$(curl -s "$BASE/api/jobs/$JOB_ID" -H "Cookie: owner_esm_e2e=1" | python3 -c "import sys,json; d=json.load(sys.stdin); j=d.get('job') or d; print(j.get('reportPath') or '')")
if [ -n "$RP" ] && [ -f "$RP" ]; then
  echo "report file: $RP ($(du -h "$RP" | cut -f1))"
  grep -c "ESMFold 预测结构" "$RP" | xargs -I{} echo "ESMFold 标记出现 {} 次"
  grep -o "esmatlas.com →" "$RP" | head -1
  grep -c "ef-stage" "$RP" | xargs -I{} echo "ef-stage 出现 {} 次"
  grep -o "平均 pLDDT [0-9.]*" "$RP" | head -2
else
  echo "(reportPath 未落盘或文件不存在: '$RP' — 无状态部署下正常，检查 API 返回的 reportHtml)"
fi
