import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants.js";

/**
 * Production builds and the production server use their own folder
 * (.next-prod), so running `next build` never overwrites the .next folder a
 * running `next dev` is using — that breaks the dev server with
 * "Cannot find module './NNNN.js'".
 *
 * @param {string} phase
 * @returns {import('next').NextConfig}
 */
export default function nextConfig(phase) {
  return {
    reactStrictMode: true,
    distDir: phase === PHASE_PRODUCTION_BUILD || phase === PHASE_PRODUCTION_SERVER ? ".next-prod" : ".next",
    transpilePackages: ["@podium/ui", "@podium/shared-types"],
    async rewrites() {
      const apiBase = process.env.API_BASE_URL ?? "http://localhost:3001";
      return [{ source: "/api/:path*", destination: `${apiBase}/api/:path*` }];
    },
  };
}
