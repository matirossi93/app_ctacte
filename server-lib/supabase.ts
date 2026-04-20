import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
export const TENANT_ID = process.env.TENANT_ID || '00000000-0000-0000-0000-000000000001';

let _client: SupabaseClient | null = null;
export function sb(): SupabaseClient {
  if (!_client) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY no configurados');
    }
    _client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }
  return _client;
}

export function hasSupabase(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);
}
