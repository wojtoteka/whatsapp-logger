import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
    // Panel ma własny package-lock.json, a obok leży ten od loggera.
    // Bez tego Next.js zgaduje, który jest ważniejszy, i sypie ostrzeżeniem.
    outputFileTracingRoot: here,

    // Media serwujemy własnym endpointem: pliki są lokalne i już małe,
    // a optymalizator obrazków tylko by tu przeszkadzał.
    images: { unoptimized: true },
};

export default nextConfig;
