import type { NextConfig } from "next";

const backendOrigin = process.env.CLAWBIT_BACKEND_URL?.trim().replace(/\/+$/, "");

if (backendOrigin) {
  let backendUrl: URL;

  try {
    backendUrl = new URL(backendOrigin);
  } catch {
    throw new Error("CLAWBIT_BACKEND_URL must be a valid absolute URL.");
  }

  const isLocalHttp =
    backendUrl.protocol === "http:" &&
    (backendUrl.hostname === "localhost" ||
      backendUrl.hostname === "127.0.0.1");

  if (backendUrl.protocol !== "https:" && !isLocalHttp) {
    throw new Error("CLAWBIT_BACKEND_URL must use HTTPS outside local development.");
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["192.168.1.100"],
  turbopack: {
    root: process.cwd(),
  },
  async rewrites() {
    if (!backendOrigin) {
      return [];
    }

    return [
      {
        // The browser keeps calling same-origin /api/*.
        // The backend receives the original FastAPI route without /api.
        source: "/api/:path*",
        destination: `${backendOrigin}/:path*`,
      },
    ];
  },
};

export default nextConfig;
