package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestMain(m *testing.M) {
	// Nothing in the tests may reach a real LiveKit, whatever happens to run on this machine: its
	// address is somewhere nothing listens. Set once, as in production, because background work
	// from one test (a profile change updates the calls) can still be reading them in the next.
	lkAPIKey, lkAPISecret = "test-key", "test-secret-test-secret-test-secret"
	livekitAPIURL = "http://127.0.0.1:1"
	flag.Parse()
	if !testing.Verbose() {
		log.SetOutput(io.Discard) // every test migrates a new database, which logs ten lines
	}
	os.Exit(m.Run())
}

// testApp is the whole backend on a fresh database in a temporary folder. The backend keeps its
// state in package variables, so tests that use one can't run in parallel.
type testApp struct {
	t       *testing.T
	handler http.Handler
}

// newTestApp resets the package state a test could touch: the database, uploads, login settings
// and rate limits.
func newTestApp(t *testing.T) *testApp {
	t.Helper()
	dir := t.TempDir()
	uploadDir = filepath.Join(dir, "uploads")
	if err := os.MkdirAll(uploadDir, 0o755); err != nil {
		t.Fatal(err)
	}
	tokenSecret = []byte("test-secret-test-secret-test-secret")
	devLogin = true
	publicURL = ""
	initDB(dir)

	// Each test starts with full buckets, as a new server would, whatever earlier tests spent.
	saved := []**limiter{&changeLimit, &uploadLimit, &messageLimit, &previewLimit, &desktopStartLimit}
	old := make([]*limiter, len(saved))
	for i, l := range saved {
		old[i] = *l
		*l = newLimiter((*l).rate, int((*l).burst))
	}
	t.Cleanup(func() {
		// Sockets the test opened are closed by now, but their handlers may still be winding down.
		for deadline := time.Now().Add(3 * time.Second); hub.count() > 0 && time.Now().Before(deadline); {
			time.Sleep(5 * time.Millisecond)
		}
		resetHub()
		for i, l := range saved {
			*l = old[i]
		}
		db.Close()
	})
	return &testApp{t: t, handler: secureHeaders(limitBodies(routes()))}
}

// client is one signed-in browser.
type client struct {
	app    *testApp
	cookie *http.Cookie
	user   user
}

// login signs in through the development login, which is the same session path as the real one.
func (a *testApp) login(name string, admin bool) *client {
	a.t.Helper()
	q := url.Values{"name": {name}}
	if admin {
		q.Set("admin", "1")
	}
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, httptest.NewRequest("GET", "/api/auth/dev?"+q.Encode(), nil))
	if rec.Code != http.StatusSeeOther {
		a.t.Fatalf("login %s: status %d: %s", name, rec.Code, rec.Body)
	}
	c := &client{app: a}
	for _, ck := range rec.Result().Cookies() {
		if ck.Name == sessionCookie {
			c.cookie = ck
		}
	}
	if c.cookie == nil {
		a.t.Fatalf("login %s: no session cookie", name)
	}
	res := c.get("/api/me")
	if err := json.Unmarshal(res.Body.Bytes(), &c.user); err != nil {
		a.t.Fatalf("login %s: /api/me: %v", name, err)
	}
	return c
}

func (c *client) send(req *http.Request) *httptest.ResponseRecorder {
	if c != nil && c.cookie != nil {
		req.AddCookie(c.cookie)
	}
	rec := httptest.NewRecorder()
	c.app.handler.ServeHTTP(rec, req)
	return rec
}

func (c *client) get(path string) *httptest.ResponseRecorder {
	return c.send(httptest.NewRequest("GET", path, nil))
}

// do sends body (if any) as JSON.
func (c *client) do(method, path string, body any) *httptest.ResponseRecorder {
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			c.app.t.Fatal(err)
		}
		r = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, path, r)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.send(req)
}

// upload sends one file as multipart form data.
func (c *client) upload(method, path, filename string, data []byte) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	part, err := mw.CreateFormFile("file", filename)
	if err != nil {
		c.app.t.Fatal(err)
	}
	part.Write(data)
	mw.Close()
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	return c.send(req)
}

func (c *client) wantStatus(rec *httptest.ResponseRecorder, want int) {
	c.app.t.Helper()
	if rec.Code != want {
		c.app.t.Fatalf("status %d, want %d: %s", rec.Code, want, rec.Body)
	}
}

// --- fixtures ---

// newServer has an admin create a server and returns its id and its text channel's.
func (a *testApp) newServer(admin *client, name string) (serverID, textChannelID int64) {
	a.t.Helper()
	rec := admin.do("POST", "/api/servers", map[string]string{"name": name})
	admin.wantStatus(rec, http.StatusOK)
	var s server
	json.Unmarshal(rec.Body.Bytes(), &s)
	if err := db.QueryRow(`SELECT id FROM channels WHERE server_id = ? AND kind = 'text'`, s.ID).Scan(&textChannelID); err != nil {
		a.t.Fatal(err)
	}
	return s.ID, textChannelID
}

func (a *testApp) addMember(admin *client, serverID int64, member *client) {
	a.t.Helper()
	admin.wantStatus(admin.do("PUT", "/api/servers/"+itoa(serverID)+"/members/"+itoa(member.user.ID), nil), http.StatusNoContent)
}

// addMessage writes a message straight to the database.
func (a *testApp) addMessage(channelID int64, author *client, content string) int64 {
	a.t.Helper()
	var id int64
	err := db.QueryRow(`INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?) RETURNING id`,
		channelID, author.user.ID, content).Scan(&id)
	if err != nil {
		a.t.Fatal(err)
	}
	return id
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

// A real 1×1 PNG, so it sniffs as an image.
var tinyPNG = []byte{
	0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 'I', 'H', 'D', 'R', 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
	0x1f, 0x15, 0xc4, 0x89, 0, 0, 0, 0x0d, 'I', 'D', 'A', 'T', 0x78, 0x9c, 0x63, 0xf8, 0xff, 0xff, 0x3f, 0, 0x05, 0xfe,
	0x02, 0xfe, 0xa7, 0x35, 0x81, 0x84, 0, 0, 0, 0, 'I', 'E', 'N', 'D', 0xae, 0x42, 0x60, 0x82,
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }

func contextWithCancel(t *testing.T) (context.Context, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	t.Cleanup(cancel)
	return ctx, cancel
}

// resetHub forgets who's online: user IDs start again from 1 in each test's database, and
// the hub would otherwise still list the last test's people for its few seconds of grace.
func resetHub() {
	hub.mu.Lock()
	defer hub.mu.Unlock()
	for _, o := range hub.online {
		if o.offline != nil {
			o.offline.Stop()
		}
	}
	hub.online = map[int64]*onlineUser{}
	hub.conns = map[*websocket.Conn]user{}
}
