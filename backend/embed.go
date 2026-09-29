package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

// Link previews: the server reads a linked page's title, description and picture (its OpenGraph
// tags) so chat can show a card under the message. Pictures come through the server as well, so
// the linked site never sees who's reading the chat.

const (
	embedTimeout      = 8 * time.Second
	maxEmbedURL       = 2048
	maxEmbedPage      = 1 << 20 // the tags are in <head>; this is plenty
	maxEmbedImage     = 8 << 20
	maxEmbedRedirects = 5
	maxEmbedTitle     = 256
	maxEmbedText      = 350
	embedCacheSize    = 1000
	embedTTL          = 6 * time.Hour
	embedMissTTL      = 30 * time.Minute // pages that had nothing, or failed: retried sooner
	embedUserAgent    = "Mozilla/5.0 (compatible; Gumcord/1.0; link preview)"
)

type embed struct {
	URL         string `json:"url"`
	Kind        string `json:"kind"` // "page", or "image"/"video" for a link straight to a picture or video file
	Site        string `json:"site,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"` // through the image proxy
	Large       bool   `json:"large,omitempty"` // the page asks for a big picture (videos, articles)
	Color       string `json:"color,omitempty"`
	Player string `json:"player,omitempty"` // a video player to frame in the chat (YouTube, Vimeo)
	Video  string `json:"video,omitempty"`  // a video file to play in the chat's own player (X posts, video links)
	Loop   bool   `json:"loop,omitempty"`   // a GIF, which X keeps as a video
}

// ── Fetching only from the public internet ──
// Links come from chat, so without this anyone could have the server read its own network: the
// LiveKit API, the Docker host, the NetBird overlay. Checked on every connection (redirects too)
// against the address actually dialed, so a name can't resolve to a public address and then a private one.

var errPrivateAddress = errors.New("not a public address")

var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"), // carrier-grade NAT, and the NetBird/Tailscale overlays
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("64:ff9b::/96"), // NAT64 can reach any IPv4 address
	netip.MustParsePrefix("64:ff9b:1::/48"),
	netip.MustParsePrefix("2002::/16"), // 6to4 embeds an IPv4 address
}

func dialPublicOnly(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return err
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return errPrivateAddress
	}
	for _, p := range blockedPrefixes {
		if p.Contains(ip) {
			return errPrivateAddress
		}
	}
	return nil
}

func checkEmbedURL(u *url.URL) error {
	if (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("only web links")
	}
	return nil
}

var embedClient = &http.Client{
	Timeout: embedTimeout,
	Transport: &http.Transport{
		Proxy:                 nil, // straight out, so the address check sees the real destination
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, Control: dialPublicOnly}).DialContext,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 5 * time.Second,
		MaxIdleConns:          20,
		IdleConnTimeout:       30 * time.Second,
	},
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= maxEmbedRedirects {
			return errors.New("too many redirects")
		}
		return checkEmbedURL(req.URL)
	},
}

// A few fetches at a time, however many links a busy channel shows.
var embedSlots = make(chan struct{}, 8)

func embedGet(ctx context.Context, target, accept string) (*http.Response, error) {
	select {
	case embedSlots <- struct{}{}:
		defer func() { <-embedSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", embedUserAgent)
	req.Header.Set("Accept", accept)
	res, err := embedClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, errors.New(res.Status)
	}
	return res, nil
}

// ── Reading a page ──

func fetchEmbed(ctx context.Context, target string) (*embed, error) {
	// X shows its posts only to a few crawlers it knows; its embed feed has what a preview needs.
	if u, err := url.Parse(target); err == nil {
		if id := tweetID(u); id != "" {
			return fetchTweet(ctx, target, id)
		}
	}
	res, err := embedGet(ctx, target, "text/html,application/xhtml+xml;q=0.9,image/*;q=0.8")
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	final := res.Request.URL // after redirects: relative picture links resolve against it

	mediaType, _, _ := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if _, ok := imageExts[mediaType]; ok {
		return &embed{URL: target, Kind: "image", Image: proxiedImage(final.String())}, nil
	}
	if videoTypes[mediaType] {
		// Played from its own site, and only once someone presses play (nothing is preloaded).
		return &embed{URL: target, Kind: "video", Video: final.String()}, nil
	}
	if mediaType != "text/html" && mediaType != "application/xhtml+xml" {
		return nil, nil
	}
	body, err := charset.NewReader(io.LimitReader(res.Body, maxEmbedPage), res.Header.Get("Content-Type"))
	if err != nil {
		return nil, err
	}
	meta, title := readHead(body)

	first := func(keys ...string) string {
		for _, k := range keys {
			if v := meta[k]; v != "" {
				return v
			}
		}
		return ""
	}
	e := &embed{
		URL:         target,
		Kind:        "page",
		Site:        clip(first("og:site_name"), maxEmbedTitle),
		Title:       clip(first("og:title", "twitter:title"), maxEmbedTitle),
		Description: clip(first("og:description", "twitter:description", "description"), maxEmbedText),
	}
	if e.Title == "" {
		e.Title = clip(title, maxEmbedTitle)
	}
	if e.Site == "" {
		e.Site = strings.TrimPrefix(final.Hostname(), "www.")
	}
	if img := first("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"); img != "" {
		if u, err := final.Parse(img); err == nil && checkEmbedURL(u) == nil {
			e.Image = proxiedImage(u.String())
		}
	}
	card := first("twitter:card")
	e.Large = e.Image != "" && (card == "summary_large_image" || card == "player")
	if u, err := url.Parse(target); err == nil {
		e.Player = videoPlayer(u, first("og:video:url", "og:video:secure_url", "og:video"))
	}
	if e.Player != "" && e.Image != "" {
		e.Large = true
	}
	if c := first("theme-color"); cssColor.MatchString(c) {
		e.Color = c
	}
	if e.Title == "" && e.Description == "" && e.Image == "" {
		return nil, nil
	}
	return e, nil
}

var cssColor = regexp.MustCompile(`^#(?:[0-9a-fA-F]{3}){1,2}$`)

// Video files browsers play (QuickTime ones when they hold H.264, as phones record).
var videoTypes = map[string]bool{"video/mp4": true, "video/webm": true, "video/ogg": true, "video/quicktime": true}

var (
	youtubeID = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	vimeoID   = regexp.MustCompile(`^/(\d+)/?$`)
	seconds   = regexp.MustCompile(`^(\d+)s?$`)
)

// videoPlayer is the player to embed for a video page, or "". Only YouTube (its privacy-enhanced
// player, which sets no cookies until you press play) and Vimeo: the app and the desktop shell
// allow exactly these players in a frame.
func videoPlayer(page *url.URL, ogVideo string) string {
	host := strings.TrimPrefix(page.Hostname(), "www.")
	switch host {
	case "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be":
		id := page.Query().Get("v")
		if host == "youtu.be" {
			id = strings.Trim(page.Path, "/")
		} else if parts := strings.Split(strings.Trim(page.Path, "/"), "/"); len(parts) == 2 && (parts[0] == "shorts" || parts[0] == "live" || parts[0] == "embed") {
			id = parts[1]
		}
		if !youtubeID.MatchString(id) {
			return ""
		}
		player := "https://www.youtube-nocookie.com/embed/" + id + "?autoplay=1"
		if m := seconds.FindStringSubmatch(page.Query().Get("t")); m != nil {
			player += "&start=" + m[1]
		}
		return player
	case "vimeo.com":
		if m := vimeoID.FindStringSubmatch(page.Path); m != nil {
			return "https://player.vimeo.com/video/" + m[1] + "?autoplay=1"
		}
	}
	// Other sites name their own player; only these two are allowed in a frame.
	if u, err := url.Parse(ogVideo); err == nil && u.Scheme == "https" && u.Hostname() == "player.vimeo.com" {
		return u.String()
	}
	return ""
}

// readHead collects a page's <meta> tags (by property, name or itemprop) and its <title>.
func readHead(r io.Reader) (map[string]string, string) {
	meta := map[string]string{}
	title := ""
	z := html.NewTokenizer(r)
	for {
		switch z.Next() {
		case html.ErrorToken:
			return meta, title
		case html.EndTagToken:
			if name, _ := z.TagName(); string(name) == "head" {
				return meta, title
			}
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			switch string(name) {
			case "body":
				return meta, title
			case "title":
				if title == "" && z.Next() == html.TextToken {
					title = string(z.Text())
				}
			case "meta":
				var key, content string
				for hasAttr {
					var k, v []byte
					k, v, hasAttr = z.TagAttr()
					switch string(k) {
					case "property", "name", "itemprop":
						if key == "" {
							key = strings.ToLower(strings.TrimSpace(string(v)))
						}
					case "content":
						content = string(v)
					}
				}
				if key != "" && meta[key] == "" {
					meta[key] = content
				}
			}
		}
	}
}

// clip tidies whitespace and cuts to n characters.
func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-1])) + "…"
}

// ── Cache: one fetch per link, however many people are reading ──

type embedEntry struct {
	embed   *embed
	expires time.Time
	done    chan struct{} // closed once fetched
}

var embedCache = struct {
	sync.Mutex
	m map[string]*embedEntry
}{m: map[string]*embedEntry{}}

// lookupEmbed answers with the preview (nil when the page has none), or limited when this user has
// asked for too many new pages lately.
func lookupEmbed(r *http.Request, target string) (e *embed, limited bool) {
	ctx := r.Context()
	embedCache.Lock()
	ent := embedCache.m[target]
	if ent != nil {
		select {
		case <-ent.done:
			if time.Now().After(ent.expires) {
				ent = nil
			}
		default: // someone's fetching it right now: wait for theirs
		}
	}
	if ent == nil {
		// Only fetches count, not previews already known.
		if !previewLimit.allow(currentUser(r).ID) {
			embedCache.Unlock()
			return nil, true
		}
		ent = &embedEntry{done: make(chan struct{})}
		pruneEmbedCache()
		embedCache.m[target] = ent
		embedCache.Unlock()

		// Not tied to this request: others may be waiting for the same link.
		fetchCtx, cancel := context.WithTimeout(context.Background(), embedTimeout)
		e, err := fetchEmbed(fetchCtx, target)
		cancel()
		if err != nil && !errors.Is(err, errPrivateAddress) {
			log.Printf("link preview for %s: %v", target, err)
		}
		ttl := embedTTL
		if e == nil {
			ttl = embedMissTTL
		}
		embedCache.Lock()
		ent.embed, ent.expires = e, time.Now().Add(ttl)
		embedCache.Unlock()
		close(ent.done)
		return e, false
	}
	embedCache.Unlock()

	select {
	case <-ent.done:
		embedCache.Lock()
		defer embedCache.Unlock()
		return ent.embed, false
	case <-ctx.Done():
		return nil, false
	}
}

// pruneEmbedCache makes room for one more entry. Called with the lock held.
func pruneEmbedCache() {
	if len(embedCache.m) < embedCacheSize {
		return
	}
	now := time.Now()
	for k, ent := range embedCache.m {
		select {
		case <-ent.done:
			if now.After(ent.expires) {
				delete(embedCache.m, k)
			}
		default:
		}
	}
	for k := range embedCache.m { // still full: drop any one
		if len(embedCache.m) < embedCacheSize {
			break
		}
		delete(embedCache.m, k)
	}
}

// ── Handlers ──

// handleEmbed answers with a link's preview, or 204 when it has none.
func handleEmbed(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	u, err := url.Parse(target)
	if err != nil || len(target) > maxEmbedURL || checkEmbedURL(u) != nil {
		http.Error(w, "not a web link", http.StatusBadRequest)
		return
	}
	e, limited := lookupEmbed(r, u.String())
	if limited {
		tooMany(w)
		return
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if e == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, e)
}

// Picture links are signed, so the proxy only fetches pictures that previews pointed at.
func imageSignature(target string) string {
	mac := hmac.New(sha256.New, tokenSecret)
	mac.Write([]byte("embed-image\x00" + target))
	return hex.EncodeToString(mac.Sum(nil)[:16])
}

func proxiedImage(target string) string {
	return "/api/embed/image?url=" + url.QueryEscape(target) + "&sig=" + imageSignature(target)
}

// handleEmbedImage passes a preview's picture through, if it really is one (no SVG: it can carry script).
func handleEmbedImage(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("url")
	if !hmac.Equal([]byte(r.URL.Query().Get("sig")), []byte(imageSignature(target))) {
		http.Error(w, "unknown picture", http.StatusForbidden)
		return
	}
	res, err := embedGet(r.Context(), target, "image/*")
	if err != nil {
		http.Error(w, "picture unavailable", http.StatusBadGateway)
		return
	}
	defer res.Body.Close()
	if res.ContentLength > maxEmbedImage {
		http.Error(w, "picture too large", http.StatusBadGateway)
		return
	}
	head := make([]byte, 512)
	n, _ := io.ReadFull(res.Body, head)
	head = head[:n]
	contentType := http.DetectContentType(head)
	if _, ok := imageExts[contentType]; !ok {
		http.Error(w, "not a picture", http.StatusBadGateway)
		return
	}
	h := w.Header()
	h.Set("Content-Type", contentType)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; sandbox")
	h.Set("Cache-Control", "private, max-age=86400")
	if res.ContentLength > 0 {
		h.Set("Content-Length", strconv.FormatInt(res.ContentLength, 10))
	}
	w.Write(head)
	io.Copy(w, io.LimitReader(res.Body, maxEmbedImage-int64(n)))
}
