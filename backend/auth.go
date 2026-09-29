package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"html/template"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/oauth2"
)

// Login goes through PocketID (OIDC). The desktop app can't run passkeys in its webview, so it
// signs in through the system browser and polls for the session. Without OIDC settings, DEV_LOGIN
// enables a name-only login for local development.

const (
	sessionCookie = "gc_session"
	oauthCookie   = "gc_oauth"
	sessionTTL    = 30 * 24 * time.Hour
	loginTTL      = 10 * time.Minute
)

var (
	publicURL        = strings.TrimRight(os.Getenv("PUBLIC_URL"), "/")
	oidcIssuer       = os.Getenv("OIDC_ISSUER")
	oidcClientID     = os.Getenv("OIDC_CLIENT_ID")
	oidcClientSecret = os.Getenv("OIDC_CLIENT_SECRET")
	devLogin         = os.Getenv("DEV_LOGIN") == "1"
	// Members of this PocketID group are Gumcord admins: they create servers and manage members.
	adminGroup = envOr("ADMIN_GROUP", "gumcord-admins")

	// Signs sessions, the OIDC round-trip state and desktop approvals.
	tokenSecret  []byte
	cookieSecure = strings.HasPrefix(publicURL, "https://")
)

type user struct {
	ID     int64  `json:"id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar"`
	Admin  bool   `json:"admin"`
}

type userCtxKey struct{}

func currentUser(r *http.Request) user {
	return r.Context().Value(userCtxKey{}).(user)
}

func initAuth(dataDir string) {
	switch {
	case oidcIssuer != "":
		if publicURL == "" || oidcClientID == "" || oidcClientSecret == "" {
			log.Fatal("OIDC_ISSUER needs PUBLIC_URL, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET")
		}
		if devLogin {
			log.Fatal("DEV_LOGIN can't be combined with OIDC: it lets anyone sign in as anyone")
		}
	case !devLogin:
		log.Fatal("no login configured: set OIDC_ISSUER (and friends), or DEV_LOGIN=1 for local development")
	}

	if s := os.Getenv("SESSION_SECRET"); s != "" {
		tokenSecret = []byte(s)
		return
	}
	// Generated once and kept with the data, so sessions survive restarts without extra config.
	keyFile := filepath.Join(dataDir, "session.key")
	if b, err := os.ReadFile(keyFile); err == nil && len(b) >= 32 {
		tokenSecret = b
		return
	}
	tokenSecret = []byte(randHex(32))
	if err := os.WriteFile(keyFile, tokenSecret, 0o600); err != nil {
		log.Fatal(err)
	}
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// --- signed tokens ---

func registered(audience string, ttl time.Duration) jwt.RegisteredClaims {
	return jwt.RegisteredClaims{
		Audience:  jwt.ClaimStrings{audience},
		ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)),
	}
}

func signToken(c jwt.Claims) string {
	s, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(tokenSecret)
	if err != nil {
		panic(err) // HS256 with a []byte key can't fail
	}
	return s
}

// parseToken checks the signature, expiry and audience, so one kind of token can't stand in for another.
func parseToken(raw, audience string, c jwt.Claims) bool {
	_, err := jwt.ParseWithClaims(raw, c, func(*jwt.Token) (any, error) { return tokenSecret, nil },
		jwt.WithAudience(audience), jwt.WithExpirationRequired(), jwt.WithValidMethods([]string{"HS256"}))
	return err == nil
}

// --- sessions ---

// Sessions are kept in the database as well as signed into the cookie, so signing out really ends
// one: a copied cookie stops working then, not when it would have expired.
func setSession(w http.ResponseWriter, userID int64) error {
	now := time.Now()
	db.Exec(`DELETE FROM sessions WHERE expires < ?`, now.Unix()) // tidy up expired ones
	c := registered("session", sessionTTL)
	c.ID = randHex(32)
	c.Subject = strconv.FormatInt(userID, 10)
	if _, err := db.Exec(`INSERT INTO sessions (id, user_id, expires) VALUES (?, ?, ?)`, c.ID, userID, now.Add(sessionTTL).Unix()); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: signToken(c), Path: "/",
		MaxAge: int(sessionTTL.Seconds()), HttpOnly: true, Secure: cookieSecure, SameSite: http.SameSiteLaxMode,
	})
	return nil
}

func sessionUser(r *http.Request) (user, bool) {
	cookie, err := r.Cookie(sessionCookie)
	if err != nil {
		return user{}, false
	}
	var c jwt.RegisteredClaims
	if !parseToken(cookie.Value, "session", &c) {
		return user{}, false
	}
	id, err := strconv.ParseInt(c.Subject, 10, 64)
	if err != nil {
		return user{}, false
	}
	var live int
	if c.ID == "" || db.QueryRow(`SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND expires > ?`, c.ID, id, time.Now().Unix()).Scan(&live) != nil {
		return user{}, false // signed out, or from before sessions were kept
	}
	u, err := profile(id)
	return u, err == nil
}

func requireUser(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := sessionUser(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && !changeLimit.allow(u.ID) {
			tooMany(w)
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userCtxKey{}, u)))
	}
}

func handleMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, currentUser(r))
}

func handleLogout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookie); err == nil {
		var c jwt.RegisteredClaims
		if parseToken(cookie.Value, "session", &c) && c.ID != "" {
			db.Exec(`DELETE FROM sessions WHERE id = ?`, c.ID)
		}
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Path: "/", MaxAge: -1})
	w.WriteHeader(http.StatusNoContent)
}

// --- OIDC ---

var (
	oidcMu       sync.Mutex
	oidcProvider *oidc.Provider // discovered on first use, so the backend starts even while PocketID is down
)

func provider(ctx context.Context) (*oidc.Provider, *oauth2.Config, error) {
	oidcMu.Lock()
	defer oidcMu.Unlock()
	if oidcProvider == nil {
		p, err := oidc.NewProvider(ctx, oidcIssuer)
		if err != nil {
			return nil, nil, err
		}
		oidcProvider = p
	}
	return oidcProvider, &oauth2.Config{
		ClientID:     oidcClientID,
		ClientSecret: oidcClientSecret,
		Endpoint:     oidcProvider.Endpoint(),
		RedirectURL:  publicURL + "/api/auth/callback",
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email", "groups"},
	}, nil
}

// loginState rides in a short-lived cookie across the round trip to PocketID.
type loginState struct {
	State    string `json:"state"`
	Nonce    string `json:"nonce"`
	Verifier string `json:"verifier"`
	Desktop  string `json:"desktop,omitempty"` // handle of the desktop sign-in this completes
	jwt.RegisteredClaims
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	desktop := r.URL.Query().Get("desktop")
	if desktop != "" && !desktopLogins.exists(desktop) {
		expiredDesktopLogin(w)
		return
	}
	if devLogin {
		authPage(w, http.StatusOK, authPageData{
			Title: "Dev login", Message: "OIDC isn't configured. Pick any name to sign in as.",
			Action: "/api/auth/dev", Method: "get", Hidden: map[string]string{"desktop": desktop},
			NameField: true, AdminField: true, Button: "Sign in",
		})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	_, conf, err := provider(ctx)
	if err != nil {
		log.Printf("oidc discovery: %v", err)
		authPage(w, http.StatusBadGateway, authPageData{Title: "Can't reach the sign-in server", Message: "Try again in a moment.", BackLink: true})
		return
	}

	st := loginState{
		State: randHex(16), Nonce: randHex(16), Verifier: oauth2.GenerateVerifier(), Desktop: desktop,
		RegisteredClaims: registered("login", loginTTL),
	}
	http.SetCookie(w, &http.Cookie{
		Name: oauthCookie, Value: signToken(st), Path: "/api/auth/",
		MaxAge: int(loginTTL.Seconds()), HttpOnly: true, Secure: cookieSecure, SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, conf.AuthCodeURL(st.State, oidc.Nonce(st.Nonce), oauth2.S256ChallengeOption(st.Verifier)), http.StatusFound)
}

func handleCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var st loginState
	cookie, err := r.Cookie(oauthCookie)
	if err != nil || !parseToken(cookie.Value, "login", &st) || q.Get("state") != st.State {
		authPage(w, http.StatusBadRequest, authPageData{Title: "Sign-in expired", Message: "Please start signing in again.", BackLink: true})
		return
	}
	http.SetCookie(w, &http.Cookie{Name: oauthCookie, Path: "/api/auth/", MaxAge: -1})

	// e.g. access_denied when PocketID doesn't allow this user into the Gumcord client.
	if e := q.Get("error"); e != "" {
		msg := q.Get("error_description")
		if msg == "" {
			msg = e
		}
		authPage(w, http.StatusForbidden, authPageData{Title: "Couldn't sign in", Message: msg, BackLink: true})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	idToken, err := exchangeCode(ctx, q.Get("code"), st)
	if err != nil {
		log.Printf("oidc callback: %v", err)
		authPage(w, http.StatusBadGateway, authPageData{Title: "Couldn't sign in", Message: "The sign-in server's response didn't check out. Try again.", BackLink: true})
		return
	}

	var claims struct {
		DisplayName       string   `json:"display_name"`
		Name              string   `json:"name"`
		PreferredUsername string   `json:"preferred_username"`
		Email             string   `json:"email"`
		Picture           string   `json:"picture"`
		Groups            []string `json:"groups"`
	}
	if err := idToken.Claims(&claims); err != nil {
		serverError(w, err)
		return
	}
	name := firstNonEmpty(claims.DisplayName, claims.Name, claims.PreferredUsername, strings.Split(claims.Email, "@")[0], "User")
	u, err := upsertUser(idToken.Subject, name, importAvatar(ctx, claims.Picture), slices.Contains(claims.Groups, adminGroup))
	if err != nil {
		serverError(w, err)
		return
	}
	finishLogin(w, r, u, st.Desktop)
}

func exchangeCode(ctx context.Context, code string, st loginState) (*oidc.IDToken, error) {
	p, conf, err := provider(ctx)
	if err != nil {
		return nil, err
	}
	tok, err := conf.Exchange(ctx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		return nil, err
	}
	raw, _ := tok.Extra("id_token").(string)
	idToken, err := p.Verifier(&oidc.Config{ClientID: oidcClientID}).Verify(ctx, raw)
	if err != nil {
		return nil, err
	}
	if idToken.Nonce != st.Nonce {
		return nil, errNonce
	}
	return idToken, nil
}

var errNonce = errors.New("id_token nonce mismatch")

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

func handleDevLogin(w http.ResponseWriter, r *http.Request) {
	if !devLogin {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" || len(name) > 32 {
		http.Error(w, "name must be 1-32 characters", http.StatusBadRequest)
		return
	}
	u, err := upsertUser("dev:"+strings.ToLower(name), name, "", r.URL.Query().Get("admin") == "1")
	if err != nil {
		serverError(w, err)
		return
	}
	finishLogin(w, r, u, r.URL.Query().Get("desktop"))
}

// finishLogin signs this browser in, or for a desktop sign-in, asks the user to confirm handing the session to the app.
func finishLogin(w http.ResponseWriter, r *http.Request, u user, desktop string) {
	if desktop == "" {
		if err := setSession(w, u.ID); err != nil {
			serverError(w, err)
			return
		}
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	code, ok := desktopLogins.code(desktop)
	if !ok {
		expiredDesktopLogin(w)
		return
	}
	grant := desktopGrant{Handle: desktop, RegisteredClaims: registered("desktop", loginTTL)}
	grant.Subject = strconv.FormatInt(u.ID, 10)
	authPage(w, http.StatusOK, authPageData{
		Title:   "Sign in to the desktop app?",
		Message: "Signing in as " + u.Name + ". Check that the Gumcord app shows this code. If you didn't just start signing in from the app, close this tab.",
		Code:    code, Action: "/api/auth/desktop/approve", Method: "post",
		Hidden: map[string]string{"grant": signToken(grant)}, Button: "Sign in to the app",
	})
}

// --- desktop sign-in ---

// The app starts a sign-in and opens its URL in the system browser, where passkeys work. Once the
// user approves there, the app's next poll receives the session cookie.
type desktopLogin struct {
	secret  string // known only to the app; proves the poll comes from the app that started it
	code    string // shown in both the app and the browser, so the user can match them
	userID  int64  // set when approved in the browser
	expires time.Time
}

type desktopStore struct {
	mu sync.Mutex
	m  map[string]*desktopLogin // by handle, which appears in the browser URL
}

var desktopLogins = &desktopStore{m: map[string]*desktopLogin{}}

func (s *desktopStore) get(handle string) *desktopLogin {
	l := s.m[handle]
	if l != nil && time.Now().After(l.expires) {
		delete(s.m, handle)
		return nil
	}
	return l
}

func (s *desktopStore) exists(handle string) bool {
	_, ok := s.code(handle)
	return ok
}

func (s *desktopStore) code(handle string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if l := s.get(handle); l != nil {
		return l.code, true
	}
	return "", false
}

type desktopGrant struct {
	Handle string `json:"handle"`
	jwt.RegisteredClaims
}

// At most this many desktop sign-ins waiting at once: the endpoint needs no account.
const maxDesktopLogins = 500

func handleDesktopStart(w http.ResponseWriter, r *http.Request) {
	if !desktopStartLimit.allow("desktop") {
		tooMany(w)
		return
	}
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O or 1/I lookalikes
	b := make([]byte, 8)
	rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	l := &desktopLogin{secret: randHex(32), code: string(b[:4]) + "-" + string(b[4:]), expires: time.Now().Add(loginTTL)}
	handle := randHex(16)

	desktopLogins.mu.Lock()
	for h, old := range desktopLogins.m {
		if time.Now().After(old.expires) {
			delete(desktopLogins.m, h)
		}
	}
	full := len(desktopLogins.m) >= maxDesktopLogins
	if !full {
		desktopLogins.m[handle] = l
	}
	desktopLogins.mu.Unlock()
	if full {
		tooMany(w)
		return
	}

	writeJSON(w, map[string]string{
		"handle": handle,
		"secret": l.secret,
		"code":   l.code,
		"url":    "/api/auth/login?desktop=" + handle,
	})
}

func handleDesktopApprove(w http.ResponseWriter, r *http.Request) {
	var g desktopGrant
	if !parseToken(r.FormValue("grant"), "desktop", &g) {
		expiredDesktopLogin(w)
		return
	}
	userID, err := strconv.ParseInt(g.Subject, 10, 64)
	if err != nil {
		expiredDesktopLogin(w)
		return
	}

	desktopLogins.mu.Lock()
	l := desktopLogins.get(g.Handle)
	if l != nil {
		l.userID = userID
	}
	desktopLogins.mu.Unlock()
	if l == nil {
		expiredDesktopLogin(w)
		return
	}
	authPage(w, http.StatusOK, authPageData{Title: "You're signed in", Message: "Head back to the Gumcord app. You can close this tab."})
}

func handleDesktopPoll(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Handle string `json:"handle"`
		Secret string `json:"secret"`
	}
	if !readJSON(w, r, &body) {
		return
	}

	desktopLogins.mu.Lock()
	l := desktopLogins.get(body.Handle)
	if l == nil || subtle.ConstantTimeCompare([]byte(l.secret), []byte(body.Secret)) != 1 {
		desktopLogins.mu.Unlock()
		http.Error(w, "expired", http.StatusGone)
		return
	}
	userID := l.userID
	if userID != 0 {
		delete(desktopLogins.m, body.Handle) // one use
	}
	desktopLogins.mu.Unlock()

	if userID == 0 {
		writeJSON(w, map[string]string{"status": "pending"})
		return
	}
	if err := setSession(w, userID); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, map[string]string{"status": "done"})
}

func expiredDesktopLogin(w http.ResponseWriter) {
	authPage(w, http.StatusGone, authPageData{Title: "This sign-in link has expired", Message: "Start signing in again from the Gumcord app."})
}

// --- pages shown outside the app (login errors, desktop approval, dev login) ---

type authPageData struct {
	Title, Message, Code string
	Action, Method       string // a form, when Action is set
	Hidden               map[string]string
	NameField            bool
	AdminField           bool // dev login: sign in as an admin
	Button               string
	BackLink             bool
}

var authTmpl = template.Must(template.New("auth").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{.Title}} · Gumcord</title>
<style>
  * { box-sizing: border-box; }
  body { min-height: 100vh; margin: 0; display: flex; align-items: center; justify-content: center; padding: 16px;
    background: #1a1b2e; color: #d4d8f0; font: 14px/1.5 system-ui, sans-serif; }
  main { width: 100%; max-width: 380px; padding: 36px 28px; border: 1px solid #33365a; border-radius: 12px;
    background: #23253a; display: flex; flex-direction: column; align-items: center; gap: 14px; text-align: center; }
  .mark { width: 56px; height: 56px; }
  h1 { margin: 0; font-size: 20px; color: #e8eaf6; text-wrap: balance; }
  p { margin: 0; color: #8a90b4; }
  .code { padding: 8px 16px; border-radius: 8px; background: #1a1b2e; color: #e8eaf6; font: 700 24px ui-monospace, monospace; letter-spacing: 0.12em; }
  form { width: 100%; display: flex; flex-direction: column; gap: 10px; }
  input { padding: 9px 12px; border: 1px solid #33365a; border-radius: 7px; background: #1a1b2e; color: #d4d8f0; font: inherit; }
  button { padding: 10px 0; border: none; border-radius: 7px; background: #5b40c2; color: #fff; font: 600 14px system-ui, sans-serif; cursor: pointer; }
  button:hover { background: #6d50d6; }
  a { color: #a78bfa; }
  .check { display: flex; align-items: center; gap: 8px; color: #8a90b4; text-align: left; }
</style>
</head>
<body>
<main>
  <img class="mark" src="/icon.svg" alt="">
  <h1>{{.Title}}</h1>
  <p>{{.Message}}</p>
  {{if .Code}}<div class="code">{{.Code}}</div>{{end}}
  {{if .Action}}
  <form method="{{.Method}}" action="{{.Action}}">
    {{range $k, $v := .Hidden}}{{if $v}}<input type="hidden" name="{{$k}}" value="{{$v}}">{{end}}{{end}}
    {{if .NameField}}<input name="name" placeholder="Display name" maxlength="32" required autofocus>{{end}}
    {{if .AdminField}}<label class="check"><input type="checkbox" name="admin" value="1"> Admin</label>{{end}}
    <button>{{.Button}}</button>
  </form>
  {{end}}
  {{if .BackLink}}<a href="/">Back to Gumcord</a>{{end}}
</main>
</body>
</html>`))

func authPage(w http.ResponseWriter, status int, d authPageData) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	if err := authTmpl.Execute(w, d); err != nil {
		log.Printf("auth page: %v", err)
	}
}
