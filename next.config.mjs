/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // pdf-parse pulls in optional deps it doesn't need at runtime here
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
