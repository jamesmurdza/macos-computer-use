import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives inside the macos-computer-use repo (a separate directory, deployed as its own
  // Vercel project) but shares no code or dependencies with it. The sibling package-lock.json one
  // level up otherwise makes Turbopack guess at a monorepo root; pin it here instead so that guess
  // never happens.
  turbopack: { root: import.meta.dirname },
  // Lets `next dev`'s HMR websocket work when the app is accessed through the Daytona sandbox's
  // proxy domain instead of localhost directly -- otherwise Next blocks the cross-origin dev
  // request by default, the HMR client never finishes bootstrapping, and the page never hydrates
  // (verified directly: every click handler is silently missing -- not just hot-reload broken).
  // Harmless in production (allowedDevOrigins is a dev-only check). Same fix as the main app's
  // next.config.ts.
  allowedDevOrigins: ["*.daytonaproxy01.net"],
};

export default nextConfig;
