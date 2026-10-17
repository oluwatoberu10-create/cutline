import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "@aws-sdk/client-s3", "ffmpeg-static", "@ffprobe-installer/ffprobe"],
  // Bundle the static FFmpeg/FFprobe binaries into the serverless functions (Vercel has no system FFmpeg).
  outputFileTracingIncludes: {
    // @ffprobe-installer resolves its platform package (package.json + binary) at runtime, so include the whole folder.
    "/**": ["./node_modules/ffmpeg-static/ffmpeg", "./node_modules/@ffprobe-installer/**/*"],
  },
  // Media uploads go through the chunked upload API (8 MB parts), not server actions.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
