import { createBrowserClient } from "@supabase/ssr";

/**
 * Connexion à Supabase depuis le navigateur (composants "use client").
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
