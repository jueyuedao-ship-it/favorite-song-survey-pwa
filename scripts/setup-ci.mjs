// Fail the production publishing job before build when its public API is invalid.
try {
  const value = process.env.VITE_API_BASE_URL;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) ||
    url.pathname !== '/api/v1' || url.search || url.hash ||
    url.username || url.password || (url.port && url.port !== '443') ||
    value.trim() !== value
  ) throw new Error();
  console.log('Public production API URL validated');
} catch {
  console.error('VITE_API_BASE_URL must be a public HTTPS Workers URL ending /api/v1');
  process.exitCode = 1;
}
