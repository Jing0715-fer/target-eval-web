#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
重建 EBI UniProtKB 回补验证报告（v2）：
 - 7 个未达 85% 阈值的靶点按「最高同源回填」策略回填最佳命中（远缘参考标记）
 - 全部 26 个回填命中内嵌序列比对视图：60 列/块经典三行布局、残基化学性质着色、
   相同/相似/不同自算（内嵌 BLOSUM62，不依赖 EBI mseq 格式）、悬停列高亮 +
   tooltip 显示双端氨基酸位点号与残基名（点击支持移动端）
 - 同步输出回补映射 JSON（26 条，mode: exact / alt-chain / best-effort）
数据源：/tmp/{verify_tasks,ebi-verify-results,alignments}.json
"""
import json, html as H
from datetime import datetime

TASKS = json.load(open('/tmp/verify_tasks.json'))
RES = json.load(open('/tmp/ebi-verify-results.json'))
ALN = json.load(open('/tmp/alignments.json'))

def sp_of(job, key):
    r = RES.get(f'{job}{key}')
    return (r.get('sp') if r else None), r

def classify(job, has_seq):
    full, _ = sp_of(job, '#0#full')
    sp, _ = sp_of(job, '#0')
    main = full or sp
    main_src = '#0#full' if full else ('#0' if sp else None)
    a1, _ = sp_of(job, '#101')
    a2, _ = sp_of(job, '#102')
    alt = None; alt_src = None
    for src, cand in (('#101', a1), ('#102', a2)):
        if cand and cand.get('pass'):
            alt, alt_src = cand, src
            break
    if not has_seq:
        return 'NOSEQ', main, main_src, alt, alt_src
    if main and main.get('pass'):
        return 'PASS', main, main_src, alt, alt_src
    if alt:
        return 'ALT', main, main_src, alt, alt_src
    return 'BEST', main, main_src, alt, alt_src

def uni_link(acc):
    return f'<a href="https://www.uniprot.org/uniprotkb/{acc}" target="_blank" rel="noopener">{acc}</a>'

def hit_cell(sp, tone_override=None):
    if not sp:
        return '<span class="dim">—</span>'
    tone = tone_override or ('ok' if sp['pass'] else ('near' if sp['id'] >= 75 else 'far'))
    return (f'<span class="{tone}"><b>{uni_link(sp["acc"])}</b> {sp["id"]}%/{sp["cov"]}%'
            f'<br><small>{H.escape(sp["desc"][:52])}</small></span>')

rows_meta = []
for t in TASKS:
    job = t['job']
    has_seq = bool(t.get('uniq'))
    cat, main, main_src, alt, alt_src = classify(job, has_seq)
    rows_meta.append({'job': job, 'label': t['label'], 'sublen': t['sublen'],
                      'cat': cat, 'main': main, 'main_src': main_src,
                      'alt': alt, 'alt_src': alt_src, 'aln': ALN.get(job)})

order = {'PASS': 0, 'ALT': 1, 'BEST': 2, 'NOSEQ': 3}
rows_meta.sort(key=lambda r: (order[r['cat']], r['job']))
n = {c: sum(1 for r in rows_meta if r['cat'] == c) for c in order}
n_alt_fn = sum(1 for r in rows_meta if r['cat'] == 'ALT' and 'Immunoglobulin' not in (r['alt'] or {}).get('desc', '') and 'Ig ' not in (r['alt'] or {}).get('desc', ''))
n_alt_ig = n['ALT'] - n_alt_fn
total_backfill = n['PASS'] + n['ALT'] + n['BEST']

# ── 比对数据（内嵌 JS，剔除 mseq — 状态由 BLOSUM62 自算）───────────────
align_js = {}
for job, a in ALN.items():
    align_js[job] = {k: a[k] for k in (
        'acc', 'desc', 'db', 'os', 'entryName', 'hitLen', 'channel', 'chainKind', 'chainLen',
        'qfrom', 'qto', 'hfrom', 'hto', 'identity', 'positive', 'gaps', 'alignLen', 'expect', 'nhsp',
        'qseq', 'hseq')}

# ── 表格行 ────────────────────────────────────────────────────────────
trs = []
for r in rows_meta:
    job, cat = r['job'], r['cat']
    if cat == 'NOSEQ':
        trs.append(f'''<tr><td>{job}</td><td>{H.escape(r["label"])}</td><td>{r["sublen"]}aa</td>
<td class="dim" colspan="3">汇总报告未留存该行原表序列（序列折叠/缺失）— 无法验证</td>
<td><span class="badge b4">无序列</span></td><td class="dim">—</td></tr>''')
        continue
    main, alt, a = r['main'], r['alt'], r['aln']
    chan = 'EBI 全库' if r['main_src'] == '#0#full' else 'EBI Swiss-Prot'
    alt_html = ''
    if alt:
        tag = '复合物功能链' if ('Immunoglobulin' not in alt['desc'] and 'Ig ' not in alt['desc']) else '抗体成分链'
        alt_html = f'<div class="alt">{tag}：{hit_cell(alt)}</div>'
    if cat == 'PASS':
        badge = f'<span class="badge b1">可回补</span><div class="chan">{chan}</div>'
        rec = uni_link(main['acc'])
        btn = 'btn-ok'
    elif cat == 'ALT':
        ig = '（仅抗体链达标）' if ('Immunoglobulin' in alt['desc'] or 'Ig ' in alt['desc']) else ''
        badge = f'<span class="badge b2">备选链可回补{ig}</span>'
        rec = f'{uni_link(alt["acc"])}<div class="chan">经 {alt["cov"] and ""}备选链 {a["chainLen"] if a else ""} aa</div>'
        btn = 'btn-ok'
    else:
        badge = f'<span class="badge b5">最高同源回填</span><div class="chan">{chan} · 远缘参考</div>'
        rec = (f'{uni_link(main["acc"])} <span class="far">· {main["id"]}% 远缘</span>'
               f'<div class="chan">未达 85% 阈值，按最高同源回填</div>')
        btn = 'btn-warn'
    main_tone = 'ok' if (main and main['pass']) else None
    trs.append(f'''<tr id="row-{job}">
<td>{job}</td>
<td>{H.escape(r["label"])}</td>
<td>{r["sublen"]}aa</td>
<td>{hit_cell(main, main_tone)}</td>
<td>{alt_html or '<span class="dim">—</span>'}</td>
<td class="rec">{rec}</td>
<td>{badge}</td>
<td><button type="button" class="alnbtn {btn}" data-job="{job}">比对 ▾</button></td></tr>
<tr class="aln-tr" id="aln-{job}" hidden><td colspan="8"><div class="aln-panel"></div></td></tr>''')

# ── 统计卡 ────────────────────────────────────────────────────────────
best_ids = [r['main']['id'] for r in rows_meta if r['cat'] == 'BEST' and r['main']]
cards = f'''<div class="card"><div class="n">28</div><div class="t">缺失 UniProt ID 靶点</div></div>
<div class="card g"><div class="n">{n['PASS'] + n['ALT']}</div><div class="t">精确回填 ≥85%（主链 {n['PASS']} + 备选链 {n['ALT']}，含抗体链 {n_alt_ig}）</div></div>
<div class="card o"><div class="n">{n['BEST']}</div><div class="t">最高同源回填 {min(best_ids):.0f}–{max(best_ids):.0f}%（远缘参考）</div></div>
<div class="card"><div class="n">{n['NOSEQ']}</div><div class="t">报告未留存序列（无法验证）</div></div>
<div class="card g2"><div class="n">{total_backfill}</div><div class="t">已指定回填条目 / 26 可验证</div></div>'''

# ── 内嵌 JS（渲染 + 交互）────────────────────────────────────────────
JS = r'''
const ALIGN = __ALIGN_JSON__;
const AA_INFO={A:['Ala','丙氨酸'],R:['Arg','精氨酸'],N:['Asn','天冬酰胺'],D:['Asp','天冬氨酸'],C:['Cys','半胱氨酸'],Q:['Gln','谷氨酰胺'],E:['Glu','谷氨酸'],G:['Gly','甘氨酸'],H:['His','组氨酸'],I:['Ile','异亮氨酸'],L:['Leu','亮氨酸'],K:['Lys','赖氨酸'],M:['Met','甲硫氨酸'],F:['Phe','苯丙氨酸'],P:['Pro','脯氨酸'],S:['Ser','丝氨酸'],T:['Thr','苏氨酸'],W:['Trp','色氨酸'],Y:['Tyr','酪氨酸'],V:['Val','缬氨酸']};
const AA_CLS={A:'hyd',V:'hyd',L:'hyd',I:'hyd',M:'hyd',F:'hyd',W:'hyd',Y:'hyd',S:'pol',T:'pol',N:'pol',Q:'pol',D:'aci',E:'aci',K:'bas',R:'bas',H:'bas',C:'cys',G:'gly',P:'pro'};
const B62O='ARNDCQEGHILKMFPSTWYV';
const B62M=[[4,-1,-2,-2,0,-1,-1,0,-2,-1,-1,-1,-1,-2,-1,1,0,-3,-2,0],[-1,5,0,-2,-3,1,0,-2,0,-3,-2,2,-1,-3,-2,-1,-1,-3,-2,-3],[-2,0,6,1,-3,0,0,0,1,-3,-3,0,-2,-3,-2,1,0,-4,-2,-3],[-2,-2,1,6,-3,0,2,-1,-1,-3,-4,-1,-3,-3,-1,0,-1,-4,-3,-3],[0,-3,-3,-3,9,-3,-4,-3,-3,-1,-1,-3,-1,-2,-3,-1,-1,-2,-2,-1],[-1,1,0,0,-3,5,2,-2,0,-3,-2,1,0,-3,-1,0,-1,-2,-1,-2],[-1,0,0,2,-4,2,5,-2,0,-3,-3,1,-2,-3,-1,0,-1,-3,-2,-2],[0,-2,0,-1,-3,-2,-2,6,-2,-4,-4,-2,-3,-3,-2,0,-2,-2,-3,-3],[-2,0,1,-1,-3,0,0,-2,8,-3,-3,-1,-2,-1,-2,-1,-2,-2,2,-3],[-1,-3,-3,-3,-1,-3,-3,-4,-3,4,2,-3,1,0,-3,-2,-1,-3,-1,3],[-1,-2,-3,-4,-1,-2,-3,-4,-3,2,4,-2,2,0,-3,-2,-1,-2,-1,1],[-1,2,0,-1,-3,1,1,-2,-1,-3,-2,5,-1,-3,-1,0,-1,-3,-2,-2],[-1,-1,-2,-3,-1,0,-2,-3,-2,1,2,-1,5,0,-2,-1,-1,-1,-1,1],[-2,-3,-3,-3,-2,-3,-3,-3,-1,0,0,-3,0,6,-4,-2,-2,1,3,-1],[-1,-2,-2,-1,-3,-1,-1,-2,-2,-3,-3,-1,-2,-4,7,-1,-1,-4,-3,-2],[1,-1,1,0,-1,0,0,0,-1,-2,-2,0,-1,-2,-1,4,1,-3,-2,-2],[0,-1,0,-1,-1,-1,-1,-2,-2,-1,-1,-1,-1,-2,-1,1,5,-2,-2,0],[-3,-3,-4,-4,-2,-2,-3,-2,-2,-3,-2,-3,-1,1,-4,-3,-2,11,2,-3],[-2,-2,-2,-3,-2,-1,-2,-3,2,-1,-1,-2,-1,3,-3,-2,-2,2,7,-1],[0,-3,-3,-3,-1,-2,-2,-3,-3,3,1,-2,1,-1,-2,-2,0,-3,-1,4]];
function b62(a,b){const i=B62O.indexOf(a),j=B62O.indexOf(b);return i<0||j<0?0:B62M[i][j]}
function computePos(seq,from){const p=new Array(seq.length);let v=from;for(let i=0;i<seq.length;i++)p[i]=seq[i]==='-'?null:v++;return p}
function fmtE(e){if(e==null)return '—';if(e===0)return '0';if(e<1e-4)return '1e'+Math.round(Math.log10(e));return String(Math.round(e*1000)/1000)}

function renderAln(job){
  const a=ALIGN[job];if(!a)return '<div class="dim">无比对数据</div>';
  const q=a.qseq,h=a.hseq,N=q.length;
  const qpos=computePos(q,a.qfrom),hpos=computePos(h,a.hfrom);
  let nId=0,nSim=0,nMis=0,nGap=0;
  for(let i=0;i<N;i++){
    if(q[i]==='-'||h[i]==='-'){nGap++;continue}
    if(q[i]===h[i]){nId++;continue}
    if(b62(q[i],h[i])>0){nSim++}else{nMis++}
  }
  const pc=x=>Math.round(x/N*1000)/10;
  const dbChip=a.db==='SP'?'<span class="dbchip sp">Swiss-Prot 已审校</span>':'<span class="dbchip tr">TrEMBL</span>';
  const chainTag=a.chainKind==='alt'?`备选链 ${a.chainLen} aa`:`提交主链 ${a.chainLen} aa`;
  const warn=a.identity<85?'<div class="aln-warn">远缘回填（一致性 '+a.identity+'% &lt; 85%）— 身份仅供参考，请结合下方比对人工复核</div>':'';
  const moreHsp=a.nhsp>1?` · 另 ${a.nhsp-1} 个比对片段未展示`:'';
  let head=`<div class="aln-head">
<div class="aln-title">${H_LBL[job]||job}（${chainTag}）↔ <a href="https://www.uniprot.org/uniprotkb/${a.acc}" target="_blank" rel="noopener">${a.acc}</a> ${H.escape(a.desc)} ${dbChip}</div>
<div class="aln-meta">${a.channel==='T3'?'EBI 全库 BLAST（uniprotkb 含 TrEMBL）':'EBI Swiss-Prot BLAST'} · 一致性 <b>${a.identity}%</b> · 相似度 <b>${a.positive}%</b> · 区段 查询 ${a.qfrom}–${a.qto} / 命中 ${a.hfrom}–${a.hto} · E 值 ${fmtE(a.expect)}${moreHsp}</div>
${warn}
<div class="aln-stats">
<span class="chip ci">相同 ${nId}（${pc(nId)}%）</span><span class="chip cs">相似 ${nSim}（${pc(nSim)}%）</span>
<span class="chip cm">不同 ${nMis}（${pc(nMis)}%）</span><span class="chip cg">缺口 ${nGap} 列</span>
<span class="chip cn">${N} 比对列</span></div>
<div class="aln-legend">
<i class="sw hyd"></i>疏水 <i class="sw pol"></i>极性 <i class="sw aci"></i>酸性 <i class="sw bas"></i>碱性 <i class="sw cys"></i>Cys <i class="sw gly"></i>Gly <i class="sw pro"></i>Pro
<span class="lg-sep"></span><b class="mi">|</b>相同 <b class="ms">+</b>相似 <b class="mm">·</b>不同 <b class="mg">–</b>缺口
<span class="lg-sep"></span><span class="dim">悬停 / 点按残基查看双端氨基酸位点号</span></div></div>`;
  const BLK=60;let blocks='';
  for(let s=0;s<N;s+=BLK){
    const e=Math.min(s+BLK,N);
    let qL='',qR='',hL='',hR='';
    for(let i=s;i<e;i++)if(qpos[i]!=null){qL=qpos[i];break}
    for(let i=e-1;i>=s;i--)if(qpos[i]!=null){qR=qpos[i];break}
    for(let i=s;i<e;i++)if(hpos[i]!=null){hL=hpos[i];break}
    for(let i=e-1;i>=s;i--)if(hpos[i]!=null){hR=hpos[i];break}
    let ql='',ml='',hl='';
    for(let i=s;i<e;i++){
      const qc=q[i],hc=h[i];
      ql+=qc==='-'?`<span class="r gp" data-c="${i}">–</span>`:`<span class="r c${AA_CLS[qc]||''}" data-c="${i}">${qc}</span>`;
      hl+=hc==='-'?`<span class="r gp" data-c="${i}">–</span>`:`<span class="r c${AA_CLS[hc]||''}" data-c="${i}">${hc}</span>`;
      let sym,cls;
      if(qc==='-'||hc==='-'){sym='&nbsp;',cls='mg'}
      else if(qc===hc){sym='|',cls='mi'}
      else if(b62(qc,hc)>0){sym='+',cls='ms'}
      else{sym='·',cls='mm'}
      ml+=`<span class="mt ${cls}" data-c="${i}">${sym}</span>`;
    }
    blocks+=`<div class="abk"><div class="al"><span class="lb">查询</span><span class="pn">${qL}</span><span class="sq">${ql}</span><span class="pn">${qR}</span></div>`
      +`<div class="al"><span class="lb"></span><span class="pn"></span><span class="sq mq">${ml}</span></div>`
      +`<div class="al"><span class="lb">命中</span><span class="pn">${hL}</span><span class="sq">${hl}</span><span class="pn">${hR}</span></div></div>`;
  }
  return head+`<div class="aln-scroll">${blocks}</div>`;
}

const H={escape:s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')};
document.querySelectorAll('.alnbtn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const job=btn.dataset.job,tr=document.getElementById('aln-'+job),panel=tr.querySelector('.aln-panel');
    if(!tr.dataset.rendered){panel.innerHTML=renderAln(job);tr.dataset.rendered='1'}
    const show=tr.hidden;tr.hidden=!show;
    btn.textContent=show?'比对 ▴':'比对 ▾';btn.classList.toggle('open',show);
    if(show)tr.scrollIntoView({block:'nearest',behavior:'smooth'});
  });
});

/* ── 悬停/点按：列高亮 + 位点号 tooltip ── */
const tip=document.createElement('div');tip.className='tip';document.body.appendChild(tip);
let hlEls=[];
function clearHl(){hlEls.forEach(e=>e.classList.remove('hl'));hlEls=[]}
function moveTip(ev){
  const w=tip.offsetWidth,hh=tip.offsetHeight;
  let x=ev.clientX+14,y=ev.clientY+16;
  if(x+w>innerWidth-8)x=ev.clientX-w-12;
  if(y+hh>innerHeight-8)y=ev.clientY-hh-12;
  tip.style.left=x+'px';tip.style.top=y+'px';
}
function showTip(target,ev){
  const scroll=target.closest('.aln-scroll');if(!scroll)return;
  const job=scroll.closest('tr').id.slice(4);
  const a=ALIGN[job];if(!a)return;
  const i=+target.dataset.c;
  const q=a.qseq[i],h=a.hseq[i];
  const qpos=computePos(a.qseq,a.qfrom),hpos=computePos(a.hseq,a.hfrom);
  let l1,l2,stat;
  if(q==='-'){l1=`查询 —（缺失） ↔ 命中 <b>${h}${hpos[i]}</b>（${AA_INFO[h][1]}）`;l2=`插入（查询空位）`;stat='g'}
  else if(h==='-'){l1=`查询 <b>${q}${qpos[i]}</b>（${AA_INFO[q][1]}） ↔ 命中 —（缺失）`;l2=`缺失（命中空位）`;stat='g'}
  else{
    const same=q===h,sim=!same&&b62(q,h)>0;
    l1=`查询 <b>${q}${qpos[i]}</b>（${AA_INFO[q][1]}） ↔ 命中 <b>${h}${hpos[i]}</b>（${AA_INFO[h][1]}）`;
    l2=same?'相同':(sim?'相似（BLOSUM62 正分）':'不同');stat=same?'i':(sim?'s':'m');
  }
  tip.innerHTML=`<div class="t1">${l1}</div><div class="t2 s-${stat}">${l2} · 第 ${i+1} 列</div>`;
  tip.style.display='block';moveTip(ev);
  clearHl();
  scroll.querySelectorAll(`[data-c="${i}"]`).forEach(e=>{e.classList.add('hl');hlEls.push(e)});
}
document.addEventListener('mouseover',e=>{
  const t=e.target.closest('.r,.mt');
  if(t&&tip.style.display==='block'||t){if(t){showTip(t,e);return}}
  tip.style.display='none';clearHl();
});
document.addEventListener('mousemove',e=>{if(tip.style.display==='block')moveTip(e)});
document.addEventListener('click',e=>{
  const t=e.target.closest('.r,.mt');
  if(t){showTip(t,e);e.stopPropagation();return}
  tip.style.display='none';clearHl();
},true);
'''

labels_js = json.dumps({r['job']: r['label'] for r in rows_meta}, ensure_ascii=False)
JS = JS.replace('__ALIGN_JSON__', json.dumps(align_js, ensure_ascii=False, separators=(',', ':')))
JS = JS.replace('H_LBL', 'LBL').replace("__LBL_JSON__", labels_js)
JS = JS.replace('const LBL=', 'const LBL=')
# 注入 LBL
JS = JS.replace("const ALIGN = ", "const LBL = " + labels_js + ";\nconst ALIGN = ", 1)

CSS = '''
:root{--ink:#1c2430;--mut:#68758a;--line:#e3e8f0;--bg:#f6f8fb;--ok:#0b7a3d;--near:#a56a00;--far:#b3372f;--acc:#7a3ba0;--warn:#c2410c}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg))}
.wrap{max-width:1180px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:22px;margin:0 0 6px}.sub{color:var(--mut);font-size:13px;margin-bottom:18px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:14px 0 20px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.card .n{font-size:26px;font-weight:700}.card .t{color:var(--mut);font-size:12px}
.card.g .n{color:var(--ok)}.card.y .n{color:var(--near)}.card.r .n{color:var(--far)}.card.o .n{color:var(--warn)}.card.g2 .n{color:var(--acc)}
.tblwrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;min-width:980px;border-collapse:collapse;background:#fff;border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
th{background:#eef2f8;text-align:left;padding:8px 10px;font-size:12px;color:var(--mut);border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
td:nth-child(1),td:nth-child(3){white-space:nowrap}
tr:last-child td{border-bottom:none}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.ok{color:var(--ok)}.near{color:var(--near)}.far{color:var(--far)}.dim{color:#9aa6b8}
.badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:600;color:#fff;white-space:nowrap}
.b1{background:var(--ok)}.b2{background:var(--near)}.b3{background:var(--far)}.b4{background:#8a95a6}.b5{background:var(--warn)}
.chan{color:var(--mut);font-size:11px;margin-top:3px}
.alt{margin:2px 0}.alt small{color:var(--mut)}
.rec a{font-weight:600}
.note{background:#fff;border:1px solid var(--line);border-left:4px solid var(--acc);border-radius:8px;padding:14px 16px;margin:18px 0;font-size:13px}
.note h3{margin:0 0 8px;font-size:14px}.note ul{margin:4px 0;padding-left:20px}.note li{margin:3px 0}
code{background:#eef2f8;padding:1px 5px;border-radius:4px;font-size:12px}
/* ── 比对按钮/面板 ── */
.alnbtn{border:1px solid var(--line);background:#fff;border-radius:16px;padding:3px 12px;font-size:12px;color:var(--acc);cursor:pointer;white-space:nowrap}
.alnbtn:hover{border-color:var(--acc);background:#f6edfb}
.alnbtn.open{background:var(--acc);color:#fff;border-color:var(--acc)}
.alnbtn.btn-warn{color:var(--warn)}.alnbtn.btn-warn:hover{border-color:var(--warn);background:#fdf1ea}
.alnbtn.btn-warn.open{background:var(--warn);color:#fff;border-color:var(--warn)}
.aln-tr>td{padding:0 10px 14px;background:#fbfcfe}
.aln-panel{border:1px solid var(--line);border-radius:10px;background:#fff;overflow:hidden}
.aln-head{padding:12px 16px 10px;border-bottom:1px solid var(--line)}
.aln-title{font-size:13.5px;font-weight:600}
.aln-title a{font-family:ui-monospace,Menlo,Consolas,monospace}
.dbchip{display:inline-block;font-size:10.5px;font-weight:600;border-radius:4px;padding:0 6px;vertical-align:1px}
.dbchip.sp{background:#e2f2e8;color:var(--ok)}.dbchip.tr{background:#f3ecfb;color:var(--acc)}
.aln-meta{color:var(--mut);font-size:12px;margin-top:3px}.aln-meta b{color:var(--ink)}
.aln-warn{margin-top:8px;font-size:12px;background:#fdf1ea;color:var(--warn);border:1px solid #f3d5c3;border-radius:6px;padding:5px 10px}
.aln-stats{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{font-size:11.5px;border-radius:12px;padding:1px 10px;border:1px solid var(--line);background:#fff}
.chip.ci{color:var(--ok);border-color:#bfe3cd}.chip.cs{color:var(--near);border-color:#ecd9ae}.chip.cm{color:var(--far);border-color:#efc7c2}.chip.cg{color:#7a8496}.chip.cn{color:var(--mut)}
.aln-legend{font-size:11.5px;color:var(--mut);margin-top:8px;display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.sw{display:inline-block;width:11px;height:11px;border-radius:3px;margin:0 1px 0 6px;vertical-align:-1px}
.sw:first-child{margin-left:0}
.sw.hyd{background:#f6e9c0}.sw.pol{background:#d9f0e0}.sw.aci{background:#fbdfe1}.sw.bas{background:#e9e1f7}.sw.cys{background:#f9dfe9}.sw.gly{background:#e9e9ee}.sw.pro{background:#fbe7d5}
.lg-sep{display:inline-block;width:1px;height:12px;background:var(--line);margin:0 8px}
.mi{color:var(--ok)}.ms{color:var(--near)}.mm{color:#cf5548}.mg{color:#b6bec9}
.aln-scroll{max-height:62vh;overflow:auto;padding:12px 16px;background:linear-gradient(#fff,#fcfdff)}
.abk{margin-bottom:14px}.abk:last-child{margin-bottom:2px}
.al{white-space:pre;font:12.5px/1.65 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
.lb{display:inline-block;min-width:3.2em;color:var(--mut);font-size:11px}
.pn{display:inline-block;min-width:4.2ch;text-align:right;color:#8792a6;font-size:11px;margin:0 8px}
.sq{white-space:pre}
.mq{color:var(--mut)}
.r{border-radius:2px;padding:0}
.r.c hyd,.r.chyd{background:#f6e9c0}.r.cpol{background:#d9f0e0}.r.caci{background:#fbdfe1}.r.cbas{background:#e9e1f7}.r.ccys{background:#f9dfe9}.r.cgly{background:#e9e9ee}.r.cpro{background:#fbe7d5}
.r.gp{color:#b6bec9}
.mt{border-radius:2px}
.r.hl,.mt.hl{outline:1.6px solid var(--acc);background:#f3eafa}
/* tooltip */
.tip{display:none;position:fixed;z-index:999;background:#232a38;color:#f2f5fa;border-radius:8px;padding:7px 11px;font-size:12px;line-height:1.5;pointer-events:none;box-shadow:0 6px 20px rgba(20,26,40,.35);max-width:340px}
.tip .t1{font-family:ui-monospace,Menlo,Consolas,monospace;white-space:nowrap}
.tip .t1 b{color:#c9a8f0;font-size:12.5px}
.tip .t2{color:#aab6cc;margin-top:2px}
.tip .t2.s-i{color:#7fd8a4}.tip .t2.s-s{color:#eec98a}.tip .t2.s-m{color:#f0a49b}.tip .t2.s-g{color:#9aa6b8}
@media (max-width:640px){.aln-scroll{padding:10px}.al{font-size:11.5px}.lb{min-width:2.6em}}
'''

page = f'''<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EBI UniProtKB 回补验证（含序列比对） · 28 缺失靶点</title>
<style>{CSS}</style></head><body><div class="wrap">
<h1>EBI UniProtKB 回补验证报告</h1>
<div class="sub">对象：TargetEval_HT_2026-11-25（117 靶点）汇总报告中缺失 UniProt ID 的 28 个靶点 · 更新：{datetime.now().strftime('%Y-%m-%d %H:%M')} · v2（最高同源回填 + 序列比对视图）</div>

<div class="cards">{cards}</div>

<div class="note"><h3>回填策略与比对视图</h3>
<ul>
<li><b>精确回填（{n['PASS'] + n['ALT']} 个）</b>：一致性 ≥85% 且覆盖 ≥40% 的命中直接回填（主链 {n['PASS']} + 复合物备选功能链/抗体链 {n['ALT']}，其中抗体链 {n_alt_ig} 个按需取舍）。</li>
<li><b>最高同源回填（{n['BEST']} 个）</b>：未达 85% 阈值的靶点按用户指示取最高同源命中回填，一致性 {min(best_ids):.0f}–{max(best_ids):.0f}%，标记为<b>远缘参考</b> — 点击行尾「比对」查看逐残基证据后再行取舍。</li>
<li><b>序列比对视图</b>：每行「比对」按钮展开 60 列/块的经典三行比对 — 残基按化学性质着色；中间行 <b class="mi">|</b> 相同 / <b class="ms">+</b> 相似（BLOSUM62 正分）/ <b class="mm">·</b> 不同；<b>悬停（或移动端点按）任一残基</b>：整列高亮并显示查询/命中两端的氨基酸位点号、残基名与匹配状态。</li>
</ul></div>

<div class="tblwrap"><table>
<thead><tr><th>作业</th><th>靶点（原始标签）</th><th>提交</th><th>主链最佳命中</th><th>备选链命中（≥85%）</th><th>建议回补</th><th>判定</th><th>比对</th></tr></thead>
<tbody>
{''.join(trs)}
</tbody></table></div>

<div class="note"><h3>结论</h3>
<ul>
<li><b>{total_backfill}/26 可验证靶点已全部指定回填条目</b>（精确 {n['PASS'] + n['ALT']} + 最高同源 {n['BEST']}）；另 {n['NOSEQ']} 个汇总报告未留存序列，无法验证。</li>
<li><b>TrEMBL 全库通道仍是主力</b>：Spike / PPRV 血凝素 / 固氮酶 / GPR88 / HIV Env / 脲酶 γ 等全部依赖毒株或物种 TrEMBL 条目（96–85%）；Swiss-Prot 快通道仅覆盖其中少数。</li>
<li><b>最高同源回填的 {n['BEST']} 个为远缘参考</b>（一致性 {min(best_ids):.0f}–{max(best_ids):.0f}%）：PA_22f1（炭疽保护性抗原 68.8%）、62_C15（分泌素 GspD 48.4%）、A1+P（curli 组装蛋白 56%）等均为工程改造体或种系距离过远的构建 — 请展开比对视图复核后使用。</li>
<li><b>比对数据来源</b>：EBI ncbiblast 作业结果 HSP（qseq/hseq + 双端坐标）；相同/相似/不同由内嵌 BLOSUM62 重新计算（与 BLAST positive 同口径），缺口列为任一端空位。</li>
</ul></div>
</div>
<script>{JS}</script></body></html>'''

for out in ['db/reports/EBI_UniProtKB_回补验证_28缺失靶点_2026-11-26.html',
            'public/reports/ebi-uniprot-verification-2026-11-26.html']:
    open(out, 'w', encoding='utf-8').write(page)
    print('written:', out, len(page), 'bytes')

# ── 回补映射 JSON（26 条）─────────────────────────────────────────────
patch = []
for r in rows_meta:
    if r['cat'] == 'NOSEQ':
        continue
    if r['cat'] in ('PASS',):
        sp, mode = r['main'], 'exact'
    elif r['cat'] == 'ALT':
        sp, mode = r['alt'], 'alt-chain'
    else:
        sp, mode = r['main'], 'best-effort'
    a = r['aln'] or {}
    patch.append({
        'job': r['job'], 'label': r['label'], 'uniprotId': sp['acc'],
        'identity': sp['id'], 'coverage': sp['cov'], 'description': sp['desc'],
        'source': ('EBI UniProtKB BLAST 全库（TrEMBL）' if (r['cat'] != 'ALT') else 'EBI Swiss-Prot BLAST（备选链）'),
        'mode': mode, 'bestEffort': r['cat'] == 'BEST',
        'chainKind': a.get('chainKind'), 'chainLen': a.get('chainLen'),
    })
json.dump({'generatedAt': datetime.now().strftime('%Y-%m-%d %H:%M'),
           'policy': '未达 85% 阈值的按最高同源命中回填（bestEffort=true 为远缘参考，需人工复核）',
           'total': len(patch), 'entries': patch},
          open('db/reports/ebi-uniprot-backfill-patch.json', 'w'), ensure_ascii=False, indent=1)
print(f'patch JSON: {len(patch)} 条')
print(f'分类: PASS={n["PASS"]} ALT={n["ALT"]}(功能{n_alt_fn}/抗体{n_alt_ig}) BEST={n["BEST"]} NOSEQ={n["NOSEQ"]}')
