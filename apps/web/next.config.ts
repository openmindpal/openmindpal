import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* ── Performance optimizations ── */

  // Enable React strict mode for catching potential issues
  reactStrictMode: true,

  // Compress responses with gzip
  compress: true,

  // Generate ETags for caching
  generateEtags: true,

  // Optimise package imports – tree-shake large libs
  experimental: {
    optimizePackageImports: ["yjs", "lib0", "y-protocols"],
  },

  // Serve fonts from same origin, avoid extra DNS lookup
  assetPrefix: undefined,

  // Reduce powered-by header
  poweredByHeader: false,

  // Disable dev indicator (bottom-left "N" circle)
  devIndicators: false,
};

export default nextConfig;
