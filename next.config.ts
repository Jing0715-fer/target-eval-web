import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // 沙箱预览经网关代理访问（公网域名不定），放行 dev HMR 跨域检查，
  // 否则 Next 16 默认仅允许 localhost 来源 → 预览域名被 403 → 前端水合失败
  allowedDevOrigins: [
    "127.0.0.1",
    "localhost",
    "**.z.ai",
    "**.space-z.ai",
    "**.aliyuncs.com",
  ],
  serverExternalPackages: ["mammoth", "z-ai-web-dev-sdk", "@prisma/client", "sharp"],
  // v2.91：请求体上限 10MiB → 200MiB。Next 16 dev 代理默认 proxyClientMaxBodySize
  // = 10,485,760 字节，超出后请求体在框架层被静默截断 → route 内 req.json() 抛错
  // →「请求体不是合法 JSON」（用户实测：v2.87 导入报告原文随汇总报告生成请求
  // 直传，多份报告合计 >10MB 即必现 — 400 后看板整单失败）。上限需覆盖直传
  // 最坏口径（64MB 字节）+ 归档快照（~24MB）+ 序列/Excel 行等余量，200MiB 留足
  // 冗余；实际载荷远小于此（上限仅为防御性天花板）。
  experimental: {
    proxyClientMaxBodySize: 209_715_200,
  },
  // v2.55：关闭开发指示器（左下角黑色「N」悬浮球）— 预览面板中遮挡内容且无功能价值
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
