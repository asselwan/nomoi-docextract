import { createClient } from "@supabase/supabase-js";

let cached = null;

/**
 * Lazily build a Supabase client with the service-role key.
 * Service-role bypasses RLS — server-side only, never ship this key to a browser.
 */
export function getSupabase() {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/**
 * Download a file from Supabase Storage and return it as a Buffer plus its
 * detected content type.
 */
export async function downloadFromStorage(bucket, path) {
  const supabase = getSupabase();
  const { data, error } = await supabase.storage.from(bucket).download(path);
  if (error) {
    throw new Error(`storage download failed for ${bucket}/${path}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`storage download returned no data for ${bucket}/${path}`);
  }

  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  // data is a Blob; type may be empty when Storage has no recorded mime.
  const contentType = data.type || mimeFromPath(path);
  return { buffer, contentType };
}

function mimeFromPath(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "heic":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}
