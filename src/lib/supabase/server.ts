import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Connexion à Supabase côté serveur (Server Components, Server Functions, Route Handlers).
 * Créer un nouveau client à chaque requête : ne pas le stocker dans une variable globale.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Appelé depuis un Server Component : les cookies ne peuvent pas être modifiés ici.
          }
        },
      },
    },
  );
}
