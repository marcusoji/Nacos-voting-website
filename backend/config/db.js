const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl        = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const supabaseAnonKey    = process.env.SUPABASE_ANON_KEY?.trim();

if (!supabaseUrl || !supabaseServiceKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.');
}

// Service-role client — bypasses RLS, used for DB reads/writes server-side
const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

// Anon client — used ONLY for user-facing auth (signInWithPassword, signUp)
// Must use anon key so Supabase creates proper user sessions
const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey || supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false }
});

module.exports = { supabase, supabaseAuth };
