package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// wsConn is one open chat connection to a real HTTP server.
type wsConn struct {
	t       *testing.T
	conn    *websocket.Conn
	lastErr error            // why the last wait ended without a match
	seen    []map[string]any // everything read so far, for failure messages
}

func (a *testApp) startServer() *httptest.Server {
	srv := httptest.NewServer(a.handler)
	a.t.Cleanup(srv.Close)
	return srv
}

// connect opens the chat socket as c, with extra headers (a browser's own, such as Origin).
func (c *client) connect(srv *httptest.Server, header http.Header) (*wsConn, *http.Response, error) {
	if header == nil {
		header = http.Header{}
	}
	if c.cookie != nil {
		header.Set("Cookie", c.cookie.String())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, res, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(srv.URL, "http")+"/api/ws", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return nil, res, err
	}
	w := &wsConn{t: c.app.t, conn: conn}
	c.app.t.Cleanup(func() { conn.CloseNow() })
	return w, res, nil
}

// mustConnect opens the socket and waits until the server has registered it. A finished handshake
// isn't that: the server says who's online as soon as it has, and anything broadcast before then
// would be missed.
func (c *client) mustConnect(srv *httptest.Server) *wsConn {
	c.app.t.Helper()
	w, _, err := c.connect(srv, nil)
	if err != nil {
		c.app.t.Fatalf("%s connecting: %v", c.user.Name, err)
	}
	w.mustGet(hasType("online"))
	return w
}

func (w *wsConn) say(channel int64, content string) {
	w.sayWith(map[string]any{"channel_id": channel, "content": content})
}

func (w *wsConn) sayWith(msg map[string]any) {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := wsjson.Write(ctx, w.conn, msg); err != nil {
		w.t.Fatal(err)
	}
}

// next waits for the next event for which match is true, skipping presence and the like.
func (w *wsConn) next(wait time.Duration, match func(map[string]any) bool) (map[string]any, bool) {
	w.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), wait)
	defer cancel()
	for {
		var ev map[string]any
		if err := wsjson.Read(ctx, w.conn, &ev); err != nil {
			w.lastErr = err
			return nil, false
		}
		w.seen = append(w.seen, ev)
		if match(ev) {
			return ev, true
		}
	}
}

func hasContent(want string) func(map[string]any) bool {
	return func(ev map[string]any) bool { return ev["content"] == want }
}

func hasType(want string) func(map[string]any) bool {
	return func(ev map[string]any) bool { return ev["type"] == want }
}

func (w *wsConn) mustGet(match func(map[string]any) bool) map[string]any {
	w.t.Helper()
	ev, ok := w.next(3*time.Second, match)
	if !ok {
		w.t.Fatalf("the expected event never arrived (%v); saw %v", w.lastErr, w.seen)
	}
	return ev
}

func (w *wsConn) mustNotGet(match func(map[string]any) bool) {
	w.t.Helper()
	if ev, ok := w.next(300*time.Millisecond, match); ok {
		w.t.Fatalf("received something it shouldn't have: %v", ev)
	}
}

func messageCount(channel int64) (n int) {
	db.QueryRow(`SELECT COUNT(*) FROM messages WHERE channel_id = ?`, channel).Scan(&n)
	return n
}

type chatFixture struct {
	app                                 *testApp
	srv                                 *httptest.Server
	admin, alice, bob, outsider         *client
	serverID, textChannel, voiceChannel int64
}

// A server with alice and bob in it, and an outsider who isn't.
func newChatFixture(t *testing.T) chatFixture {
	a := newTestApp(t)
	f := chatFixture{app: a, srv: a.startServer()}
	f.admin = a.login("admin", true)
	f.alice = a.login("alice", false)
	f.bob = a.login("bob", false)
	f.outsider = a.login("outsider", false)
	f.serverID, f.textChannel = a.newServer(f.admin, "S")
	a.addMember(f.admin, f.serverID, f.alice)
	a.addMember(f.admin, f.serverID, f.bob)
	db.QueryRow(`SELECT id FROM channels WHERE server_id = ? AND kind = 'voice'`, f.serverID).Scan(&f.voiceChannel)
	return f
}

func TestWebSocketNeedsASession(t *testing.T) {
	a := newTestApp(t)
	srv := a.startServer()
	_, res, err := (&client{app: a}).connect(srv, nil)
	if err == nil || res == nil || res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("signed out: err=%v res=%v", err, res)
	}
}

func TestWebSocketRefusesOtherSites(t *testing.T) {
	a := newTestApp(t)
	srv := a.startServer()
	alice := a.login("alice", false)
	// A page on another site can make the browser open the socket with alice's cookie.
	_, res, err := alice.connect(srv, http.Header{"Sec-Fetch-Site": {"cross-site"}, "Origin": {"https://evil.example"}})
	if err == nil || res == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-site socket: err=%v res=%v", err, res)
	}
	if _, _, err := alice.connect(srv, http.Header{"Sec-Fetch-Site": {"same-origin"}}); err != nil {
		t.Fatalf("same-origin socket: %v", err)
	}
}

func TestMessagesReachTheServersMembersOnly(t *testing.T) {
	f := newChatFixture(t)
	alice, bob, outsider := f.alice.mustConnect(f.srv), f.bob.mustConnect(f.srv), f.outsider.mustConnect(f.srv)

	alice.say(f.textChannel, "hello")
	got := bob.mustGet(hasContent("hello"))
	if got["author"] != "alice" || got["channel_id"] != float64(f.textChannel) || got["id"] == nil {
		t.Fatalf("event: %v", got)
	}
	alice.mustGet(hasContent("hello")) // the sender sees it come back
	outsider.mustNotGet(hasContent("hello"))

	var stored string
	db.QueryRow(`SELECT content FROM messages WHERE channel_id = ?`, f.textChannel).Scan(&stored)
	if stored != "hello" {
		t.Fatalf("stored %q", stored)
	}
}

func TestMessagesFromNonMembersAndOtherChannelKindsAreDropped(t *testing.T) {
	f := newChatFixture(t)
	alice, outsider := f.alice.mustConnect(f.srv), f.outsider.mustConnect(f.srv)

	outsider.say(f.textChannel, "let me in")                       // not a member
	alice.say(f.voiceChannel, "text in a voice channel")           // voice channels have no chat
	alice.say(99999, "nowhere")                                    // no such channel
	alice.say(f.textChannel, "   ")                                // nothing to send
	alice.say(f.textChannel, strings.Repeat("x", maxMessageLen+1)) // too long
	alice.say(f.textChannel, "this one is fine")
	alice.mustGet(hasContent("this one is fine"))

	if n := messageCount(f.textChannel) + messageCount(f.voiceChannel); n != 1 {
		t.Fatalf("%d messages stored, want only the valid one", n)
	}
}

func TestRemovedMemberStopsBeingHeardWithoutReconnecting(t *testing.T) {
	f := newChatFixture(t)
	alice, bob := f.alice.mustConnect(f.srv), f.bob.mustConnect(f.srv)

	alice.say(f.textChannel, "before")
	bob.mustGet(hasContent("before"))

	f.admin.wantStatus(f.admin.do("DELETE", "/api/servers/"+itoa(f.serverID)+"/members/"+itoa(f.alice.user.ID), nil), http.StatusNoContent)
	alice.say(f.textChannel, "after")
	bob.say(f.textChannel, "sentinel")
	bob.mustGet(hasContent("sentinel"))
	bob.mustNotGet(hasContent("after"))
	alice.mustNotGet(hasContent("sentinel")) // and doesn't hear the server either
}

func TestAttachmentsMustPointAtTheUploadFolder(t *testing.T) {
	f := newChatFixture(t)
	alice := f.alice.mustConnect(f.srv)

	tests := []struct {
		name      string
		url, kind string
		wantURL   string
		wantKind  string
	}{
		{"own upload", "/files/abc.png", "image", "/files/abc.png", "image"},
		{"video", "/files/abc.mp4", "video", "/files/abc.mp4", "video"},
		{"unknown type becomes a file", "/files/abc.zip", "executable", "/files/abc.zip", "file"},
		{"another site", "https://evil.example/x.png", "image", "", ""},
		{"protocol-relative", "//evil.example/x.png", "image", "", ""},
		{"escaping the folder", "/files/../gumcord.db", "file", "", ""},
		{"script url", "javascript:alert(1)", "image", "", ""},
		{"fake sticker", "/files/abc.png", "sticker", "/files/abc.png", "image"},
		{"real sticker", "/files/sticker-abc.png", "sticker", "/files/sticker-abc.png", "sticker"},
	}
	for i, tt := range tests {
		content := "attachment test " + itoa(int64(i))
		alice.sayWith(map[string]any{
			"channel_id": f.textChannel, "content": content, "attachment_url": tt.url, "attachment_type": tt.kind,
		})
		alice.mustGet(hasContent(content))

		var url, kind string
		db.QueryRow(`SELECT attachment_url, attachment_type FROM messages WHERE content = ?`, content).Scan(&url, &kind)
		if url != tt.wantURL || kind != tt.wantKind {
			t.Errorf("%s: stored (%q, %q), want (%q, %q)", tt.name, url, kind, tt.wantURL, tt.wantKind)
		}
	}
}

func TestChatIsRateLimited(t *testing.T) {
	f := newChatFixture(t)
	messageLimit = newLimiter(0.001, 3)
	alice := f.alice.mustConnect(f.srv)

	for i := range 6 {
		alice.say(f.textChannel, "spam "+itoa(int64(i)))
	}
	for i := range 3 {
		alice.mustGet(hasContent("spam " + itoa(int64(i))))
	}
	alice.mustNotGet(func(ev map[string]any) bool { return ev["content"] != nil })
	if n := messageCount(f.textChannel); n != 3 {
		t.Fatalf("%d messages stored, want 3", n)
	}
}

func TestEditsAndDeletesAreBroadcast(t *testing.T) {
	f := newChatFixture(t)
	alice, bob := f.alice.mustConnect(f.srv), f.bob.mustConnect(f.srv)
	outsider := f.outsider.mustConnect(f.srv)
	id := f.app.addMessage(f.textChannel, f.alice, "first draft")
	path := "/api/messages/" + itoa(id)

	f.alice.wantStatus(f.alice.do("PATCH", path, map[string]string{"content": "second draft"}), http.StatusNoContent)
	ev := bob.mustGet(hasType("message_edited"))
	if ev["content"] != "second draft" || ev["id"] != float64(id) {
		t.Fatalf("edit event: %v", ev)
	}
	alice.mustGet(hasType("message_edited"))

	f.admin.wantStatus(f.admin.do("DELETE", path, nil), http.StatusNoContent)
	if ev := bob.mustGet(hasType("message_deleted")); ev["id"] != float64(id) {
		t.Fatalf("delete event: %v", ev)
	}
	outsider.mustNotGet(func(ev map[string]any) bool { return ev["type"] == "message_edited" || ev["type"] == "message_deleted" })
}

func TestTooManyConnectionsPerUser(t *testing.T) {
	a := newTestApp(t)
	srv := a.startServer()
	alice := a.login("alice", false)
	for range maxConnsPerUser {
		alice.mustConnect(srv)
	}
	// The next one is accepted and then closed with a policy violation.
	extra, _, err := alice.connect(srv, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		if _, _, err := extra.conn.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
				t.Fatalf("closed with %v (status %d)", err, websocket.CloseStatus(err))
			}
			return
		}
	}
}
