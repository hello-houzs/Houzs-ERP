import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  /* Houzs ERP — independent webapp */
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
