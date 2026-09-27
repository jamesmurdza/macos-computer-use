import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives inside the macos-computer-use repo (a separate directory, deployed as its own
  // Vercel project) but shares no code or dependencies with it. The sibling package-lock.json one
  // level up otherwise makes Turbopack guess at a monorepo root; pin it here instead so that guess
  // never happens.
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
