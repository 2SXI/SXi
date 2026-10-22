// Public configuration. The anon key is MEANT to be public — Row Level Security in the
// database is what protects each client's data. NEVER put the service-role key here.
export const CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY",
  // Where "Open Webmail" points once SXI's mail platform exists (e.g. https://mail.sxidigital.com). Empty = button disabled.
  WEBMAIL_URL: "",
  SUPPORT_WHATSAPP: "https://wa.me/263781053299",
};
