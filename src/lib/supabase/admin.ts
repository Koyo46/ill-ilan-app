import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicEnv, getSupabaseServiceRoleKey } from "./env";

export const getSupabaseAdminClient = () => {
  const { supabaseUrl } = getSupabasePublicEnv();
  const supabaseServiceRoleKey = getSupabaseServiceRoleKey();
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
};
