package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// --- sessions ---

func TestSignedOutRequestsAreRefused(t *testing.T) {
	a := newTestApp(t)
	nobody := &client{app: a}
	for _, path := range []string{"/api/me", "/api/servers", "/api/channels/1/messages", "/api/ws", "/api/embed?url=https://example.com"} {
		if rec := nobody.get(path); rec.Code != http.StatusUnauthorized {
			t.Errorf("GET %s signed out: %d", path, rec.Code)
		}
	}
	if rec := nobody.do("POST", "/api/servers", map[string]string{"name": "x"}); rec.Code != http.StatusUnauthorized {
		t.Errorf("POST /api/servers signed out: %d", rec.Code)
	}
}

func TestSessionCookieChecks(t *testing.T) {
	a := newTestApp(t)
	alice := a.login("alice", false)
	if rec := alice.get("/api/me"); rec.Code != 200 {
		t.Fatalf("a fresh session: %d", rec.Code)
	}

	sessionFor := func(c jwt.RegisteredClaims) *client {
		return &client{app: a, cookie: &http.Cookie{Name: sessionCookie, Value: signToken(c)}}
	}
	valid := func() jwt.RegisteredClaims {
		c := registered("session", time.Hour)
		c.ID = "unknown-session"
		c.Subject = itoa(alice.user.ID)
		return c
	}

	tests := map[string]*client{
		"signed by another key": func() *client {
			c := valid()
			tok, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString([]byte("some other secret"))
			return &client{app: a, cookie: &http.Cookie{Name: sessionCookie, Value: tok}}
		}(),
		"garbage": {app: a, cookie: &http.Cookie{Name: sessionCookie, Value: "not.a.token"}},
		"unsigned (alg none)": func() *client {
			tok, _ := jwt.NewWithClaims(jwt.SigningMethodNone, valid()).SignedString(jwt.UnsafeAllowNoneSignatureType)
			return &client{app: a, cookie: &http.Cookie{Name: sessionCookie, Value: tok}}
		}(),
		"valid signature but no such session row": sessionFor(valid()),
		"expired": func() *client {
			c := valid()
			c.ExpiresAt = jwt.NewNumericDate(time.Now().Add(-time.Minute))
			return sessionFor(c)
		}(),
		"another kind of token (desktop sign-in)": func() *client {
			c := registered("desktop", time.Hour)
			c.ID, c.Subject = "x", itoa(alice.user.ID)
			return sessionFor(c)
		}(),
		"no expiry": func() *client {
			c := valid()
			c.ExpiresAt = nil
			return sessionFor(c)
		}(),
	}
	for name, c := range tests {
		if rec := c.get("/api/me"); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", name, rec.Code)
		}
	}
}

func TestLogoutEndsTheSession(t *testing.T) {
	a := newTestApp(t)
	alice := a.login("alice", false)
	stolen := &client{app: a, cookie: alice.cookie} // someone who copied the cookie

	alice.wantStatus(alice.do("POST", "/api/auth/logout", nil), http.StatusNoContent)
	if rec := stolen.get("/api/me"); rec.Code != http.StatusUnauthorized {
		t.Fatalf("a copied cookie still works after signing out: %d", rec.Code)
	}
	// Another session of the same person is unaffected.
	other := a.login("alice", false)
	if rec := other.get("/api/me"); rec.Code != 200 {
		t.Fatalf("signing out ended a different session: %d", rec.Code)
	}
}

func TestSessionCookieAttributes(t *testing.T) {
	a := newTestApp(t)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, httptest.NewRequest("GET", "/api/auth/dev?name=alice", nil))
	var found bool
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie {
			found = true
			if !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Path != "/" {
				t.Errorf("cookie attributes: %+v", c)
			}
		}
	}
	if !found {
		t.Fatal("no session cookie")
	}
}

func TestDevLoginIsOffUnlessEnabled(t *testing.T) {
	a := newTestApp(t)
	devLogin = false
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, httptest.NewRequest("GET", "/api/auth/dev?name=mallory&admin=1", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("dev login with DEV_LOGIN unset: %d", rec.Code)
	}
}

func TestDevLoginRejectsBadNames(t *testing.T) {
	a := newTestApp(t)
	for _, name := range []string{"", "   ", strings.Repeat("x", 33)} {
		rec := httptest.NewRecorder()
		a.handler.ServeHTTP(rec, httptest.NewRequest("GET", "/api/auth/dev?name="+url.QueryEscape(name), nil))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("name %q: %d", name, rec.Code)
		}
	}
}

// --- servers and access ---

func TestOnlyAdminsCreateServers(t *testing.T) {
	a := newTestApp(t)
	alice := a.login("alice", false)
	admin := a.login("admin", true)

	alice.wantStatus(alice.do("POST", "/api/servers", map[string]string{"name": "mine"}), http.StatusForbidden)
	admin.wantStatus(admin.do("POST", "/api/servers", map[string]string{"name": "ok"}), http.StatusOK)
	admin.wantStatus(admin.do("POST", "/api/servers", map[string]string{"name": ""}), http.StatusBadRequest)
	admin.wantStatus(admin.do("POST", "/api/servers", map[string]string{"name": strings.Repeat("x", 65)}), http.StatusBadRequest)

	for _, req := range []struct{ method, path string }{
		{"PATCH", "/api/servers/1"}, {"DELETE", "/api/servers/1"}, {"GET", "/api/users"},
		{"PATCH", "/api/channels/1"}, {"DELETE", "/api/channels/1"},
		{"PUT", "/api/servers/1/members/1"}, {"DELETE", "/api/servers/1/members/1"},
		{"POST", "/api/servers/1/channels"},
	} {
		if rec := alice.do(req.method, req.path, map[string]string{"name": "x"}); rec.Code != http.StatusForbidden {
			t.Errorf("%s %s as a member: %d, want 403", req.method, req.path, rec.Code)
		}
	}
}

func TestServerVisibilityFollowsMembership(t *testing.T) {
	a := newTestApp(t)
	admin := a.login("admin", true)
	alice := a.login("alice", false)
	bob := a.login("bob", false)

	serverID, channelID := a.newServer(admin, "Secret club")
	a.addMember(admin, serverID, alice)
	base := "/api/servers/" + itoa(serverID)

	// A member sees it; an outsider gets "not found", not "forbidden", so it doesn't reveal it exists.
	alice.wantStatus(alice.get(base+"/channels"), 200)
	alice.wantStatus(alice.get("/api/channels/"+itoa(channelID)+"/messages"), 200)
	alice.wantStatus(alice.get(base+"/members"), 200)
	for _, path := range []string{base + "/channels", base + "/members", "/api/channels/" + itoa(channelID) + "/messages"} {
		bob.wantStatus(bob.get(path), http.StatusNotFound)
	}
	if got := bob.get("/api/servers").Body.String(); strings.Contains(got, "Secret club") {
		t.Errorf("an outsider's server list shows it: %s", got)
	}
	if got := alice.get("/api/servers").Body.String(); !strings.Contains(got, "Secret club") {
		t.Errorf("a member's server list is missing it: %s", got)
	}

	// Admins see every server, member or not.
	other := a.login("admin2", true)
	other.wantStatus(other.get(base+"/channels"), 200)

	// Removing someone takes access away straight away.
	admin.wantStatus(admin.do("DELETE", base+"/members/"+itoa(alice.user.ID), nil), http.StatusNoContent)
	alice.wantStatus(alice.get(base+"/channels"), http.StatusNotFound)
	alice.wantStatus(alice.get("/api/channels/"+itoa(channelID)+"/messages"), http.StatusNotFound)
}

func TestChannelAccess(t *testing.T) {
	a := newTestApp(t)
	admin := a.login("admin", true)
	alice := a.login("alice", false)
	bob := a.login("bob", false)
	serverID, textID := a.newServer(admin, "S")
	a.addMember(admin, serverID, alice)

	var voiceID int64
	db.QueryRow(`SELECT id FROM channels WHERE server_id = ? AND kind = 'voice'`, serverID).Scan(&voiceID)

	for _, tt := range []struct {
		who        *client
		channel    int64
		wantOK     bool
		wantKind   string
		wantServer int64
	}{
		{alice, textID, true, "text", serverID},
		{alice, voiceID, true, "voice", serverID},
		{admin, textID, true, "text", serverID},
		{bob, textID, false, "text", serverID},
		{alice, 99999, false, "", 0},
	} {
		sid, kind, ok := channelAccess(tt.who.user, tt.channel)
		if ok != tt.wantOK || kind != tt.wantKind || sid != tt.wantServer {
			t.Errorf("%s on channel %d: (%d, %q, %v)", tt.who.user.Name, tt.channel, sid, kind, ok)
		}
	}
	if got := visibleChannels(bob.user); len(got) != 0 {
		t.Errorf("bob sees %v", got)
	}
	if got := visibleChannels(alice.user); !got[textID] || !got[voiceID] || len(got) != 2 {
		t.Errorf("alice sees %v", got)
	}
}

func TestChannelNamesAreUniquePerServer(t *testing.T) {
	a := newTestApp(t)
	admin := a.login("admin", true)
	one, _ := a.newServer(admin, "one")
	two, _ := a.newServer(admin, "two")

	make := func(server int64, name, kind string) int {
		return admin.do("POST", "/api/servers/"+itoa(server)+"/channels", map[string]string{"name": name, "kind": kind}).Code
	}
	if c := make(one, "memes", "text"); c != 200 {
		t.Fatalf("create: %d", c)
	}
	if c := make(one, "memes", "text"); c != http.StatusConflict {
		t.Errorf("duplicate in the same server: %d, want 409", c)
	}
	if c := make(two, "memes", "text"); c != 200 {
		t.Errorf("same name in another server: %d", c)
	}
	if c := make(one, "x", "stage"); c != http.StatusBadRequest {
		t.Errorf("unknown kind: %d", c)
	}
}

// --- messages ---

func TestHistoryIsTheLatestFiftyInOrder(t *testing.T) {
	a := newTestApp(t)
	admin := a.login("admin", true)
	_, ch := a.newServer(admin, "S")
	for i := range 60 {
		a.addMessage(ch, admin, "m"+itoa(int64(i)))
	}

	var msgs []wsMsg
	rec := admin.get("/api/channels/" + itoa(ch) + "/messages")
	admin.wantStatus(rec, 200)
	if err := json.Unmarshal(rec.Body.Bytes(), &msgs); err != nil {
		t.Fatal(err)
	}
	if len(msgs) != 50 || msgs[0].Content != "m10" || msgs[49].Content != "m59" {
		t.Fatalf("%d messages, first %q last %q", len(msgs), msgs[0].Content, msgs[len(msgs)-1].Content)
	}
}

func TestEditAndDeleteMessages(t *testing.T) {
	a := newTestApp(t)
	admin := a.login("admin", true)
	alice := a.login("alice", false)
	bob := a.login("bob", false)
	outsider := a.login("outsider", false)
	serverID, ch := a.newServer(admin, "S")
	a.addMember(admin, serverID, alice)
	a.addMember(admin, serverID, bob)

	msg := a.addMessage(ch, alice, "original")
	path := "/api/messages/" + itoa(msg)
	content := func() (c string, edited bool) {
		var at *string
		db.QueryRow(`SELECT content, edited_at FROM messages WHERE id = ?`, msg).Scan(&c, &at)
		return c, at != nil
	}

	// Only the author edits.
	bob.wantStatus(bob.do("PATCH", path, map[string]string{"content": "hijacked"}), http.StatusForbidden)
	admin.wantStatus(admin.do("PATCH", path, map[string]string{"content": "hijacked"}), http.StatusForbidden)
	outsider.wantStatus(outsider.do("PATCH", path, map[string]string{"content": "hijacked"}), http.StatusNotFound)
	if c, edited := content(); c != "original" || edited {
		t.Fatalf("someone else's edit went through: %q", c)
	}

	alice.wantStatus(alice.do("PATCH", path, map[string]string{"content": "   "}), http.StatusBadRequest)
	alice.wantStatus(alice.do("PATCH", path, map[string]string{"content": strings.Repeat("x", maxMessageLen+1)}), http.StatusBadRequest)
	alice.wantStatus(alice.do("PATCH", path, map[string]string{"content": "fixed"}), http.StatusNoContent)
	if c, edited := content(); c != "fixed" || !edited {
		t.Fatalf("after editing: %q, edited=%v", c, edited)
	}

	// Only the author or an admin deletes.
	bob.wantStatus(bob.do("DELETE", path, nil), http.StatusForbidden)
	outsider.wantStatus(outsider.do("DELETE", path, nil), http.StatusNotFound)
	admin.wantStatus(admin.do("DELETE", path, nil), http.StatusNoContent)
	alice.wantStatus(alice.do("DELETE", path, nil), http.StatusNotFound)

	own := a.addMessage(ch, bob, "mine")
	bob.wantStatus(bob.do("DELETE", "/api/messages/"+itoa(own), nil), http.StatusNoContent)
}

func TestRemovedMemberCannotEditOldMessages(t *testing.T) {
	a := newTestApp(t)
	admin := a.login("admin", true)
	alice := a.login("alice", false)
	serverID, ch := a.newServer(admin, "S")
	a.addMember(admin, serverID, alice)
	msg := a.addMessage(ch, alice, "hi")

	admin.wantStatus(admin.do("DELETE", "/api/servers/"+itoa(serverID)+"/members/"+itoa(alice.user.ID), nil), http.StatusNoContent)
	alice.wantStatus(alice.do("PATCH", "/api/messages/"+itoa(msg), map[string]string{"content": "still here"}), http.StatusNotFound)
	alice.wantStatus(alice.do("DELETE", "/api/messages/"+itoa(msg), nil), http.StatusNotFound)
}

func TestEditingLeavesAttachmentOnlyMessagesAlone(t *testing.T) {
	a := newTestApp(t)
	admin := a.login("admin", true)
	_, ch := a.newServer(admin, "S")
	var id int64
	db.QueryRow(`INSERT INTO messages (channel_id, user_id, content, attachment_url, attachment_type)
		VALUES (?, ?, '', '/files/x.png', 'image') RETURNING id`, ch, admin.user.ID).Scan(&id)

	// A message with a picture may have its text cleared; one with nothing may not.
	admin.wantStatus(admin.do("PATCH", "/api/messages/"+itoa(id), map[string]string{"content": ""}), http.StatusNoContent)
	plain := a.addMessage(ch, admin, "text")
	admin.wantStatus(admin.do("PATCH", "/api/messages/"+itoa(plain), map[string]string{"content": ""}), http.StatusBadRequest)
}

// --- requests ---

func TestMalformedJSONIsRefusedNotTreatedAsEmpty(t *testing.T) {
	a := newTestApp(t)
	alice := a.login("alice", false)
	alice.wantStatus(alice.do("PATCH", "/api/me", map[string]string{"name": "Ally"}), 200)

	req := httptest.NewRequest("PATCH", "/api/me", strings.NewReader("{not json"))
	req.Header.Set("Content-Type", "application/json")
	alice.wantStatus(alice.send(req), http.StatusBadRequest)
	// An empty name would reset it to the provider's; a garbled request must not do that.
	if got := alice.get("/api/me").Body.String(); !strings.Contains(got, "Ally") {
		t.Fatalf("a bad request changed the name: %s", got)
	}
}

func TestLargeJSONBodiesAreRefused(t *testing.T) {
	a := newTestApp(t)
	admin := a.login("admin", true)
	rec := admin.do("POST", "/api/servers", map[string]string{"name": strings.Repeat("x", maxRequestBody+1)})
	if rec.Code < 400 {
		t.Fatalf("a %d byte body was accepted: %d", maxRequestBody+1, rec.Code)
	}
}

func TestChangesAreRateLimited(t *testing.T) {
	a := newTestApp(t)
	changeLimit = newLimiter(0.001, 3)
	alice := a.login("alice", false)

	var limited int
	for range 6 {
		if alice.do("PATCH", "/api/me", map[string]string{"name": "x"}).Code == http.StatusTooManyRequests {
			limited++
		}
	}
	if limited != 3 {
		t.Fatalf("%d of 6 changes limited, want 3", limited)
	}
	// Reading isn't a change.
	alice.wantStatus(alice.get("/api/me"), 200)
}

func TestSecurityHeaders(t *testing.T) {
	a := newTestApp(t)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, httptest.NewRequest("GET", "/api/nothing-here", nil))
	h := rec.Header()
	if h.Get("X-Frame-Options") != "DENY" || h.Get("X-Content-Type-Options") != "nosniff" ||
		!strings.Contains(h.Get("Content-Security-Policy"), "frame-ancestors 'none'") || h.Get("Referrer-Policy") != "no-referrer" {
		t.Errorf("headers: %v", h)
	}
	if rec.Code != http.StatusNotFound {
		t.Errorf("unknown API paths must 404, not fall through to the app: %d", rec.Code)
	}
}

func TestSameOrigin(t *testing.T) {
	publicURL = "https://chat.example.com"
	t.Cleanup(func() { publicURL = "" })
	tests := []struct {
		name    string
		headers map[string]string
		host    string
		want    bool
	}{
		{"same-origin fetch", map[string]string{"Sec-Fetch-Site": "same-origin"}, "x", true},
		{"typed into the address bar", map[string]string{"Sec-Fetch-Site": "none"}, "x", true},
		{"another site", map[string]string{"Sec-Fetch-Site": "cross-site"}, "x", false},
		{"another subdomain", map[string]string{"Sec-Fetch-Site": "same-site"}, "x", false},
		{"no metadata, no origin (not a browser)", nil, "x", true},
		{"no metadata, public origin", map[string]string{"Origin": "https://chat.example.com"}, "x", true},
		{"no metadata, same host", map[string]string{"Origin": "http://localhost:8080"}, "localhost:8080", true},
		{"no metadata, other origin", map[string]string{"Origin": "https://evil.example"}, "chat.example.com", false},
	}
	for _, tt := range tests {
		r := httptest.NewRequest("GET", "/api/ws", nil)
		r.Host = tt.host
		for k, v := range tt.headers {
			r.Header.Set(k, v)
		}
		if got := sameOrigin(r); got != tt.want {
			t.Errorf("%s: %v, want %v", tt.name, got, tt.want)
		}
	}
}

// --- uploads ---

func TestUploadsAreNeverServedAsActiveContent(t *testing.T) {
	a := newTestApp(t)
	alice := a.login("alice", false)

	upload := func(name string, data []byte) map[string]string {
		rec := alice.upload("POST", "/api/upload", name, data)
		alice.wantStatus(rec, 200)
		var out map[string]string
		json.Unmarshal(rec.Body.Bytes(), &out)
		return out
	}

	// A picture named .html is stored as the picture it is.
	img := upload("page.html", tinyPNG)
	if img["type"] != "image" || !strings.HasSuffix(img["url"], ".png") {
		t.Fatalf("png named .html: %v", img)
	}

	// SVG can carry script, so it's a plain file: downloaded, and sandboxed if opened anyway.
	svg := upload("pic.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`))
	if svg["type"] != "file" {
		t.Fatalf("svg: %v", svg)
	}
	rec := alice.get(svg["url"])
	alice.wantStatus(rec, 200)
	if rec.Header().Get("Content-Disposition") != "attachment" || !strings.Contains(rec.Header().Get("Content-Security-Policy"), "sandbox") {
		t.Errorf("svg served inline: %v", rec.Header())
	}
	if rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Error("no nosniff on uploads")
	}

	// HTML too.
	html := upload("x.html", []byte("<!doctype html><script>alert(1)</script>"))
	rec = alice.get(html["url"])
	if rec.Header().Get("Content-Disposition") != "attachment" {
		t.Errorf("html served inline: %v", rec.Header())
	}

	// Real pictures display inline.
	rec = alice.get(img["url"])
	if rec.Header().Get("Content-Disposition") != "" || rec.Header().Get("Content-Type") != "image/png" {
		t.Errorf("picture headers: %v", rec.Header())
	}
}

func TestUploadsCannotEscapeTheFolder(t *testing.T) {
	a := newTestApp(t)
	alice := a.login("alice", false)
	for _, path := range []string{"/files/../gumcord.db", "/files/%2e%2e/gumcord.db", "/files/..%2fgumcord.db", "/files/"} {
		rec := alice.get(path)
		if rec.Code == 200 {
			t.Errorf("GET %s: 200", path)
		}
	}
}

func TestProfilePicturesMustBePictures(t *testing.T) {
	a := newTestApp(t)
	alice := a.login("alice", false)

	alice.wantStatus(alice.upload("PUT", "/api/me/avatar", "me.png", []byte("not a picture")), http.StatusBadRequest)
	alice.wantStatus(alice.upload("PUT", "/api/me/avatar", "me.svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`)), http.StatusBadRequest)

	rec := alice.upload("PUT", "/api/me/avatar", "me.png", tinyPNG)
	alice.wantStatus(rec, 200)
	var u user
	json.Unmarshal(rec.Body.Bytes(), &u)
	if !strings.HasPrefix(u.Avatar, "/files/avatar-") {
		t.Fatalf("avatar %q", u.Avatar)
	}
	alice.wantStatus(alice.do("DELETE", "/api/me/avatar", nil), 200)
}

func TestUploadsAreRateLimited(t *testing.T) {
	a := newTestApp(t)
	uploadLimit = newLimiter(0.001, 2)
	alice := a.login("alice", false)
	var limited int
	for range 4 {
		if alice.upload("POST", "/api/upload", "a.png", tinyPNG).Code == http.StatusTooManyRequests {
			limited++
		}
	}
	if limited != 2 {
		t.Fatalf("%d of 4 uploads limited, want 2", limited)
	}
}
