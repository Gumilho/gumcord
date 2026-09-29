package main

import (
	"net/http"
	"strings"
)

// Headers on every response: the app can't be framed by another site (clickjacking), browsers
// don't guess content types, and HTTPS sticks once used.
func secureHeaders(next http.Handler) http.Handler {
	https := strings.HasPrefix(publicURL, "https://")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		// Uploads and proxied pictures replace this with their own, stricter policy.
		h.Set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'; base-uri 'self'")
		h.Set("Referrer-Policy", "no-referrer") // see app.html
		h.Set("Permissions-Policy", "geolocation=(), payment=(), usb=()")
		if https {
			h.Set("Strict-Transport-Security", "max-age=31536000")
		}
		next.ServeHTTP(w, r)
	})
}

// Requests other than uploads carry a little JSON or a form; uploads (multipart) have their own limits.
const maxRequestBody = 64 << 10

func limitBodies(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
			r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
		}
		next.ServeHTTP(w, r)
	})
}
