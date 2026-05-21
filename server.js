import http from "node:http";
import crypto from "node:crypto";

import { extractLabs, extractCard } from "./lib/extract.js";
import { LLMParseError } from "./lib/llm.js";

const PORT = Number(process.env.PORT) || 8080;

const ALLOWED_ORIGINS = new Set([
  "https://healthspan.nomoi.ai",
  "https://frontdesk.nomoi.ai",
]);

const MAX_BODY_BYTES = 1_000_000; // JSON request bodies only — documents come from Storage

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function corsHeaders(origin) {
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function sendJson(res, status, body, origin) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...corsHeaders(origin),
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw === "") return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function isAuthorised(req) {
  // The caller must present the Supabase service-role key. The Healthspan
  // dashboard and the Front Desk clinic view already hold it at runtime —
  // the operator pastes it to read data — and forward it here. It is never
  // baked into client code, so it cannot leak through a public config file.
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!expected) return false; // fail closed if not configured
  const header = req.headers["authorization"] || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(expected);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ------------------------------------------------------------------ *
 * request handler
 * ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  // health
  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true }, origin);
    return;
  }

  const isExtractRoute =
    req.method === "POST" && (path === "/extract/labs" || path === "/extract/card");

  if (!isExtractRoute) {
    sendJson(res, 404, { error: "not found" }, origin);
    return;
  }

  // auth — both POST endpoints
  if (!isAuthorised(req)) {
    sendJson(res, 401, { error: "unauthorized" }, origin);
    return;
  }

  try {
    const body = await readJsonBody(req);

    if (path === "/extract/labs") {
      const result = await extractLabs(body);
      sendJson(res, 200, { ok: true, ...result }, origin);
      return;
    }

    // path === "/extract/card"
    const result = await extractCard(body);
    sendJson(res, 200, { ok: true, ...result }, origin);
  } catch (err) {
    if (err instanceof LLMParseError) {
      sendJson(
        res,
        422,
        { error: "extraction_failed", detail: "the document could not be parsed into structured data" },
        origin,
      );
      return;
    }
    const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
    if (status >= 500) {
      console.error("[docextract] error:", err);
    }
    sendJson(
      res,
      status,
      { error: status >= 500 ? "internal_error" : "bad_request", detail: err?.message || "unexpected error" },
      origin,
    );
  }
});

server.listen(PORT, () => {
  console.log(`[docextract] listening on :${PORT}`);
});
