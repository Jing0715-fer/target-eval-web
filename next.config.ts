import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["mammoth", "z-ai-web-dev-sdk", "@prisma/client", "sharp"],
  // v2.55：关闭开发指示器（左下角黑色「N」悬浮球）— 预览面板中遮挡内容且无功能价值
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
