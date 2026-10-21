import { handleOAuth } from '../../../oauth-core.mjs';
export async function onRequest({ request, env }) { return handleOAuth(request, env); }
