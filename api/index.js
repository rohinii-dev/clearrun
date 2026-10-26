// Single Vercel function for every /api/... route (see vercel.json rewrites).
// One function keeps routing predictable and stays well under Vercel's function limits.
import { errorResponse, handleApi } from '../lib/api.mjs';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const routed = url.searchParams.get('__route');
    if (routed !== null) {
      url.searchParams.delete('__route');
      const rest = url.searchParams.toString();
      req.url = '/api/' + routed.replace(/^\/+/, '') + (rest ? '?' + rest : '');
    }
    await handleApi(req, res);
  } catch (error) {
    errorResponse(res, error);
  }
}
