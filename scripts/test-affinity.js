/** 测试部署环境的连接亲和性：同一 keep-alive 连接上 init → chunk 是否可见 */
const https = require('https')

const HOST = 'targeteval.space.zhipuaidemo.cn'
const agent = new https.Agent({ keepAlive: true, maxSockets: 1 })

function req(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      { host: HOST, path, method, agent, headers },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
      },
    )
    r.on('error', reject)
    if (body) r.write(body)
    r.end()
  })
}

async function main() {
  // 1. init
  const init = await req('POST', '/api/evaluate/upload/init', JSON.stringify({ name: 'affinity.docx', size: 100 }), { 'content-type': 'application/json' })
  console.log('INIT:', init.status, init.body.slice(0, 120))
  const cookie = (init.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ')
  console.log('FC-REQ-ID:', init.headers['x-fc-request-id'])
  const m = JSON.parse(init.body)
  if (!m.ok) return
  // 2. chunk on SAME connection (keep-alive agent)
  const chunk = await req(
    'PUT',
    `/api/evaluate/upload/chunk?uploadId=${m.uploadId}&offset=0`,
    Buffer.alloc(100, 7),
    { 'content-type': 'application/octet-stream', cookie },
  )
  console.log('CHUNK(same-conn):', chunk.status, chunk.body.slice(0, 160))
  console.log('FC-REQ-ID:', chunk.headers && chunk.headers['x-fc-request-id'])
  // 3. status on same connection
  const st = await req('GET', `/api/evaluate/upload/status?uploadId=${m.uploadId}`, null, { cookie })
  console.log('STATUS(same-conn):', st.status, st.body.slice(0, 160))
  agent.destroy()
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
