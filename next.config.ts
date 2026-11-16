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
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
