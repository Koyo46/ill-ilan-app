import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicEnv } from "./env";

let browserClient: ReturnType<typeof createClient> | null = null;

export const getSupabaseBrowserClient = () => {
  if (!browserClient) {
    const { supabaseUrl, supabaseAnonKey } = getSupabasePublicEnv();
    browserClient = createClient(supabaseUrl, supabaseAnonKey);
  }
  return browserClient;
};
