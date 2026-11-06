import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@lms/shared"],
  // Same-origin API calls: the browser talks to /api/v1 here, Next forwards to the Fastify API,
  // so session cookies stay first-party and no CORS is needed.
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${process.env.API_URL ?? "http://127.0.0.1:4000"}/api/v1/:path*` }];
  },
  experimental: {
    optimizePackageImports: ["antd", "@ant-design/icons", "recharts"],
  },
};

export default nextConfig;
