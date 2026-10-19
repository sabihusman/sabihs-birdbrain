/** Single source of truth for the API host; change VITE_API_BASE_URL (or this default) when a custom domain arrives. */
export const API_BASE_URL = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'https://bird-brain.duckdns.org').replace(/\/+$/, '');
