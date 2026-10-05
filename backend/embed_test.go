package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDialPublicOnly(t *testing.T) {
	tests := []struct {
		addr   string
		public bool
	}{
		{"8.8.8.8:443", true},
		{"[2606:4700:4700::1111]:443", true},

		{"127.0.0.1:80", false},
		{"[::1]:80", false},
		{"10.0.0.5:80", false},
		{"172.16.0.1:80", false},
		{"192.168.1.1:80", false},
		{"169.254.169.254:80", false}, // cloud metadata
		{"0.0.0.0:80", false},
		{"100.64.0.1:80", false}, // NetBird / Tailscale / carrier-grade NAT
		{"198.18.0.1:80", false},
		{"224.0.0.1:80", false},
		{"[fd00::1]:80", false},
		{"[fe80::1]:80", false},
		{"[::ffff:127.0.0.1]:80", false}, // IPv4 loopback dressed as IPv6
		{"[64:ff9b::7f00:1]:80", false},  // NAT64 to 127.0.0.1
		{"[2002:7f00:1::1]:80", false},   // 6to4 of 127.0.0.1
		{"localhost:80", false},          // a name is never dialed: only resolved addresses are
		{"not-an-address", false},
	}
	for _, tt := range tests {
		err := dialPublicOnly("tcp", tt.addr, nil)
		if tt.public && err != nil {
			t.Errorf("%s refused: %v", tt.addr, err)
		}
		if !tt.public && err == nil {
			t.Errorf("%s allowed", tt.addr)
		}
	}
}

func TestEmbedClientCannotReachLoopback(t *testing.T) {
	hit := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
	}))
	defer srv.Close()

	if res, err := embedGet(t.Context(), srv.URL, "*/*"); err == nil {
		res.Body.Close()
		t.Fatal("fetched a loopback address")
	}
	if hit {
		t.Fatal("the request reached the loopback server")
	}
}

func TestCheckEmbedURL(t *testing.T) {
	for raw, ok := range map[string]bool{
		"https://example.com/a": true,
		"http://example.com":    true,
		"file:///etc/passwd":    false,
		"ftp://example.com":     false,
		"javascript:alert(1)":   false,
		"https://":              false,
		"//example.com":         false,
	} {
		u, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if got := checkEmbedURL(u) == nil; got != ok {
			t.Errorf("%q: allowed=%v, want %v", raw, got, ok)
		}
	}
}

func TestVideoPlayer(t *testing.T) {
	tests := []struct{ page, ogVideo, want string }{
		{"https://www.youtube.com/watch?v=dQw4w9WgXcQ", "", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1"},
		{"https://youtu.be/dQw4w9WgXcQ?t=42", "", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&start=42"},
		{"https://www.youtube.com/shorts/dQw4w9WgXcQ", "", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1"},
		{"https://vimeo.com/123456", "", "https://player.vimeo.com/video/123456?autoplay=1"},
		// The id ends up in a URL we frame, so anything that isn't an id is refused.
		{"https://www.youtube.com/watch?v=x%22%3E%3Cscript", "", ""},
		{"https://www.youtube.com/watch", "", ""},
		// Other sites can name a player, but only Vimeo's is framed.
		{"https://example.com/p", "https://player.vimeo.com/video/9", "https://player.vimeo.com/video/9"},
		{"https://example.com/p", "https://evil.example/player", ""},
		{"https://example.com/p", "http://player.vimeo.com/video/9", ""},
		{"https://example.com/p", "javascript:alert(1)", ""},
	}
	for _, tt := range tests {
		page, err := url.Parse(tt.page)
		if err != nil {
			t.Fatal(err)
		}
		if got := videoPlayer(page, tt.ogVideo); got != tt.want {
			t.Errorf("videoPlayer(%q, %q) = %q, want %q", tt.page, tt.ogVideo, got, tt.want)
		}
	}
}

func TestReadHead(t *testing.T) {
	page := `<!doctype html><html><head>
		<title>The Title</title>
		<META PROPERTY="og:title" content="OG Title">
		<meta name="description" content="Plain description">
		<meta property="og:title" content="second one is ignored">
		<meta itemprop="image" content="/pic.png">
		</head><body><meta property="og:description" content="in the body, ignored"></body></html>`
	meta, title := readHead(strings.NewReader(page))
	if title != "The Title" {
		t.Errorf("title %q", title)
	}
	for key, want := range map[string]string{
		"og:title":       "OG Title",
		"description":    "Plain description",
		"image":          "/pic.png",
		"og:description": "",
	} {
		if meta[key] != want {
			t.Errorf("meta[%q] = %q, want %q", key, meta[key], want)
		}
	}
}

func TestClip(t *testing.T) {
	if got := clip("  a \n b\t c  ", 20); got != "a b c" {
		t.Errorf("whitespace: %q", got)
	}
	if got := clip("abcdefghij", 5); got != "abcd…" {
		t.Errorf("cut: %q", got)
	}
	if got := clip("ééééé", 5); got != "ééééé" {
		t.Errorf("counts characters, not bytes: %q", got)
	}
}

func TestEmbedImageProxyNeedsSignature(t *testing.T) {
	tokenSecret = []byte("test-secret-test-secret-test-secret")
	target := "https://example.com/pic.png"

	good := proxiedImage(target)
	if !strings.Contains(good, "sig="+imageSignature(target)) {
		t.Fatalf("proxied link isn't signed: %s", good)
	}
	if imageSignature(target) == imageSignature(target+"x") {
		t.Fatal("signature doesn't depend on the target")
	}

	for name, query := range map[string]string{
		"no signature":    "url=" + url.QueryEscape(target),
		"wrong signature": "url=" + url.QueryEscape(target) + "&sig=00",
		"signature for another url": "url=" + url.QueryEscape("http://169.254.169.254/") +
			"&sig=" + imageSignature(target),
	} {
		rec := httptest.NewRecorder()
		handleEmbedImage(rec, httptest.NewRequest("GET", "/api/embed/image?"+query, nil))
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s: status %d, want 403", name, rec.Code)
		}
	}
}
